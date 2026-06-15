# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Discord bot for AI-powered issue triage, moderation, and community features. Built with discord.js 14, Express, Firebase/Firestore, and OpenRouter for AI classification. CommonJS throughout, Node.js 18+.

## Commands

```bash
npm install        # Install dependencies
npm start          # Run the bot (node src/index.js)
```

No test suite or linter is configured.

## Architecture

### Entry Point & Event Flow

`src/index.js` is the entry point. It initializes Firestore, loads config, registers slash commands, starts the dashboard server, then logs in to Discord. Event listeners dispatch to trigger handlers and slash commands.

**Message processing order in `messageCreate`:** AutoMod check → AFK check → XP award → Thread handler → Mention handler.

### Two-Layer Configuration

`src/config/config.js` loads defaults from `config.json`, then overlays Firestore overrides. The `/config` slash command writes to Firestore. Always use the config service rather than reading `config.json` directly.

### Issue Pipeline

```
Trigger (mention/reaction/forum) → Queue (src/services/queue.js, max 50, sequential)
  → AI Classification (src/services/openrouter.js via OpenRouter API)
  → Duplicate Detection (src/services/duplicates.js, Jaccard similarity)
  → Firestore Storage (src/services/firestore.js)
  → Triage Embed (src/services/triage.js)
```

`src/services/pipeline.js` orchestrates this flow. The queue processes one issue at a time to avoid API rate limits.

### Triggers

- `src/triggers/mention.js` — Bot @mention creates an issue
- `src/triggers/reaction.js` — 🐛 or 💡 emoji on a message creates an issue
- `src/triggers/forum.js` — New forum thread auto-creates an issue
- `src/triggers/thread.js` — Messages in tracked threads append context

### Dashboard

`src/dashboard/server.js` runs an Express REST API (`/api/issues`, `/api/stats`) with API key auth (`X-API-Key` header) and rate limiting. Static frontend in `src/dashboard/public/`.

### Auto-Moderation

`src/services/automod.js` handles spam detection (message rate, duplicates, mentions), raid detection (join velocity), and content filtering (caps, invites, blocklist). Uses in-memory tracking with a 30-second Firestore config cache. Disabled by default (`automod_enabled: false`).

### Slash Commands

Commands live in `src/commands/` — one file per command. Each exports `{ data, execute }` where `data` is a `SlashCommandBuilder` and `execute` handles the interaction. Button interactions are handled in `src/index.js` (lines ~262-515).

### Firestore Collections

- `issues` — Triage issues with status, priority, category, AI summary
- `config` — Key-value pairs for runtime config overrides
- `automod` — Sub-documents: `config`, `blocklist`, `links`

## Environment Variables

Required in `.env` (see `.env.example`):
- `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`
- `OPENROUTER_API_KEY`
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`

## Key Dependencies

- `discord.js` ^14 — Discord API
- `firebase-admin` ^13 — Firestore
- `express` ^5 — Dashboard API
- `node-cron` ^4 — Digest scheduling
- `dotenv` ^17 — Env loading
