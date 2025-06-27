const { App, ExpressReceiver } = require('@slack/bolt');
require('dotenv').config();
const axios = require('axios');

// Create custom receiver for Slack Events
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// Slash command: opens the modal
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
            placeholder: { type: 'plain_text', text: 'Search...' },
            min_query_length: 1
          }
        },
        {
          type: 'input',
          block_id: 'summary_block',
          label: { type: 'plain_text', text: 'Summary' },
          element: {
            type: 'plain_text_input',
            action_id: 'summary_input'
          }
        }
      ]
    }
  });
});

// This handles the dynamic external_select search
app.options('service_input', async ({ options, ack }) => {
  console.log('✅ options handler triggered');
  console.log('🔍 Raw options payload:', JSON.stringify(options, null, 2));

  const search = options.value || '';
  console.log(`🔍 Search term: "${search}"`);

  try {
    const pdRes = await axios.get('https://api.pagerduty.com/services', {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2'
      },
      params: {
        query: search,
        limit: 25
      }
    });

    console.log(`✅ PagerDuty raw data: ${JSON.stringify(pdRes.data, null, 2)}`);

    const services = pdRes.data.services || [];
    const formatted = services.map(s => ({
      text: { type: 'plain_text', text: s.name },
      value: s.id
    }));

    console.log(`✅ Returning ${formatted.length} options`);
    await ack({ options: formatted });
  } catch (err) {
    console.error('❌ Error calling PagerDuty:', err);
    await ack({ options: [] });
  }
});

// Just ack modal for now
app.view('escalate_modal', async ({ ack }) => {
  console.log('✅ Modal submit received');
  await ack();
});

// Start
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Server running on port ${port}`);
})();
