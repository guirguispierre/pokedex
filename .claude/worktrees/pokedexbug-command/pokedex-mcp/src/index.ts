#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import admin from "firebase-admin";

// --- Input Validation & Security ---
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_COMMENT_LENGTH = 2000;
const MAX_CONTEXT_LENGTH = 2000;
const MAX_NAME_LENGTH = 100;
const MAX_SEARCH_QUERY_LENGTH = 200;

interface FilterResult {
  pass: boolean;
  reason?: string;
}

function filterIssue(title: string, description: string): FilterResult {
  const original = `${title} ${description}`;
  const combined = original.toLowerCase();

  if (title.length < 5) return { pass: false, reason: "Title too short. Please provide a clear summary (at least 5 characters)." };
  if (description.length < 15) return { pass: false, reason: "Description too short. Please include enough detail (at least 15 characters)." };

  const gibberishPattern = /^[a-z]{1,3}(\s[a-z]{1,3}){0,2}$|(.)\2{4,}|^[^a-zA-Z]*$/;
  if (gibberishPattern.test(title.trim())) return { pass: false, reason: "Title appears to be gibberish. Please describe the actual issue." };

  if (/(.)\1{5,}/.test(combined)) return { pass: false, reason: "Report contains excessive repeated characters." };

  const greetings = ["hello", "hi", "hey", "sup", "yo", "test", "testing", "asdf", "qwerty", "foo", "bar", "baz", "lol", "lmao", "bruh"];
  const titleWords = title.toLowerCase().trim().split(/\s+/);
  if (titleWords.length <= 2 && greetings.includes(titleWords[0])) return { pass: false, reason: "This doesn't appear to be a bug report. Please describe what went wrong." };

  // Check uppercase ratio on original (pre-lowercased) text
  const uppercaseRatio = (original.match(/[A-Z]/g) || []).length / Math.max(original.length, 1);
  if (original.length > 20 && uppercaseRatio > 0.7) return { pass: false, reason: "Please avoid excessive caps. Describe the issue clearly." };

  const urlCount = (combined.match(/https?:\/\//g) || []).length;
  if (urlCount > 3 && combined.length < 200) return { pass: false, reason: "Report contains too many links relative to its content." };

  const words = combined.split(/\s+/);
  if (words.length > 3) {
    const unique = new Set(words);
    if (unique.size / words.length < 0.3) return { pass: false, reason: "Report contains too many repeated words." };
  }

  const abusePatterns = /\b(fuck\s*you|kill\s*yourself|kys|stfu|die|hack|ddos|dox)\b/i;
  if (abusePatterns.test(combined)) return { pass: false, reason: "Report contains inappropriate content. Please be respectful." };

  return { pass: true };
}

function sanitizeString(input: string, maxLength: number): string {
  return input.slice(0, maxLength).trim();
}

// Firestore doc IDs cannot contain '/' or be empty
function isValidDocId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && !/[/]/.test(id);
}

function isValidScreenshotUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["https:"].includes(parsed.protocol)) return false;
    // Block internal/private network URLs
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") return false;
    if (hostname.startsWith("10.") || hostname.startsWith("192.168.")) return false;
    // 172.16.0.0 – 172.31.255.255 are private; other 172.x.x.x are public
    const m172 = hostname.match(/^172\.(\d+)\./);
    if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return false;
    if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
    // IPv6 localhost and ULA (Unique Local Address) blocking
    if (hostname === "[::1]" || hostname === "::1") return false;
    if (/^\[?f[cd][0-9a-f]{2}:/i.test(hostname)) return false;
    // Only allow common image hosting domains
    const allowedDomains = ["cdn.discordapp.com", "media.discordapp.net", "i.imgur.com", "imgur.com", "raw.githubusercontent.com", "user-images.githubusercontent.com"];
    return allowedDomains.some(d => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// --- Rate Limiting (in-memory for stdio/HTTP mode) ---
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_WRITE = 10;
const RATE_LIMIT_MAX_READ = 30;
const RATE_LIMIT_EVICT_INTERVAL_MS = 300_000;

// Sanitize rate limit keys to prevent bypass via special characters
function sanitizeRateLimitKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9:_\-@.]/g, "_").slice(0, 200);
}

