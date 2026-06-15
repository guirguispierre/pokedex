"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const errorMessages: Record<string, string> = {
  no_code: "No authorization code received. Please try again.",
  not_in_server: "You must be a member of the server to access the dashboard.",
  auth_failed: "Authentication failed. Please try again.",
};

function LoginContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");

  return (
    <div className="flex items-center justify-center min-h-screen bg-discord-primary">
      <div className="bg-discord-secondary rounded-lg shadow-xl p-8 max-w-md w-full mx-4">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-white mb-2">
            PokeMod Dashboard
          </h1>
          <p className="text-discord-muted text-sm">
            Sign in with Discord to access the moderator dashboard
          </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-md p-3 mb-6">
            <p className="text-red-400 text-sm text-center">
              {errorMessages[error] || "An unknown error occurred."}
            </p>
          </div>
        )}

        <a
          href="/api/auth/discord"
          className="flex items-center justify-center gap-3 w-full bg-discord-blurple hover:bg-discord-blurple/80 text-white font-medium py-3 px-4 rounded-md transition-colors"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
          </svg>
          Sign in with Discord
        </a>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-discord-primary">
          <div className="text-discord-muted">Loading...</div>
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
