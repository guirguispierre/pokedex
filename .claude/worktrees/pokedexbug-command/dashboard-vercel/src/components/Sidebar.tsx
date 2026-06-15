"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/hooks/useSession";
import ConnectionStatus from "@/components/ConnectionStatus";
import type { PermissionTier } from "@/lib/permissions";

const tierOrder: PermissionTier[] = ["viewer", "moderator", "admin"];

function hasTier(userTier: PermissionTier, requiredTier: PermissionTier): boolean {
  return tierOrder.indexOf(userTier) >= tierOrder.indexOf(requiredTier);
}

interface NavItem {
  href: string;
  label: string;
  icon: string;
  requiredTier: PermissionTier;
}

const navItems: NavItem[] = [
  { href: "/", label: "Overview", icon: "\uD83D\uDCCA", requiredTier: "viewer" },
  { href: "/moderation", label: "Moderation", icon: "\uD83D\uDEE1\uFE0F", requiredTier: "moderator" },
  { href: "/automod", label: "AutoMod", icon: "\u2699\uFE0F", requiredTier: "moderator" },
  { href: "/issues", label: "Issues", icon: "\uD83D\uDC1B", requiredTier: "moderator" },
  { href: "/recipes", label: "Recipes", icon: "\uD83C\uDF73", requiredTier: "viewer" },
  { href: "/stats", label: "Stats", icon: "\uD83D\uDCC8", requiredTier: "viewer" },
  { href: "/logs", label: "Logs", icon: "\uD83D\uDD0D", requiredTier: "moderator" },
  { href: "/settings", label: "Settings", icon: "\u26A1", requiredTier: "admin" },
];

export default function Sidebar() {
  const [expanded, setExpanded] = useState(false);
  const pathname = usePathname();
  const { user, logout } = useSession();

  const filteredItems = navItems.filter(
    (item) => user && hasTier(user.tier, item.requiredTier)
  );

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <aside
      className="fixed left-0 top-0 h-screen bg-discord-secondary border-r border-discord-border flex flex-col z-40 transition-all duration-200"
      style={{ width: expanded ? 208 : 56 }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      {/* Logo / Header */}
      <div className="h-14 flex items-center px-4 border-b border-discord-border shrink-0">
        <span className="text-lg font-bold text-white whitespace-nowrap overflow-hidden">
          {expanded ? "PokeMod" : "P"}
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-2 overflow-y-auto overflow-x-hidden">
        {filteredItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-3 px-4 py-2 mx-1 rounded-md text-sm transition-colors whitespace-nowrap overflow-hidden ${
              isActive(item.href)
                ? "bg-discord-accent/20 text-white"
                : "text-discord-text-muted hover:text-white hover:bg-white/5"
            }`}
          >
            <span className="text-base shrink-0 w-6 text-center">{item.icon}</span>
            <span
              className={`transition-opacity duration-200 ${
                expanded ? "opacity-100" : "opacity-0"
              }`}
            >
              {item.label}
            </span>
          </Link>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-discord-border p-3 space-y-3 shrink-0">
        <div className={`transition-opacity duration-200 ${expanded ? "opacity-100" : "opacity-0"}`}>
          <ConnectionStatus />
        </div>

        {user && (
          <div className="flex items-center gap-2 overflow-hidden">
            {user.avatar ? (
              <img
                src={`https://cdn.discordapp.com/avatars/${user.userId}/${user.avatar}.png?size=32`}
                alt={user.username}
                className="w-8 h-8 rounded-full shrink-0"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-discord-blurple flex items-center justify-center shrink-0 text-white text-xs font-bold">
                {user.username[0]?.toUpperCase()}
              </div>
            )}
            <span
              className={`text-sm text-discord-text truncate transition-opacity duration-200 ${
                expanded ? "opacity-100" : "opacity-0"
              }`}
            >
              {user.username}
            </span>
          </div>
        )}

        <button
          onClick={logout}
          className={`flex items-center gap-2 text-discord-text-muted hover:text-discord-red text-sm transition-colors w-full overflow-hidden ${
            expanded ? "" : "justify-center"
          }`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
            />
          </svg>
          <span
            className={`transition-opacity duration-200 ${
              expanded ? "opacity-100" : "opacity-0"
            }`}
          >
            Logout
          </span>
        </button>
      </div>
    </aside>
  );
}
