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

const userChannelCache = new Map();

// Slash command → open modal
app.command('/noc_escalation', async ({ ack, body, client }) => {
  console.log('✅ Slash command received');
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'escalate_modal',
      private_metadata: body.user_id, // store reporter id
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
          block_id: 'channel_block',
          label: { type: 'plain_text', text: 'Channel to Escalate (your channels)' },
          element: {
            type: 'external_select',
            action_id: 'channel_input',
            placeholder: { type: 'plain_text', text: 'Type 3+ letters...' },
            min_query_length: 3,
          },
          hint: {
            type: 'plain_text',
            text: 'If you don’t see your channel: join it first. For private channels, also `/invite @noc_escalation` there.',
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
      ],
    },
  });
});

// Service options
app.options({ action_id: 'service_input' }, async ({ options, ack }) => {
  const search = options.value || '';
  console.log(`🔍 options() services: "${search}"`);

  const res = await axios.get('https://api.pagerduty.com/services', {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
    params: { query: search, limit: 25 },
  });

  const formatted = res.data.services.map((s) => ({
    text: { type: 'plain_text', text: s.name },
    value: `${s.id}:::${s.name}`,
  }));

  console.log(`✅ PD returned ${formatted.length} services`);
  await ack({ options: formatted });
});

// Channel options — user’s channels only
app.options({ action_id: 'channel_input' }, async ({ options, body, ack, client }) => {
  const search = (options.value || '').toLowerCase();
  const reporterId = body.view.private_metadata;
  console.log(`🔍 options() channels for ${reporterId}: "${search}"`);

  if (search.length < 3) {
    return ack({ options: [] });
  }

  let userChannels = userChannelCache.get(reporterId);

  if (!userChannels) {
    console.log(`⏳ Fetching channels for ${reporterId}`);
    const userConvos = await client.users.conversations({
      user: reporterId,
      types: 'public_channel,private_channel',
      limit: 1000,
    });
    userChannels = userConvos.channels.map((c) => ({
      id: c.id,
      name: c.name,
    }));
    userChannelCache.set(reporterId, userChannels);
    setTimeout(() => userChannelCache.delete(reporterId), 5 * 60 * 1000);
    console.log(`✅ Cached ${userChannels.length} channels`);
  }

  const filtered = userChannels
    .filter((c) => c.name.includes(search))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 100)
    .map((c) => ({
      text: { type: 'plain_text', text: `#${c.name}` },
      value: c.id,
    }));

  console.log(`✅ Channels filtered: ${filtered.length}`);
  await ack({ options: filtered });
});

// Modal submit
app.view('escalate_modal', async ({ ack, view, body, client }) => {
  await ack();
  console.log('✅ Modal submitted');

  const userId = body.user.id;
  const selected = view.state.values.service_block.service_input.selected_option.value;
  const [serviceId, serviceName] = selected.split(':::');
  const channelId = view.state.values.channel_block.channel_input.selected_option.value;
  const summary = view.state.values.summary_block.summary_input.value;

  console.log(`✅ Final: Service ID: ${serviceId}`);
  console.log(`✅ Final: Service Name: ${serviceName}`);
  console.log(`✅ Final: Channel ID: ${channelId}`);

  const serviceRes = await axios.get(`https://api.pagerduty.com/services/${serviceId}`, {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
  });
  const escalationPolicyId = serviceRes.data.service.escalation_policy?.id;
  console.log(`✅ Escalation policy: ${escalationPolicyId}`);

  let oncallTags = [];

  if (escalationPolicyId) {
    const oncalls = await axios.get('https://api.pagerduty.com/oncalls', {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
      params: { escalation_policy_ids: [escalationPolicyId] },
    });

    const levelOneUsers = oncalls.data.oncalls
      .filter((o) => o.user && o.escalation_level === 1)
      .map((o) => o.user.summary)
      .filter((v, i, a) => a.indexOf(v) === i);

    console.log(`✅ Level 1 On-calls:`, levelOneUsers);

    for (const name of levelOneUsers) {
      const pdEmail = `${name.toLowerCase().replace(' ', '.')}@pluto.tv`;
      const altEmail = pdEmail.replace('@pluto.tv', '@paramount.com');
      let slackTag = null;

      try {
        const slackUser = await client.users.lookupByEmail({ email: pdEmail });
        slackTag = `<@${slackUser.user.id}>`;
      } catch {
        try {
          const slackUser2 = await client.users.lookupByEmail({ email: altEmail });
          slackTag = `<@${slackUser2.user.id}>`;
        } catch {
          console.log(`❌ No Slack match for ${name}`);
        }
      }

      if (slackTag) oncallTags.push(slackTag);
    }
  }

  const oncallText = oncallTags.length > 0 ? oncallTags.join(' ') : 'No current On-call';

  const message = `:rotating_light: *Escalation*
• Reporter: <@${userId}>
• Service: ${serviceName}
• Summary: ${summary}
• On-call: ${oncallText}`;

  await client.chat.postMessage({
    channel: channelId,
    text: message,
  });

  console.log('✅ Escalation posted to selected channel');
});

// Start server
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation running on ${port}`);
})();
