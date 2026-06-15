import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { requireTier } from "@/lib/permissions";
import { adminDb } from "@/lib/firebase-admin";
import { kickUser } from "@/lib/discord";
import { FieldValue } from "firebase-admin/firestore";

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!requireTier(session.tier, "moderator")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { userId, username, reason } = await request.json();
    if (!userId || !username || !reason) {
      return NextResponse.json(
        { error: "Missing required fields: userId, username, reason" },
        { status: 400 }
      );
    }

    await kickUser(userId, reason);

    const batch = adminDb.batch();

    const infractionRef = adminDb.collection("infractions").doc();
    batch.set(infractionRef, {
      type: "kick",
      targetUser: username,
      targetUserId: userId,
      moderator: session.username,
      moderatorId: session.userId,
      reason,
      source: "dashboard",
      timestamp: FieldValue.serverTimestamp(),
    });

    const logRef = adminDb.collection("mod_logs").doc();
    batch.set(logRef, {
      action: "kick",
      targetUser: username,
      targetUserId: userId,
      moderator: session.username,
      moderatorId: session.userId,
      reason,
      source: "dashboard",
      timestamp: FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Kick error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
