"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/hooks/useSession";
import type { PermissionTier } from "@/lib/permissions";

const tierOrder: PermissionTier[] = ["viewer", "moderator", "admin"];

function hasTier(userTier: PermissionTier, requiredTier: PermissionTier): boolean {
  return tierOrder.indexOf(userTier) >= tierOrder.indexOf(requiredTier);
}

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredTier?: PermissionTier;
}

export default function ProtectedRoute({
  children,
  requiredTier = "viewer",
}: ProtectedRouteProps) {
  const { user, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-discord-primary">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-discord-blurple border-t-transparent" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  if (!hasTier(user.tier, requiredTier)) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-discord-primary">
        <div className="bg-discord-secondary rounded-lg p-8 max-w-md text-center">
          <h2 className="text-xl font-bold text-white mb-2">No Permission</h2>
          <p className="text-discord-muted text-sm">
            You need <span className="font-semibold text-discord-text">{requiredTier}</span> access
            or higher to view this page.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
