"use client";

import { useState, useEffect, useCallback } from "react";
import ProtectedRoute from "@/components/ProtectedRoute";
import IssueCard from "@/components/IssueCard";

export default function IssuesPage() {
  const [statusFilter, setStatusFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [issues, setIssues] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchIssues = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (priorityFilter) params.set("priority", priorityFilter);

    try {
      const res = await fetch(`/api/issues?${params}`);
      if (res.ok) {
        const data = await res.json();
        setIssues(data.issues);
      }
    } catch (e) {
      console.error("Failed to fetch issues:", e);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, priorityFilter]);

  useEffect(() => {
    fetchIssues();
  }, [fetchIssues]);

  return (
    <ProtectedRoute requiredTier="viewer">
      <div>
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold">Issues</h1>
          <button
            onClick={fetchIssues}
            className="text-xs bg-discord-tertiary text-discord-muted hover:text-discord-text px-3 py-1.5 rounded-md transition-colors"
          >
            Refresh
          </button>
        </div>

        <div className="flex gap-2 mb-4 flex-wrap">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-discord-tertiary border border-discord-border rounded-md px-3 py-1.5 text-sm text-discord-text"
          >
            <option value="">All Status</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="escalated">Escalated</option>
            <option value="fixed">Fixed</option>
            <option value="merged">Merged</option>
            <option value="closed">Closed</option>
            <option value="wontfix">Won&apos;t Fix</option>
          </select>
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            className="bg-discord-tertiary border border-discord-border rounded-md px-3 py-1.5 text-sm text-discord-text"
          >
            <option value="">All Priority</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse h-16 bg-discord-secondary rounded-lg" />
            ))}
          </div>
        ) : issues.length === 0 ? (
          <p className="text-discord-muted text-sm">No issues found</p>
        ) : (
          <div className="space-y-2">
            {issues.map((issue: any) => (
              <IssueCard key={issue.id} issue={issue} />
            ))}
          </div>
        )}
      </div>
    </ProtectedRoute>
  );
}
