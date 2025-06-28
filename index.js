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
app.command('/noc_escalation', async ({ ack, body, client, logger }) => {
  console.log('✅ Slash command received');
  await ack();

  try {
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
            element: {
              type: 'plain_text_input',
              action_id: 'summary_input',
            },
          },
        ],
      },
    });
  } catch (err) {
    console.error('❌ Modal open error:', err);
  }
});

// Options handler for external select
app.options({ action_id: 'service_input' }, async ({ options, ack, logger }) => {
  const searchTerm = options.value || '';
  console.log(`🔍 options() called. Search term: "${searchTerm}"`);

  if (searchTerm.toLowerCase() === 'test') {
    console.log(`✅ Returning STATIC fallback option`);
    return ack({
      options: [
        {
          text: { type: 'plain_text', text: 'STATIC TEST SERVICE' },
          value: 'static-test-id',
        },
      ],
    });
  }

  try {
    const response = await axios.get('https://api.pagerduty.com/services', {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
      params: {
        query: searchTerm,
        limit: 25,
      },
    });

    const services = response.data.services || [];
    console.log(`✅ PagerDuty returned ${services.length} services for "${searchTerm}"`);

    const formatted = services.map((s) => ({
      text: { type: 'plain_text', text: s.name },
      value: s.id,
    }));

    console.log(`✅ Returning ${formatted.length} options back to Slack`);
    await ack({ options: formatted });

  } catch (err) {
    console.error('❌ Error fetching PD services:', err);
    await ack({ options: [] });
  }
});

// Submit handler for modal
app.view('escalate_modal', async ({ ack, view, body, client }) => {
  await ack();
  console.log('✅ Modal submitted');

  const userId = body.user.id;
  const selectedService = view.state.values.service_block.service_input.selected_option?.text.text || 'N/A';
  const urgency = view.state.values.urgency_block.urgency_input.selected_option?.text.text || 'N/A';
  const summary = view.state.values.summary_block.summary_input.value;

  // Get real display name
  const userInfo = await client.users.info({ user: userId });
  const displayName = userInfo.user.profile.display_name || userInfo.user.real_name || `<@${userId}>`;

  const msg = `*🚨 Escalation*\n• *Reporter:* ${displayName}\n• *Service:* ${selectedService}\n• *Urgency:* ${urgency}\n• *Summary:* ${summary}`;

  await client.chat.postMessage({
    channel: '#noc-escalation-test',
    text: msg,
  });

  console.log('✅ Escalation message sent to channel');
});

// Start
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation FINAL test running on ${port}`);
})();