function evictExpiredBuckets(): void {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (now > bucket.resetAt) {
      rateLimitBuckets.delete(key);
    }
  }
}

// Periodically evict expired entries to prevent unbounded memory growth
setInterval(evictExpiredBuckets, RATE_LIMIT_EVICT_INTERVAL_MS).unref();

function checkRateLimit(key: string, isWrite: boolean): boolean {
  const now = Date.now();
  const max = isWrite ? RATE_LIMIT_MAX_WRITE : RATE_LIMIT_MAX_READ;
  const safeKey = sanitizeRateLimitKey(key);
  const bucket = rateLimitBuckets.get(safeKey);

  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(safeKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (bucket.count >= max) return false;
  bucket.count++;
  return true;
}

// --- Firebase Init ---
function initFirebase() {
  if (admin.apps.length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";

  if (privateKey.includes("\\n")) {
    privateKey = privateKey.replace(/\\n/g, "\n");
  }

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Firebase credentials. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY."
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

function getDb() {
  initFirebase();
  return admin.firestore();
}

// --- Discord Bot REST API (edit existing embed with context) ---
async function postContextToDiscord(issue: Record<string, unknown>, issueId: string, context: string, author: string) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return;

  // Determine channel and message to edit (works for both pending and approved issues)
  const channelId = (issue.triageChannelId as string) || (issue.pendingChannelId as string);
  const messageId = (issue.triageMessageId as string) || (issue.pendingReplyMessageId as string);
  if (!channelId || !messageId) return;

  const headers = {
    Authorization: `Bot ${botToken}`,
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
    const filtered = fields.filter((f: { name: string }) => !f.name.startsWith("💬"));
    filtered.push({ name: "💬 Context Added", value: `**${author}**: ${context.slice(0, 240)}` });
    embed.fields = filtered;
    embed.timestamp = new Date().toISOString();

    // PATCH the message with updated embed
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    console.error("Discord context embed edit failed:", err);
  }
}

// --- Discord Webhook ---
async function postToDiscordWebhook(issue: Record<string, unknown>, issueId: string) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const PRIORITY_COLORS: Record<string, number> = {
    critical: 0xff0000,
    high: 0xff8c00,
    medium: 0xffd700,
    low: 0x00cc00,
  };

  const color = PRIORITY_COLORS[issue.priority as string] ?? 0x808080;

  const embed = {
    title: issue.summary as string,
    color,
    fields: [
      { name: "Priority", value: issue.priority as string, inline: true },
      { name: "Category", value: issue.category as string, inline: true },
      { name: "Reporter", value: issue.reporterName as string, inline: true },
      { name: "Source", value: "MCP Agent", inline: true },
      { name: "Description", value: (issue.text as string)?.slice(0, 1024) || "(no description)" },
    ],
    footer: { text: `Issue ID: ${issueId} | via Pokedex MCP` },
    timestamp: new Date().toISOString(),
    ...(issue.screenshotUrl ? { image: { url: issue.screenshotUrl as string } } : {}),
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Pokedex",
        avatar_url: "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/137.png",
        embeds: [embed],
      }),
    });
  } catch (err) {
    console.error("Discord webhook failed:", err);
  }
}

// --- MCP Server ---
const server = new McpServer({
  name: "pokedex-mcp-server",
  version: "1.0.0",
});

