# Pokedex MCP Server

An MCP (Model Context Protocol) server that lets AI agents report bugs and feature requests directly to the Pokedex issue tracker — without needing Discord.

Issues are saved to Firebase Firestore (same database as the Discord bot) and posted to the `#eng-triage` Discord channel via webhook.

## Tools

| Tool | Description |
|------|-------------|
| `pokedex_report_bug` | Report a bug with title, description, priority, category, and optional screenshot |
| `pokedex_suggest_feature` | Submit a feature request |
| `pokedex_check_issue` | Check the status of a reported issue by ID |
| `pokedex_my_issues` | List all issues you've reported |

## Setup

### 1. Install

```bash
cd pokedex-mcp
npm install
npm run build
```

### 2. Environment Variables

Set these in your shell or `.env`:

```
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=your-service-account@your-project-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
DISCORD_GUILD_ID=your-guild-id
```

To create a Discord webhook: Server Settings → Integrations → Webhooks → New Webhook → set the channel to `#eng-triage` → Copy URL.

### 3. Add to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pokedex": {
      "command": "node",
      "args": ["/path/to/pokedex-mcp/dist/index.js"],
      "env": {
        "FIREBASE_PROJECT_ID": "your-project-id",
        "FIREBASE_CLIENT_EMAIL": "your-service-account@your-project-id.iam.gserviceaccount.com",
        "FIREBASE_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\\n...",
        "DISCORD_WEBHOOK_URL": "https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN",
        "DISCORD_GUILD_ID": "your-guild-id"
      }
    }
  }
}
```

### 4. Add to Claude Code

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "pokedex": {
      "command": "node",
      "args": ["/path/to/pokedex-mcp/dist/index.js"],
      "env": {
        "FIREBASE_PROJECT_ID": "your-project-id",
        "FIREBASE_CLIENT_EMAIL": "...",
        "FIREBASE_PRIVATE_KEY": "...",
        "DISCORD_WEBHOOK_URL": "...",
        "DISCORD_GUILD_ID": "..."
      }
    }
  }
}
```

## Usage

Once connected, your AI agent can:

- **"Report a bug: my email sync is broken"** → creates issue, notifies Discord
- **"Check status of issue ABC123"** → returns current status
- **"Show my reported issues"** → lists all your issues
- **"Suggest a feature: dark mode for the mobile app"** → creates feature request

All issues appear on the [Pokedex Dashboard](https://dashboard-vercel-puce.vercel.app) and in Discord `#eng-triage`.
