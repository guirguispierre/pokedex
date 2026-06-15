"use client";

import { useCollection } from "@/hooks/useFirestore";

interface ModLog {
  id: string;
  action: string;
  targetUser: string;
  targetUserId: string;
  moderator: string;
  moderatorId: string;
  reason: string;
  source: string;
  timestamp: { seconds: number; nanoseconds: number } | null;
}

const actionIcons: Record<string, string> = {
  warn: "\u26a0\ufe0f",
  timeout: "\ud83d\udd07",
  kick: "\ud83d\udc62",
  ban: "\ud83d\udd28",
  automod: "\ud83e\udd16",
  "remove-timeout": "\ud83d\udd14",
};

const actionColors: Record<string, string> = {
  warn: "text-discord-yellow",
  timeout: "text-discord-yellow",
  kick: "text-orange-400",
  ban: "text-discord-red",
  automod: "text-discord-blurple",
  "remove-timeout": "text-discord-green",
};

function formatRelativeTime(timestamp: { seconds: number } | null): string {
  if (!timestamp) return "just now";
  const now = Date.now();
  const then = timestamp.seconds * 1000;
  const diff = now - then;

  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(then).toLocaleDateString();
}

function SkeletonRow() {
  return (
    <div className="flex items-start gap-3 px-4 py-3 animate-pulse">
      <div className="w-8 h-8 rounded-lg bg-discord-tertiary shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-3.5 bg-discord-tertiary rounded w-3/4" />
        <div className="h-3 bg-discord-tertiary rounded w-1/2" />
      </div>
      <div className="h-3 bg-discord-tertiary rounded w-12 shrink-0" />
    </div>
  );
}

export default function ActivityFeed() {
  const { data: logs, loading } = useCollection<ModLog>("mod_logs", {
    orderBy: ["timestamp", "desc"],
    limit: 20,
  });

  return (
    <div className="bg-discord-secondary rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-discord-border">
        <h3 className="text-sm font-semibold text-white">Recent Activity</h3>
      </div>

      <div className="divide-y divide-discord-border/50 max-h-[480px] overflow-y-auto">
        {loading ? (
          <>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </>
        ) : logs.length === 0 ? (
          <div className="px-4 py-8 text-center text-discord-muted text-sm">
            No recent activity
          </div>
        ) : (
          logs.map((log) => (
            <div
              key={log.id}
              className="flex items-start gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors"
            >
              <span className="w-8 h-8 rounded-lg bg-discord-tertiary flex items-center justify-center text-sm shrink-0">
                {actionIcons[log.action] || "\ud83d\udcdd"}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-discord-text leading-snug">
                  <span className={`font-medium ${actionColors[log.action] || "text-white"}`}>
                    {log.action.charAt(0).toUpperCase() + log.action.slice(1)}
                  </span>{" "}
                  <span className="text-white font-medium">{log.targetUser}</span>
                </p>
                {log.reason && (
                  <p className="text-xs text-discord-muted mt-0.5 truncate">
                    {log.reason}
                  </p>
                )}
                <p className="text-xs text-discord-muted/70 mt-0.5">
                  by {log.moderator}
                  {log.source === "dashboard" && (
                    <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-discord-blurple/10 text-discord-blurple font-medium">
                      Dashboard
                    </span>
                  )}
                </p>
              </div>
              <span className="text-[11px] text-discord-muted shrink-0 pt-0.5">
                {formatRelativeTime(log.timestamp)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
