"use client";

import { useState, useCallback } from "react";
import ProtectedRoute from "@/components/ProtectedRoute";
import { useDocument } from "@/hooks/useFirestore";

interface AutomodConfig {
  id: string;
  enabled: boolean;
  maxMessagesPerWindow: number;
  messageWindowMs: number;
  maxDuplicates: number;
  duplicateWindowMs: number;
  maxMentionsPerMessage: number;
  capsPercentThreshold: number;
  raidJoinCount: number;
  raidJoinWindowMs: number;
  raidAutoKick: boolean;
  blockInviteLinks: boolean;
  dmOnAction: boolean;
}

interface BlocklistData {
  id: string;
  words: string[];
}

interface LinksData {
  id: string;
  allowedDomains: string[];
  blockedDomains: string[];
}

interface ExemptionsData {
  id: string;
  exemptRoles: string[];
  exemptChannels: string[];
}

const defaults: Omit<AutomodConfig, "id"> = {
  enabled: false,
  maxMessagesPerWindow: 5,
  messageWindowMs: 3000,
  maxDuplicates: 3,
  duplicateWindowMs: 10000,
  maxMentionsPerMessage: 5,
  capsPercentThreshold: 70,
  raidJoinCount: 10,
  raidJoinWindowMs: 10000,
  raidAutoKick: true,
  blockInviteLinks: true,
  dmOnAction: false,
};

