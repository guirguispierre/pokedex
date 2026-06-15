# Moderator Dashboard for PokéMod — Design Spec

**Date:** 2026-03-25
**Status:** Approved

## Overview

A unified moderator dashboard for the PokéMod Discord bot, replacing the existing `dashboard-vercel` frontend. Provides full moderation control, auto-mod configuration, issue triage, and server stats through a web UI with real-time updates.

## Architecture

### Stack

- **Frontend:** Next.js 14 (App Router) on Vercel
- **Auth:** Discord OAuth2 (no custom sign-up/login)
- **Database:** Firebase Firestore (shared with bot)
- **Real-time:** Firebase Client SDK `onSnapshot` listeners
- **Mod Actions:** Next.js API routes -> Discord REST API
- **Styling:** Tailwind CSS, Discord-native dark theme

### Data Flow

```
[Dashboard Frontend]
  |-- reads --> Firestore (onSnapshot, real-time)
  |-- writes --> Next.js API Routes
                    |-- Discord REST API (bans, kicks, timeouts, warns)
                    |-- Firestore via Admin SDK (config changes, issue updates)

[Discord Bot]
  |-- writes --> Firestore (infractions, mod_logs, issues, automod events)
  |-- reads --> Firestore (config, automod settings -- picks up dashboard changes)
```

The bot and dashboard share Firestore as the data layer. The bot writes events; the dashboard listens in real-time. Mod actions from the dashboard go through Discord's REST API so Discord remains the source of truth for server state.

## Authentication & Permissions

### Auth Flow

1. User clicks "Login with Discord" -> redirected to Discord OAuth2
2. Discord returns auth code -> Next.js API route exchanges for access token
3. API route fetches user's guild membership and roles via Discord API
4. Session stored in encrypted cookie (iron-session)
5. Discord roles mapped to dashboard permission tiers

### Permission Tiers

| Tier | Can View | Can Configure | Can Moderate |
|------|----------|--------------|-------------|
| Viewer | Issues, server stats (member count, age, etc.) | No | No |
| Moderator | Everything including logs | Automod settings, blocklists | Warn, timeout, kick |
| Admin | Everything | Everything | Everything including ban |

Role-to-tier mapping is configurable in the Settings page (admin only). Initially 3 users, designed to scale to more.

### Auth Edge Cases

- User removed from Discord server -> next API call checks guild membership, revokes session
- User's Discord role changes -> permissions re-fetched on each API route call (not cached long-term)
- OAuth token expires -> redirect to re-auth flow

## Layout

**Collapsible icon sidebar** -- slim icon-only sidebar that expands on hover/click. Maximizes content space while keeping all navigation accessible. Discord/Slack-like feel.

**Navigation items:**
1. Overview (home)
2. Moderation
3. AutoMod Config
4. Issues (mod+ only)
5. Stats (all users)
6. Mod Logs (mod+ only)
7. Settings (admin only)

## Visual Design

**Discord-native dark theme** using Discord's exact color palette:

- Background primary: `#2b2d31`
- Background secondary: `#1e1f22`
- Background tertiary: `#111214`
- Text primary: `#f2f3f5`
- Text secondary: `#b5bac1`
- Text muted: `#949ba4`
- Accent/brand: `#5865f2` (blurple)
- Danger: `#f23f42`
- Warning: `#fee75c`
- Success: `#23a55a`

Goal: feels like an extension of Discord, low cognitive load for mods who already live there. Will use the frontend-design skill during implementation to ensure high design quality and avoid generic AI aesthetics.

## Pages

### 1. Overview (Home)

- Stat cards: member count, active infractions, open issues, automod status (on/off)
- Activity chart: mod actions over time (line/bar chart)
- Recent actions feed: real-time via Firestore `onSnapshot` -- shows warnings, bans, automod actions, issue updates
- Quick-action buttons: timeout user, view latest issue

### 2. Moderation

- **User search:** look up any guild member, see their full infraction history
- **Take actions:** warn, timeout (with duration picker), kick, ban -- each requires a reason field
- **Active timeouts:** list with time remaining, option to remove early
- **Infraction log:** filterable by user, type (warn/timeout/kick/ban), date range, moderator who issued it
- Infraction detail shows: evidence (deleted message content), moderator notes, timestamps

### 3. AutoMod Config

