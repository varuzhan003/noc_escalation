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

// Slash command opens modal
app.command('/noc_escalation', async ({ ack, body, client }) => {
  console.log('✅ Slash command received');
  await ack();

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildModal('', '', ''),
    });
  } catch (err) {
    console.error('❌ Modal open error:', err);
  }
});

// Build modal blocks
function buildModal(onCallTag, serviceId, serviceName) {
  const blocks = [
    {
      type: 'input',
      block_id: 'service_block',
      label: { type: 'plain_text', text: 'Service' },
      element: {
        type: 'external_select',
        action_id: 'service_input',
        placeholder: { type: 'plain_text', text: 'Search services...' },
        min_query_length: 2,
      },
    },
  ];

  if (onCallTag) {
    blocks.push({
      type: 'context',
      block_id: 'oncall_block',
      elements: [
        {
          type: 'mrkdwn',
          text: `*Current On-call:* ${onCallTag}`,
        },
      ],
    });
  }

  blocks.push(
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
    {
      type: 'input',
      block_id: 'summary_block',
      label: { type: 'plain_text', text: 'Summary' },
      element: {
        type: 'plain_text_input',
        action_id: 'summary_input',
      },
    }
  );

  return {
    type: 'modal',
    callback_id: 'escalate_modal',
    title: { type: 'plain_text', text: 'NOC Escalation' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
    private_metadata: JSON.stringify({ serviceId, onCallTag, serviceName }),
  };
}

// External select options handler
app.options({ action_id: 'service_input' }, async ({ options, ack }) => {
  const searchTerm = options.value || '';
  console.log(`🔍 options() called. Search term: "${searchTerm}"`);

  if (searchTerm.toLowerCase() === 'test') {
    return ack({
      options: [
        {
          text: { type: 'plain_text', text: 'STATIC TEST SERVICE' },
          value: 'static-test-id',
        },
      ],
    });
  }

  try {
    const response = await axios.get('https://api.pagerduty.com/services', {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
      params: { query: searchTerm, limit: 25 },
    });

    const services = response.data.services || [];
    console.log(`✅ PagerDuty returned ${services.length} services`);

    const formatted = services.map((s) => ({
      text: { type: 'plain_text', text: s.name },
      value: s.id,
    }));

    await ack({ options: formatted });
  } catch (err) {
    console.error('❌ Error fetching PD services:', err);
    await ack({ options: [] });
  }
});

// Block action: when Service is picked
app.action('service_input', async ({ body, ack, client, action }) => {
  await ack();
  console.log(`🔁 Service selected: ${action.selected_option.value}`);

  const serviceId = action.selected_option.value;
  const serviceName = action.selected_option.text.text;
  let onCallTag = '_No current On-call_';

  try {
    const svc = await axios.get(`https://api.pagerduty.com/services/${serviceId}`, {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
    });

    const escalationPolicyId = svc.data.service.escalation_policy?.id;
    console.log('🔍 Escalation Policy ID:', escalationPolicyId);

    if (escalationPolicyId) {
      const ocResp = await axios.get('https://api.pagerduty.com/oncalls', {
        headers: {
          Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
          Accept: 'application/vnd.pagerduty+json;version=2',
        },
        params: {
          escalation_policy_ids: escalationPolicyId,
        },
      });

      console.log('🔍 Raw oncalls:', JSON.stringify(ocResp.data.oncalls, null, 2));

      const onCallUser = ocResp.data.oncalls[0]?.user;
      console.log('🔍 On-call user object:', onCallUser);

      let email = onCallUser?.email;
      console.log('🔍 On-call user email (direct):', email);

      if (!email && onCallUser?.id) {
        console.log(`🔍 Fallback: GET /users/${onCallUser.id}`);
        const userResp = await axios.get(`https://api.pagerduty.com/users/${onCallUser.id}`, {
          headers: {
            Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
            Accept: 'application/vnd.pagerduty+json;version=2',
          },
        });
        email = userResp.data.user?.email;
        console.log('🔍 Fallback email:', email);
      }

      if (email) {
        const slackUser = await client.users.lookupByEmail({ email });
        console.log('🔍 Slack lookup:', slackUser);
        if (slackUser.ok && slackUser.user.id) {
          onCallTag = `<@${slackUser.user.id}>`;
        }
      }
    }
  } catch (err) {
    console.error('❌ Error getting on-call:', err);
  }

  console.log(`✅ On-call tag: ${onCallTag}`);

  await client.views.update({
    view_id: body.view.id,
    view: buildModal(onCallTag, serviceId, serviceName),
  });
});

// Final submit handler
app.view('escalate_modal', async ({ ack, view, body, client }) => {
  await ack();
  console.log('✅ Modal submitted');

  const userId = body.user.id;
  const summary = view.state.values.summary_block.summary_input.value;
  const urgency = view.state.values.urgency_block.urgency_input.selected_option?.text.text || 'N/A';

  let serviceName = view.state.values.service_block.service_input.selected_option?.text.text || 'N/A';

  let onCallTag = '_No current On-call_';
  try {
    const meta = JSON.parse(view.private_metadata);
    if (meta && meta.onCallTag) {
      onCallTag = meta.onCallTag;
    }
    if (meta && meta.serviceName) {
      serviceName = meta.serviceName;
    }
  } catch (err) {
    console.error('❌ Error reading metadata:', err);
  }

  const result = await client.users.info({ user: userId });
  const reporter = result.user.profile.display_name || result.user.real_name || `<@${userId}>`;

  const msg = `*🚨 Escalation*\n• *Reporter:* ${reporter}\n• *Service:* ${serviceName}\n• *Urgency:* ${urgency}\n• *Summary:* ${summary}\n• *On-call:* ${onCallTag}`;

  await client.chat.postMessage({
    channel: '#noc-escalation-test',
    text: msg,
  });

  console.log('✅ Escalation posted with on-call');
});

// Start
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation FINAL running on ${port}`);
})();