// Tool 1: Report a bug
server.registerTool(
  "pokedex_report_bug",
  {
    title: "Report Bug",
    description:
      "Report a bug or issue to the Pokedex engineering triage system. The issue will be saved to the database and posted to the Discord eng-triage channel for engineers to review.",
    inputSchema: {
      title: z.string().describe("Short summary of the bug (1-2 sentences)"),
      description: z.string().describe("Detailed description of the bug — what happened, what you expected, steps to reproduce"),
      priority: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .default("medium")
        .describe("Bug severity: critical (data loss/security), high (core feature broken), medium (workaround exists), low (minor/cosmetic)"),
      category: z
        .enum(["bug", "performance", "security", "ux_issue", "infrastructure", "other"])
        .optional()
        .default("bug")
        .describe("Category of the issue"),
      reporter_name: z.string().describe("Your name or username"),
      reporter_id: z.string().optional().describe("Your unique user ID (optional)"),
      screenshot_url: z.string().url().optional().describe("URL to a screenshot showing the issue (optional)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ title, description, priority, category, reporter_name, reporter_id, screenshot_url }) => {
    // Rate limit
    const rlKey = `write:${reporter_id || reporter_name}`;
    if (!checkRateLimit(rlKey, true)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Rate limit exceeded. Try again later." }) }] };
    }

    // Sanitize inputs
    const safeTitle = sanitizeString(title, MAX_TITLE_LENGTH);
    const safeDesc = sanitizeString(description, MAX_DESCRIPTION_LENGTH);
    const safeName = sanitizeString(reporter_name, MAX_NAME_LENGTH);

    // Spam/quality filter
    const filter = filterIssue(safeTitle, safeDesc);
    if (!filter.pass) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "rejected", reason: filter.reason }) }] };
    }

    const db = getDb();

    const issueData: Record<string, unknown> = {
      messageId: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      guildId: process.env.DISCORD_GUILD_ID || "mcp",
      channelId: "mcp",
      reporterId: reporter_id || `mcp-${safeName}`,
      reporterName: safeName,
      text: safeDesc,
      priority: priority || "medium",
      category: category || "bug",
      summary: safeTitle,
      reasoning: "Reported via Pokedex MCP agent integration",
      status: "pending",
      source: "mcp",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (screenshot_url) {
      if (!isValidScreenshotUrl(screenshot_url)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid screenshot URL. Only HTTPS URLs from trusted image hosts are accepted." }) }] };
      }
      const safeScreenshotUrl = screenshot_url.trim().slice(0, 2048);
      issueData.attachments = [{
        url: safeScreenshotUrl, name: "screenshot.png", isImage: true,
        contentType: "image/png", size: 0,
      }];
      issueData.screenshotUrl = safeScreenshotUrl;
    }

    const docRef = await db.collection("issues").add(issueData);
    const issueId = docRef.id;

    await postToDiscordWebhook(issueData, issueId);

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        issueId, status: "created", priority: issueData.priority, category: issueData.category,
        message: `Bug reported successfully. Issue ID: ${issueId}. The engineering team has been notified.`,
      }, null, 2) }],
    };
  }
);

// Tool 2: Suggest a feature
server.registerTool(
  "pokedex_suggest_feature",
  {
    title: "Suggest Feature",
    description: "Submit a feature request or suggestion to the Pokedex engineering team.",
    inputSchema: {
      title: z.string().describe("Short title for the feature request"),
      description: z.string().describe("Detailed description — what it should do, why it's useful"),
      reporter_name: z.string().describe("Your name or username"),
      reporter_id: z.string().optional().describe("Your unique user ID (optional)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ title, description, reporter_name, reporter_id }) => {
    // Rate limit
    const rlKey = `write:${reporter_id || reporter_name}`;
    if (!checkRateLimit(rlKey, true)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Rate limit exceeded. Try again later." }) }] };
    }

    // Sanitize inputs
    const safeTitle = sanitizeString(title, MAX_TITLE_LENGTH);
    const safeDesc = sanitizeString(description, MAX_DESCRIPTION_LENGTH);
    const safeName = sanitizeString(reporter_name, MAX_NAME_LENGTH);

    // Spam/quality filter
    const filter = filterIssue(safeTitle, safeDesc);
    if (!filter.pass) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "rejected", reason: filter.reason }) }] };
    }

    const db = getDb();

    const issueData: Record<string, unknown> = {
      messageId: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      guildId: process.env.DISCORD_GUILD_ID || "mcp",
      channelId: "mcp",
      reporterId: reporter_id || `mcp-${safeName}`,
      reporterName: safeName,
      text: `[FEATURE REQUEST] ${safeDesc}`,
      priority: "low",
      category: "feature_request",
      summary: safeTitle,
      reasoning: "Feature request submitted via Pokedex MCP agent integration",
      status: "pending",
      source: "mcp",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("issues").add(issueData);
    const issueId = docRef.id;
    await postToDiscordWebhook(issueData, issueId);

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        issueId, status: "created", category: "feature_request",
        message: `Feature request submitted. Issue ID: ${issueId}. The team will review it.`,
      }, null, 2) }],
    };
  }
);

