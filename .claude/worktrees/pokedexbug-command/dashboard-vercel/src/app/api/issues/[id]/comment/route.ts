import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { requireTier } from "@/lib/permissions";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session.userId || !requireTier(session.tier, "moderator")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = params;
  const { text } = await req.json();
  if (!text?.trim()) {
    return NextResponse.json({ error: "Comment text required" }, { status: 400 });
  }

  const noteEntry = {
    text: text.trim(),
    authorId: session.userId,
    authorName: session.username ?? "unknown",
    createdAt: new Date().toISOString(),
  };

  // Use arrayUnion for atomic append (prevents concurrent requests from losing comments)
  const docRef = adminDb.collection("issues").doc(id);
  const doc = await docRef.get();
  if (!doc.exists) {
    return NextResponse.json({ error: "Issue not found" }, { status: 404 });
  }

  await docRef.update({
    notes: FieldValue.arrayUnion(noteEntry),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true });
}
