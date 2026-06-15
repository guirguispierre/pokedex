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
import FeedbackCard from "@/components/FeedbackCard";
import Link from "next/link";

const APP_VERSION = "1.0.0";
const CACHE_KEY = "pokedex_feedback_cache";
const CACHE_TTL = 60_000;

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

interface CacheData {
  posts: FeedbackPost[];
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

function saveCache(posts: FeedbackPost[]) {
  try {
    const data: CacheData = { posts, timestamp: Date.now(), version: APP_VERSION };
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {}
}

export default function FeedbackPage() {
  const [posts, setPosts] = useState<FeedbackPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activePriority, setActivePriority] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const fetchFeedback = useCallback(async (useCache = true) => {
    if (useCache) {
      const cached = loadCache();
      if (cached) {
        setPosts(cached.posts);
        setLoading(false);
        setLastFetched(new Date(cached.timestamp));
        fetchFeedback(false);
        return;
      }
    }

    try {
      const q = query(
        collection(db, "feedback"),
        where("status", "==", "published"),
        orderBy("createdAt", "desc")
      );
      const snapshot = await getDocs(q);
      const docs = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as FeedbackPost[];
      setPosts(docs);
      saveCache(docs);
      setLastFetched(new Date());
    } catch (err) {
      console.error("Firestore error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFeedback(true);
  }, [fetchFeedback]);

  // Stats
  const stats = useMemo(() => {
    const categories = new Set(posts.map((p) => p.category).filter(Boolean));
    const authors = new Set(posts.map((p) => p.authorName).filter(Boolean));
    return {
      total: posts.length,
      categories: categories.size,
      authors: authors.size,
    };
  }, [posts]);

  // Filter chips
  const { categoryCounts, priorityCounts } = useMemo(() => {
    const cc: Record<string, number> = {};
    const pc: Record<string, number> = {};
    posts.forEach((p) => {
      if (p.category) cc[p.category] = (cc[p.category] || 0) + 1;
      if (p.priority) pc[p.priority] = (pc[p.priority] || 0) + 1;
    });
    return { categoryCounts: cc, priorityCounts: pc };
  }, [posts]);

  // Filtered results
  const filtered = useMemo(() => {
    let result = posts;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (p) =>
          (p.threadName || "").toLowerCase().includes(q) ||
          (p.content || "").toLowerCase().includes(q) ||
          (p.summary || "").toLowerCase().includes(q) ||
          (p.authorName || "").toLowerCase().includes(q) ||
          (p.forumTags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    if (activeCategory) result = result.filter((p) => p.category === activeCategory);
    if (activePriority) result = result.filter((p) => p.priority === activePriority);
    return result;
  }, [posts, search, activeCategory, activePriority]);

  const sortedCategories = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const sortedPriorities = Object.entries(priorityCounts)
    .sort((a, b) => {
      const order = ["critical", "high", "medium", "low"];
      return order.indexOf(a[0]) - order.indexOf(b[0]);
    });

  const priorityChipColors: Record<string, string> = {
    critical: "border-red-500/30 bg-red-500/10 text-red-400",
    high: "border-orange-500/30 bg-orange-500/10 text-orange-400",
    medium: "border-yellow-500/30 bg-yellow-500/10 text-yellow-400",
    low: "border-green-500/30 bg-green-500/10 text-green-400",
  };

  function formatCategory(cat: string): string {
    return cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Header */}
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Link
            href="/"
            className="text-xs text-gray-600 hover:text-gold transition-colors"
          >
            Recipes
          </Link>
          <span className="text-gray-700">/</span>
          <span className="text-xs text-gray-400">Feedback</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold bg-gradient-to-r from-gold to-gold-soft bg-clip-text text-transparent">
          Community Feedback
        </h1>
        <p className="text-gray-400 mt-2 text-sm sm:text-base">
          Live feedback from #feedback — automatically synced from Discord
        </p>
      </header>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-8">
        {[
          { label: "Posts", value: stats.total, icon: "\uD83D\uDCDD" },
          { label: "Categories", value: stats.categories, icon: "\uD83D\uDCCA" },
          { label: "Contributors", value: stats.authors, icon: "\uD83D\uDC65" },
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
          placeholder="Search feedback by title, content, author, or tag..."
          className="w-full glass rounded-xl px-4 py-3 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-gold/50 transition-all"
        />
      </div>

      {/* Filter chips */}
      {(sortedPriorities.length > 0 || sortedCategories.length > 0) && (
        <div className="flex gap-2 flex-wrap mb-6">
          {(activeCategory || activePriority) && (
            <button
              onClick={() => {
                setActiveCategory(null);
                setActivePriority(null);
              }}
              className="text-[11px] px-3 py-1.5 rounded-full border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              Clear
            </button>
          )}

          {sortedPriorities.map(([priority, count]) => (
            <button
              key={`p-${priority}`}
              onClick={() => {
                setActivePriority(activePriority === priority ? null : priority);
                setActiveCategory(null);
              }}
              className={`text-[11px] px-3 py-1.5 rounded-full border transition-colors ${
                activePriority === priority
                  ? priorityChipColors[priority] || "border-gray-500/30 bg-gray-500/10 text-gray-400"
                  : "border-border bg-bg-card text-gray-500 hover:text-gray-300 hover:bg-bg-hover"
              }`}
            >
              {priority} ({count})
            </button>
          ))}

          {sortedCategories.map(([category, count]) => (
            <button
              key={`c-${category}`}
              onClick={() => {
                setActiveCategory(activeCategory === category ? null : category);
                setActivePriority(null);
              }}
              className={`text-[11px] px-3 py-1.5 rounded-full border transition-colors ${
                activeCategory === category
                  ? "border-accent/50 bg-accent/10 text-accent"
                  : "border-border bg-bg-card text-gray-500 hover:text-gray-300 hover:bg-bg-hover"
              }`}
            >
              {formatCategory(category)} ({count})
            </button>
          ))}
        </div>
      )}

      {/* Feedback grid */}
      {loading ? (
        <div className="text-center py-20">
          <div className="w-10 h-10 border-2 border-border border-t-gold rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-500 text-sm">Loading feedback...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-xl text-gray-300 mb-2">
            {posts.length === 0 ? "No feedback yet" : "No matches"}
          </p>
          <p className="text-sm text-gray-600">
            {posts.length === 0
              ? "Feedback from #feedback will appear here automatically"
              : "Try a different search or filter"}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((p) => (
            <FeedbackCard key={p.id} post={p} />
          ))}
        </div>
      )}

      {/* Footer */}
      {!loading && filtered.length > 0 && (
        <p className="text-xs text-gray-600 text-center mt-8">
          Showing {filtered.length} of {posts.length} feedback posts
        </p>
      )}

      <footer className="text-center mt-12 pb-8 space-y-2">
        <p className="text-xs text-gray-700">
          Powered by <span className="text-gold/60">Pokedex</span> — feedback synced automatically from Discord
        </p>
        <div className="flex items-center justify-center gap-3 text-[10px] text-gray-700">
          <span>v{APP_VERSION}</span>
          {lastFetched && (
            <span>Updated {lastFetched.toLocaleTimeString()}</span>
          )}
          <button
            onClick={() => {
              setLoading(true);
              fetchFeedback(false);
            }}
            className="text-gold/40 hover:text-gold transition-colors"
          >
            Refresh
          </button>
        </div>
      </footer>
    </div>
  );
}