// Tool 3: Check issue status
server.registerTool(
  "pokedex_check_issue",
  {
    title: "Check Issue Status",
    description: "Check the current status of a previously reported issue by its ID.",
    inputSchema: {
      issue_id: z.string().describe("The issue ID returned when the bug was reported"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ issue_id }) => {
    if (!checkRateLimit(`read:${issue_id}`, false)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Rate limit exceeded. Try again later." }) }] };
    }

    const db = getDb();
    const safeId = sanitizeString(issue_id, 128);
    if (!isValidDocId(safeId)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid issue ID format", issue_id: safeId }) }] };
    }
    const doc = await db.collection("issues").doc(safeId).get();
    if (!doc.exists) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Issue not found", issue_id: safeId }) }] };
    }

    const data = doc.data()!;
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        issueId: doc.id, summary: data.summary, status: data.status || "open",
        priority: data.priority, category: data.category, reporterName: data.reporterName,
        text: data.text?.slice(0, 500), reasoning: data.reasoning,
        source: data.source || "discord",
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        closedAt: data.closedAt?.toDate?.()?.toISOString() || null,
        hasAttachments: (data.attachments?.length || 0) > 0,
        threadContextCount: data.threadContext?.length || 0,
      }, null, 2) }],
    };
  }
);

// Tool 4: List my issues
server.registerTool(
  "pokedex_my_issues",
  {
    title: "My Issues",
    description: "List all issues previously reported by a specific user.",
    inputSchema: {
      reporter_name: z.string().describe("Your name or username to look up"),
      status: z.enum(["open", "closed", "fixed", "acknowledged", "escalated", "all"]).optional().default("all").describe("Filter by status"),
      limit: z.number().optional().default(20).describe("Max issues to return"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ reporter_name, status, limit }) => {
    if (!checkRateLimit(`read:${reporter_name}`, false)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Rate limit exceeded. Try again later." }) }] };
    }

    const safeName = sanitizeString(reporter_name, MAX_NAME_LENGTH);
    const safeLimit = Math.min(Math.max(limit || 20, 1), 50);
    const db = getDb();
    let query = db.collection("issues").where("reporterName", "==", safeName).orderBy("createdAt", "desc").limit(safeLimit);

    if (status && status !== "all") {
      query = db.collection("issues").where("reporterName", "==", safeName).where("status", "==", status).orderBy("createdAt", "desc").limit(safeLimit);
    }

    const snapshot = await query.get();
    const issues = snapshot.docs.map((doc) => {
      const d = doc.data();
      return {
        issueId: doc.id, summary: d.summary, status: d.status || "open",
        priority: d.priority, category: d.category, source: d.source || "discord",
        createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
      };
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ reporter: reporter_name, total: issues.length, issues }, null, 2) }],
    };
  }
);

