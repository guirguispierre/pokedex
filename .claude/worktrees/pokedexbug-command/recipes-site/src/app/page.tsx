"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { db } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
} from "firebase/firestore";
import RecipeCard from "@/components/RecipeCard";
import Link from "next/link";

const APP_VERSION = "1.0.1";
const CACHE_KEY = "pokedex_recipes_cache";
const CACHE_TTL = 60_000; // 1 minute

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
}

interface CacheData {
  recipes: Recipe[];
  timestamp: number;
  version: string;
}

function loadCache(): CacheData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data: CacheData = JSON.parse(raw);
    if (data.version !== APP_VERSION) return null;
    if (Date.now() - data.timestamp > CACHE_TTL) return null;
    return data;
  } catch {
    return null;
  }
}

function saveCache(recipes: Recipe[]) {
  try {
    const data: CacheData = { recipes, timestamp: Date.now(), version: APP_VERSION };
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {}
}

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const fetchRecipes = useCallback(async (useCache = true) => {
    // Try cache first for instant load
    if (useCache) {
      const cached = loadCache();
      if (cached) {
        setRecipes(cached.recipes);
        setLoading(false);
        setLastFetched(new Date(cached.timestamp));
        // Still fetch fresh data in background
        fetchRecipes(false);
        return;
      }
    }

    try {
      const q = query(
        collection(db, "recipes"),
        where("status", "==", "approved"),
        orderBy("shareCount", "desc")
      );
      const snapshot = await getDocs(q);
      const docs = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Recipe[];
      setRecipes(docs);
      saveCache(docs);
      setLastFetched(new Date());
    } catch (err) {
      console.error("Firestore error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecipes(true);
  }, [fetchRecipes]);

  // Stats
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

  // Filter chips data
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

  // Filtered results
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
    if (activeTag) result = result.filter((r) => (r.tags || []).includes(activeTag));
    if (activeSource) result = result.filter((r) => r.source === activeSource);
    return result;
  }, [recipes, search, activeTag, activeSource]);

  const sortedSources = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const sortedTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Header */}
      <header className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold bg-gradient-to-r from-gold to-gold-soft bg-clip-text text-transparent">
          Community Recipes
        </h1>
        <p className="text-gray-400 mt-2 text-sm sm:text-base">
          Shared by the community in #show-and-tell
        </p>
        <Link
          href="/feedback"
          className="inline-block mt-3 text-xs text-gold/60 hover:text-gold transition-colors"
        >
          View Community Feedback &rarr;
        </Link>
      </header>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {[
          { label: "Recipes", value: stats.total, icon: "\uD83C\uDF73" },
          { label: "Sources", value: stats.sources, icon: "\uD83C\uDF10" },
          { label: "Contributors", value: stats.contributors, icon: "\uD83D\uDC65" },
          { label: "Tags", value: stats.tags, icon: "\uD83C\uDFF7\uFE0F" },
        ].map((s) => (
          <div key={s.label} className="glass rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-gold">
              {loading ? "..." : s.value}
            </div>
            <div className="text-xs text-gray-500 uppercase tracking-wide mt-1">
              {s.icon} {s.label}
            </div>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="mb-5">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, tag, source, or code..."
          className="w-full glass rounded-xl px-4 py-3 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-gold/50 transition-all"
        />
      </div>

      {/* Filter chips */}
      {(sortedSources.length > 0 || sortedTags.length > 0) && (
        <div className="flex gap-2 flex-wrap mb-6">
          {(activeTag || activeSource) && (
            <button
              onClick={() => { setActiveTag(null); setActiveSource(null); }}
              className="text-[11px] px-3 py-1.5 rounded-full border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              Clear
            </button>
          )}

          {sortedSources.map(([source, count]) => (
            <button
              key={`s-${source}`}
              onClick={() => { setActiveSource(activeSource === source ? null : source); setActiveTag(null); }}
              className={`text-[11px] px-3 py-1.5 rounded-full border transition-colors ${
                activeSource === source
                  ? "border-gold/50 bg-gold-glow text-gold"
                  : "border-border bg-bg-card text-gray-500 hover:text-gray-300 hover:bg-bg-hover"
              }`}
            >
              {source} ({count})
            </button>
          ))}

          {sortedTags.map(([tag, count]) => (
            <button
              key={`t-${tag}`}
              onClick={() => { setActiveTag(activeTag === tag ? null : tag); setActiveSource(null); }}
              className={`text-[11px] px-3 py-1.5 rounded-full border transition-colors ${
                activeTag === tag
                  ? "border-accent/50 bg-accent/10 text-accent"
                  : "border-border bg-bg-card text-gray-500 hover:text-gray-300 hover:bg-bg-hover"
              }`}
            >
              #{tag} ({count})
            </button>
          ))}
        </div>
      )}

      {/* Recipe grid */}
      {loading ? (
        <div className="text-center py-20">
          <div className="w-10 h-10 border-2 border-border border-t-gold rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-500 text-sm">Loading recipes...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-xl text-gray-300 mb-2">
            {recipes.length === 0 ? "No recipes yet" : "No matches"}
          </p>
          <p className="text-sm text-gray-600">
            {recipes.length === 0
              ? "Use /recipes scrape in Discord to import from #show-and-tell"
              : "Try a different search or filter"}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((r) => (
            <RecipeCard key={r.id} recipe={r} />
          ))}
        </div>
      )}

      {/* Footer */}
      {!loading && filtered.length > 0 && (
        <p className="text-xs text-gray-600 text-center mt-8">
          Showing {filtered.length} of {recipes.length} recipes
        </p>
      )}

      <footer className="text-center mt-12 pb-8 space-y-2">
        <p className="text-xs text-gray-700">
          Powered by <span className="text-gold/60">Pokedex</span> — recipes shared by the community
        </p>
        <div className="flex items-center justify-center gap-3 text-[10px] text-gray-700">
          <span>v{APP_VERSION}</span>
          {lastFetched && (
            <span>Updated {lastFetched.toLocaleTimeString()}</span>
          )}
          <button
            onClick={() => { setLoading(true); fetchRecipes(false); }}
            className="text-gold/40 hover:text-gold transition-colors"
          >
            Refresh
          </button>
        </div>
      </footer>
    </div>
  );
}
