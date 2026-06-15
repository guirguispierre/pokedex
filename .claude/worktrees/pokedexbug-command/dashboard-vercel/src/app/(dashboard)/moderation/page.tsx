"use client";

import { useState, useCallback } from "react";
import ProtectedRoute from "@/components/ProtectedRoute";
import UserSearch from "@/components/UserSearch";
import ModActionModal from "@/components/ModActionModal";
import InfractionTable from "@/components/InfractionTable";
import { useSession } from "@/hooks/useSession";

type ActionType = "warn" | "timeout" | "kick" | "ban";

interface SelectedUser {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
}

const actionButtons: {
  type: ActionType;
  label: string;
  icon: string;
  color: string;
  requiredTier: "moderator" | "admin";
}[] = [
  {
    type: "warn",
    label: "Warn",
    icon: "\u26a0\ufe0f",
    color: "bg-discord-yellow/10 text-discord-yellow hover:bg-discord-yellow/20 border-discord-yellow/20",
    requiredTier: "moderator",
  },
  {
    type: "timeout",
    label: "Timeout",
    icon: "\ud83d\udd07",
    color: "bg-discord-yellow/10 text-discord-yellow hover:bg-discord-yellow/20 border-discord-yellow/20",
    requiredTier: "moderator",
  },
  {
    type: "kick",
    label: "Kick",
    icon: "\ud83d\udc62",
    color: "bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 border-orange-500/20",
    requiredTier: "moderator",
  },
  {
    type: "ban",
    label: "Ban",
    icon: "\ud83d\udd28",
    color: "bg-discord-red/10 text-discord-red hover:bg-discord-red/20 border-discord-red/20",
    requiredTier: "admin",
  },
];

const tierOrder = ["viewer", "moderator", "admin"];

function hasTier(userTier: string, requiredTier: string): boolean {
  return tierOrder.indexOf(userTier) >= tierOrder.indexOf(requiredTier);
}

export default function ModerationPage() {
  const { user } = useSession();
  const [selectedUser, setSelectedUser] = useState<SelectedUser | null>(null);
  const [activeAction, setActiveAction] = useState<ActionType | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSelect = useCallback(
    (member: {
      user: { id: string; username: string; avatar: string | null; global_name: string | null };
      nick: string | null;
    }) => {
      setSelectedUser({
        id: member.user.id,
        username: member.user.username,
        displayName:
          member.nick || member.user.global_name || member.user.username,
        avatar: member.user.avatar,
      });
    },
    []
  );

  const handleRemoveTimeout = async () => {
    if (!selectedUser) return;
    try {
      const res = await fetch("/api/mod/remove-timeout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: selectedUser.id,
          username: selectedUser.username,
        }),
      });
      if (!res.ok) throw new Error("Failed");
      setRefreshKey((k) => k + 1);
    } catch {
      // Error handling could be improved with toast
    }
  };

  return (
    <ProtectedRoute requiredTier="moderator">
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-bold text-white">Moderation</h1>
          <p className="text-sm text-discord-muted mt-1">
            Search users and take moderation actions
          </p>
        </div>

        {/* User Search */}
        <div className="bg-discord-secondary rounded-lg p-5">
          <h2 className="text-sm font-semibold text-white mb-3">
            Find a User
          </h2>
          <UserSearch onSelect={handleSelect} />
        </div>

        {/* Selected User Card */}
        {selectedUser && (
          <div className="bg-discord-secondary rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-4">
              {selectedUser.avatar ? (
                <img
                  src={`https://cdn.discordapp.com/avatars/${selectedUser.id}/${selectedUser.avatar}.png?size=64`}
                  alt={selectedUser.displayName}
                  className="w-12 h-12 rounded-full"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-discord-blurple flex items-center justify-center text-white font-bold">
                  {selectedUser.displayName[0]?.toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-base font-semibold text-white truncate">
                  {selectedUser.displayName}
                </p>
                <p className="text-sm text-discord-muted">
                  {selectedUser.username}
                </p>
              </div>
              <button
                onClick={() => setSelectedUser(null)}
                className="text-discord-muted hover:text-white transition-colors p-1"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap gap-2">
              {actionButtons.map((btn) => {
                const allowed = user ? hasTier(user.tier, btn.requiredTier) : false;
                return (
                  <button
                    key={btn.type}
                    onClick={() => setActiveAction(btn.type)}
                    disabled={!allowed}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${btn.color}`}
                  >
                    <span>{btn.icon}</span>
                    {btn.label}
                  </button>
                );
              })}
              <button
                onClick={handleRemoveTimeout}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md border bg-discord-green/10 text-discord-green hover:bg-discord-green/20 border-discord-green/20 transition-colors"
              >
                <span>{"\ud83d\udd14"}</span>
                Remove Timeout
              </button>
            </div>

            {/* User's Infraction History */}
            <div>
              <h3 className="text-sm font-semibold text-white mb-3">
                Infraction History
              </h3>
              <InfractionTable
                key={`user-${selectedUser.id}-${refreshKey}`}
                filterUserId={selectedUser.id}
              />
            </div>
          </div>
        )}

        {/* All Infractions */}
        <div>
          <h2 className="text-sm font-semibold text-white mb-3">
            All Infractions
          </h2>
          <InfractionTable key={`all-${refreshKey}`} />
        </div>

        {/* Modal */}
        {activeAction && selectedUser && (
          <ModActionModal
            action={activeAction}
            targetUser={{
              id: selectedUser.id,
              username: selectedUser.username,
            }}
            onClose={() => setActiveAction(null)}
            onSuccess={() => setRefreshKey((k) => k + 1)}
          />
        )}
      </div>
    </ProtectedRoute>
  );
}
