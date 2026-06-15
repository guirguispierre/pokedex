import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { requireTier } from "@/lib/permissions";
import { adminDb } from "@/lib/firebase-admin";

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!requireTier(session.tier, "moderator")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const configRef = adminDb.collection("automod").doc("config");
    await configRef.set(body, { merge: true });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("AutoMod config error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
