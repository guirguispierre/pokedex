import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { requireTier } from "@/lib/permissions";
import { searchGuildMembers } from "@/lib/discord";

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!requireTier(session.tier, "moderator")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q");
    if (!q) {
      return NextResponse.json(
        { error: "Missing query parameter: q" },
        { status: 400 }
      );
    }

    const members = await searchGuildMembers(q);
    return NextResponse.json({ members });
  } catch (error) {
    console.error("Search error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
