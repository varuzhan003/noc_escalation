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

// Store last context for fallback
let lastEscalationContext = {};

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
            placeholder: { type: 'plain_text', text: 'Type to search...' },
            min_query_length: 2,
          },
        },
        {
          type: 'input',
          block_id: 'summary_block',
          label: { type: 'plain_text', text: 'Summary' },
          element: { type: 'plain_text_input', action_id: 'summary_input' },
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
  const term = options.value || '';
  const resp = await axios.get('https://api.pagerduty.com/services', {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
    params: { query: term, limit: 25 },
  });
  const services = resp.data.services || [];
  const formatted = services.map(s => ({
    text: { type: 'plain_text', text: s.name },
    value: `${s.id}|${s.name}`,
  }));
  await ack({ options: formatted });
});

// Main escalation
app.view('escalate_modal', async ({ ack, view, body, client }) => {
  await ack();
  const userId = body.user.id;
  const [serviceId, serviceName] = view.state.values.service_block.service_input.selected_option.value.split('|');
  const summary = view.state.values.summary_block.summary_input.value;
  const urgency = view.state.values.urgency_block.urgency_input.selected_option.text.text;

  console.log(`✅ Final: Service ID: ${serviceId}`);
  console.log(`✅ Final: Service Name: ${serviceName}`);

  // Fetch service details
  const svc = await axios.get(`https://api.pagerduty.com/services/${serviceId}`, {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
  }).then(r => r.data.service);

  const desc = svc.description || '';
  console.log(`✅ Service description: ${desc}`);

  // Extract channel from description
  const channelMatch = desc.match(/Communication Channel:\s*(#[\w\-]+)/i);
  const finalChannel = channelMatch ? channelMatch[1] : null;
  console.log(`✅ Extracted channel: ${finalChannel}`);

  // On-call: only level 1
  const policy = svc.escalation_policy.id;
  const oncalls = await axios.get(`https://api.pagerduty.com/oncalls`, {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
    params: { escalation_policy_ids: [policy] },
  }).then(r => r.data.oncalls.filter(o => o.escalation_level === 1));

  console.log(`✅ On-calls raw: ${JSON.stringify(oncalls, null, 2)}`);

  const mentions = [];
  for (const oc of oncalls) {
    const pdName = oc.user.summary;
    const guessEmail = `${pdName.split(' ')[0].toLowerCase()}.${pdName.split(' ')[1].toLowerCase()}@paramount.com`;
    try {
      const u = await client.users.lookupByEmail({ email: guessEmail });
      mentions.push(`<@${u.user.id}>`);
    } catch {
      mentions.push(`_${pdName}_`);
    }
  }

  const finalOnCalls = mentions.length ? mentions.join(', ') : '_No on-calls found_';
  console.log(`✅ Slack on-call mentions: ${finalOnCalls}`);

  lastEscalationContext = { userId, serviceName, urgency, summary, finalOnCalls };

  if (finalChannel) {
    await client.chat.postMessage({
      channel: finalChannel,
      text: `:rotating_light: *Escalation*\n• Reporter: <@${userId}>\n• Service: ${serviceName}\n• Urgency: ${urgency}\n• Summary: ${summary}\n• On-call: ${finalOnCalls}`,
    });
  } else {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'manual_channel',
        title: { type: 'plain_text', text: 'Set Channel' },
        submit: { type: 'plain_text', text: 'Post' },
        blocks: [
          {
            type: 'input',
            block_id: 'channel_block',
            label: { type: 'plain_text', text: 'No channel found — enter #channel' },
            element: { type: 'plain_text_input', action_id: 'channel_input' },
          },
        ],
      },
    });
  }
});

// Fallback post
app.view('manual_channel', async ({ ack, view, client }) => {
  await ack();
  const manual = view.state.values.channel_block.channel_input.value;
  const { userId, serviceName, urgency, summary, finalOnCalls } = lastEscalationContext;

  await client.chat.postMessage({
    channel: manual,
    text: `:rotating_light: *Escalation*\n• Reporter: <@${userId}>\n• Service: ${serviceName}\n• Urgency: ${urgency}\n• Summary: ${summary}\n• On-call: ${finalOnCalls}`,
  });
});

// Start
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation running with robust channel + on-call on ${port}`);
})();
