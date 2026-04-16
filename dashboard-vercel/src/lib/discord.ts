const DISCORD_API = "https://discord.com/api/v10";
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const GUILD_ID = process.env.DISCORD_GUILD_ID!;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID!;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET!;
const REDIRECT_URI = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/callback`;

function botHeaders() {
  return {
    Authorization: `Bot ${BOT_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/** Validate that a value looks like a Discord snowflake (numeric string). */
function assertSnowflake(value: string, label: string): void {
  if (!/^\d{17,20}$/.test(value)) {
    throw new Error(`Invalid ${label}: must be a Discord snowflake`);
  }
}

export async function exchangeCode(code: string) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status}`);
  }

  return res.json();
}

export async function getDiscordUser(accessToken: string) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to get user: ${res.status}`);
  }

  return res.json();
}

export async function getGuildMember(userId: string) {
  assertSnowflake(userId, "userId");
  const res = await fetch(
    `${DISCORD_API}/guilds/${GUILD_ID}/members/${encodeURIComponent(userId)}`,
    { headers: botHeaders() }
  );

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Failed to get guild member: ${res.status}`);
  }

  return res.json();
}

export async function getGuildRoles() {
  const res = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/roles`, {
    headers: botHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Failed to get guild roles: ${res.status}`);
  }

  return res.json();
}

export async function getGuild() {
  const res = await fetch(
    `${DISCORD_API}/guilds/${GUILD_ID}?with_counts=true`,
    { headers: botHeaders() }
  );

  if (!res.ok) {
    throw new Error(`Failed to get guild: ${res.status}`);
  }

  return res.json();
}

export async function getGuildChannels() {
  const res = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/channels`, {
    headers: botHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Failed to get channels: ${res.status}`);
  }

  return res.json();
}

export async function banUser(userId: string, reason: string) {
  assertSnowflake(userId, "userId");
  const res = await fetch(
    `${DISCORD_API}/guilds/${GUILD_ID}/bans/${encodeURIComponent(userId)}`,
    {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ reason }),
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to ban user: ${res.status}`);
  }

  return res.ok;
}

export async function kickUser(userId: string, reason: string) {
  assertSnowflake(userId, "userId");
  const res = await fetch(
    `${DISCORD_API}/guilds/${GUILD_ID}/members/${encodeURIComponent(userId)}`,
    {
      method: "DELETE",
      headers: {
        ...botHeaders(),
        "X-Audit-Log-Reason": encodeURIComponent(reason),
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to kick user: ${res.status}`);
  }

  return res.ok;
}

export async function timeoutUser(
  userId: string,
  durationSeconds: number,
  reason: string
) {
  const until = new Date(
    Date.now() + durationSeconds * 1000
  ).toISOString();

  assertSnowflake(userId, "userId");
  const res = await fetch(
    `${DISCORD_API}/guilds/${GUILD_ID}/members/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: {
        ...botHeaders(),
        "X-Audit-Log-Reason": encodeURIComponent(reason),
      },
      body: JSON.stringify({ communication_disabled_until: until }),
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to timeout user: ${res.status}`);
  }

  return res.json();
}

export async function removeTimeout(userId: string) {
  assertSnowflake(userId, "userId");
  const res = await fetch(
    `${DISCORD_API}/guilds/${GUILD_ID}/members/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ communication_disabled_until: null }),
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to remove timeout: ${res.status}`);
  }

  return res.json();
}

export async function searchGuildMembers(query: string, limit: number = 10) {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
  });

  const res = await fetch(
    `${DISCORD_API}/guilds/${GUILD_ID}/members/search?${params}`,
    { headers: botHeaders() }
  );

  if (!res.ok) {
    throw new Error(`Failed to search members: ${res.status}`);
  }

  return res.json();
}
