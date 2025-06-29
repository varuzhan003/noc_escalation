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

// Load options dynamically
app.options({ action_id: 'service_input' }, async ({ options, ack }) => {
  const searchTerm = options.value || '';
  console.log(`🔍 options() called: "${searchTerm}"`);

  const res = await axios.get('https://api.pagerduty.com/services', {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
    params: { query: searchTerm, limit: 25 },
  });

  console.log(`✅ PD returned ${res.data.services.length} services`);
  const formatted = res.data.services.map(s => ({
    text: { type: 'plain_text', text: s.name },
    value: `${s.id}|||${s.escalation_policy.id}`,
  }));

  await ack({ options: formatted });
});

// Modal submit
app.view('escalate_modal', async ({ ack, view, body, client }) => {
  await ack();
  console.log('✅ Modal submitted');

  const userId = body.user.id;
  const selected = view.state.values.service_block.service_input.selected_option.value;
  const [serviceId, escalationId] = selected.split('|||');
  const urgency = view.state.values.urgency_block.urgency_input.selected_option.text.text;
  const summary = view.state.values.summary_block.summary_input.value;

  console.log(`✅ Final: Service ID: ${serviceId}`);
  console.log(`✅ Final: Escalation policy: ${escalationId}`);

  // Get on-call user
  const oncallRes = await axios.get('https://api.pagerduty.com/oncalls', {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
    params: { escalation_policy_ids: [escalationId] },
  });

  const oncall = oncallRes.data.oncalls.find(o => o.schedule);
  console.log('✅ Final: Real On-call:', oncall);

  let slackMention = '_No current On-call_';

  if (oncall && oncall.user && oncall.user.id) {
    const pdUser = await axios.get(`https://api.pagerduty.com/users/${oncall.user.id}`, {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
    });

    const email = pdUser.data.user.email;
    console.log('✅ Final: On-call email:', email);

    try {
      const slackUser = await client.users.lookupByEmail({ email });
      slackMention = `<@${slackUser.user.id}>`;
    } catch (err) {
      console.error('❌ Slack lookup failed:', err);
    }
  }

  const msg = `:rotating_light: *Escalation*\n• Reporter: <@${userId}>\n• Service: ${selected.split('|||')[0]}\n• Urgency: ${urgency}\n• Summary: ${summary}\n• On-call: ${slackMention}`;

  await client.chat.postMessage({
    channel: '#noc-escalation-test',
    text: msg,
  });

  console.log('✅ Final escalation sent with on-call');
});

// Health check
receiver.router.get('/', (req, res) => res.send('OK'));

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation running with NAME MATCH on port ${port}`);
})();
