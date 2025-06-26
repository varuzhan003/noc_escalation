const { App, ExpressReceiver } = require('@slack/bolt');
require('dotenv').config();

// Setup receiver to handle /slack/events endpoint
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events'
});

// Create Bolt app with custom receiver
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

// Slash command handler
app.command('/escalate', async ({ ack, body, client }) => {
  await ack(); // Respond quickly to Slack

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
              type: 'plain_text_input',
              action_id: 'service_input',
              placeholder: { type: 'plain_text', text: 'e.g. service-audio-pipeline' }
            }
          },
          {
            type: 'input',
            block_id: 'summary_block',
            label: { type: 'plain_text', text: 'Summary of the issue' },
            element: { type: 'plain_text_input', action_id: 'summary_input' }
          },
          {
            type: 'input',
            block_id: 'monitor_block',
            label: { type: 'plain_text', text: 'Datadog Monitor Link' },
            element: { type: 'plain_text_input', action_id: 'monitor_input' }
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
    console.error('Error opening modal:', error);
  }
});

// Modal submission handler
app.view('escalate_modal', async ({ ack, view, body, client }) => {
  await ack(); // Acknowledge immediately

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

    const fallbackChannel = '#noc-escalation-test';
    await client.chat.postMessage({ channel: fallbackChannel, text: message });
  } catch (error) {
    console.error('Error posting escalation message:', error);
  }
});

// Start express server
receiver.app.listen(process.env.PORT || 3000, () => {
  console.log('⚡️ noc_escalation is running!');
});
