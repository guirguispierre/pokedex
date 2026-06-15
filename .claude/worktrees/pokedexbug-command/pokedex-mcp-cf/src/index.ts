import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

interface Env {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
  DISCORD_WEBHOOK_URL: string;
  DISCORD_GUILD_ID: string;
  DISCORD_BOT_TOKEN: string;
  RATE_LIMIT: KVNamespace;
}

// === Rate Limiting ===
const RATE_LIMIT_WINDOW = 60; // seconds
const RATE_LIMIT_MAX_READ = 30; // read operations per window
const RATE_LIMIT_MAX_WRITE = 10; // write operations (report/suggest) per window

async function checkRateLimit(env: Env, ip: string, isWrite: boolean): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  const bucket = isWrite ? "w" : "r";
  const key = `rl:${bucket}:${ip}`;
  const max = isWrite ? RATE_LIMIT_MAX_WRITE : RATE_LIMIT_MAX_READ;

  const stored = await env.RATE_LIMIT.get(key);
  const count = stored ? parseInt(stored, 10) : 0;

  if (count >= max) {
    return { allowed: false, remaining: 0, resetIn: RATE_LIMIT_WINDOW };
  }

  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW });
  return { allowed: true, remaining: max - count - 1, resetIn: RATE_LIMIT_WINDOW };
}

function rateLimitHeaders(remaining: number, resetIn: number): Record<string, string> {
  return {
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + resetIn),
  };
}

function rateLimitResponse(resetIn: number): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Rate limit exceeded. Try again later." } },
    { status: 429, headers: { "Retry-After": String(resetIn), ...rateLimitHeaders(0, resetIn) } }
  );
}

// === Input Length Limits ===
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_CONTEXT_LENGTH = 2000;
const MAX_NAME_LENGTH = 100;

function sanitizeString(input: string, maxLength: number): string {
  return String(input || "").slice(0, maxLength).trim();
}

function isValidScreenshotUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") return false;
    if (hostname.startsWith("10.") || hostname.startsWith("192.168.")) return false;
    // 172.16.0.0 – 172.31.255.255 are private; other 172.x.x.x are public
    const m172 = hostname.match(/^172\.(\d+)\./);
    if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return false;
    if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
    // IPv6 localhost and ULA blocking
    if (hostname === "[::1]" || hostname === "::1") return false;
    if (/^\[?f[cd][0-9a-f]{2}:/i.test(hostname)) return false;
    const allowedDomains = ["cdn.discordapp.com", "media.discordapp.net", "i.imgur.com", "imgur.com", "raw.githubusercontent.com", "user-images.githubusercontent.com"];
    return allowedDomains.some(d => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// === Spam / Quality Filter ===

interface FilterResult {
  pass: boolean;
  reason?: string;
}

function filterIssue(title: string, description: string): FilterResult {
  const original = `${title} ${description}`;
  const combined = original.toLowerCase();

  // 1. Too short — not actionable
  if (title.length < 5) return { pass: false, reason: "Title too short. Please provide a clear summary (at least 5 characters)." };
  if (description.length < 15) return { pass: false, reason: "Description too short. Please include enough detail for engineers to understand the issue (at least 15 characters)." };

  // 2. Gibberish / keyboard spam detection
  const gibberishPattern = /^[a-z]{1,3}(\s[a-z]{1,3}){0,2}$|(.)\2{4,}|^[^a-zA-Z]*$/;
  if (gibberishPattern.test(title.trim())) return { pass: false, reason: "Title appears to be gibberish. Please describe the actual issue." };

  // 3. Repetitive characters
  if (/(.)\1{5,}/.test(combined)) return { pass: false, reason: "Report contains excessive repeated characters." };

  // 4. Just greetings / not an issue
  const greetings = ["hello", "hi", "hey", "sup", "yo", "test", "testing", "asdf", "qwerty", "foo", "bar", "baz", "lol", "lmao", "bruh"];
  const titleWords = title.toLowerCase().trim().split(/\s+/);
  if (titleWords.length <= 2 && greetings.includes(titleWords[0])) return { pass: false, reason: "This doesn't appear to be a bug report. Please describe what went wrong." };

  // 5. All caps rage — check on original (pre-lowercased) text
  const uppercaseRatio = (original.match(/[A-Z]/g) || []).length / Math.max(original.length, 1);
  if (original.length > 20 && uppercaseRatio > 0.7) return { pass: false, reason: "Please avoid excessive caps. Describe the issue clearly so engineers can help." };

  // 6. URL spam — multiple links in short text
  const urlCount = (combined.match(/https?:\/\//g) || []).length;
  if (urlCount > 3 && combined.length < 200) return { pass: false, reason: "Report contains too many links relative to its content." };

  // 7. Duplicate word spam ("bug bug bug bug")
  const words = combined.split(/\s+/);
  if (words.length > 3) {
    const unique = new Set(words);
    if (unique.size / words.length < 0.3) return { pass: false, reason: "Report contains too many repeated words." };
  }

  // 8. Profanity / abuse filter (basic)
  const abusePatterns = /\b(fuck\s*you|kill\s*yourself|kys|stfu|die|hack|ddos|dox)\b/i;
  if (abusePatterns.test(combined)) return { pass: false, reason: "Report contains inappropriate content. Please be respectful." };

  return { pass: true };
}

// === JWT / Firestore Auth ===

async function createJWT(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    sub: env.FIREBASE_CLIENT_EMAIL,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: "https://www.googleapis.com/auth/datastore",
  };

  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const signingInput = `${enc(header)}.${enc(payload)}`;

  let pem = env.FIREBASE_PRIVATE_KEY;
  if (pem.includes("\\n")) pem = pem.replace(/\\n/g, "\n");
  const pemBody = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s/g, "");
  const binaryKey = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  return `${signingInput}.${sig}`;
}

async function getAccessToken(env: Env): Promise<string> {
  const jwt = await createJWT(env);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// === Firestore REST API ===

const FIRESTORE_BASE = (projectId: string) =>
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

function toFirestoreValue(val: unknown): Record<string, unknown> {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "string") return { stringValue: val };
  if (typeof val === "number") return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === "boolean") return { booleanValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === "object") {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreValue(val: Record<string, unknown>): unknown {
  if ("stringValue" in val) return val.stringValue;
  if ("integerValue" in val) return Number(val.integerValue);
  if ("doubleValue" in val) return val.doubleValue;
  if ("booleanValue" in val) return val.booleanValue;
  if ("nullValue" in val) return null;
  if ("timestampValue" in val) return val.timestampValue;
  if ("arrayValue" in val) {
    const arr = val.arrayValue as { values?: Record<string, unknown>[] };
    return (arr.values || []).map(fromFirestoreValue);
  }
  if ("mapValue" in val) {
    const map = val.mapValue as { fields?: Record<string, Record<string, unknown>> };
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(map.fields || {})) {
      result[k] = fromFirestoreValue(v);
    }
    return result;
  }
  return null;
}

function fromFirestoreDoc(doc: Record<string, unknown>): Record<string, unknown> {
  const fields = doc.fields as Record<string, Record<string, unknown>> || {};
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    result[k] = fromFirestoreValue(v);
  }
  // Extract doc ID from name
  const name = doc.name as string;
  if (name) {
    result.id = name.split("/").pop();
  }
  return result;
}

async function firestoreCreate(env: Env, token: string, data: Record<string, unknown>): Promise<string> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    fields[k] = toFirestoreValue(v);
  }

  const res = await fetch(`${FIRESTORE_BASE(env.FIREBASE_PROJECT_ID)}/issues`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });

  const doc = await res.json() as { name: string };
  return doc.name.split("/").pop()!;
}

async function firestoreGet(env: Env, token: string, docId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${FIRESTORE_BASE(env.FIREBASE_PROJECT_ID)}/issues/${docId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return fromFirestoreDoc(await res.json() as Record<string, unknown>);
}

async function firestoreQuery(env: Env, token: string, field: string, value: string, limit = 20): Promise<Record<string, unknown>[]> {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "issues" }],
          where: {
            fieldFilter: {
              field: { fieldPath: field },
              op: "EQUAL",
              value: { stringValue: value },
            },
          },
          orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
          limit: limit,
        },
      }),
    }
  );

  const results = await res.json() as Array<{ document?: Record<string, unknown> }>;
  return results
    .filter((r) => r.document)
    .map((r) => fromFirestoreDoc(r.document!));
}

