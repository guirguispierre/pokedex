"use client";

interface StatCardProps {
  label: string;
  value: string | number;
  subText?: string;
  color?: "blurple" | "green" | "red" | "yellow";
  icon?: string;
}

const colorMap = {
  blurple: "border-discord-blurple",
  green: "border-discord-green",
  red: "border-discord-red",
  yellow: "border-discord-yellow",
};

const iconBgMap = {
  blurple: "bg-discord-blurple/10 text-discord-blurple",
  green: "bg-discord-green/10 text-discord-green",
  red: "bg-discord-red/10 text-discord-red",
  yellow: "bg-discord-yellow/10 text-discord-yellow",
};

export default function StatCard({
  label,
  value,
  subText,
  color = "blurple",
  icon,
}: StatCardProps) {
  return (
    <div
      className={`bg-discord-secondary rounded-lg p-5 border-l-[3px] ${colorMap[color]} transition-all duration-150 hover:bg-discord-secondary/80`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-discord-muted mb-1.5">
            {label}
          </p>
          <p className="text-2xl font-bold text-white leading-none">{value}</p>
          {subText && (
            <p className="text-xs text-discord-muted mt-2">{subText}</p>
          )}
        </div>
        {icon && (
          <span
            className={`text-lg shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${iconBgMap[color]}`}
          >
            {icon}
          </span>
        )}
      </div>
    </div>
  );
}
