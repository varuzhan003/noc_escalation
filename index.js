const { App, ExpressReceiver } = require('@slack/bolt');
require('dotenv').config();
const axios = require('axios');

// Setup ExpressReceiver
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
});

// Create Bolt App
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
          block_id: 'summary_block',
          label: { type: 'plain_text', text: 'Summary' },
          element: {
            type: 'plain_text_input',
            action_id: 'summary_input',
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
});

// External select handler
app.options({ action_id: 'service_input' }, async ({ options, ack }) => {
  const search = options.value || '';
  console.log(`🔍 options() called: "${search}"`);

  const response = await axios.get('https://api.pagerduty.com/services', {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
    params: {
      query: search,
      limit: 25,
    },
  });

  const services = response.data.services || [];
  console.log(`✅ PD returned ${services.length} services`);

  const formatted = services.map(s => ({
    text: { type: 'plain_text', text: s.name },
    value: `${s.id}|||${s.name}`,
  }));

  await ack({ options: formatted });
});

// Modal submission handler
app.view('escalate_modal', async ({ ack, view, body, client }) => {
  await ack();
  console.log('✅ Modal submitted');

  const userId = body.user.id;
  const selectedService = view.state.values.service_block.service_input.selected_option?.value || 'N/A';
  const [serviceId, serviceName] = selectedService.split('|||');

  const summary = view.state.values.summary_block.summary_input.value;
  const urgency = view.state.values.urgency_block.urgency_input.selected_option.text.text;

  console.log(`✅ Final: Service ID: ${serviceId}`);
  console.log(`✅ Final: Service Name: ${serviceName}`);

  // --- GET COMMUNICATION CHANNEL ---
  const pdResp = await axios.get(`https://api.pagerduty.com/services/${serviceId}`, {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
  });

  const pdService = pdResp.data.service || {};
  const description = pdService.description || '';
  let channelMatch = description.match(/Communication Channel:\s*(#\S+)/i);
  let targetChannel = channelMatch ? channelMatch[1] : null;

  console.log(`✅ Final: Extracted channel: ${targetChannel}`);

  // If no channel → fallback modal
  if (!targetChannel) {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'fallback_channel',
        title: { type: 'plain_text', text: 'Provide Channel' },
        submit: { type: 'plain_text', text: 'Send' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'channel_block',
            label: { type: 'plain_text', text: 'Slack Channel' },
            element: {
              type: 'plain_text_input',
              action_id: 'channel_input',
              placeholder: { type: 'plain_text', text: '#noc-escalation-test' },
            },
          },
        ],
      },
    });
    return; // stop here for fallback flow
  }

  // If we have channel → post immediately
  const msg = `*🚨 Escalation*\n• Reporter: <@${userId}>\n• Service: ${serviceName}\n• Urgency: ${urgency}\n• Summary: ${summary}`;
  await client.chat.postMessage({ channel: targetChannel, text: msg });

  console.log(`✅ Final escalation posted to ${targetChannel}`);
});

// Fallback modal submission handler
app.view('fallback_channel', async ({ ack, view, body, client }) => {
  await ack();
  const channel = view.state.values.channel_block.channel_input.value;

  if (!channel) {
    console.log(`❌ No channel provided, not posting.`);
    return;
  }

  const msg = `*🚨 Escalation*\n• Reporter: <@${body.user.id}>\n• Channel provided manually: ${channel}`;
  await client.chat.postMessage({ channel, text: msg });

  console.log(`✅ Final fallback posted to ${channel}`);
});

// Start App
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation running with COMMUNICATION CHANNEL on port ${port}`);
})();
