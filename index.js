const { App, ExpressReceiver } = require('@slack/bolt');
require('dotenv').config();
const axios = require('axios');

// ExpressReceiver for events
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// Slash command to open modal
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
              placeholder: { type: 'plain_text', text: 'Search for a service...' },
              min_query_length: 2
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
  } catch (err) {
    logger.error('❌ Error opening modal:', err);
  }
});

// External select handler — returns matching services
app.options({ action_id: 'service_input' }, async ({ options, ack, logger }) => {
  const search = options.value || '';
  console.log(`✅ External select triggered, search: "${search}"`);

  try {
    const response = await axios.get('https://api.pagerduty.com/services', {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2'
      },
      params: {
        query: search,
        limit: 100
      }
    });

    const services = response.data.services || [];
    console.log(`✅ PagerDuty returned ${services.length} services`);

    const formattedOptions = services.map(s => ({
      text: { type: 'plain_text', text: s.name },
      value: s.id
    }));

    console.log(`✅ Returning ${formattedOptions.length} options`);
    await ack({ options: formattedOptions });

  } catch (err) {
    console.error('❌ Error fetching services:', err);
    await ack({ options: [] });
  }
});

// Modal submission — posts message
app.view('escalate_modal', async ({ ack, view, body, client, logger }) => {
  console.log('✅ Modal submitted');
  await ack();

  const userId = body.user.id;
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
    text: message
  });

  console.log('✅ Escalation message sent');
});

// Start server
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation running on port ${port}`);
})();
