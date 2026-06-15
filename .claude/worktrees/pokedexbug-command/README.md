# Pokedex

A Discord bot that uses AI to automatically classify, prioritize, and organize user-reported issues for engineering teams.

When users report issues via @mentions or emoji reactions, Pokedex uses [OpenRouter](https://openrouter.ai) to analyze the report, assign a priority and category, and post a clean embed to a dedicated triage channel — so engineers see a sorted, organized feed instead of scattered messages.

## Features

- **@mention to report** — Tag the bot with a description of the problem
- **Emoji reactions** — React with a configurable emoji (default: bug) on any message to flag it
- **AI classification** — Assigns priority (critical/high/medium/low) and category (bug/feature request/performance/etc.)
- **Follow-up questions** — Asks for more details when a report is vague
- **Triage channel** — Posts color-coded embeds to a dedicated channel for engineers
- **Scheduled digests** — Optional daily/weekly summary of all issues grouped by priority
- **Fully configurable** — Change model, channels, emoji, and more via `/config` slash commands
- **Two-layer config** — Defaults from `config.json`, runtime overrides via Discord slash commands stored in Firestore

## Setup

### Prerequisites

- Node.js 18+
- A [Discord bot application](https://discord.com/developers/applications)
- A [Firebase project](https://console.firebase.google.com) with Firestore enabled
- An [OpenRouter API key](https://openrouter.ai/keys)

### 1. Clone and install

```bash
git clone https://github.com/guirguispierre/pokedex.git
cd pokedex
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in your `.env`:

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `DISCORD_APP_ID` | Application ID from Discord Developer Portal |
| `DISCORD_GUILD_ID` | Server ID (right-click server > Copy Server ID) |
| `OPENROUTER_API_KEY` | API key from OpenRouter |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Service account email from Firebase |
| `FIREBASE_PRIVATE_KEY` | Private key from Firebase service account JSON |

### 3. Discord Developer Portal

- Go to your bot's settings > **Bot** tab
- Enable **Message Content Intent**
- Enable **Server Members Intent**

### 4. Invite the bot

Replace `YOUR_APP_ID` with your Application ID:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&permissions=274877975552&scope=bot%20applications.commands
```

### 5. Create triage channel

Create a channel called `#eng-triage` in your Discord server (or configure a different name in `config.json`).

### 6. Start

```bash
npm start
```

## Usage

### Reporting issues

- **@mention** the bot: `@Pokedex the login page is broken`
- **React** with the configured emoji on any message

### Commands

| Command | Description |
|---------|-------------|
| `/help` | Show usage guide |
| `/config list` | View all settings |
| `/config set <key> <value>` | Change a setting (admin only) |
| `/config get <key>` | View a specific setting |
| `/config reset <key>` | Reset to default (admin only) |

### Configuration

All settings can be changed via `/config set` or by editing `config.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `model` | `anthropic/claude-sonnet-4` | OpenRouter model ID |
| `triage_channel` | `eng-triage` | Channel for issue embeds |
| `emoji_trigger` | bug emoji | Reaction emoji trigger |
| `output_mode` | `embed` | `embed`, `summary`, or `both` |
| `acknowledge` | `true` | Reply to the reporter |
| `summary_interval` | `daily` | Digest frequency (`daily`/`weekly`) |
| `priorities` | `critical,high,medium,low` | Priority levels |
| `categories` | `bug,feature_request,ux_issue,performance,security,other` | Issue categories |

### Customizing the AI prompt

The system prompt in `src/services/openrouter.js` (`buildSystemPrompt`) contains platform-specific context. Update it to describe **your** product, common issues, and priority guidelines.

## Architecture

```
User @mentions bot or reacts with emoji
  -> Bot extracts message text
  -> Queued for sequential processing (max 50)
  -> Sent to OpenRouter for AI classification
  -> Stored in Firebase Firestore
  -> Posted as embed to triage channel
  -> (Optional) Reply to reporter with classification
```

### Project structure

```
src/
  index.js              Entry point, event listeners
  config/config.js      Two-layer config (file + Firestore)
  services/
    openrouter.js       AI classification via OpenRouter
    firestore.js        Issue and config storage
    triage.js           Embed building, digest scheduling
    pipeline.js         Shared classify/store/post pipeline
    queue.js            Rate-limited sequential queue
  triggers/
    mention.js          @mention handler
    reaction.js         Emoji reaction handler
  commands/
    config.js           /config slash command
    help.js             /help slash command
```

## License

MIT
