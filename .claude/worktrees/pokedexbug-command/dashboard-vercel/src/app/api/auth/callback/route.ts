import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, getDiscordUser, getGuildMember } from "@/lib/discord";
import { getSession } from "@/lib/session";
import { resolvePermissionTier } from "@/lib/permissions";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  if (!code) {
    return NextResponse.redirect(`${appUrl}/login?error=no_code`);
  }

  // Validate OAuth state parameter to prevent CSRF
  const storedState = request.cookies.get("oauth_state")?.value;
  if (!state || !storedState || state !== storedState) {
    const response = NextResponse.redirect(`${appUrl}/login?error=invalid_state`);
    response.cookies.delete("oauth_state");
    return response;
  }

  try {
    const tokenData = await exchangeCode(code);
    const user = await getDiscordUser(tokenData.access_token);
    const member = await getGuildMember(user.id);

    if (!member) {
      return NextResponse.redirect(`${appUrl}/login?error=not_in_server`);
    }

    const tier = await resolvePermissionTier(member.roles);

    const session = await getSession();
    session.userId = user.id;
    session.username = user.username;
    session.avatar = user.avatar;
    session.accessToken = tokenData.access_token;
    session.tier = tier;
    await session.save();

    const response = NextResponse.redirect(appUrl);
    // Clear the oauth_state cookie
    response.cookies.delete("oauth_state");
    return response;
  } catch (error) {
    console.error("Auth callback error:", error);
    return NextResponse.redirect(`${appUrl}/login?error=auth_failed`);
  }
}
