# Heroku worker

The Procfile runs only `worker: node src/index.js`; Discord uses an outbound
gateway connection, not an HTTP web process. Use the Node.js buildpack. The
runtime is pinned to Node 22, matching CI.
No credential files or `.env` are needed on Heroku.

## Config vars

Required for bot login and guild command registration:

- `DISCORD_TOKEN`: Discord bot token.
- `DISCORD_APP_ID`: Discord application ID.
- `DISCORD_GUILD_ID`: guild in which commands are registered.

Required for full Firebase-backed functionality (otherwise those features no-op):

- `FIREBASE_SERVICE_ACCOUNT`: complete service-account JSON, or base64 of that
  JSON. This takes precedence over split credentials. Invalid nonempty JSON
  configuration disables Firebase rather than falling back silently.
- Alternatively set all of `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and
  `FIREBASE_PRIVATE_KEY`. Actual newlines and literal `\n` sequences in the
  private key are both supported. Keep the PEM BEGIN/END lines.

Optional:

- `OPENROUTER_API_KEY`: enables AI classification/tagging; needed for full AI functionality.
- `POKEDEX_OWNER_ID`: owner Discord user ID, unless configured in Firestore/defaults.
- `POKEDEX_DISABLE_TRIAGE`: exactly `true` disables issue triage.
- `DASHBOARD_URL`: public recipe/dashboard link used by Discord commands; point
  it at a separately hosted frontend/API, not this worker.
- `DASHBOARD_PORT`: local listener port (default 3000 locally). On Heroku the
  dashboard is disabled unless explicitly set. Even then it binds loopback only
  and is **not routed publicly**; do not set it for normal worker operation.
- `DASHBOARD_API_KEY`: protects authenticated dashboard endpoints if enabled;
  public recipe/feedback endpoints remain public. Without a key, protected
  endpoints allow localhost only.
- `OPENROUTER_MODEL`: only the standalone `scripts/retag-recipes.js` migration
  uses this; defaults to `openai/gpt-4o-mini`.
- `DYNO`: supplied automatically by Heroku, used to disable the dashboard by
  default. Do not set it yourself. The worker does not consume `PORT`.

Example commands below use placeholders only. Enter real values privately in
Heroku's config-var UI or a secure shell, not in source control or shared logs.
Base64 is encoding, not encryption; protect the entire account value as a secret.

```sh
heroku config:set --app YOUR_APP DISCORD_TOKEN='YOUR_BOT_TOKEN' DISCORD_APP_ID='YOUR_APP_ID' DISCORD_GUILD_ID='YOUR_GUILD_ID'
heroku config:set --app YOUR_APP FIREBASE_SERVICE_ACCOUNT='YOUR_COMPLETE_JSON_OR_BASE64_JSON'
# Alternative to FIREBASE_SERVICE_ACCOUNT (unset that var first if switching):
heroku config:set --app YOUR_APP FIREBASE_PROJECT_ID='YOUR_PROJECT_ID' FIREBASE_CLIENT_EMAIL='YOUR_SERVICE_ACCOUNT_EMAIL' FIREBASE_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\nYOUR_KEY_BODY\n-----END PRIVATE KEY-----\n'
heroku config:set --app YOUR_APP OPENROUTER_API_KEY='YOUR_OPENROUTER_KEY'
```

Enable the required Discord privileged intents (Message Content, Server Members,
and Presence) in the developer portal and grant the bot appropriate permissions.
Enable Firestore and grant the service account access to the project.

## Scaling and uptime

After deploying through your normal release workflow, scale a single worker:

```sh
heroku ps:scale web=0 worker=1 --app YOUR_APP
```

If Heroku reports that `web` doesn't exist (this Procfile defines none), use
`heroku ps:scale worker=1 --app YOUR_APP` instead. Do not run multiple workers:
they would receive duplicate Discord events and run duplicate schedulers.

Worker-only Eco apps do not sleep from HTTP inactivity, but consume the shared
monthly Eco hour pool continuously. When the pool is exhausted, Eco dynos sleep
until the next month. Basic is always-on without that Eco pool restriction and
is the safer choice for 24/7 operation. Always-on is not zero downtime: restarts,
deploys, daily cycling, and failures still interrupt the connection. SIGTERM and
SIGINT destroy the Discord client and exit, with a bounded shutdown timeout.

See [Heroku Eco dyno hours](https://devcenter.heroku.com/articles/eco-dyno-hours).

Configuration audit: the bot reads bundled `config.json` for non-secret defaults
and command source files for discovery; dotenv optionally reads `.env` locally.
There are no service-account path or `GOOGLE_APPLICATION_CREDENTIALS` reads in
the application. Firebase always uses explicit config-var credentials. Keep
secrets out of `config.json`; use config vars for credentials.
