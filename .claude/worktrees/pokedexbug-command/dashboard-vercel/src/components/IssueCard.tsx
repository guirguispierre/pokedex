import Link from "next/link";

const priorityColors: Record<string, string> = {
  critical: "bg-red-500 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-yellow-500 text-black",
  low: "bg-gray-500 text-white",
};

const statusDots: Record<string, string> = {
  open: "bg-green-500",
  acknowledged: "bg-blue-500",
  "in-progress": "bg-yellow-500",
  escalated: "bg-orange-500",
  fixed: "bg-emerald-500",
  merged: "bg-purple-500",
  closed: "bg-gray-500",
  wontfix: "bg-red-500",
  deleted: "bg-red-800",
};

export default function IssueCard({ issue }: { issue: any }) {
  return (
    <Link
      href={`/issues/${issue.id}`}
      className="block bg-discord-secondary rounded-lg p-4 hover:brightness-110 transition-all"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDots[issue.status] || statusDots.open}`} />
            <h3 className="text-sm font-medium text-discord-text truncate">
              {issue.summary || issue.text?.slice(0, 80) || "Untitled"}
            </h3>
          </div>
          <p className="text-xs text-discord-muted truncate">
            {issue.reporterName || "Unknown"} &middot;{" "}
            {issue.createdAt?.seconds
              ? new Date(issue.createdAt.seconds * 1000).toLocaleDateString()
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {issue.category && (
            <span className="px-2 py-0.5 rounded text-xs bg-discord-tertiary text-discord-muted">
              {issue.category}
            </span>
          )}
          {issue.priority && (
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${priorityColors[issue.priority] || ""}`}>
              {issue.priority}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
