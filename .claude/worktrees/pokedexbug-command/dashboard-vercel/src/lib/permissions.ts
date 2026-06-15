import { adminDb } from "./firebase-admin";

export type PermissionTier = "viewer" | "moderator" | "admin";

interface RoleMapping {
  adminRoles: string[];
  modRoles: string[];
}

let cachedMapping: RoleMapping | null = null;
let cacheTime = 0;
const CACHE_TTL = 60000;

export async function getRoleMapping(): Promise<RoleMapping> {
  if (cachedMapping && Date.now() - cacheTime < CACHE_TTL)
    return cachedMapping;

  const doc = await adminDb.collection("config").doc("dashboard_roles").get();
  cachedMapping = doc.exists
    ? (doc.data() as RoleMapping)
    : { adminRoles: [], modRoles: [] };
  cacheTime = Date.now();
  return cachedMapping;
}

export async function resolvePermissionTier(
  memberRoles: string[]
): Promise<PermissionTier> {
  const mapping = await getRoleMapping();
  if (mapping.adminRoles.some((r) => memberRoles.includes(r))) return "admin";
  if (mapping.modRoles.some((r) => memberRoles.includes(r)))
    return "moderator";
  return "viewer";
}

export function requireTier(
  userTier: PermissionTier | undefined,
  requiredTier: PermissionTier
): boolean {
  if (!userTier) return false;
  const tierOrder: PermissionTier[] = ["viewer", "moderator", "admin"];
  return tierOrder.indexOf(userTier) >= tierOrder.indexOf(requiredTier);
}
