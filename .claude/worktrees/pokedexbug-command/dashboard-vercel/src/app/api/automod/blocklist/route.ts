import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { requireTier } from "@/lib/permissions";
import { adminDb } from "@/lib/firebase-admin";
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

    const { action, word } = await request.json();
    if (!action || !word) {
      return NextResponse.json(
        { error: "Missing required fields: action, word" },
        { status: 400 }
      );
    }

    const ref = adminDb.collection("automod").doc("blocklist");

    if (action === "add") {
      await ref.set(
        { words: FieldValue.arrayUnion(word) },
        { merge: true }
      );
    } else if (action === "remove") {
      await ref.update({ words: FieldValue.arrayRemove(word) });
    } else {
      return NextResponse.json(
        { error: "Invalid action. Use 'add' or 'remove'" },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Blocklist error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
