"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import ProtectedRoute from "@/components/ProtectedRoute";

const statusOptions = ["open", "acknowledged", "escalated", "fixed", "merged", "closed", "wontfix", "deleted"];
const priorityOptions = ["critical", "high", "medium", "low"];

export default function IssueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [issue, setIssue] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchIssue = useCallback(async () => {
    try {
      const res = await fetch(`/api/issues/${id}`);
      if (res.ok) {
        const data = await res.json();
        setIssue(data.issue);
      }
    } catch (e) {
      console.error("Failed to fetch issue:", e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchIssue();
  }, [fetchIssue]);

  const updateIssue = async (updates: Record<string, string>) => {
    setSaving(true);
    await fetch(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    await fetchIssue();
    setSaving(false);
  };

  const addComment = async () => {
    if (!comment.trim()) return;
    setSaving(true);
    await fetch(`/api/issues/${id}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: comment }),
    });
    setComment("");
    await fetchIssue();
    setSaving(false);
  };

  if (loading) return <div className="animate-pulse h-64 bg-discord-secondary rounded-lg" />;
  if (!issue) return <p className="text-discord-muted">Issue not found</p>;

  return (
    <ProtectedRoute requiredTier="viewer">
      <div className="max-w-3xl">
        <button onClick={() => router.back()} className="text-sm text-discord-muted hover:text-discord-text mb-4 transition-colors">
          &larr; Back to Issues
        </button>

        <div className="bg-discord-secondary rounded-lg p-6 mb-4">
          <h1 className="text-lg font-bold mb-2">{issue.summary || issue.text?.slice(0, 100) || "Untitled"}</h1>
          {issue.text && <p className="text-sm text-discord-muted mb-4">{issue.text}</p>}

          <div className="flex gap-4 mb-4">
            <div>
              <label className="block text-xs text-discord-muted mb-1">Status</label>
              <select value={issue.status || "open"} onChange={(e) => updateIssue({ status: e.target.value })} disabled={saving}
                className="bg-discord-tertiary border border-discord-border rounded-md px-2 py-1 text-sm text-discord-text">
                {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-discord-muted mb-1">Priority</label>
              <select value={issue.priority || ""} onChange={(e) => updateIssue({ priority: e.target.value })} disabled={saving}
                className="bg-discord-tertiary border border-discord-border rounded-md px-2 py-1 text-sm text-discord-text">
                <option value="">Unclassified</option>
                {priorityOptions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><span className="text-discord-muted">Reporter:</span> <span>{issue.reporterName || "Unknown"}</span></div>
            <div><span className="text-discord-muted">Category:</span> <span>{issue.category || "None"}</span></div>
            <div><span className="text-discord-muted">Assignee:</span> <span>{issue.assigneeName || "Unassigned"}</span></div>
            <div><span className="text-discord-muted">Created:</span> <span>{issue.createdAt?.seconds ? new Date(issue.createdAt.seconds * 1000).toLocaleString() : "Unknown"}</span></div>
          </div>
        </div>

        {issue.threadContext?.length > 0 && (
          <div className="bg-discord-secondary rounded-lg p-4 mb-4">
            <h2 className="text-sm font-semibold mb-3">Context</h2>
            <div className="space-y-2">
              {issue.threadContext.map((ctx: any, i: number) => (
                <div key={i} className="text-sm text-discord-muted bg-discord-tertiary rounded p-2">{ctx.text}</div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-discord-secondary rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-3">Comments</h2>
          <div className="space-y-3 mb-4">
            {(issue.notes || []).map((note: any, i: number) => (
              <div key={i} className="bg-discord-tertiary rounded-lg p-3">
                <div className="flex justify-between mb-1">
                  <span className="text-xs font-medium">{note.authorName}</span>
                  <span className="text-xs text-discord-muted">{note.createdAt ? new Date(note.createdAt).toLocaleString() : ""}</span>
                </div>
                <p className="text-sm text-discord-muted">{note.text}</p>
              </div>
            ))}
            {(!issue.notes || issue.notes.length === 0) && <p className="text-xs text-discord-muted">No comments yet</p>}
          </div>
          <div className="flex gap-2">
            <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addComment()}
              placeholder="Add a comment..." className="flex-1 bg-discord-tertiary border border-discord-border rounded-md px-3 py-2 text-sm text-discord-text placeholder-discord-muted focus:outline-none focus:border-discord-accent" />
            <button onClick={addComment} disabled={saving || !comment.trim()} className="bg-discord-accent text-white px-4 py-2 rounded-md text-sm disabled:opacity-50">Send</button>
          </div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
