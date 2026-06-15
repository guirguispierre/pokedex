import { getIronSession, IronSession } from "iron-session";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";

export interface SessionData {
  userId?: string;
  username?: string;
  avatar?: string;
  accessToken?: string;
  tier?: "viewer" | "moderator" | "admin";
}

function getSessionPassword(): string {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET environment variable is required in production"
    );
  }
  // Generate a one-time random secret for dev (changes on restart)
  if (!(globalThis as any).__devSessionSecret) {
    (globalThis as any).__devSessionSecret = randomBytes(32).toString("hex");
  }
  return (globalThis as any).__devSessionSecret;
}

function getSessionOptions() {
  return {
    password: getSessionPassword(),
    cookieName: "pokemod-session",
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax" as const,
      maxAge: 60 * 60 * 24 * 7,
    },
  };
}

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, getSessionOptions());
}
