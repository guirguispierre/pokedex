"use client";

import { useState, useMemo } from "react";
import RecipeCard from "@/components/RecipeCard";
import StatCard from "@/components/StatCard";
import { useCollection } from "@/hooks/useFirestore";

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
  status?: string;
  reviewedBy?: string;
  createdAt?: { seconds: number } | null;
}

export default function RecipesPage() {
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);

  const { data: recipes, loading } = useCollection<Recipe>("recipes", {
    where: [["status", "==", "approved"]],
    orderBy: ["shareCount", "desc"],
    limit: 500,
  });

  // Compute stats
  const stats = useMemo(() => {
    const sources = new Set(recipes.map((r) => r.source).filter(Boolean));
    const contributors = new Set<string>();
    recipes.forEach((r) =>
      (r.sharedBy || []).forEach((s) => contributors.add(s.name))
    );
    const tags = new Set<string>();
    recipes.forEach((r) => (r.tags || []).forEach((t) => tags.add(t)));

    return {
      total: recipes.length,
      sources: sources.size,
      contributors: contributors.size,
      tags: tags.size,
    };
  }, [recipes]);

  // Compute tag and source counts for filter chips
  const { tagCounts, sourceCounts } = useMemo(() => {
    const tc: Record<string, number> = {};
    const sc: Record<string, number> = {};

    recipes.forEach((r) => {
      if (r.source) sc[r.source] = (sc[r.source] || 0) + 1;
      (r.tags || []).forEach((t) => {
        tc[t] = (tc[t] || 0) + 1;
      });
    });

    return { tagCounts: tc, sourceCounts: sc };
  }, [recipes]);

  // Filter recipes
  const filtered = useMemo(() => {
    let result = recipes;

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) =>
          (r.title || "").toLowerCase().includes(q) ||
          (r.description || "").toLowerCase().includes(q) ||
          (r.source || "").toLowerCase().includes(q) ||
          (r.referCode || "").toLowerCase().includes(q) ||
          (r.tags || []).some((t) => t.includes(q))
      );
    }

    if (activeTag) {
      result = result.filter((r) => (r.tags || []).includes(activeTag));
    }

    if (activeSource) {
      result = result.filter((r) => r.source === activeSource);
    }

    return result;
  }, [recipes, search, activeTag, activeSource]);

  const sortedSources = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const sortedTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white">Community Recipes</h1>
        <p className="text-sm text-discord-muted mt-1">
          Shared by the community in #show-and-tell
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          label="Total Recipes"
          value={loading ? "..." : stats.total}
          color="yellow"
          icon={"\uD83C\uDF73"}
        />
        <StatCard
          label="Sources"
          value={loading ? "..." : stats.sources}
          color="blurple"
          icon={"\uD83C\uDF10"}
        />
        <StatCard
          label="Contributors"
          value={loading ? "..." : stats.contributors}
          color="green"
          icon={"\uD83D\uDC65"}
        />
        <StatCard
          label="Tags"
          value={loading ? "..." : stats.tags}
          color="yellow"
          icon={"\uD83C\uDFF7\uFE0F"}
        />
      </div>

      {/* Search */}
      <div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search recipes by name, tag, source, or code..."
          className="w-full bg-discord-tertiary text-discord-text rounded-lg px-4 py-2.5 text-sm border border-discord-border focus:border-discord-blurple focus:outline-none transition-colors placeholder:text-discord-muted"
        />
      </div>

      {/* Filter chips */}
      {(sortedSources.length > 0 || sortedTags.length > 0) && (
        <div className="flex gap-2 flex-wrap">
          {/* Clear filter */}
          {(activeTag || activeSource) && (
            <button
              onClick={() => {
                setActiveTag(null);
                setActiveSource(null);
              }}
              className="text-[11px] px-2.5 py-1 rounded-full border border-discord-red/30 bg-discord-red/10 text-discord-red hover:bg-discord-red/20 transition-colors"
            >
              Clear filter
            </button>
          )}

          {/* Source chips */}
          {sortedSources.map(([source, count]) => (
            <button
              key={`s-${source}`}
              onClick={() => {
                setActiveSource(activeSource === source ? null : source);
                setActiveTag(null);
              }}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                activeSource === source
                  ? "border-discord-blurple bg-discord-blurple/20 text-white"
                  : "border-discord-border bg-discord-secondary text-discord-muted hover:text-discord-text hover:bg-discord-secondary/80"
              }`}
            >
              {source} ({count})
            </button>
          ))}

          {/* Tag chips */}
          {sortedTags.map(([tag, count]) => (
            <button
              key={`t-${tag}`}
              onClick={() => {
                setActiveTag(activeTag === tag ? null : tag);
                setActiveSource(null);
              }}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                activeTag === tag
                  ? "border-discord-yellow bg-discord-yellow/20 text-white"
                  : "border-discord-border bg-discord-secondary text-discord-muted hover:text-discord-text hover:bg-discord-secondary/80"
              }`}
            >
              #{tag} ({count})
            </button>
          ))}
        </div>
      )}

      {/* Recipe grid */}
      {loading ? (
        <div className="text-center py-12">
          <div className="w-8 h-8 border-2 border-discord-border border-t-discord-blurple rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-discord-muted">Loading recipes...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-lg text-white mb-1">
            {recipes.length === 0 ? "No recipes yet" : "No matches"}
          </p>
          <p className="text-sm text-discord-muted">
            {recipes.length === 0
              ? "Use /recipes scrape in Discord to import from #show-and-tell"
              : "Try a different search or filter"}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((recipe) => (
            <RecipeCard
              key={recipe.id}
              title={recipe.title}
              url={recipe.url}
              source={recipe.source}
              referCode={recipe.referCode}
              description={recipe.description}
              tags={recipe.tags}
              shareCount={recipe.shareCount}
              sharedBy={recipe.sharedBy}
              reviewedBy={recipe.reviewedBy}
            />
          ))}
        </div>
      )}

      {/* Footer count */}
      {!loading && filtered.length > 0 && (
        <p className="text-xs text-discord-muted text-center pb-4">
          Showing {filtered.length} of {recipes.length} recipes
        </p>
      )}
    </div>
  );
}
