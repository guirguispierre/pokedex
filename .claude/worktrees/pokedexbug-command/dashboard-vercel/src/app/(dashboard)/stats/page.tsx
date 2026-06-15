"use client";

import { useEffect, useState } from "react";
import StatCard from "@/components/StatCard";
import { useCollection } from "@/hooks/useFirestore";

interface GuildStats {
  name: string;
  memberCount: number;
  onlineCount: number;
  channelCount: number;
  roleCount: number;
  createdAt: string;
}

export default function StatsPage() {
  const [guild, setGuild] = useState<GuildStats | null>(null);
  const [error, setError] = useState("");
  const { data: infractions } = useCollection("infractions", {
    orderBy: ["createdAt", "desc"] as [string, "asc" | "desc"],
    limit: 500,
  });
  const { data: issues } = useCollection("issues");

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then(setGuild)
      .catch((e) => setError(e.message));
  }, []);

  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

  const thisWeek = infractions.filter((i: any) => i.createdAt?.seconds * 1000 > weekAgo).length;
  const thisMonth = infractions.filter((i: any) => i.createdAt?.seconds * 1000 > monthAgo).length;
  const openIssues = issues.filter((i: any) => i.status === "open").length;
  const closedIssues = issues.filter((i: any) => i.status === "closed").length;

  const typeCounts: Record<string, number> = {};
  infractions.forEach((i: any) => {
    const t = i.type || i.action || "unknown";
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  });

  const serverAge = guild?.createdAt
    ? Math.floor((now - new Date(guild.createdAt).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  return (
    <div>
      <h1 className="text-xl font-bold mb-6">Stats</h1>

      {error && <p className="text-red-400 text-sm mb-4">Failed to load server stats: {error}</p>}

      <h2 className="text-sm font-semibold text-discord-muted mb-3">Server</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Members" value={guild?.memberCount ?? "..."} color="blurple" />
        <StatCard label="Online" value={guild?.onlineCount ?? "..."} color="green" />
        <StatCard label="Channels" value={guild?.channelCount ?? "..."} color="blurple" />
        <StatCard label="Server Age" value={serverAge ? `${serverAge}d` : "..."} color="blurple" />
      </div>

      <h2 className="text-sm font-semibold text-discord-muted mb-3">Moderation</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="This Week" value={thisWeek} color="yellow" />
        <StatCard label="This Month" value={thisMonth} color="yellow" />
        <StatCard label="Total Infractions" value={infractions.length} color="red" />
        <StatCard label="Open Issues" value={openIssues} color="blurple" />
      </div>

      <h2 className="text-sm font-semibold text-discord-muted mb-3">Infraction Breakdown</h2>
      <div className="bg-discord-secondary rounded-lg p-4 mb-6">
        {Object.keys(typeCounts).length === 0 ? (
          <p className="text-sm text-discord-muted">No infractions recorded</p>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {Object.entries(typeCounts).sort(([, a], [, b]) => b - a).map(([type, count]) => (
              <div key={type} className="flex items-center justify-between">
                <span className="text-sm text-discord-muted capitalize">{type}</span>
                <span className="text-sm font-medium">{count}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <h2 className="text-sm font-semibold text-discord-muted mb-3">Issues</h2>
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Open" value={openIssues} color="green" />
        <StatCard label="Closed" value={closedIssues} color="red" />
        <StatCard label="Total" value={issues.length} color="blurple" />
      </div>
    </div>
  );
}
