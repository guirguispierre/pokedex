"use client";

import { useState, useCallback } from "react";

interface DiscordMember {
  user: {
    id: string;
    username: string;
    avatar: string | null;
    global_name: string | null;
  };
  nick: string | null;
}

interface UserSearchProps {
  onSelect: (member: DiscordMember) => void;
}

export default function UserSearch({ onSelect }: UserSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DiscordMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const res = await fetch(
        `/api/mod/search?q=${encodeURIComponent(query.trim())}`
      );
      const data = await res.json();
      setResults(data.members || []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") search();
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search for a user..."
          className="flex-1 bg-discord-tertiary text-discord-text text-sm rounded-md px-3 py-2 border border-discord-border focus:border-discord-blurple focus:outline-none placeholder:text-discord-muted transition-colors"
        />
        <button
          onClick={search}
          disabled={loading || !query.trim()}
          className="px-4 py-2 bg-discord-blurple text-white text-sm font-medium rounded-md hover:bg-discord-blurple/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "..." : "Search"}
        </button>
      </div>

      {results.length > 0 && (
        <div className="bg-discord-tertiary rounded-md border border-discord-border divide-y divide-discord-border/50 max-h-60 overflow-y-auto">
          {results.map((member) => {
            const displayName =
              member.nick ||
              member.user.global_name ||
              member.user.username;
            const avatarUrl = member.user.avatar
              ? `https://cdn.discordapp.com/avatars/${member.user.id}/${member.user.avatar}.png?size=32`
              : null;

            return (
              <button
                key={member.user.id}
                onClick={() => onSelect(member)}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.04] transition-colors text-left"
              >
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt={displayName}
                    className="w-8 h-8 rounded-full shrink-0"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-discord-blurple flex items-center justify-center shrink-0 text-white text-xs font-bold">
                    {displayName[0]?.toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white truncate">
                    {displayName}
                  </p>
                  <p className="text-xs text-discord-muted truncate">
                    {member.user.username}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {searched && !loading && results.length === 0 && (
        <p className="text-sm text-discord-muted text-center py-3">
          No members found
        </p>
      )}
    </div>
  );
}
