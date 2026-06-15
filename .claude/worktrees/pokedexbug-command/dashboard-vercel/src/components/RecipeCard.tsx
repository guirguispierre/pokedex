"use client";

interface Sharer {
  name: string;
  sharedAt?: string;
}

interface RecipeCardProps {
  title: string;
  url: string;
  source?: string;
  referCode?: string;
  description?: string;
  tags?: string[];
  shareCount?: number;
  sharedBy?: Sharer[];
  reviewedBy?: string;
}

const sourceColors: Record<string, string> = {
  Poke: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  Pokepaste: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  Showdown: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  Smogon: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  YouTube: "bg-red-500/10 text-red-400 border-red-500/20",
  Reddit: "bg-orange-500/10 text-orange-400 border-orange-500/20",
};

export default function RecipeCard({
  title,
  url,
  source,
  referCode,
  description,
  tags,
  shareCount,
  sharedBy,
  reviewedBy,
}: RecipeCardProps) {
  const sourceColor =
    sourceColors[source || ""] ||
    "bg-discord-blurple/10 text-discord-blurple border-discord-blurple/20";

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group block bg-discord-secondary rounded-lg p-5 border border-transparent hover:border-discord-border transition-all duration-150 hover:bg-discord-secondary/80 relative"
    >
      {/* External link icon */}
      <svg
        className="absolute top-4 right-4 w-4 h-4 text-discord-muted group-hover:text-discord-blurple transition-colors"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
        />
      </svg>

      {/* Title */}
      <h3 className="text-sm font-semibold text-white pr-6 line-clamp-2 group-hover:text-discord-blurple transition-colors">
        {title || "Untitled Recipe"}
      </h3>

      {/* Refer code */}
      {referCode && (
        <div className="mt-2">
          <code className="text-xs px-2 py-0.5 rounded bg-discord-tertiary text-discord-yellow border border-discord-border font-mono">
            {referCode}
          </code>
        </div>
      )}

      {/* Description */}
      {description && (
        <p className="text-xs text-discord-muted mt-2 line-clamp-2">
          {description}
        </p>
      )}

      {/* Meta row */}
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        {source && (
          <span
            className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${sourceColor}`}
          >
            {source}
          </span>
        )}

        {(shareCount ?? 0) > 1 && (
          <span className="text-[10px] text-discord-muted">
            <strong className="text-discord-text">{shareCount}</strong> shares
          </span>
        )}

        {sharedBy?.[0]?.name && (
          <span className="text-[10px] text-discord-muted">
            by {sharedBy[0].name}
          </span>
        )}
      </div>

      {/* Tags */}
      {tags && tags.length > 0 && (
        <div className="flex gap-1.5 mt-3 flex-wrap">
          {tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="text-[10px] px-1.5 py-0.5 rounded bg-discord-blurple/10 text-discord-blurple border border-discord-blurple/15"
            >
              {tag}
            </span>
          ))}
          {tags.length > 4 && (
            <span className="text-[10px] text-discord-muted">
              +{tags.length - 4}
            </span>
          )}
        </div>
      )}
    </a>
  );
}
