"use client";

interface Sharer {
  name: string;
  sharedAt?: string;
}

interface Recipe {
  id: string;
  title: string;
  url: string;
  source?: string;
  referCode?: string;
  description?: string;
  tags?: string[];
  shareCount?: number;
  sharedBy?: Sharer[];
}

const sourceColors: Record<string, string> = {
  Poke: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  Pokepaste: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  Showdown: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  Smogon: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  YouTube: "bg-red-500/10 text-red-400 border-red-500/20",
  Reddit: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  Pikalytics: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  Limitless: "bg-green-500/10 text-green-400 border-green-500/20",
};

export default function RecipeCard({ recipe: r }: { recipe: Recipe }) {
  const sourceColor =
    sourceColors[r.source || ""] ||
    "bg-indigo-500/10 text-indigo-400 border-indigo-500/20";

  return (
    <a
      href={r.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group glass rounded-xl p-5 block relative transition-all duration-200 hover:bg-bg-hover hover:border-white/10 hover:-translate-y-0.5"
    >
      {/* External link icon */}
      <svg
        className="absolute top-4 right-4 w-4 h-4 text-gray-700 group-hover:text-gold transition-colors"
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
      <h3 className="text-sm font-semibold text-gray-100 pr-6 line-clamp-2 group-hover:text-gold transition-colors">
        {r.title || "Untitled Recipe"}
      </h3>

      {/* Refer code */}
      {r.referCode && (
        <div className="mt-2">
          <code className="text-xs px-2 py-0.5 rounded bg-gold/5 text-gold-soft border border-gold/10 font-mono select-all">
            {r.referCode}
          </code>
        </div>
      )}

      {/* Description */}
      {r.description && (
        <p className="text-xs text-gray-500 mt-2 line-clamp-2">
          {r.description}
        </p>
      )}

      {/* Meta */}
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        {r.source && (
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${sourceColor}`}>
            {r.source}
          </span>
        )}
        {(r.shareCount ?? 0) > 1 && (
          <span className="text-[10px] text-gray-600">
            <strong className="text-gray-400">{r.shareCount}</strong> shares
          </span>
        )}
        {r.sharedBy?.[0]?.name && (
          <span className="text-[10px] text-gray-600">
            by {r.sharedBy[0].name}
          </span>
        )}
      </div>

      {/* Tags */}
      {r.tags && r.tags.length > 0 && (
        <div className="flex gap-1.5 mt-3 flex-wrap">
          {r.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/15"
            >
              {tag}
            </span>
          ))}
          {r.tags.length > 4 && (
            <span className="text-[10px] text-gray-600">+{r.tags.length - 4}</span>
          )}
        </div>
      )}
    </a>
  );
}
