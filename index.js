require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');

// Create a custom receiver with /slack/events endpoint
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events'
});

// Initialize the Bolt app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

// Slash command listener
app.command('/noc_escalation', async ({ ack, respond, body, client, logger }) => {
  try {
    await ack(); // Acknowledge quickly

    await respond({
      response_type: 'ephemeral',
      text: 'Opening escalation modal...'
    });

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
              type: 'plain_text_input',
              action_id: 'service_input',
              placeholder: { type: 'plain_text', text: 'e.g. service-audio-pipeline' }
            }
          },
          {
            type: 'input',
            block_id: 'summary_block',
            label: { type: 'plain_text', text: 'Summary of the issue' },
            element: {
              type: 'plain_text_input',
              action_id: 'summary_input'
            }
          },
          {
            type: 'input',
            block_id: 'monitor_block',
            label: { type: 'plain_text', text: 'Datadog Monitor Link' },
            element: {
              type: 'plain_text_input',
              action_id: 'monitor_input'
            }
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
              }))
            }
          }
        ]
      }
    });
  } catch (error) {
    logger.error('❌ Error in /noc_escalation handler:', error);
  }
});

// Modal submission handler
app.view('escalate_modal', async ({ ack, view, body, client, logger }) => {
  await ack();

  try {
    const userId = body.user.id;
    const service = view.state.values.service_block.service_input.value;
    const summary = view.state.values.summary_block.summary_input.value;
    const monitorLink = view.state.values.monitor_block.monitor_input.value;
    const urgency = view.state.values.urgency_block.urgency_input.selected_option.text.text;

    const message = `*🚨 New Escalation Alert*\n
*Reporter:* <@${userId}>
*Service:* ${service}
*Summary:* ${summary}
*Urgency:* ${urgency}

*🔗 Links:*
• <${monitorLink}|Datadog Monitor>
• <https://datadog.com/dashboard/${service}|Dashboard>
• <https://datadog.com/logs/${service}?from=-30m|Logs (last 30m)>

*🧠 Context:*
• Owner Team: _TBD_
• On-call: _TBD_
• Deployment: _TBD_`;

    await client.chat.postMessage({
      channel: '#noc-escalation-test',
      text: message
    });
  } catch (error) {
    logger.error('❌ Error handling modal submit:', error);
  }
});

// Start the server
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation is running on port ${port}`);
})();
