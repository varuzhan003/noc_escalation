const { App, ExpressReceiver } = require('@slack/bolt');
require('dotenv').config();
const axios = require('axios');

// ExpressReceiver for Slack events
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// Slash command opens modal
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
            placeholder: { type: 'plain_text', text: 'Type 2+ letters...' },
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
              value: level.toLowerCase()
            })),
          },
        },
        {
          type: 'input',
          block_id: 'summary_block',
          label: { type: 'plain_text', text: 'Summary' },
          element: {
            type: 'plain_text_input',
            action_id: 'summary_input',
          },
        },
      ],
    },
  });
});

// Options handler
app.options({ action_id: 'service_input' }, async ({ options, ack }) => {
  const searchTerm = options.value || '';
  console.log(`🔍 options() called: "${searchTerm}"`);

  const response = await axios.get('https://api.pagerduty.com/services', {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
    params: { query: searchTerm, limit: 25 },
  });

  const services = response.data.services || [];
  console.log(`✅ PD returned ${services.length} services`);
  const formatted = services.map(s => ({
    text: { type: 'plain_text', text: s.name },
    value: s.id,
  }));

  await ack({ options: formatted });
});

// Modal submit
app.view('escalate_modal', async ({ ack, view, body, client, logger }) => {
  await ack();
  console.log('✅ Modal submitted');

  const userId = body.user.id;
  const selectedServiceId = view.state.values.service_block.service_input.selected_option?.value || 'N/A';
  const urgency = view.state.values.urgency_block.urgency_input.selected_option?.text?.text || 'N/A';
  const summary = view.state.values.summary_block.summary_input.value;

  console.log(`✅ Final: Service ID: ${selectedServiceId}`);

  let slackMention = 'No current On-call';

  try {
    const svc = await axios.get(`https://api.pagerduty.com/services/${selectedServiceId}`, {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
    });

    const escalationId = svc.data.service?.escalation_policy?.id;
    console.log(`✅ Final: Escalation policy: ${escalationId}`);

    if (escalationId) {
      const oncalls = await axios.get('https://api.pagerduty.com/oncalls', {
        headers: {
          Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
          Accept: 'application/vnd.pagerduty+json;version=2',
        },
        params: { 'escalation_policy_ids[]': escalationId },
      });

      const oncall = oncalls.data.oncalls.find(o => o.schedule) || oncalls.data.oncalls[0];
      console.log('✅ Final: Real On-call:', JSON.stringify(oncall, null, 2));

      const oncallName = oncall.user.summary;
      const pdEmail = `${oncallName.toLowerCase().replace(/ /g, '.')}@pluto.tv`;
      const slackEmail = pdEmail.replace('@pluto.tv', '@paramount.com');

      console.log(`✅ Final: On-call email: ${slackEmail}`);

      try {
        const slackUser = await client.users.lookupByEmail({ email: slackEmail });
        slackMention = `<@${slackUser.user.id}>`;
      } catch (err) {
        console.error('❌ Email lookup failed, fallback:', err);
        const slackUsers = await client.users.list();
        const fallback = slackUsers.members.find(u =>
          u.profile.real_name_normalized?.toLowerCase().includes(oncallName.toLowerCase())
        );
        if (fallback) {
          slackMention = `<@${fallback.id}>`;
          console.log(`✅ Fallback name match: ${fallback.profile.real_name}`);
        }
      }
    }
  } catch (err) {
    console.error('❌ Final fallback error:', err);
  }

  await client.chat.postMessage({
    channel: '#noc-escalation-test',
    text: `:rotating_light: *Escalation*\n• Reporter: <@${userId}>\n• Service: ${selectedServiceId}\n• Urgency: ${urgency}\n• Summary: ${summary}\n• On-call: ${slackMention}`,
  });

  console.log('✅ Final escalation sent with on-call');
});

// Start
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation SMART running on ${port}`);
})();
