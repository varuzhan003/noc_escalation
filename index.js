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

app.options({ action_id: 'service_input' }, async ({ options, ack }) => {
  const searchTerm = options.value || '';
  console.log(`🔍 options() called: "${searchTerm}"`);

  const response = await axios.get('https://api.pagerduty.com/services', {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
    params: { query: searchTerm, limit: 25 },
  });

  const services = response.data.services || [];
  console.log(`✅ PD returned ${services.length} services`);

  const formatted = services.map(s => ({
    text: { type: 'plain_text', text: s.name },
    value: s.id,
  }));

  await ack({ options: formatted });
});

app.view('escalate_modal', async ({ ack, view, body, client }) => {
  await ack();
  console.log('✅ Modal submitted');

  const userId = body.user.id;
  const serviceId = view.state.values.service_block.service_input.selected_option.value;
  const serviceName = view.state.values.service_block.service_input.selected_option.text.text;
  const urgency = view.state.values.urgency_block.urgency_input.selected_option.text.text;
  const summary = view.state.values.summary_block.summary_input.value;

  console.log(`✅ Final: Service ID: ${serviceId}`);
  console.log(`✅ Final: Service Name: ${serviceName}`);

  // 🔍 Try to get channel & on-call
  let channelToPost = null;
  let oncallTag = '_No On-call_';

  try {
    const svc = await axios.get(`https://api.pagerduty.com/services/${serviceId}`, {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
    });

    const description = svc.data.service.description || '';
    console.log(`✅ Service description: ${description}`);

    // More robust regex
    const channelMatch = description.match(/Communication Channel:?[\s\n]+(#[\w\-_]+)/i);
    channelToPost = channelMatch ? channelMatch[1].trim() : null;

    console.log(`✅ Extracted channel: ${channelToPost}`);

    // Get on-call same as before
    const escalationId = svc.data.service.escalation_policy.id;
    const oncalls = await axios.get('https://api.pagerduty.com/oncalls', {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
      params: { escalation_policy_ids: [escalationId] },
    });

    const level1s = oncalls.data.oncalls.filter(o => o.escalation_level === 1);
    const names = level1s.map(o => o.user.summary);
    oncallTag = names.length ? names.map(n => `_${n}_`).join(', ') : '_No On-call_';

    console.log(`✅ On-calls: ${oncallTag}`);

  } catch (err) {
    console.error('❌ PD details error:', err);
  }

  if (!channelToPost) {
    console.log('❌ No channel → open fallback modal');
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'fallback_channel_modal',
        title: { type: 'plain_text', text: 'Provide Channel' },
        submit: { type: 'plain_text', text: 'Send' },
        close: { type: 'plain_text', text: 'Cancel' },
        private_metadata: JSON.stringify({ serviceName, urgency, summary, oncallTag }),
        blocks: [
          {
            type: 'input',
            block_id: 'channel_block',
            label: { type: 'plain_text', text: 'Slack channel name (#channel)' },
            element: {
              type: 'plain_text_input',
              action_id: 'channel_input',
            },
          },
        ],
      },
    });
    return;
  }

  await client.chat.postMessage({
    channel: channelToPost,
    text: `:rotating_light: *Escalation*
• Reporter: <@${userId}>
• Service: ${serviceName}
• Urgency: ${urgency}
• Summary: ${summary}
• On-call: ${oncallTag}`,
  });

  console.log(`✅ Posted to ${channelToPost}`);
});

app.view('fallback_channel_modal', async ({ ack, view, body, client }) => {
  await ack();

  const userId = body.user.id;
  const channelName = view.state.values.channel_block.channel_input.value;
  const meta = JSON.parse(view.private_metadata);

  await client.chat.postMessage({
    channel: channelName,
    text: `:rotating_light: *Escalation*
• Reporter: <@${userId}>
• Service: ${meta.serviceName}
• Urgency: ${meta.urgency}
• Summary: ${meta.summary}
• On-call: ${meta.oncallTag}`,
  });

  console.log(`✅ Posted fallback to ${channelName}`);
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation running with robust channel + on-call on ${port}`);
})();
