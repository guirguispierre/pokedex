"use client";

import Link from "next/link";
import StatCard from "@/components/StatCard";
import ActivityFeed from "@/components/ActivityFeed";
import { useCollection } from "@/hooks/useFirestore";
import { useDocument } from "@/hooks/useFirestore";

interface Issue {
  id: string;
  status: string;
}

interface Infraction {
  id: string;
  type: string;
  timestamp: { seconds: number } | null;
}

interface AutomodConfig {
  id: string;
  enabled: boolean;
}

const quickLinks = [
  {
    href: "/moderation",
    label: "Moderation",
    icon: "\ud83d\udee1\ufe0f",
    description: "Manage infractions and user actions",
  },
  {
    href: "/issues",
    label: "Issues",
    icon: "\ud83d\udc1b",
    description: "View and triage reported issues",
  },
  {
    href: "/automod",
    label: "AutoMod",
    icon: "\u2699\ufe0f",
    description: "Configure automated moderation",
  },
  {
    href: "/recipes",
    label: "Recipes",
    icon: "\ud83c\udf73",
    description: "Community-shared recipes from #show-and-tell",
  },
];

export default function OverviewPage() {
  const { data: issues } = useCollection<Issue>("issues");
  const { data: infractions } = useCollection<Infraction>("infractions");
  const { data: automodConfig } = useDocument<AutomodConfig>("automod", "config");

  const openIssues = issues.filter((i) => i.status === "open").length;
  const totalInfractions = infractions.length;

  const now = Date.now();
  const activeTimeouts = infractions.filter((inf) => {
    if (inf.type !== "timeout") return false;
    if (!inf.timestamp) return false;
    const ts = inf.timestamp.seconds * 1000;
    return now - ts < 7 * 24 * 60 * 60 * 1000;
  }).length;

  const automodEnabled = automodConfig?.enabled ?? false;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Overview</h1>
        <p className="text-sm text-discord-muted mt-1">
          Server moderation at a glance
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Open Issues"
          value={openIssues}
          subText="Awaiting triage"
          color="red"
          icon="\ud83d\udc1b"
        />
        <StatCard
          label="Total Infractions"
          value={totalInfractions}
          subText="All time"
          color="yellow"
          icon="\u26a0\ufe0f"
        />
        <StatCard
          label="Active Timeouts"
          value={activeTimeouts}
          subText="Last 7 days"
          color="blurple"
          icon="\ud83d\udd07"
        />
        <StatCard
          label="AutoMod"
          value={automodEnabled ? "Enabled" : "Disabled"}
          subText={automodEnabled ? "Actively filtering" : "Not running"}
          color={automodEnabled ? "green" : "red"}
          icon="\ud83e\udd16"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Activity Feed - takes 2 cols */}
        <div className="lg:col-span-2">
          <ActivityFeed />
        </div>

        {/* Quick Actions */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-white px-1">
            Quick Actions
          </h3>
          {quickLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="group block bg-discord-secondary rounded-lg p-4 hover:bg-discord-secondary/80 transition-all duration-150 border border-transparent hover:border-discord-border"
            >
              <div className="flex items-center gap-3">
                <span className="text-lg w-9 h-9 rounded-lg bg-discord-tertiary flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                  {link.icon}
                </span>
                <div>
                  <p className="text-sm font-medium text-white group-hover:text-discord-blurple transition-colors">
                    {link.label}
                  </p>
                  <p className="text-xs text-discord-muted mt-0.5">
                    {link.description}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
