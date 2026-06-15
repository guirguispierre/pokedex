import { NextResponse } from "next/server";
import { randomBytes } from "crypto";

export async function GET() {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/callback`;
  const scope = "identify guilds";

  // Generate random state for CSRF protection
  const state = randomBytes(32).toString("hex");

  const params = new URLSearchParams({
    client_id: clientId!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    state,
  });

  const response = NextResponse.redirect(
    `https://discord.com/api/oauth2/authorize?${params}`
  );

  // Store state in httpOnly cookie for validation in callback
  response.cookies.set("oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 300, // 5 minutes
    path: "/",
  });

  return response;
}
