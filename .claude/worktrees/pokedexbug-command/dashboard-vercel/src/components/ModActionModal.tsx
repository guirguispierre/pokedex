"use client";

import { useState } from "react";

type ActionType = "warn" | "timeout" | "kick" | "ban";

interface ModActionModalProps {
  action: ActionType;
  targetUser: { id: string; username: string };
  onClose: () => void;
  onSuccess: () => void;
}

const actionConfig: Record<
  ActionType,
  { label: string; icon: string; color: string; hoverColor: string; endpoint: string }
> = {
  warn: {
    label: "Warn",
    icon: "\u26a0\ufe0f",
    color: "bg-discord-yellow text-black",
    hoverColor: "hover:bg-discord-yellow/80",
    endpoint: "/api/mod/warn",
  },
  timeout: {
    label: "Timeout",
    icon: "\ud83d\udd07",
    color: "bg-discord-yellow text-black",
    hoverColor: "hover:bg-discord-yellow/80",
    endpoint: "/api/mod/timeout",
  },
  kick: {
    label: "Kick",
    icon: "\ud83d\udc62",
    color: "bg-orange-500 text-white",
    hoverColor: "hover:bg-orange-500/80",
    endpoint: "/api/mod/kick",
  },
  ban: {
    label: "Ban",
    icon: "\ud83d\udd28",
    color: "bg-discord-red text-white",
    hoverColor: "hover:bg-discord-red/80",
    endpoint: "/api/mod/ban",
  },
};

const durationOptions = [
  { label: "5 min", value: 300 },
  { label: "30 min", value: 1800 },
  { label: "1 hour", value: 3600 },
  { label: "6 hours", value: 21600 },
  { label: "1 day", value: 86400 },
  { label: "1 week", value: 604800 },
];

export default function ModActionModal({
  action,
  targetUser,
  onClose,
  onSuccess,
}: ModActionModalProps) {
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState(durationOptions[0].value);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const config = actionConfig[action];

  const handleSubmit = async () => {
    if (!reason.trim()) {
      setError("Reason is required");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const body: Record<string, unknown> = {
        userId: targetUser.id,
        username: targetUser.username,
        reason: reason.trim(),
      };
      if (action === "timeout") {
        body.duration = duration;
      }

      const res = await fetch(config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Action failed");
      }

      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-discord-secondary rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-discord-border">
          <div className="flex items-center gap-2.5">
            <span className="text-lg">{config.icon}</span>
            <h2 className="text-base font-semibold text-white">
              {config.label} User
            </h2>
          </div>
          <p className="text-sm text-discord-muted mt-1">
            Target:{" "}
            <span className="text-white font-medium">
              {targetUser.username}
            </span>
          </p>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {action === "timeout" && (
            <div>
              <label className="block text-xs font-medium text-discord-muted uppercase tracking-wider mb-2">
                Duration
              </label>
              <div className="grid grid-cols-3 gap-2">
                {durationOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setDuration(opt.value)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                      duration === opt.value
                        ? "bg-discord-blurple/20 border-discord-blurple text-discord-blurple"
                        : "bg-discord-tertiary border-discord-border text-discord-muted hover:text-white hover:border-discord-border"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-discord-muted uppercase tracking-wider mb-2">
              Reason <span className="text-discord-red">*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (error) setError("");
              }}
              placeholder="Provide a reason for this action..."
              rows={3}
              className="w-full bg-discord-tertiary text-discord-text text-sm rounded-md px-3 py-2 border border-discord-border focus:border-discord-blurple focus:outline-none placeholder:text-discord-muted resize-none transition-colors"
            />
          </div>

          {error && (
            <p className="text-sm text-discord-red">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-discord-border flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-sm text-discord-text hover:text-white transition-colors rounded-md"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || !reason.trim()}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${config.color} ${config.hoverColor}`}
          >
            {loading ? "Processing..." : `${config.label} User`}
          </button>
        </div>
      </div>
    </div>
  );
}