- **Master toggle:** enable/disable automod
- **Thresholds:** flood rate (messages/seconds), duplicate count/window, mention limit, caps percentage -- editable number inputs
- **Blocklist:** add/remove blocked words and phrases, view current list
- **Link filtering:** manage allowed and blocked domains, view current lists
- **Raid protection:** toggle on/off, set join rate threshold
- **Exemptions:** add/remove exempt roles and channels
- **DM notifications:** toggle whether users receive DMs on automod actions
- **Log channel:** set which channel receives automod log messages
- All changes write directly to Firestore `automod` collection -> bot picks up changes in real-time

### 4. Issues (Mod+ Only)

- **List view:** filterable by priority (critical/high/medium/low), category (bug/feature/ux/performance/security), status (open/acknowledged/in-progress/closed/wontfix)
- **Issue detail:** full description, context gathered, comments, attachments
- **Triage actions:** acknowledge, assign to moderator, escalate priority, close, mark as won't fix
- **Comments:** add comments from dashboard, visible in Firestore (synced with bot's triage embeds)

### 5. Stats (All Users)

- **Server stats:** member count, server age, channel count, role count
- **Bot stats:** uptime, total commands used
- **Moderation stats:** actions this week/month, most common infraction types, top moderators by action count
- **Charts:** moderation activity over time, issue resolution rate, automod blocks over time

### 6. Mod Logs (Mod+ Only)

- **Real-time feed:** all automod actions and manual mod actions as they happen
- **Filters:** action type, target user, moderator, date range
- **Evidence:** deleted message content, screenshots where available
- **Export:** download filtered logs as CSV (admin only)

### 7. Settings (Admin Only)

- **Bot config:** triage channel, emoji trigger, output mode, summary interval, feedback forum, acknowledge toggle
- **Role mapping:** configure which Discord roles correspond to viewer/moderator/admin tiers
- **Dashboard preferences:** default page on login

## Firestore Collections

### Existing (shared with bot)

| Collection | Purpose |
|---|---|
| `issues` | Bug reports, feature requests from triage pipeline |
| `config` | Bot configuration overrides |
| `automod` | Auto-moderation settings and state |
| `infractions` | Warnings, timeouts, kicks, bans |

### New

| Collection | Purpose |
|---|---|
| `mod_logs` | Detailed log entries for all mod actions (automod + manual). Each doc: `{ action, targetUser, moderator, reason, evidence, timestamp, source: 'bot' or 'dashboard' }` |
| `dashboard_sessions` | Auth session metadata (not used for real-time) |

## Real-time Updates

- Firebase Client SDK `onSnapshot` on: `issues`, `infractions`, `mod_logs`, `automod`, `config`
- Connection status indicator in sidebar footer: green = live, yellow = reconnecting, red = disconnected
- If disconnected >30 seconds: banner "Live updates paused -- reconnecting..."
- Firestore handles reconnection automatically

## Firestore Security Rules

- **Read access:** authenticated users with valid guild membership (verified via custom claims or session check)
- **Write access:** frontend SDK is read-only; all mutations go through Next.js API routes using Firebase Admin SDK server-side
- API routes validate session + permission tier before any write

## Error Handling

### Mod Action Failures

- Discord API rate limits -> queue actions, show "pending" state in UI, retry with exponential backoff
- Discord API errors (user already banned, bot lacks perms, target has higher role) -> clear error message in UI, no silent failures
- Optimistic UI updates with rollback on failure

### Permission Conflicts

- Dashboard mod tries to moderate someone with a higher Discord role -> Discord API rejects -> dashboard shows "Cannot moderate this user -- they have a higher role"
- Multiple mods act on same user simultaneously -> last write wins in Firestore, both see the result via real-time listener

### Data Consistency

- Bot is the source of truth for Discord state
- Dashboard reads from Firestore (which bot keeps in sync)
- If Firestore and Discord diverge, mod actions go through Discord API which is authoritative

## Deployment

- Deployed on Vercel, replacing current `dashboard-vercel` directory
- Environment variables needed on Vercel:
  - `DISCORD_CLIENT_ID` -- OAuth2 application client ID
  - `DISCORD_CLIENT_SECRET` -- OAuth2 application client secret
  - `DISCORD_BOT_TOKEN` -- for REST API mod actions
  - `DISCORD_GUILD_ID` -- target server
  - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` -- Admin SDK
  - `NEXT_PUBLIC_FIREBASE_*` -- Client SDK config (project ID, API key, etc.)
  - `SESSION_SECRET` -- for iron-session cookie encryption
  - `NEXT_PUBLIC_APP_URL` -- for OAuth redirect URI

## Out of Scope

- Mobile-responsive design (desktop-first for mod workflows, mobile can come later)
- Audit trail for dashboard config changes (can be added later)
- Multi-server support (single guild only for now)
- Light mode (Discord-native dark only)