async function firestoreUpdate(env: Env, token: string, docId: string, data: Record<string, unknown>): Promise<boolean> {
  const fields: Record<string, unknown> = {};
  const fieldPaths: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    fields[k] = toFirestoreValue(v);
    fieldPaths.push(k);
  }

  const updateMask = fieldPaths.map(f => `updateMask.fieldPaths=${f}`).join("&");
  const res = await fetch(
    `${FIRESTORE_BASE(env.FIREBASE_PROJECT_ID)}/issues/${docId}?${updateMask}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    }
  );
  return res.ok;
}

// === Discord Bot REST API (edit existing embed with context) ===

async function postContextToDiscord(env: Env, issue: Record<string, unknown>, issueId: string, context: string, author: string) {
  if (!env.DISCORD_BOT_TOKEN) return;

  // Determine channel and message to edit (works for both pending and approved issues)
  const channelId = (issue.triageChannelId as string) || (issue.pendingChannelId as string);
  const messageId = (issue.triageMessageId as string) || (issue.pendingReplyMessageId as string);
  if (!channelId || !messageId) return;

  const headers = {
    Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
  };

  try {
    // Fetch the existing message to get its current embeds
    const getRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, { headers });
    if (!getRes.ok) return;

    const msg = await getRes.json() as { embeds?: Array<Record<string, unknown>> };
    const embeds = msg.embeds || [];
    if (embeds.length === 0) return;

    // Update the first embed — add/replace the context field
    const embed = embeds[0];
    const fields = (embed.fields as Array<{ name: string; value: string; inline?: boolean }>) || [];

    // Remove any existing "💬 Context Added" field so we replace it with the latest
    const filtered = fields.filter(f => !f.name.startsWith("💬"));
    filtered.push({ name: "💬 Context Added", value: `**${author}**: ${context.slice(0, 240)}` });
    embed.fields = filtered;
    embed.timestamp = new Date().toISOString();

    // PATCH the message with updated embed
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch {
    // Silently fail — context was still saved to Firestore
  }
}

// === Discord Webhook ===

async function postToDiscord(env: Env, issue: Record<string, unknown>, issueId: string) {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const colors: Record<string, number> = { critical: 0xff0000, high: 0xff8c00, medium: 0xffd700, low: 0x00cc00 };
  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Pokedex",
      avatar_url: "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/137.png",
      content: "📥 New MCP report pending approval",
      embeds: [{
        title: String(issue.summary || "Untitled report"),
        color: colors[String(issue.priority || "medium")] ?? 0x9b59b6,
        description: String(issue.text || "(no description)").slice(0, 4096),
        fields: [
          { name: "Reporter", value: String(issue.reporterName || "unknown"), inline: true },
          { name: "Priority", value: String(issue.priority || "medium"), inline: true },
          { name: "Category", value: String(issue.category || "other"), inline: true },
          { name: "Source", value: "MCP Agent", inline: true },
        ],
        footer: { text: `Issue ID: ${issueId}` },
        timestamp: new Date().toISOString(),
      }],
    }),
  });
}

// === MCP Server Setup ===

function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "pokedex-mcp-server", version: "1.0.0" });

  server.registerTool("pokedex_report_bug", {
    title: "Report Bug",
    description: "Report a bug to the Pokedex engineering triage system. Saved to database and posted to Discord eng-triage.",
    inputSchema: {
      title: z.string().describe("Short summary of the bug"),
      description: z.string().describe("Detailed description — what happened, expected behavior, steps to reproduce"),
      priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium").describe("Severity level"),
      category: z.enum(["bug", "performance", "security", "ux_issue", "infrastructure", "other"]).optional().default("bug"),
      reporter_name: z.string().describe("Your name or username"),
      reporter_id: z.string().optional().describe("Your user ID"),
      screenshot_url: z.string().url().optional().describe("Screenshot URL"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ title, description, priority, category, reporter_name, reporter_id, screenshot_url }) => {
    const token = await getAccessToken(env);
    const data: Record<string, unknown> = {
      messageId: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      guildId: env.DISCORD_GUILD_ID || "mcp",
      channelId: "mcp",
      reporterId: reporter_id || `mcp-${reporter_name}`,
      reporterName: reporter_name,
      text: description,
      priority: priority || "medium",
      category: category || "bug",
      summary: title,
      reasoning: "Reported via Pokedex MCP",
      status: "pending",
      source: "mcp",
      createdAt: new Date().toISOString(),
    };

    if (screenshot_url) {
      data.attachments = [{ url: screenshot_url, name: "screenshot.png", isImage: true }];
    }

    const issueId = await firestoreCreate(env, token, data);
    await postToDiscord(env, data, issueId);

    return { content: [{ type: "text" as const, text: JSON.stringify({ issueId, status: "created", priority: data.priority, category: data.category, message: `Bug reported. Issue ID: ${issueId}. Engineering team notified.` }, null, 2) }] };
  });

  server.registerTool("pokedex_suggest_feature", {
    title: "Suggest Feature",
    description: "Submit a feature request to the engineering team.",
    inputSchema: {
      title: z.string().describe("Feature title"),
      description: z.string().describe("What it should do and why"),
      reporter_name: z.string().describe("Your name"),
      reporter_id: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ title, description, reporter_name, reporter_id }) => {
    const token = await getAccessToken(env);
    const data: Record<string, unknown> = {
      messageId: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      guildId: env.DISCORD_GUILD_ID || "mcp",
      channelId: "mcp",
      reporterId: reporter_id || `mcp-${reporter_name}`,
      reporterName: reporter_name,
      text: `[FEATURE REQUEST] ${description}`,
      priority: "low",
      category: "feature_request",
      summary: title,
      reasoning: "Feature request via Pokedex MCP",
      status: "pending",
      source: "mcp",
      createdAt: new Date().toISOString(),
    };

    const issueId = await firestoreCreate(env, token, data);
    await postToDiscord(env, data, issueId);

    return { content: [{ type: "text" as const, text: JSON.stringify({ issueId, status: "created", category: "feature_request", message: `Feature request submitted. ID: ${issueId}` }, null, 2) }] };
  });

  server.registerTool("pokedex_check_issue", {
    title: "Check Issue Status",
    description: "Check the status of a reported issue by ID.",
    inputSchema: { issue_id: z.string().describe("Issue ID") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ issue_id }) => {
    const token = await getAccessToken(env);
    const issue = await firestoreGet(env, token, issue_id);
    if (!issue) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Issue not found" }) }] };

    return { content: [{ type: "text" as const, text: JSON.stringify({
      issueId: issue.id, summary: issue.summary, status: issue.status || "open",
      priority: issue.priority, category: issue.category, reporterName: issue.reporterName,
      text: ((issue.text as string) || "").slice(0, 500), source: issue.source || "discord",
      createdAt: issue.createdAt,
    }, null, 2) }] };
  });

  server.registerTool("pokedex_my_issues", {
    title: "My Issues",
    description: "List all issues reported by a user.",
    inputSchema: {
      reporter_name: z.string().describe("Your name or username"),
      limit: z.number().optional().default(20),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ reporter_name, limit }) => {
    const token = await getAccessToken(env);
    const issues = await firestoreQuery(env, token, "reporterName", reporter_name, limit || 20);

    return { content: [{ type: "text" as const, text: JSON.stringify({
      reporter: reporter_name, total: issues.length,
      issues: issues.map(i => ({ issueId: i.id, summary: i.summary, status: i.status || "open", priority: i.priority, category: i.category, createdAt: i.createdAt })),
    }, null, 2) }] };
  });

  return server;
}

// === Worker Export ===

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", server: "pokedex-mcp-server", version: "1.0.0", runtime: "cloudflare-workers" });
    }

    // Compute CORS origin for reuse in both OPTIONS and POST responses
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = ["https://claude.ai", "https://console.anthropic.com"];
    const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

    // Helper to add CORS headers to any response
    function withCors(response: Response): Response {
      const res = new Response(response.body, response);
      res.headers.set("Access-Control-Allow-Origin", allowOrigin);
      res.headers.set("Vary", "Origin");
      return res;
    }

    // MCP endpoint — handle protocol directly (no Express shim needed)
    if (url.pathname === "/mcp" && request.method === "POST") {
      const mcpResult = await (async (): Promise<Response> => {
      const body = await request.json() as { jsonrpc: string; id: unknown; method: string; params?: unknown };
      const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";

      // Rate limit write operations (tools/call with write tools)
      const isWriteCall = body.method === "tools/call" &&
        ["pokedex_report_bug", "pokedex_suggest_feature", "pokedex_add_context"].includes((body.params as any)?.name);
      const isReadCall = body.method === "tools/call" || body.method === "tools/list";

      if (isWriteCall || isReadCall) {
        const rl = await checkRateLimit(env, clientIp, isWriteCall);
        if (!rl.allowed) return rateLimitResponse(rl.resetIn);
      }

      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "pokedex-mcp-server", version: "1.0.0" },
          },
        });
      }

      if (body.method === "notifications/initialized") {
        return Response.json({ jsonrpc: "2.0", id: body.id });
      }

      if (body.method === "tools/list") {
        const server = createServer(env);
        // Get tool definitions by inspecting registered tools
        const tools = [
          { name: "pokedex_report_bug", title: "Report Bug", description: "Report a bug to the Pokedex engineering triage system. Saved to database and posted to Discord eng-triage.", inputSchema: { type: "object", properties: { title: { type: "string", description: "Short summary of the bug" }, description: { type: "string", description: "Detailed description" }, priority: { type: "string", enum: ["critical","high","medium","low"], default: "medium" }, category: { type: "string", enum: ["bug","performance","security","ux_issue","infrastructure","other"], default: "bug" }, reporter_name: { type: "string", description: "Your name" }, reporter_id: { type: "string", description: "Your user ID" }, screenshot_url: { type: "string", description: "Screenshot URL" } }, required: ["title","description","reporter_name"] }, annotations: { readOnlyHint: false, destructiveHint: false } },
          { name: "pokedex_suggest_feature", title: "Suggest Feature", description: "Submit a feature request.", inputSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, reporter_name: { type: "string" }, reporter_id: { type: "string" } }, required: ["title","description","reporter_name"] }, annotations: { readOnlyHint: false } },
          { name: "pokedex_check_issue", title: "Check Issue", description: "Check status of an issue by ID.", inputSchema: { type: "object", properties: { issue_id: { type: "string" } }, required: ["issue_id"] }, annotations: { readOnlyHint: true } },
          { name: "pokedex_my_issues", title: "My Issues", description: "List issues reported by a user.", inputSchema: { type: "object", properties: { reporter_name: { type: "string" }, limit: { type: "number", default: 20 } }, required: ["reporter_name"] }, annotations: { readOnlyHint: true } },
          { name: "pokedex_add_context", title: "Add Context to Issue", description: "Add follow-up context, reproduction steps, or additional details to an existing open issue without creating a new one.", inputSchema: { type: "object", properties: { issue_id: { type: "string", description: "The issue ID to add context to" }, context: { type: "string", description: "Additional context, details, or reproduction steps" }, author: { type: "string", description: "Your name or username" } }, required: ["issue_id", "context", "author"] }, annotations: { readOnlyHint: false, destructiveHint: false } },
        ];
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools } });
      }

      if (body.method === "tools/call") {
        const params = body.params as { name: string; arguments: Record<string, unknown> };
        const args = params.arguments;
        const token = await getAccessToken(env);

        try {
          if (params.name === "pokedex_report_bug") {
            const safeTitle = sanitizeString(args.title as string, MAX_TITLE_LENGTH);
            const safeDesc = sanitizeString(args.description as string, MAX_DESCRIPTION_LENGTH);
            const safeName = sanitizeString(args.reporter_name as string, MAX_NAME_LENGTH);

            // Spam/quality filter
            const filter = filterIssue(safeTitle, safeDesc);
            if (!filter.pass) {
              return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ error: "rejected", reason: filter.reason }, null, 2) }] } });
            }
            const data: Record<string, unknown> = {
              messageId: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              guildId: env.DISCORD_GUILD_ID || "mcp", channelId: "mcp",
              reporterId: (args.reporter_id as string) || `mcp-${safeName}`,
              reporterName: safeName, text: safeDesc,
              priority: args.priority || "medium", category: args.category || "bug",
              summary: safeTitle, reasoning: "Reported via Pokedex MCP",
              status: "pending", source: "mcp", createdAt: new Date().toISOString(),
            };
            if (args.screenshot_url) {
              if (!isValidScreenshotUrl(args.screenshot_url as string)) {
                return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ error: "Invalid screenshot URL. Only HTTPS URLs from trusted image hosts are accepted." }) }] } });
              }
              const safeScreenshotUrl = (args.screenshot_url as string).trim().slice(0, 2048);
              data.attachments = [{ url: safeScreenshotUrl, name: "screenshot.png", isImage: true }];
            }
            const issueId = await firestoreCreate(env, token, data);
            await postToDiscord(env, data, issueId);
            return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ issueId, status: "created", priority: data.priority, message: `Bug reported. ID: ${issueId}` }, null, 2) }] } });
          }

          if (params.name === "pokedex_suggest_feature") {
            const safeTitle = sanitizeString(args.title as string, MAX_TITLE_LENGTH);
            const safeDesc = sanitizeString(args.description as string, MAX_DESCRIPTION_LENGTH);
            const safeName = sanitizeString(args.reporter_name as string, MAX_NAME_LENGTH);

            const filter = filterIssue(safeTitle, safeDesc);
            if (!filter.pass) {
              return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ error: "rejected", reason: filter.reason }, null, 2) }] } });
            }
            const data: Record<string, unknown> = {
              messageId: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              guildId: env.DISCORD_GUILD_ID || "mcp", channelId: "mcp",
              reporterId: (args.reporter_id as string) || `mcp-${safeName}`,
              reporterName: safeName, text: `[FEATURE REQUEST] ${safeDesc}`,
              priority: "low", category: "feature_request", summary: safeTitle,
              reasoning: "Feature request via Pokedex MCP", status: "pending", source: "mcp", createdAt: new Date().toISOString(),
            };
            const issueId = await firestoreCreate(env, token, data);
            await postToDiscord(env, data, issueId);
            return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ issueId, status: "created", message: `Feature submitted. ID: ${issueId}` }, null, 2) }] } });
          }

          if (params.name === "pokedex_check_issue") {
            const issue = await firestoreGet(env, token, args.issue_id as string);
            if (!issue) return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ error: "Issue not found" }) }] } });
            return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ issueId: issue.id, summary: issue.summary, status: issue.status || "open", priority: issue.priority, category: issue.category, createdAt: issue.createdAt }, null, 2) }] } });
          }

          if (params.name === "pokedex_my_issues") {
            const issues = await firestoreQuery(env, token, "reporterName", args.reporter_name as string, (args.limit as number) || 20);
            return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ reporter: args.reporter_name, total: issues.length, issues: issues.map(i => ({ issueId: i.id, summary: i.summary, status: i.status || "open", priority: i.priority, category: i.category })) }, null, 2) }] } });
          }

          if (params.name === "pokedex_add_context") {
            const safeId = sanitizeString(args.issue_id as string, 128);
            const safeContext = sanitizeString(args.context as string, MAX_CONTEXT_LENGTH);
            const safeAuthor = sanitizeString(args.author as string, MAX_NAME_LENGTH);

            const issue = await firestoreGet(env, token, safeId);
            if (!issue) return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ error: "Issue not found" }) }] } });

            const status = (issue.status as string) || "open";
            if (["closed", "fixed", "wontfix"].includes(status)) {
              return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ error: "Issue is closed. Reopen it first.", issue_id: safeId, status }) }] } });
            }

            // Use Firestore commit API with appendMissingElements transform to avoid race conditions
            const docPath = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/issues/${safeId}`;
            const contextEntry = { text: `${safeAuthor}: ${safeContext}`, addedAt: new Date().toISOString() };
            const commitRes = await fetch(
              `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  writes: [
                    {
                      transform: {
                        document: docPath,
                        fieldTransforms: [
                          {
                            fieldPath: "threadContext",
                            appendMissingElements: { values: [toFirestoreValue(contextEntry)] },
                          },
                          {
                            fieldPath: "updatedAt",
                            setToServerValue: "REQUEST_TIME",
                          },
                        ],
                      },
                    },
                  ],
                }),
              }
            );
            if (!commitRes.ok) {
              return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "Failed to add context. Please try again." } });
            }

            // Re-fetch the issue to get channel/message IDs for Discord notification
            const updatedIssue = await firestoreGet(env, token, safeId);
            const totalEntries = updatedIssue ? ((updatedIssue.threadContext as unknown[]) || []).length : 1;
            if (updatedIssue) {
              await postContextToDiscord(env, updatedIssue, safeId, safeContext, safeAuthor);
            }

            return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({
              issueId: safeId, summary: issue.summary, contextAdded: { text: safeContext, author: safeAuthor },
              totalContextEntries: totalEntries, message: `Context added to issue ${safeId}. Discord notification sent.`,
            }, null, 2) }] } });
          }

          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Unknown tool: ${params.name}` } });
        } catch (err: unknown) {
          // Do not leak internal error details to the client
          console.error("MCP tool error:", err);
          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "An internal error occurred. Please try again later." } });
        }
      }

      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Method not found: ${body.method}` } });
      })();
      return withCors(mcpResult);
    }

    // CORS preflight — restrict to known origins instead of wildcard
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": allowOrigin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin",
        },
      });
    }

    return Response.json({ error: "Not found. MCP endpoint is POST /mcp" }, { status: 404 });
  },
};
