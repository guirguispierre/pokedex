"use client";

import { useState } from "react";
import ProtectedRoute from "@/components/ProtectedRoute";
import { useCollection } from "@/hooks/useFirestore";

const actionIcons: Record<string, string> = {
  warn: "\u26a0\ufe0f", timeout: "\ud83d\udd07", kick: "\ud83d\udc62",
  ban: "\ud83d\udd28", automod: "\ud83e\udd16", remove_timeout: "\u2705",
};

export default function LogsPage() {
  const [actionFilter, setActionFilter] = useState("");
  const { data: logs, loading } = useCollection("mod_logs", {
    orderBy: ["timestamp", "desc"] as [string, "asc" | "desc"],
    limit: 100,
  });

  const filtered = actionFilter ? logs.filter((l: any) => l.action === actionFilter) : logs;

  const downloadCsv = () => {
    const csvEscape = (val: string) => {
      const s = String(val ?? "");
      if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const headers = ["Date", "Action", "Target", "Moderator", "Reason", "Source"];
    const rows = filtered.map((l: any) => [
      l.timestamp ? new Date(l.timestamp.seconds * 1000).toISOString() : "",
      l.action, l.targetUser, l.moderator, l.reason || "", l.source,
    ].map(csvEscape));
    const csv = [headers.join(","), ...rows.map((r: string[]) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `mod-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <ProtectedRoute requiredTier="moderator">
      <div>
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold">Mod Logs</h1>
          <button onClick={downloadCsv} className="text-xs bg-discord-tertiary text-discord-muted hover:text-discord-text px-3 py-1.5 rounded-md">
            Export CSV
          </button>
        </div>

        <div className="flex gap-2 mb-4 flex-wrap">
          {["", "warn", "timeout", "kick", "ban", "automod", "remove_timeout"].map((a) => (
            <button key={a} onClick={() => setActionFilter(a)}
              className={`px-3 py-1 rounded-md text-xs transition-colors ${actionFilter === a ? "bg-discord-accent text-white" : "bg-discord-tertiary text-discord-muted hover:text-discord-text"}`}>
              {a || "All"}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-2">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="animate-pulse h-12 bg-discord-secondary rounded-lg" />)}</div>
        ) : filtered.length === 0 ? (
          <p className="text-discord-muted text-sm">No logs found</p>
        ) : (
          <div className="space-y-1">
            {filtered.map((log: any) => (
              <div key={log.id} className="bg-discord-secondary rounded-lg px-4 py-3 flex items-center gap-3">
                <span className="text-lg flex-shrink-0">{actionIcons[log.action] || "\ud83d\udccb"}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium capitalize">{log.action?.replace("_", " ")}</span>
                    <span className="text-xs text-discord-muted">{log.targetUser}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-discord-tertiary text-discord-muted">{log.source}</span>
                  </div>
                  <p className="text-xs text-discord-muted truncate">{log.reason || "No reason"} &middot; by {log.moderator}</p>
                  {log.evidence && <p className="text-xs text-discord-muted mt-1 bg-discord-tertiary rounded px-2 py-1">{log.evidence}</p>}
                </div>
                <span className="text-xs text-discord-muted flex-shrink-0">
                  {log.timestamp ? new Date(log.timestamp.seconds * 1000).toLocaleString() : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </ProtectedRoute>
  );
}
