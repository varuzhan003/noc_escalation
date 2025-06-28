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
    view: buildModal('_', '', ''),
  });
});

function buildModal(onCallTag, serviceId, serviceName) {
  const blocks = [
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
  ];

  if (onCallTag && onCallTag !== '_') {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*Current On-call:* ${onCallTag}` }],
    });
  }

  blocks.push(
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
    }
  );

  return {
    type: 'modal',
    callback_id: 'escalate_modal',
    title: { type: 'plain_text', text: 'NOC Escalation' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
    private_metadata: JSON.stringify({ serviceId, onCallTag, serviceName }),
  };
}

app.options({ action_id: 'service_input' }, async ({ options, ack, body, client }) => {
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

    if (services.length === 1) {
      const s = services[0];
      console.log(`🔍 Single service match: ${s.name}`);

      let onCallTag = '_No current On-call_';
      try {
        const escalationPolicyId = s.escalation_policy?.id;
        console.log('🔍 Escalation Policy:', escalationPolicyId);

        if (escalationPolicyId) {
          const ocResp = await axios.get('https://api.pagerduty.com/oncalls', {
            headers: {
              Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
              Accept: 'application/vnd.pagerduty+json;version=2',
            },
            params: { escalation_policy_ids: [escalationPolicyId] },
          });

          const realOncall = ocResp.data.oncalls.find(o => o.schedule !== null);
          console.log('🔍 Real On-call:', realOncall);

          if (realOncall?.user?.id) {
            const userResp = await axios.get(`https://api.pagerduty.com/users/${realOncall.user.id}`, {
              headers: {
                Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
                Accept: 'application/vnd.pagerduty+json;version=2',
              },
            });

            const email = userResp.data.user?.email;
            console.log('🔍 On-call user email:', email);

            if (email) {
              const slackUser = await client.users.lookupByEmail({ email });
              console.log('🔍 Slack user:', slackUser.user?.id);
              if (slackUser.ok && slackUser.user?.id) {
                onCallTag = `<@${slackUser.user.id}>`;
              }
            }
          }
        }
      } catch (err) {
        console.error('❌ On-call lookup error:', err);
      }

      console.log(`✅ FINAL On-call Tag: ${onCallTag}`);

      await client.views.update({
        view_id: body.view.id,
        view: buildModal(onCallTag, s.id, s.name),
      });
    }

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

app.view('escalate_modal', async ({ ack, view, body, client }) => {
  await ack();
  const userId = body.user.id;
  const urgency = view.state.values.urgency_block.urgency_input.selected_option?.text.text || 'N/A';
  const summary = view.state.values.summary_block.summary_input.value;

  let serviceName = 'N/A';
  let onCallTag = '_No current On-call_';
  try {
    const meta = JSON.parse(view.private_metadata);
    onCallTag = meta.onCallTag || onCallTag;
    serviceName = meta.serviceName || serviceName;
  } catch {}

  const result = await client.users.info({ user: userId });
  const reporter = result.user.profile.display_name || result.user.real_name || `<@${userId}>`;

  const msg = `*🚨 Escalation*\n• *Reporter:* ${reporter}\n• *Service:* ${serviceName}\n• *Urgency:* ${urgency}\n• *Summary:* ${summary}\n• *On-call:* ${onCallTag}`;

  await client.chat.postMessage({
    channel: '#noc-escalation-test',
    text: msg,
  });

  console.log('✅ Escalation sent with On-call');
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Final version running on ${port}`);
})();
