"use client";

import { useState } from "react";
import { useCollection } from "@/hooks/useFirestore";

interface Infraction {
  id: string;
  type: string;
  targetUser: string;
  targetUserId: string;
  moderator: string;
  reason: string;
  source: string;
  timestamp: { seconds: number } | null;
}

type FilterType = "all" | "warn" | "timeout" | "kick" | "ban" | "automod";

const filterOptions: { value: FilterType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "warn", label: "Warn" },
  { value: "timeout", label: "Timeout" },
  { value: "kick", label: "Kick" },
  { value: "ban", label: "Ban" },
  { value: "automod", label: "AutoMod" },
];

const typeIcons: Record<string, string> = {
  warn: "\u26a0\ufe0f",
  timeout: "\ud83d\udd07",
  kick: "\ud83d\udc62",
  ban: "\ud83d\udd28",
  automod: "\ud83e\udd16",
};

const typeBadgeColors: Record<string, string> = {
  warn: "bg-discord-yellow/10 text-discord-yellow",
  timeout: "bg-discord-yellow/10 text-discord-yellow",
  kick: "bg-orange-500/10 text-orange-400",
  ban: "bg-discord-red/10 text-discord-red",
  automod: "bg-discord-blurple/10 text-discord-blurple",
};

function formatDate(timestamp: { seconds: number } | null): string {
  if (!timestamp) return "-";
  return new Date(timestamp.seconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface InfractionTableProps {
  filterUserId?: string;
}

export default function InfractionTable({ filterUserId }: InfractionTableProps) {
  const [filter, setFilter] = useState<FilterType>("all");

  const constraints: Parameters<typeof useCollection>[1] = {
    orderBy: ["timestamp", "desc"],
    limit: 100,
  };

  if (filterUserId) {
    constraints.where = [["targetUserId", "==", filterUserId]];
  }

  const { data: infractions, loading } = useCollection<Infraction>(
    "infractions",
    constraints
  );

  const filtered =
    filter === "all"
      ? infractions
      : infractions.filter((inf) => inf.type === filter);

  return (
    <div className="bg-discord-secondary rounded-lg overflow-hidden">
      {/* Filter bar */}
      <div className="px-4 py-3 border-b border-discord-border flex items-center gap-2 overflow-x-auto">
        {filterOptions.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value)}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              filter === opt.value
                ? "bg-discord-blurple/20 text-discord-blurple"
                : "text-discord-muted hover:text-white hover:bg-white/5"
            }`}
          >
            {opt.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-discord-muted shrink-0">
          {filtered.length} result{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-discord-border/50">
              <th className="text-left px-4 py-2.5 text-xs font-medium text-discord-muted uppercase tracking-wider">
                Type
              </th>
              {!filterUserId && (
                <th className="text-left px-4 py-2.5 text-xs font-medium text-discord-muted uppercase tracking-wider">
                  User
                </th>
              )}
              <th className="text-left px-4 py-2.5 text-xs font-medium text-discord-muted uppercase tracking-wider">
                Reason
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-discord-muted uppercase tracking-wider">
                Moderator
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-discord-muted uppercase tracking-wider">
                Date
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-discord-border/30">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  <td className="px-4 py-3">
                    <div className="h-5 bg-discord-tertiary rounded w-16" />
                  </td>
                  {!filterUserId && (
                    <td className="px-4 py-3">
                      <div className="h-4 bg-discord-tertiary rounded w-24" />
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="h-4 bg-discord-tertiary rounded w-40" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 bg-discord-tertiary rounded w-20" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="h-4 bg-discord-tertiary rounded w-28" />
                  </td>
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={filterUserId ? 4 : 5}
                  className="px-4 py-8 text-center text-discord-muted"
                >
                  No infractions found
                </td>
              </tr>
            ) : (
              filtered.map((inf) => (
                <tr
                  key={inf.id}
                  className="hover:bg-white/[0.02] transition-colors"
                >
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${
                        typeBadgeColors[inf.type] || "bg-discord-tertiary text-discord-muted"
                      }`}
                    >
                      <span>{typeIcons[inf.type] || ""}</span>
                      {inf.type}
                    </span>
                  </td>
                  {!filterUserId && (
                    <td className="px-4 py-2.5 text-white font-medium">
                      {inf.targetUser}
                    </td>
                  )}
                  <td className="px-4 py-2.5 text-discord-text max-w-xs truncate">
                    {inf.reason}
                  </td>
                  <td className="px-4 py-2.5 text-discord-muted">
                    {inf.moderator}
                  </td>
                  <td className="px-4 py-2.5 text-discord-muted text-xs whitespace-nowrap">
                    {formatDate(inf.timestamp)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
