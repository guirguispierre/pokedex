import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { requireTier } from "@/lib/permissions";
import { adminDb } from "@/lib/firebase-admin";
import { removeTimeout } from "@/lib/discord";
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

    const { userId, username } = await request.json();
    if (!userId || !username) {
      return NextResponse.json(
        { error: "Missing required fields: userId, username" },
        { status: 400 }
      );
    }

    await removeTimeout(userId);

    const logRef = adminDb.collection("mod_logs").doc();
    await logRef.set({
      action: "remove-timeout",
      targetUser: username,
      targetUserId: userId,
      moderator: session.username,
      moderatorId: session.userId,
      reason: "Timeout removed via dashboard",
      source: "dashboard",
      timestamp: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Remove timeout error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
