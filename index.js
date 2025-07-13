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

async function getDatadogDashboardUrl(serviceName) {
  try {
    const dashboards = await axios.get(
      'https://api.datadoghq.com/api/v1/dashboard',
      {
        headers: {
          'DD-API-KEY': process.env.DATADOG_API_KEY,
          'DD-APPLICATION-KEY': process.env.DATADOG_APP_KEY,
        },
      }
    );

    const match = dashboards.data.dashboards.find((d) =>
      d.title.toLowerCase().includes(serviceName.toLowerCase())
    );

    if (match) {
      return `https://app.datadoghq.com${match.url}`;
    }
  } catch (err) {
    console.log(`❌ Error fetching Datadog dashboards: ${err.message}`);
  }
  return 'No dashboard found.';
}

function getDatadogErrorLogsUrl(serviceName) {
  const encodedQuery = encodeURIComponent(`service:${serviceName} status:error`);
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  return `https://app.datadoghq.com/logs?query=${encodedQuery}&from_ts=${oneHourAgo}&to_ts=${now}&live=true`;
}

app.command('/noc_escalation', async ({ ack, body, client }) => {
  await ack();
  console.log('✅ Slash command received');

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'escalate_modal',
      private_metadata: body.user_id,
      title: { type: 'plain_text', text: 'NOC Escalation' },
      submit: { type: 'plain_text', text: 'Send' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'service_block',
          label: { type: 'plain_text', text: 'Service Name' },
          element: {
            type: 'external_select',
            action_id: 'service_input',
            placeholder: { type: 'plain_text', text: 'Start typing to search...' },
            min_query_length: 2,
          },
        },
        {
          type: 'input',
          block_id: 'channel_block',
          label: { type: 'plain_text', text: 'Escalation Channel' },
          element: {
            type: 'external_select',
            action_id: 'channel_input',
            placeholder: { type: 'plain_text', text: 'Start typing to search...' },
            min_query_length: 3,
          },
        },
        {
          type: 'input',
          block_id: 'summary_block',
          label: { type: 'plain_text', text: 'Incident Summary' },
          element: {
            type: 'plain_text_input',
            action_id: 'summary_input',
            multiline: true,
            placeholder: { type: 'plain_text', text: 'E.g. Alerts firing, API 5xx spike, etc.' },
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'If the channel doesn\'t show up, make sure you\'re a member. For private channels, also invite `@noc_escalation`.',
            },
          ],
        },
      ],
    },
  });
});

app.options({ action_id: 'service_input' }, async ({ options, ack }) => {
  const search = options.value || '';
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

  await ack({ options: formatted });
});

app.options({ action_id: 'channel_input' }, async ({ options, body, ack, client }) => {
  const search = (options.value || '').toLowerCase();
  const reporterId = body.view.private_metadata;

  if (search.length < 3) return ack({ options: [] });

  let userChannels = userChannelCache.get(reporterId);

  if (!userChannels) {
    const userConvos = await client.users.conversations({
      user: reporterId,
      types: 'public_channel,private_channel',
      limit: 1000,
    });
    userChannels = userConvos.channels.map((c) => ({ id: c.id, name: c.name }));
    userChannelCache.set(reporterId, userChannels);
    setTimeout(() => userChannelCache.delete(reporterId), 5 * 60 * 1000);
  }

  const filtered = userChannels
    .filter((c) => c.name.includes(search))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 100)
    .map((c) => ({
      text: { type: 'plain_text', text: `#${c.name}` },
      value: c.id,
    }));

  await ack({ options: filtered });
});

app.view('escalate_modal', async ({ ack, view, body, client }) => {
  await ack();

  const userId = body.user.id;
  const selected = view.state.values.service_block.service_input.selected_option.value;
  const [serviceId, serviceName] = selected.split(':::');
  const channelId = view.state.values.channel_block.channel_input.selected_option.value;
  const summary = view.state.values.summary_block.summary_input.value;

  const dashboardLink = await getDatadogDashboardUrl(serviceName);
  const errorLogsLink = getDatadogErrorLogsUrl(serviceName);

  const serviceRes = await axios.get(`https://api.pagerduty.com/services/${serviceId}`, {
    headers: {
      Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
      Accept: 'application/vnd.pagerduty+json;version=2',
    },
  });
  const escalationPolicyId = serviceRes.data.service.escalation_policy?.id;

  let oncallTags = [];

  if (escalationPolicyId) {
    const oncalls = await axios.get('https://api.pagerduty.com/oncalls', {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
      params: { escalation_policy_ids: [escalationPolicyId] },
    });

    for (const oncall of oncalls.data.oncalls) {
      if (!oncall.user || oncall.escalation_level !== 1) continue;

      const pdUserId = oncall.user.id;
      try {
        const pdUser = await axios.get(`https://api.pagerduty.com/users/${pdUserId}`, {
          headers: {
            Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
            Accept: 'application/vnd.pagerduty+json;version=2',
          },
        });

        const realEmail = pdUser.data.user.email;
        try {
          const slackUser = await client.users.lookupByEmail({ email: realEmail });
          oncallTags.push(`<@${slackUser.user.id}>`);
        } catch {
          console.log(`❌ Slack user not found for ${realEmail}`);
        }
      } catch (err) {
        console.log(`❌ Failed to fetch PD user ${pdUserId}`, err);
      }
    }
  }

  const oncallText = oncallTags.length > 0 ? oncallTags.join(' ') : 'No current On-call';

  const message = `:rotating_light: *Escalation Initiated!*
• *Reporter:* <@${userId}>
• *Service:* ${serviceName}
• *Summary:* ${summary}
• *Service Dashboard:* ${dashboardLink}
• *Service Error Logs (Last 1h):* ${errorLogsLink}
• *On-call:* ${oncallText}`;

  await client.chat.postMessage({ channel: channelId, text: message });
  console.log('✅ Escalation posted!');
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation bot running on port ${port}`);
})();
