const { App, ExpressReceiver } = require('@slack/bolt');
require('dotenv').config();

// Use ExpressReceiver with custom endpoint for Slack Events & Interactivity
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
});

// Initialize your Bolt app with the receiver
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// Slash command: /noc_escalation
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
            type: 'plain_text_input',
            action_id: 'service_input',
            placeholder: { type: 'plain_text', text: 'e.g. service-video-api' },
          },
        },
        {
          type: 'input',
          block_id: 'summary_block',
          label: { type: 'plain_text', text: 'Summary of the issue' },
          element: {
            type: 'plain_text_input',
            action_id: 'summary_input',
          },
        },
        {
          type: 'input',
          block_id: 'monitor_block',
          label: { type: 'plain_text', text: 'Datadog Monitor Link' },
          element: {
            type: 'plain_text_input',
            action_id: 'monitor_input',
          },
        },
        {
          type: 'input',
          block_id: 'urgency_block',
          label: { type: 'plain_text', text: 'Urgency' },
          element: {
            type: 'static_select',
            action_id: 'urgency_input',
            options: ['Low', 'Medium', 'High'].map((level) => ({
              text: { type: 'plain_text', text: level },
              value: level.toLowerCase(),
            })),
          },
        },
      ],
    },
  });
});

// Modal submission handler
app.view('escalate_modal', async ({ ack, view, body, client }) => {
  console.log('✅ Modal submit received');
  await ack();
  console.log('✅ Modal submit acked');

  // Extract form values
  const userId = body.user.id;
  const service = view.state.values.service_block.service_input.value;
  const summary = view.state.values.summary_block.summary_input.value;
  const monitorLink = view.state.values.monitor_block.monitor_input.value;
  const urgency = view.state.values.urgency_block.urgency_input.selected_option.text.text;

  // Build your message
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

  // Post to fallback channel
  await client.chat.postMessage({
    channel: '#noc-escalation-test',
    text: message,
  });

  console.log('✅ Escalation message sent');
});

// Start Bolt app
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation is running on port ${port}`);
})();
