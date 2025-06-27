const { App, ExpressReceiver } = require('@slack/bolt');
require('dotenv').config();
const axios = require('axios');

// ExpressReceiver with Slack endpoint
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// Slash command: open modal
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
            label: { type: 'plain_text', text: 'Select Service' },
            element: {
              type: 'external_select',
              action_id: 'service_input',
              placeholder: { type: 'plain_text', text: 'Search for a service...' },
              min_query_length: 2
            },
          },
          {
            type: 'input',
            block_id: 'summary_block',
            label: { type: 'plain_text', text: 'Summary' },
            element: {
              type: 'plain_text_input',
              action_id: 'summary_input'
            },
          },
          {
            type: 'input',
            block_id: 'monitor_block',
            label: { type: 'plain_text', text: 'Datadog Monitor Link' },
            element: {
              type: 'plain_text_input',
              action_id: 'monitor_input'
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
        ],
      },
    });
  } catch (err) {
    logger.error('❌ Error opening modal:', err);
  }
});

// Dynamic search handler for external_select
app.options('service_input', async ({ options, ack, logger }) => {
  const search = options.value || '';
  console.log(`🔍 Received external_select search: "${search}"`);

  try {
    const response = await axios.get(
      'https://api.pagerduty.com/services',
      {
        headers: {
          Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
          Accept: 'application/vnd.pagerduty+json;version=2',
        },
        params: {
          query: search,
          limit: 100,
        },
      }
    );

    const services = response.data.services || [];
    console.log(`✅ PagerDuty returned ${services.length} services for "${search}"`);

    const optionsToSend = services.slice(0, 100).map(service => ({
      text: { type: 'plain_text', text: service.name },
      value: service.id,
    }));

    console.log(`✅ Sending ${optionsToSend.length} options to Slack`);
    await ack({ options: optionsToSend });
  } catch (error) {
    logger.error('❌ Error in external_select handler:', error);
    await ack({ options: [] });
  }
});

// Modal submit handler
app.view('escalate_modal', async ({ ack, view, body, client, logger }) => {
  console.log('✅ Modal submit received');
  await ack();
  console.log('✅ Modal submit acked');

  const userId = body.user.id;
  const serviceId = view.state.values.service_block.service_input.selected_option.value;
  const serviceName = view.state.values.service_block.service_input.selected_option.text.text;
  const summary = view.state.values.summary_block.summary_input.value;
  const monitorLink = view.state.values.monitor_block.monitor_input.value;
  const urgency = view.state.values.urgency_block.urgency_input.selected_option.text.text;

  const message = `*🚨 New Escalation Alert*\n
*Reporter:* <@${userId}>
*Service:* ${serviceName}
*Summary:* ${summary}
*Urgency:* ${urgency}

*🔗 Links:*
• <${monitorLink}|Datadog Monitor>

*🧠 Context:*
• Owner Team: _TBD_
• On-call: _TBD_
• Deployment: _TBD_`;

  await client.chat.postMessage({
    channel: '#noc-escalation-test',
    text: message,
  });

  console.log('✅ Escalation message sent');
});

// Start server
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation with external_select running on port ${port}`);
})();
