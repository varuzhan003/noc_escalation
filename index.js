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

// Slash command opens the modal
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

// Dynamic service search
app.options({ action_id: 'service_input' }, async ({ options, ack }) => {
  const search = options.value || '';
  console.log(`🔍 options() called: "${search}"`);
  const response = await axios.get('https://api.pagerduty.com/services', {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
    params: { query: search, limit: 25 },
  });

  const services = response.data.services.map((s) => ({
    text: { type: 'plain_text', text: s.name },
    value: `${s.id}|${s.name}`,
  }));

  console.log(`✅ PD returned ${services.length} services`);
  await ack({ options: services });
});

// On submit
app.view('escalate_modal', async ({ ack, view, body, client }) => {
  await ack();
  const userId = body.user.id;

  const [serviceId, serviceName] =
    view.state.values.service_block.service_input.selected_option?.value.split('|') || [];
  const summary = view.state.values.summary_block.summary_input.value;
  const urgency = view.state.values.urgency_block.urgency_input.selected_option.text.text;

  console.log(`✅ Final: Service ID: ${serviceId}`);
  console.log(`✅ Final: Service Name: ${serviceName}`);

  let channel = null;

  // 1) Try to extract channel from service description
  const service = await axios.get(`https://api.pagerduty.com/services/${serviceId}`, {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
  });

  const desc = service.data.service.description || '';
  console.log(`✅ Service description: ${desc}`);
  const match = desc.match(/Communication Channel:\s*(#\S+)/i);
  if (match) {
    channel = match[1].trim();
  }
  console.log(`✅ Extracted channel: ${channel}`);

  // 2) Get escalation policy & first-level on-calls
  const escalationPolicyId = service.data.service.escalation_policy?.id;
  const oncallsRes = await axios.get(`https://api.pagerduty.com/oncalls`, {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
    params: {
      escalation_policy_ids: [escalationPolicyId],
    },
  });

  const rawOncalls = oncallsRes.data.oncalls.filter((o) => o.escalation_level === 1);
  console.log(`✅ On-calls raw: ${JSON.stringify(rawOncalls, null, 2)}`);

  const mentions = [];
  for (const oc of rawOncalls) {
    const pdName = oc.user.summary;
    const email = `${pdName.toLowerCase().replace(/ /g, '.')}@paramount.com`;
    try {
      const slackUser = await client.users.lookupByEmail({ email });
      mentions.push(`<@${slackUser.user.id}>`);
    } catch (err) {
      mentions.push(`_${pdName}_`);
    }
  }
  const oncallMentions = mentions.join(', ');
  console.log(`✅ Slack on-call mentions: ${oncallMentions}`);

  // 3) If no channel, ask user
  if (!channel) {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'fallback_channel',
        title: { type: 'plain_text', text: 'No Channel Found' },
        submit: { type: 'plain_text', text: 'Send' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'fallback_channel_block',
            label: { type: 'plain_text', text: 'Select Slack channel:' },
            element: {
              type: 'conversations_select',
              action_id: 'channel_select',
              default_to_current_conversation: false,
            },
          },
        ],
      },
    });

    receiver.router.post('/manual_escalation', async (req, res) => {
      const channelId = req.body.payload.view.state.values.fallback_channel_block.channel_select.selected_conversation;
      await client.chat.postMessage({
        channel: channelId,
        text: `:rotating_light: *Escalation*\n• Reporter: <@${userId}>\n• Service: ${serviceName}\n• Urgency: ${urgency}\n• Summary: ${summary}\n• On-call: ${oncallMentions}`,
      });
      res.send('');
    });

    return;
  }

  // 4) Post in channel if found
  await client.chat.postMessage({
    channel,
    text: `:rotating_light: *Escalation*\n• Reporter: <@${userId}>\n• Service: ${serviceName}\n• Urgency: ${urgency}\n• Summary: ${summary}\n• On-call: ${oncallMentions}`,
  });

  console.log(`✅ Posted escalation to ${channel}`);
});

// Start
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation running with final robust logic on ${port}`);
})();
