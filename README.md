# Pokedex

A multipurpose Discord bot built around AI-powered issue triage, with moderation, leveling, and community features layered on top. Users report problems via `@mention`, emoji reactions, or forum posts; Pokedex classifies, deduplicates, and routes them to a triage channel so engineers see a clean, prioritized feed instead of scattered messages.

Built with discord.js 14, Express 5, Firebase/Firestore, and [OpenRouter](https://openrouter.ai) for AI classification. CommonJS, Node.js 18+.

## Features

### Issue triage
- **Multi-source capture** — `@mention`, 🐛/💡 reactions, new forum threads, or the `/pokedexbug` command
- **AI classification** — Priority (critical/high/medium/low) and category (bug/feature request/performance/security/etc.) via OpenRouter
- **Duplicate detection** — Jaccard similarity against recent issues before creating a new one
- **Thread context** — Follow-up messages in tracked threads append to the originating issue
- **Sequential queue** — Max 50 concurrent, processed one at a time to respect API limits
- **Triage embeds** — Color-coded by priority, posted to a dedicated channel
- **Scheduled digests** — Optional daily/weekly summaries grouped by priority
- **Issue management** — `/issue` to list, view, close, reopen, assign, note, or merge; `/merge` preserves full context across merged issues
- **Feedback triage** — Convert forum feedback posts into issues with `/feedbacktriage`

### Moderation
- **AutoMod** — Spam (rate/duplicate/mention), raid (join velocity), and content filters (caps, invites, blocklist) with escalating timeouts
- **Manual tools** — `/ban`, `/kick`, `/mute`, `/unmute`, `/warn`, `/purge`, `/lock`, `/unlock`, `/slowmode`, `/deletethread`
- **Infraction log** — Warnings persisted per user with reason and moderator

### Community & engagement
- **Leveling** — XP per message with cooldown; `/level`, `/leaderboard`
- **AFK** — `/afk` sets status; mentions auto-reply with the AFK message
- **Giveaways** — `/giveaway` with configurable winners and reroll
- **Polls** — `/poll` with auto-close and results tally
- **Reaction roles** — `/reactionrole` to wire up self-assign menus
- **Starboard** — Configurable channel and star threshold
- **Suggestions** — `/suggest` with status tracking (pending/approved/denied/considering/implemented)

### Content
- **Recipes** — `/recipes` browses the community recipe collection; `autoscrape` can auto-ingest new posts from `#show-and-tell`

### Dashboard
- Express REST API at `/api/issues`, `/api/stats`, and `/api/recipes`
- Auth via `X-API-Key` header (constant-time compare) with a localhost bypass for development
- Rate limited to 60 req/min per IP
- Static frontend in `src/dashboard/public/` (`index.html`, `recipes.html`)

### Configuration
- **Two-layer config** — Defaults from `config.json`, runtime overrides in Firestore via `/config set`

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

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | yes | Bot token from Discord Developer Portal |
| `DISCORD_APP_ID` | yes | Application ID |
| `DISCORD_GUILD_ID` | yes | Server ID (right-click server → Copy Server ID) |
| `OPENROUTER_API_KEY` | yes | OpenRouter API key |
| `FIREBASE_PROJECT_ID` | yes | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | yes | Service account email |
| `FIREBASE_PRIVATE_KEY` | yes | Private key from Firebase service account JSON |
| `DASHBOARD_API_KEY` | no | API key for dashboard endpoints; omit to allow localhost only |
| `DASHBOARD_PORT` | no | Dashboard port (default `3000`) |

### 3. Discord Developer Portal

In your bot's **Bot** tab, enable:
- **Message Content Intent**
- **Server Members Intent**

### 4. Invite the bot

Replace `YOUR_APP_ID` with your Application ID:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&permissions=274877975552&scope=bot%20applications.commands
```

### 5. Create a triage channel

Create `#eng-triage` (or set a different name via `/config set triage_channel <name>`).

### 6. Run

```bash
npm start        # start the bot
npm test         # run the vitest suite
```

## Commands

Use `/help` in Discord for the live, grouped list. A summary:

| Category | Commands |
|----------|----------|
| Issues | `/issue`, `/merge`, `/pokedexbug`, `/feedback`, `/feedbacktriage`, `/leaderboard` |
| Moderation | `/automod`, `/ban`, `/kick`, `/mute`, `/unmute`, `/warn`, `/purge`, `/lock`, `/unlock`, `/slowmode`, `/deletethread` |
| Community | `/level`, `/afk`, `/giveaway`, `/poll`, `/reactionrole`, `/starboard`, `/suggest` |
| Content | `/recipes` |
| Admin | `/config`, `/autoscrape` |
| Meta | `/help`, `/ping`, `/serverinfo`, `/changelog` |

## Configuration

Edit `config.json` or use `/config set <key> <value>`. Firestore overrides win.

| Key | Default | Description |
|-----|---------|-------------|
| `model` | `anthropic/claude-sonnet-4` | OpenRouter model ID |
| `triage_channel` | `eng-triage` | Channel for issue embeds |
| `emoji_trigger` | 🐛 | Reaction that flags a message as a bug |
| `suggestion_emoji` | 💡 | Reaction that flags a message as a suggestion |
| `output_mode` | `embed` | `embed`, `summary`, or `both` |
| `acknowledge` | `true` | Reply to the reporter with the classification |
| `summary_interval` | `daily` | Digest frequency (`daily` / `weekly`) |
| `priorities` | `critical,high,medium,low` | Priority levels |
| `categories` | `bug,feature_request,ux_issue,performance,security,suggestion,other` | Issue categories |
| `level_announce` | `true` | Announce level-ups in chat |
| `feedback_forum` | `feedback` | Forum channel watched by the feedback pipeline |
| `autoscrape_recipes_enabled` | `false` | Auto-ingest recipes from `#show-and-tell` |
| `autoscrape_recipes_auto_approve` | `false` | Skip manual approval for scraped recipes |

### Customizing the AI prompt

The system prompt in `src/services/openrouter.js` (`buildSystemPrompt`) contains platform-specific context. Update it to describe **your** product, common issues, and priority guidelines.

## Architecture

### Issue pipeline

```
Trigger (mention / reaction / forum / command)
  → queue.js          (sequential, max 50)
  → openrouter.js     (AI classification)
  → duplicates.js     (Jaccard similarity)
  → firestore.js      (persist)
  → triage.js         (embed to triage channel)
```

`src/services/pipeline.js` orchestrates this flow. `messageCreate` processing order is: AutoMod → AFK → XP → thread handler → mention handler.

### Project structure

```
src/
  index.js                Entry point, event listeners, button interactions
  config/config.js        Two-layer config (file + Firestore)
  commands/               One file per slash command
  triggers/
    mention.js            @mention handler
    reaction.js           🐛 / 💡 reaction handler
    forum.js              New forum thread handler
    thread.js             Tracked-thread context appender
    autoscrape.js         Recipe auto-ingest from #show-and-tell
  services/
    pipeline.js           Orchestrates classify → dedupe → store → post
    queue.js              Rate-limited sequential queue
    openrouter.js         AI classification via OpenRouter
    duplicates.js         Jaccard similarity duplicate detection
    firestore.js          Issue, config, and collection storage
    triage.js             Embed building and scheduled digests
    automod.js            Spam / raid / content moderation
    contextEvaluator.js   Context-quality scoring for issues
    pending.js            Pending-issue polling
    mcpApproval.js        MCP approval workflow
  dashboard/
    server.js             Express REST API
    public/               Static frontend (index.html, recipes.html)
```

### Firestore collections

`issues`, `config`, `automod` (with `config` / `blocklist` / `links` / `exemptions` sub-documents), `levels`, `infractions`, `suggestions`, `suggest_config`, `giveaways`, `starboard_config`, `starboard_posts`, `recipes`, `feedback`, `reaction_roles`, `welcome_config`.

## License

MIT
