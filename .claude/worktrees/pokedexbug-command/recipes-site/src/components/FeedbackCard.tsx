"use client";

interface FeedbackPost {
  id: string;
  threadName: string;
  authorName: string;
  content: string;
  summary?: string;
  category?: string;
  priority?: string;
  forumTags?: string[];
  attachments?: { url: string; name: string }[];
  createdAt?: { seconds: number };
}

const categoryColors: Record<string, string> = {
  bug: "bg-red-500/10 text-red-400 border-red-500/20",
  feature_request: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  ux_issue: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  performance: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  security: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  suggestion: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  other: "bg-gray-500/10 text-gray-400 border-gray-500/20",
};

const priorityIndicators: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-green-500",
};

function formatCategory(cat: string): string {
  return cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function timeAgo(seconds: number): string {
  const diff = Math.floor(Date.now() / 1000 - seconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

export default function FeedbackCard({ post }: { post: FeedbackPost }) {
  const catColor =
    categoryColors[post.category || ""] ||
    "bg-indigo-500/10 text-indigo-400 border-indigo-500/20";
  const priorityDot = priorityIndicators[post.priority || ""] || "bg-gray-500";

  return (
    <div className="glass rounded-xl p-5 transition-all duration-200 hover:bg-bg-hover hover:border-white/10">
      {/* Header */}
      <div className="flex items-start gap-3">
        {/* Priority dot */}
        <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${priorityDot}`} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-gray-100 line-clamp-2">
            {post.threadName || post.summary || "Untitled Feedback"}
          </h3>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[11px] text-gray-500">
              by <span className="text-gray-400">{post.authorName}</span>
            </span>
            {post.createdAt?.seconds && (
              <span className="text-[11px] text-gray-600">
                {timeAgo(post.createdAt.seconds)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Summary / Content preview */}
      <p className="text-xs text-gray-400 mt-3 line-clamp-3 leading-relaxed">
        {post.summary || post.content}
      </p>

      {/* Full content if different from summary */}
      {post.summary && post.content !== post.summary && (
        <p className="text-[11px] text-gray-600 mt-2 line-clamp-2 leading-relaxed">
          {post.content}
        </p>
      )}

      {/* Attachments */}
      {post.attachments && post.attachments.length > 0 && (
        <div className="flex gap-2 mt-3">
          {post.attachments.slice(0, 3).map((a, i) => (
            <a
              key={i}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] px-2 py-1 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/15 hover:bg-indigo-500/20 transition-colors"
            >
              {a.name || `Image ${i + 1}`}
            </a>
          ))}
        </div>
      )}

      {/* Tags */}
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        {post.category && (
          <span
            className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${catColor}`}
          >
            {formatCategory(post.category)}
          </span>
        )}
        {(post.forumTags || []).map((tag) => (
          <span
            key={tag}
            className="text-[10px] px-1.5 py-0.5 rounded bg-gold/5 text-gold-soft border border-gold/10"
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}
