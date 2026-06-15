import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getGuildMember } from "@/lib/discord";
import { resolvePermissionTier } from "@/lib/permissions";

export async function GET() {
  const session = await getSession();

  if (!session.userId) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  try {
    // Re-check guild membership and refresh tier
    const member = await getGuildMember(session.userId);

    if (!member) {
      session.destroy();
      return NextResponse.json(
        { user: null, error: "not_in_server" },
        { status: 403 }
      );
    }

    const tier = await resolvePermissionTier(member.roles);
    session.tier = tier;
    await session.save();

    return NextResponse.json({
      user: {
        userId: session.userId,
        username: session.username,
        avatar: session.avatar,
        tier,
      },
    });
  } catch (error) {
    console.error("Session check error:", error);
    return NextResponse.json({
      user: {
        userId: session.userId,
        username: session.username,
        avatar: session.avatar,
        tier: session.tier,
      },
    });
  }
}