// Tool 5: Update an issue
server.registerTool(
  "pokedex_update_issue",
  {
    title: "Update Issue",
    description:
      "Update an existing issue's priority, status, or category. Use this to escalate, close, or reclassify issues.",
    inputSchema: {
      issue_id: z.string().describe("The issue ID to update"),
      reporter_name: z.string().describe("Your name or username (must match the original reporter)"),
      status: z
        .enum(["open", "acknowledged", "fixed", "closed", "escalated", "wontfix"])
        .optional()
        .describe("New status for the issue"),
      priority: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("New priority level"),
      category: z
        .enum(["bug", "performance", "security", "ux_issue", "infrastructure", "feature_request", "other"])
        .optional()
        .describe("New category"),
      reason: z.string().optional().describe("Reason for the update (shown in audit trail)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ issue_id, reporter_name, status, priority, category, reason }) => {
    if (!checkRateLimit(`write:${issue_id}`, true)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Rate limit exceeded. Try again later." }) }] };
    }

    const db = getDb();
    const safeId = sanitizeString(issue_id, 128);
    if (!isValidDocId(safeId)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid issue ID format", issue_id: safeId }) }] };
    }
    const safeName = sanitizeString(reporter_name, MAX_NAME_LENGTH);
    const docRef = db.collection("issues").doc(safeId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Issue not found", issue_id: safeId }) }] };
    }

    const data = doc.data()!;

    // Authorization: MCP agents can only update issues they created via MCP
    if (data.source !== "mcp") {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP agents can only update issues created via MCP.", issue_id: safeId }) }] };
    }
    // Verify the caller is the original reporter, not just any MCP agent
    if (data.reporterName !== safeName) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "You can only update issues you originally reported.", issue_id: safeId }) }] };
    }

    // MCP agents cannot directly close/fix issues — that requires moderator action
    if (status && ["closed", "fixed", "wontfix"].includes(status)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "MCP agents cannot close issues. Only moderators can close issues via Discord.", issue_id: safeId }) }] };
    }

    const updates: Record<string, unknown> = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (status) updates.status = status;
    if (priority) updates.priority = priority;
    if (category) updates.category = category;

    if (reason) {
      const safeReason = sanitizeString(reason, MAX_COMMENT_LENGTH);
      updates.notes = admin.firestore.FieldValue.arrayUnion({
        text: safeReason,
        author: "MCP Agent",
        timestamp: new Date().toISOString(),
      });
    }

    await docRef.update(updates);

    const updated = (await docRef.get()).data()!;
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        issueId: safeId,
        summary: updated.summary,
        status: updated.status,
        priority: updated.priority,
        category: updated.category,
        message: `Issue ${safeId} updated successfully.`,
      }, null, 2) }],
    };
  }
);

// Tool 6: Search issues
server.registerTool(
  "pokedex_search_issues",
  {
    title: "Search Issues",
    description:
      "Search issues by keyword across summaries and descriptions. Returns matching issues sorted by most recent.",
    inputSchema: {
      query: z.string().describe("Search keyword or phrase to find in issue titles and descriptions"),
      status: z
        .enum(["open", "closed", "fixed", "acknowledged", "escalated", "all"])
        .optional()
        .default("all")
        .describe("Filter by status"),
      limit: z.number().optional().default(10).describe("Max results to return"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, status, limit }) => {
    if (!checkRateLimit(`read:search`, false)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Rate limit exceeded. Try again later." }) }] };
    }

    const db = getDb();
    const searchLimit = Math.min(limit || 10, 50);
    const safeQuery = sanitizeString(query, MAX_SEARCH_QUERY_LENGTH);
    const queryLower = safeQuery.toLowerCase();

    // Firestore doesn't support full-text search, so we fetch recent issues and filter client-side
    let baseQuery = db.collection("issues").orderBy("createdAt", "desc").limit(200);

    if (status && status !== "all") {
      baseQuery = db.collection("issues")
        .where("status", "==", status)
        .orderBy("createdAt", "desc")
        .limit(200);
    }

    const snapshot = await baseQuery.get();
    const matches = snapshot.docs
      .filter((doc) => {
        const d = doc.data();
        const summary = (d.summary || "").toLowerCase();
        const text = (d.text || "").toLowerCase();
        const category = (d.category || "").toLowerCase();
        return summary.includes(queryLower) || text.includes(queryLower) || category.includes(queryLower);
      })
      .slice(0, searchLimit)
      .map((doc) => {
        const d = doc.data();
        return {
          issueId: doc.id,
          summary: d.summary,
          status: d.status || "open",
          priority: d.priority,
          category: d.category,
          reporter: d.reporterName,
          source: d.source || "discord",
          createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
        };
      });

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        query,
        total: matches.length,
        issues: matches,
      }, null, 2) }],
    };
  }
);

