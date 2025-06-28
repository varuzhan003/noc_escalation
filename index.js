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

// Slash command → open modal
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
  } catch (err) {
    console.error('❌ Modal open error:', err);
  }
});

// External select → options loader
app.options({ action_id: 'service_input' }, async ({ options, ack, logger }) => {
  const searchTerm = options.value || '';
  console.log(`🔍 options() called: "${searchTerm}"`);

  if (searchTerm.toLowerCase() === 'test') {
    return ack({
      options: [
        {
          text: { type: 'plain_text', text: 'STATIC TEST' },
          value: 'static-id',
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
      params: {
        query: searchTerm,
        limit: 25,
      },
    });

    const services = response.data.services || [];
    console.log(`✅ PD returned ${services.length} services`);

    const formatted = services.map(s => ({
      text: { type: 'plain_text', text: s.name },
      value: `${s.id}::${s.escalation_policy?.id || ''}`,
    }));

    await ack({ options: formatted });

  } catch (err) {
    console.error('❌ PD options error:', err);
    await ack({ options: [] });
  }
});

// Modal submit → handle escalation
app.view('escalate_modal', async ({ ack, view, body, client, logger }) => {
  await ack();
  console.log('✅ Modal submitted');

  const userId = body.user.id;
  const summary = view.state.values.summary_block.summary_input.value;
  const urgency = view.state.values.urgency_block.urgency_input.selected_option.text.text;

  const serviceRaw = view.state.values.service_block.service_input.selected_option?.text.text || 'N/A';
  const serviceMeta = view.state.values.service_block.service_input.selected_option?.value || '';
  const [serviceId, escalationPolicyId] = serviceMeta.split('::');

  console.log(`✅ Final: Service: ${serviceRaw}`);
  console.log(`✅ Final: Escalation policy: ${escalationPolicyId}`);

  let onCallTag = '_No current On-call_';

  try {
    const oncallRes = await axios.get('https://api.pagerduty.com/oncalls', {
      headers: {
        Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
      params: {
        escalation_policy_ids: [escalationPolicyId],
      },
    });

    const oncalls = oncallRes.data.oncalls || [];
    const realOncall = oncalls.find(oc => oc.schedule);
    console.log(`✅ Final: Real On-call: ${JSON.stringify(realOncall, null, 2)}`);

    if (realOncall && realOncall.user?.summary) {
      const name = realOncall.user.summary;
      console.log(`✅ Final: On-call name: ${name}`);

      const slackUsers = await client.users.list();
      const match = slackUsers.members.find(u => u.real_name && u.real_name.toLowerCase() === name.toLowerCase());

      if (match) {
        onCallTag = `<@${match.id}>`;
        console.log(`✅ Final: Slack user match: ${match.real_name} (${match.id})`);
      } else {
        console.log(`❌ No match found for on-call name.`);
      }
    }

  } catch (err) {
    console.error('❌ Final on-call fallback error:', err);
  }

  const msg = `*🚨 Escalation*\n• Reporter: <@${userId}>\n• Service: ${serviceRaw}\n• Urgency: ${urgency}\n• Summary: ${summary}\n• On-call: ${onCallTag}`;

  await client.chat.postMessage({
    channel: '#noc-escalation-test',
    text: msg,
  });

  console.log('✅ Final escalation sent with on-call');
});

// Start server
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ noc_escalation running with NAME MATCH on port ${port}`);
})();
