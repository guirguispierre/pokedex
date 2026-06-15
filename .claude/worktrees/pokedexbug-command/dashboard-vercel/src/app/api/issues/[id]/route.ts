import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { requireTier } from "@/lib/permissions";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = params;
  const doc = await adminDb.collection("issues").doc(id).get();
  if (!doc.exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const data = doc.data()!;
  return NextResponse.json({
    issue: {
      id: doc.id,
      summary: data.summary || null,
      text: data.text || null,
      status: data.status || "open",
      priority: data.priority || null,
      category: data.category || null,
      reporterName: data.reporterName || null,
      assigneeName: data.assigneeName || null,
      threadContext: data.threadContext || [],
      notes: data.notes || [],
      createdAt: data.createdAt ? { seconds: data.createdAt.seconds } : null,
      updatedAt: data.updatedAt ? { seconds: data.updatedAt.seconds } : null,
    },
  });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session.userId || !requireTier(session.tier, "moderator")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = params;
  const docRef = adminDb.collection("issues").doc(id);
  const doc = await docRef.get();
  if (!doc.exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updates = await req.json();

  const allowed = ["status", "priority", "assigneeId", "assigneeName"];
  const filtered: any = {};
  for (const key of allowed) {
    if (key in updates) filtered[key] = updates[key];
  }
  filtered.updatedAt = FieldValue.serverTimestamp();

  if (updates.status === "closed") {
    filtered.closedBy = session.userId;
    filtered.closedAt = FieldValue.serverTimestamp();
  }
  if (updates.assigneeId) {
    filtered.assignedBy = session.userId;
    filtered.assignedAt = FieldValue.serverTimestamp();
  }

  await docRef.update(filtered);
  return NextResponse.json({ ok: true });
}
