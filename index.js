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
      view: buildModal('', ''),
    });
  } catch (err) {
    console.error('❌ Modal open error:', err);
  }
});

// Build modal blocks (takes onCall mention if any)
function buildModal(onCallTag, serviceId) {
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

  // If we have an on-call, add a context block
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

  // Always add urgency + summary
  blocks.push(
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
    private_metadata: JSON.stringify({ serviceId }), // store serviceId for later
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
      value: s.id, // store PD service ID as the option value
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
  let onCallTag = '_No current On-call_';

  try {
    // 1️⃣ Get service details to find escalation policy
    const svc = await axios.get(`https://api.pagerduty.com/services/${serviceId}`, {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
    });

    const escalationPolicyId = svc.data.service.escalation_policy?.id;

    if (escalationPolicyId) {
      // 2️⃣ Get on-calls for this escalation policy
      const ocResp = await axios.get('https://api.pagerduty.com/oncalls', {
        headers: {
          Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
          Accept: 'application/vnd.pagerduty+json;version=2',
        },
        params: {
          escalation_policy_ids: escalationPolicyId,
        },
      });

      const onCallUser = ocResp.data.oncalls[0]?.user;
      const email = onCallUser?.email;

      if (email) {
        // 3️⃣ Lookup Slack ID by email
        const slackUser = await client.users.lookupByEmail({ email });
        if (slackUser.ok && slackUser.user.id) {
          onCallTag = `<@${slackUser.user.id}>`;
        }
      }
    }
  } catch (err) {
    console.error('❌ Error getting on-call:', err);
  }

  console.log(`✅ On-call tag: ${onCallTag}`);

  // Update modal with on-call tag
  await client.views.update({
    view_id: body.view.id,
    view: buildModal(onCallTag, serviceId),
  });
});

// Final submit handler
app.view('escalate_modal', async ({ ack, view, body, client }) => {
  await ack();
  console.log('✅ Modal submitted');

  const userId = body.user.id;
  const summary = view.state.values.summary_block.summary_input.value;
  const urgency = view.state.values.urgency_block.urgency_input.selected_option?.text.text || 'N/A';

  // Service name is selected text
  const serviceName = view.state.values.service_block.service_input.selected_option?.text.text || 'N/A';

  // On-call tag is passed in private metadata
  let onCallTag = '_No current On-call_';
  try {
    const meta = JSON.parse(view.private_metadata);
    const serviceId = meta.serviceId;

    // If needed, re-fetch on-call for final safety
    const svc = await axios.get(`https://api.pagerduty.com/services/${serviceId}`, {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
    });

    const escalationPolicyId = svc.data.service.escalation_policy?.id;

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

      const onCallUser = ocResp.data.oncalls[0]?.user;
      const email = onCallUser?.email;

      if (email) {
        const slackUser = await client.users.lookupByEmail({ email });
        if (slackUser.ok && slackUser.user.id) {
          onCallTag = `<@${slackUser.user.id}>`;
        }
      }
    }
  } catch (err) {
    console.error('❌ On-call fallback error:', err);
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
  console.log(`⚡️ noc_escalation FINAL with on-call running on ${port}`);
})();
