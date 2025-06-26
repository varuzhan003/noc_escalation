
# noc_escalation

A Slack app that lets Pluto TV's NOC team escalate incidents via the `/escalate` command.

## 🚀 Deploy to Render

1. Go to https://render.com and create a free account
2. Click "New Web Service"
3. Choose "Manual deploy"
4. Upload this folder's contents
5. Set these environment variables:
   - SLACK_SIGNING_SECRET
   - SLACK_BOT_TOKEN
6. Use `node index.js` as the start command
7. Use the public URL in your Slack app slash command settings

## ✅ Slack Setup

- Add a slash command `/escalate`
- Set its Request URL to: `https://your-render-url.com`

Enjoy faster, easier NOC escalations!
