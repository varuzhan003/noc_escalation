const { App, ExpressReceiver } = require('@slack/bolt');
require('dotenv').config();
const axios = require('axios');

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

app.command('/noc_escalation', async ({ ack, body, client }) => {
  console.log('✅ Slash command received');
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'escalate_modal',
      title: { type: 'plain_text', text: 'NOC Escalation' },
      submit: { type: 'plain_text', text: 'Send' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'service_block',
          label: { type: 'plain_text', text: 'Service' },
          element: {
            type: 'external_select',
            action_id: 'service_input',
            placeholder: { type: 'plain_text', text: 'Search services...' },
            min_query_length: 2,
          },
        },
        {
          type: 'input',
          block_id: 'urgency_block',
          label: { type: 'plain_text', text: 'Urgency' },
          element: {
            type: 'static_select',
            action_id: 'urgency_input',
            options: ['Low', 'Medium', 'High'].map(level => ({
              text: { type: 'plain_text', text: level },
              value: level.toLowerCase(),
            })),
          },
        },
        {
          type: 'input',
          block_id: 'summary_block',
          label: { type: 'plain_text', text: 'Summary' },
          element: { type: 'plain_text_input', action_id: 'summary_input' },
        },
      ],
    },
  });
});

// Dynamic external select options
app.options({ action_id: 'service_input' }, async ({ options, ack }) => {
  const searchTerm = options.value || '';
  console.log(`🔍 options() called: "${searchTerm}"`);

  try {
    const response = await axios.get('https://api.pagerduty.com/services', {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
      params: { query: searchTerm, limit: 25 },
    });

    const services = response.data.services || [];
    console.log(`✅ PD returned ${services.length} services`);

    await ack({
      options: services.map(s => ({
        text: { type: 'plain_text', text: s.name },
        value: s.id,
      })),
    });
  } catch (err) {
    console.error('❌ options() error:', err);
    await ack({ options: [] });
  }
});

// Final submit handler
app.view('escalate_modal', async ({ ack, view, body, client, logger }) => {
  await ack();
  console.log('✅ Modal submitted');

  const userId = body.user.id;
  const urgency = view.state.values.urgency_block.urgency_input.selected_option?.text.text || 'N/A';
  const summary = view.state.values.summary_block.summary_input.value;
  const serviceId = view.state.values.service_block.service_input.selected_option?.value || null;

  let serviceName = 'N/A';
  let onCallTag = '_No current On-call_';

  if (serviceId) {
    try {
      const sResp = await axios.get(`https://api.pagerduty.com/services/${serviceId}`, {
        headers: {
          Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
          Accept: 'application/vnd.pagerduty+json;version=2',
        },
      });
      const sData = sResp.data.service;
      serviceName = sData.name;
      console.log(`✅ Final: Service: ${serviceName}`);

      const policyId = sData.escalation_policy?.id;
      if (policyId) {
        const ocResp = await axios.get('https://api.pagerduty.com/oncalls', {
          headers: {
            Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
            Accept: 'application/vnd.pagerduty+json;version=2',
          },
          params: { escalation_policy_ids: [policyId] },
        });

        const realOncall = ocResp.data.oncalls.find(o => o.schedule !== null);
        console.log('✅ Final: Real On-call:', realOncall);

        if (realOncall?.user?.id) {
          const userResp = await axios.get(`https://api.pagerduty.com/users/${realOncall.user.id}`, {
            headers: {
              Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
              Accept: 'application/vnd.pagerduty+json;version=2',
            },
          });

          const email = userResp.data.user?.email;
          console.log('✅ Final: On-call email:', email);

          if (email) {
            const slackUser = await client.users.lookupByEmail({ email });
            console.log('✅ Final: Slack user:', slackUser.user?.id);
            if (slackUser.ok && slackUser.user?.id) {
              onCallTag = `<@${slackUser.user.id}>`;
            }
          }
        }
      }
    } catch (err) {
      console.error('❌ Final on-call error:', err);
    }
  }

  const result = await client.users.info({ user: userId });
  const reporter = result.user.profile.display_name || result.user.real_name || `<@${userId}>`;

  const msg = `*🚨 Escalation*\n• Reporter: ${reporter}\n• Service: ${serviceName}\n• Urgency: ${urgency}\n• Summary: ${summary}\n• On-call: ${onCallTag}`;

  await client.chat.postMessage({
    channel: '#noc-escalation-test',
    text: msg,
  });

  console.log('✅ Final escalation sent with on-call');
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Final version always resolves on-call at submit on ${port}`);
})();
