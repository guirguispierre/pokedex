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

    const { action, type, id } = await request.json();
    if (!action || !type || !id) {
      return NextResponse.json(
        { error: "Missing required fields: action, type, id" },
        { status: 400 }
      );
    }

    if (!["role", "channel"].includes(type)) {
      return NextResponse.json(
        { error: "Invalid type. Use 'role' or 'channel'" },
        { status: 400 }
      );
    }

    const ref = adminDb.collection("automod").doc("exemptions");
    const field = type === "role" ? "exemptRoles" : "exemptChannels";

    if (action === "add") {
      await ref.set(
        { [field]: FieldValue.arrayUnion(id) },
        { merge: true }
      );
    } else if (action === "remove") {
      await ref.update({ [field]: FieldValue.arrayRemove(id) });
    } else {
      return NextResponse.json(
        { error: "Invalid action. Use 'add' or 'remove'" },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Exemptions error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