// Tool 7: Add comment to an issue
server.registerTool(
  "pokedex_add_comment",
  {
    title: "Add Comment",
    description:
      "Add a comment or follow-up note to an existing issue. Useful for providing additional context, reproduction steps, or status updates.",
    inputSchema: {
      issue_id: z.string().describe("The issue ID to comment on"),
      comment: z.string().describe("The comment text to add"),
      author: z.string().describe("Your name or username"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ issue_id, comment, author }) => {
    if (!checkRateLimit(`write:${author}`, true)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Rate limit exceeded. Try again later." }) }] };
    }

    const db = getDb();
    const safeId = sanitizeString(issue_id, 128);
    if (!isValidDocId(safeId)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid issue ID format", issue_id: safeId }) }] };
    }
    const safeComment = sanitizeString(comment, MAX_COMMENT_LENGTH);
    const safeAuthor = sanitizeString(author, MAX_NAME_LENGTH);
    const docRef = db.collection("issues").doc(safeId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Issue not found", issue_id: safeId }) }] };
    }

    const noteEntry = {
      text: safeComment,
      author: safeAuthor,
      timestamp: new Date().toISOString(),
    };

    await docRef.update({
      notes: admin.firestore.FieldValue.arrayUnion(noteEntry),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const data = doc.data()!;
    const existingNotes = data.notes || [];

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        issueId: safeId,
        summary: data.summary,
        commentAdded: noteEntry,
        totalComments: existingNotes.length + 1,
        message: `Comment added to issue ${safeId}.`,
      }, null, 2) }],
    };
  }
);

// Tool 8: Add context to an existing issue (reporter-facing, uses threadContext)
server.registerTool(
  "pokedex_add_context",
  {
    title: "Add Context to Issue",
    description:
      "Add follow-up context, reproduction steps, or additional details to an existing open issue without creating a new one. This is visible to reporters and engineers. Use this when you have more information about a previously reported issue.",
    inputSchema: {
      issue_id: z.string().describe("The issue ID to add context to"),
      context: z.string().describe("The additional context, details, reproduction steps, or follow-up information"),
      author: z.string().describe("Your name or username"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ issue_id, context, author }) => {
    if (!checkRateLimit(`write:${author}`, true)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Rate limit exceeded. Try again later." }) }] };
    }

    const db = getDb();
    const safeId = sanitizeString(issue_id, 128);
    if (!isValidDocId(safeId)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid issue ID format", issue_id: safeId }) }] };
    }
    const safeContext = sanitizeString(context, MAX_CONTEXT_LENGTH);
    const safeAuthor = sanitizeString(author, MAX_NAME_LENGTH);
    const docRef = db.collection("issues").doc(safeId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Issue not found", issue_id: safeId }) }] };
    }

    const data = doc.data()!;
    const status = data.status || "open";
    if (["closed", "fixed", "wontfix"].includes(status)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Issue is closed. Reopen it first.", issue_id: safeId, status }) }] };
    }

    const contextEntry = {
      text: `${safeAuthor}: ${safeContext}`,
      addedAt: new Date().toISOString(),
    };

    // Use arrayUnion to prevent race conditions with concurrent context additions
    await docRef.update({
      threadContext: admin.firestore.FieldValue.arrayUnion(contextEntry),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Post context notification to Discord (works for both pending and approved issues)
    const updatedDoc = await docRef.get();
    const updatedData = updatedDoc.data()!;
    await postContextToDiscord(updatedData, safeId, safeContext, safeAuthor);

    const totalEntries = updatedData.threadContext?.length || 1;

    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        issueId: safeId,
        summary: data.summary,
        contextAdded: { text: safeContext, author: safeAuthor },
        totalContextEntries: totalEntries,
        message: `Context added to issue ${safeId}. Total context entries: ${totalEntries}. Discord notification sent.`,
      }, null, 2) }],
    };
  }
);

// --- Start (stdio or HTTP) ---
async function main() {
  const mode = process.env.MCP_TRANSPORT || "stdio";

  if (mode === "http") {
    const app = express();
    app.use(express.json());

    // Health check
    app.get("/health", (_req, res) => {
      res.json({ status: "ok", server: "pokedex-mcp-server", version: "1.0.0" });
    });

    // MCP endpoint
    app.post("/mcp", async (req, res) => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    const port = parseInt(process.env.PORT || "3001");
    app.listen(port, () => {
      console.log(`Pokedex MCP server running on http://0.0.0.0:${port}/mcp`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Pokedex MCP server running on stdio");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
