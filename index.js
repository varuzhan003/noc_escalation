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
          element: { type: 'plain_text_input', action_id: 'summary_input' },
        },
        {
          type: 'input',
          block_id: 'urgency_block',
          label: { type: 'plain_text', text: 'Urgency' },
          element: {
            type: 'static_select',
            action_id: 'urgency_input',
            options: ['Low', 'Medium', 'High'].map((lvl) => ({
              text: { type: 'plain_text', text: lvl },
              value: lvl.toLowerCase(),
            })),
          },
        },
      ],
    },
  });
});

// External select
app.options({ action_id: 'service_input' }, async ({ options, ack }) => {
  const searchTerm = options.value || '';
  console.log(`🔍 options() called: "${searchTerm}"`);

  const response = await axios.get('https://api.pagerduty.com/services', {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
    params: {
      query: searchTerm,
      limit: 25,
    },
  });

  const services = response.data.services || [];
  console.log(`✅ PD returned ${services.length} services`);

  const opts = services.map((s) => ({
    text: { type: 'plain_text', text: s.name },
    value: s.id,
  }));

  await ack({ options: opts });
});

// Modal submission
app.view('escalate_modal', async ({ ack, view, body, client }) => {
  await ack();
  console.log('✅ Modal submitted');

  const userId = body.user.id;
  const serviceId = view.state.values.service_block.service_input.selected_option?.value;
  const serviceName = view.state.values.service_block.service_input.selected_option?.text.text;
  const summary = view.state.values.summary_block.summary_input.value;
  const urgency = view.state.values.urgency_block.urgency_input.selected_option.text.text;

  console.log(`✅ Final: Service ID: ${serviceId}`);
  console.log(`✅ Final: Service Name: ${serviceName}`);

  const svc = await axios.get(`https://api.pagerduty.com/services/${serviceId}`, {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
  });

  const svcDesc = svc.data.service.description || '';
  console.log(`✅ Service description: ${svcDesc}`);

  // Try to extract any #channel from description
  const channelMatch = svcDesc.match(/#[\w\-]+/);
  const extractedChannel = channelMatch ? channelMatch[0] : null;
  console.log(`✅ Extracted channel: ${extractedChannel}`);

  // Get escalation policy ID
  const epId = svc.data.service.escalation_policy.id;
  console.log(`✅ Final: Escalation policy: ${epId}`);

  // Get current on-calls level 1
  const oncallResp = await axios.get('https://api.pagerduty.com/oncalls', {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
    params: {
      escalation_policy_ids: [epId],
    },
  });

  const levelOne = oncallResp.data.oncalls.filter((o) => o.escalation_level === 1);
  console.log(`✅ On-calls raw:`, levelOne);

  const mentionPromises = levelOne.map(async (o) => {
    const emailGuess = `${o.user.summary.split(' ').join('.').toLowerCase()}@pluto.tv`;
    const fallbackEmail = emailGuess.replace('@pluto.tv', '@paramount.com');
    try {
      const slackUser = await client.users.lookupByEmail({ email: emailGuess });
      return `<@${slackUser.user.id}>`;
    } catch {
      try {
        const slackUser = await client.users.lookupByEmail({ email: fallbackEmail });
        return `<@${slackUser.user.id}>`;
      } catch {
        return `_${o.user.summary}_`;
      }
    }
  });

  const mentions = await Promise.all(mentionPromises);
  console.log(`✅ Slack on-call mentions: ${mentions}`);

  let finalChannel = extractedChannel;

  if (!finalChannel) {
    console.log(`❌ No channel → open fallback modal`);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'fallback_channel_modal',
        title: { type: 'plain_text', text: 'No Channel' },
        submit: { type: 'plain_text', text: 'Send' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'channel_block',
            label: { type: 'plain_text', text: 'Channel to Post To' },
            element: {
              type: 'plain_text_input',
              action_id: 'channel_input',
              placeholder: { type: 'plain_text', text: '#noc-escalation-test' },
            },
          },
        ],
      },
    });
    return;
  }

  await client.chat.postMessage({
    channel: finalChannel,
    text: `:rotating_light: *Escalation*
• Reporter: <@${userId}>
• Service: ${serviceName}
• Urgency: ${urgency}
• Summary: ${summary}
• On-call: ${mentions.join(', ')}`,
  });

  console.log(`✅ Posted escalation to ${finalChannel}`);
});

// Fallback
app.view('fallback_channel_modal', async ({ ack, view, body, client }) => {
  await ack();

  const userId = body.user.id;
  const manualChannel = view.state.values.channel_block.channel_input.value;

  await client.chat.postMessage({
    channel: manualChannel,
    text: `:rotating_light: *Escalation*
• Reporter: <@${userId}>
• Channel: ${manualChannel}`,
  });

  console.log(`✅ Posted fallback to ${manualChannel}`);
});

// Start
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation running with robust channel + on-call tagging on ${port}`);
})();