function Toggle({
  enabled,
  onChange,
  label,
  description,
}: {
  enabled: boolean;
  onChange: (val: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-white">{label}</p>
        {description && (
          <p className="text-xs text-discord-muted mt-0.5">{description}</p>
        )}
      </div>
      <button
        onClick={() => onChange(!enabled)}
        className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${
          enabled ? "bg-discord-green" : "bg-discord-tertiary"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform duration-200 mt-0.5 ${
            enabled ? "translate-x-[22px]" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (val: number) => void;
  suffix?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-discord-muted uppercase tracking-wider mb-1.5">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full bg-discord-tertiary text-discord-text text-sm rounded-md px-3 py-2 border border-discord-border focus:border-discord-blurple focus:outline-none transition-colors"
        />
        {suffix && (
          <span className="text-xs text-discord-muted shrink-0">{suffix}</span>
        )}
      </div>
    </div>
  );
}

function TagChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 bg-discord-tertiary text-discord-text text-xs px-2.5 py-1 rounded-md border border-discord-border">
      {label}
      <button
        onClick={onRemove}
        className="text-discord-muted hover:text-discord-red transition-colors ml-0.5"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </span>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-discord-secondary rounded-lg overflow-hidden">
      <div className="px-5 py-3 border-b border-discord-border">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

export default function AutoModPage() {
  const { data: configData, loading: configLoading } =
    useDocument<AutomodConfig>("automod", "config");
  const { data: blocklistData } =
    useDocument<BlocklistData>("automod", "blocklist");
  const { data: linksData } = useDocument<LinksData>("automod", "links");
  const { data: exemptionsData } =
    useDocument<ExemptionsData>("automod", "exemptions");

  const config = { ...defaults, ...configData };
  const blocklist = blocklistData?.words || [];
  const allowedDomains = linksData?.allowedDomains || [];
  const blockedDomains = linksData?.blockedDomains || [];
  const exemptRoles = exemptionsData?.exemptRoles || [];
  const exemptChannels = exemptionsData?.exemptChannels || [];

  const [newWord, setNewWord] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [domainType, setDomainType] = useState<"allow" | "block">("allow");
  const [newExemptionId, setNewExemptionId] = useState("");
  const [exemptionType, setExemptionType] = useState<"role" | "channel">("role");
  const [saving, setSaving] = useState(false);

  const updateConfig = useCallback(
    async (updates: Partial<Omit<AutomodConfig, "id">>) => {
      setSaving(true);
      try {
        await fetch("/api/automod", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        });
      } finally {
        setSaving(false);
      }
    },
    []
  );

  const updateBlocklist = useCallback(
    async (action: "add" | "remove", word: string) => {
      await fetch("/api/automod/blocklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, word }),
      });
    },
    []
  );

  const updateLinks = useCallback(
    async (action: "add" | "remove", type: "allow" | "block", domain: string) => {
      await fetch("/api/automod/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, type, domain }),
      });
    },
    []
  );

  const updateExemptions = useCallback(
    async (action: "add" | "remove", type: "role" | "channel", id: string) => {
      await fetch("/api/automod/exemptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, type, id }),
      });
    },
    []
  );

  const handleAddWord = () => {
    if (!newWord.trim()) return;
    updateBlocklist("add", newWord.trim().toLowerCase());
    setNewWord("");
  };

  const handleAddDomain = () => {
    if (!newDomain.trim()) return;
    updateLinks("add", domainType, newDomain.trim().toLowerCase());
    setNewDomain("");
  };

  const handleAddExemption = () => {
    if (!newExemptionId.trim()) return;
    updateExemptions("add", exemptionType, newExemptionId.trim());
    setNewExemptionId("");
  };

  if (configLoading) {
    return (
      <ProtectedRoute requiredTier="moderator">
        <div className="max-w-4xl mx-auto space-y-6">
          <div>
            <h1 className="text-xl font-bold text-white">AutoMod Configuration</h1>
            <p className="text-sm text-discord-muted mt-1">Loading...</p>
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-discord-secondary rounded-lg h-32 animate-pulse"
            />
          ))}
        </div>
      </ProtectedRoute>
    );
  }

  return (
    <ProtectedRoute requiredTier="moderator">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">
              AutoMod Configuration
            </h1>
            <p className="text-sm text-discord-muted mt-1">
              Configure automated moderation rules
            </p>
          </div>
          {saving && (
            <span className="text-xs text-discord-muted animate-pulse">
              Saving...
            </span>
          )}
        </div>

        {/* Master Toggle */}
        <div className="bg-discord-secondary rounded-lg px-5 py-4">
          <Toggle
            enabled={config.enabled}
            onChange={(val) => updateConfig({ enabled: val })}
            label="Enable AutoMod"
            description="Master switch for all automated moderation features"
          />
        </div>

        {/* Spam Thresholds */}
        <SectionCard title="Spam Thresholds">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <NumberInput
              label="Max Messages Per Window"
              value={config.maxMessagesPerWindow}
              onChange={(val) => updateConfig({ maxMessagesPerWindow: val })}
            />
            <NumberInput
              label="Message Window"
              value={config.messageWindowMs}
              onChange={(val) => updateConfig({ messageWindowMs: val })}
              suffix="ms"
            />
            <NumberInput
              label="Max Duplicates"
              value={config.maxDuplicates}
              onChange={(val) => updateConfig({ maxDuplicates: val })}
            />
            <NumberInput
              label="Duplicate Window"
              value={config.duplicateWindowMs}
              onChange={(val) => updateConfig({ duplicateWindowMs: val })}
              suffix="ms"
            />
            <NumberInput
              label="Max Mentions Per Message"
              value={config.maxMentionsPerMessage}
              onChange={(val) => updateConfig({ maxMentionsPerMessage: val })}
            />
            <NumberInput
              label="Caps Threshold"
              value={config.capsPercentThreshold}
              onChange={(val) => updateConfig({ capsPercentThreshold: val })}
              suffix="%"
            />
          </div>
        </SectionCard>

        {/* Options */}
        <SectionCard title="Options">
          <div className="space-y-4">
            <Toggle
              enabled={config.dmOnAction}
              onChange={(val) => updateConfig({ dmOnAction: val })}
              label="DM on Action"
              description="Send a direct message to users when an action is taken"
            />
            <Toggle
              enabled={config.blockInviteLinks}
              onChange={(val) => updateConfig({ blockInviteLinks: val })}
              label="Block Invite Links"
              description="Automatically remove Discord invite links"
            />
            <Toggle
              enabled={config.raidAutoKick}
              onChange={(val) => updateConfig({ raidAutoKick: val })}
              label="Raid Auto-Kick"
              description="Automatically kick users during detected raids"
            />
          </div>
        </SectionCard>

        {/* Raid Protection */}
        <SectionCard title="Raid Protection">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <NumberInput
              label="Join Count Threshold"
              value={config.raidJoinCount}
              onChange={(val) => updateConfig({ raidJoinCount: val })}
            />
            <NumberInput
              label="Join Window"
              value={config.raidJoinWindowMs}
              onChange={(val) => updateConfig({ raidJoinWindowMs: val })}
              suffix="ms"
            />
          </div>
        </SectionCard>

        {/* Blocklist */}
        <SectionCard title="Blocklist">
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                value={newWord}
                onChange={(e) => setNewWord(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddWord()}
                placeholder="Add a blocked word..."
                className="flex-1 bg-discord-tertiary text-discord-text text-sm rounded-md px-3 py-2 border border-discord-border focus:border-discord-blurple focus:outline-none placeholder:text-discord-muted transition-colors"
              />
              <button
                onClick={handleAddWord}
                disabled={!newWord.trim()}
                className="px-4 py-2 bg-discord-blurple text-white text-sm font-medium rounded-md hover:bg-discord-blurple/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Add
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {blocklist.length === 0 ? (
                <p className="text-xs text-discord-muted">
                  No blocked words yet
                </p>
              ) : (
                blocklist.map((word) => (
                  <TagChip
                    key={word}
                    label={word}
                    onRemove={() => updateBlocklist("remove", word)}
                  />
                ))
              )}
            </div>
          </div>
        </SectionCard>

        {/* Link Filtering */}
        <SectionCard title="Link Filtering">
          <div className="space-y-4">
            <div className="flex gap-2">
              <select
                value={domainType}
                onChange={(e) =>
                  setDomainType(e.target.value as "allow" | "block")
                }
                className="bg-discord-tertiary text-discord-text text-sm rounded-md px-3 py-2 border border-discord-border focus:border-discord-blurple focus:outline-none transition-colors"
              >
                <option value="allow">Allow</option>
                <option value="block">Block</option>
              </select>
              <input
                type="text"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddDomain()}
                placeholder="domain.com"
                className="flex-1 bg-discord-tertiary text-discord-text text-sm rounded-md px-3 py-2 border border-discord-border focus:border-discord-blurple focus:outline-none placeholder:text-discord-muted transition-colors"
              />
              <button
                onClick={handleAddDomain}
                disabled={!newDomain.trim()}
                className="px-4 py-2 bg-discord-blurple text-white text-sm font-medium rounded-md hover:bg-discord-blurple/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Add
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-medium text-discord-muted uppercase tracking-wider mb-2">
                  Allowed Domains
                </p>
                <div className="flex flex-wrap gap-2">
                  {allowedDomains.length === 0 ? (
                    <p className="text-xs text-discord-muted">None</p>
                  ) : (
                    allowedDomains.map((d) => (
                      <TagChip
                        key={d}
                        label={d}
                        onRemove={() => updateLinks("remove", "allow", d)}
                      />
                    ))
                  )}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-discord-muted uppercase tracking-wider mb-2">
                  Blocked Domains
                </p>
                <div className="flex flex-wrap gap-2">
                  {blockedDomains.length === 0 ? (
                    <p className="text-xs text-discord-muted">None</p>
                  ) : (
                    blockedDomains.map((d) => (
                      <TagChip
                        key={d}
                        label={d}
                        onRemove={() => updateLinks("remove", "block", d)}
                      />
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </SectionCard>

        {/* Exemptions */}
        <SectionCard title="Exemptions">
          <div className="space-y-4">
            <div className="flex gap-2">
              <select
                value={exemptionType}
                onChange={(e) =>
                  setExemptionType(e.target.value as "role" | "channel")
                }
                className="bg-discord-tertiary text-discord-text text-sm rounded-md px-3 py-2 border border-discord-border focus:border-discord-blurple focus:outline-none transition-colors"
              >
                <option value="role">Role</option>
                <option value="channel">Channel</option>
              </select>
              <input
                type="text"
                value={newExemptionId}
                onChange={(e) => setNewExemptionId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddExemption()}
                placeholder="Role or Channel ID"
                className="flex-1 bg-discord-tertiary text-discord-text text-sm rounded-md px-3 py-2 border border-discord-border focus:border-discord-blurple focus:outline-none placeholder:text-discord-muted transition-colors"
              />
              <button
                onClick={handleAddExemption}
                disabled={!newExemptionId.trim()}
                className="px-4 py-2 bg-discord-blurple text-white text-sm font-medium rounded-md hover:bg-discord-blurple/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Add
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-medium text-discord-muted uppercase tracking-wider mb-2">
                  Exempt Roles
                </p>
                <div className="flex flex-wrap gap-2">
                  {exemptRoles.length === 0 ? (
                    <p className="text-xs text-discord-muted">None</p>
                  ) : (
                    exemptRoles.map((id) => (
                      <TagChip
                        key={id}
                        label={id}
                        onRemove={() =>
                          updateExemptions("remove", "role", id)
                        }
                      />
                    ))
                  )}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-discord-muted uppercase tracking-wider mb-2">
                  Exempt Channels
                </p>
                <div className="flex flex-wrap gap-2">
                  {exemptChannels.length === 0 ? (
                    <p className="text-xs text-discord-muted">None</p>
                  ) : (
                    exemptChannels.map((id) => (
                      <TagChip
                        key={id}
                        label={id}
                        onRemove={() =>
                          updateExemptions("remove", "channel", id)
                        }
                      />
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </SectionCard>
      </div>
    </ProtectedRoute>
  );
}
