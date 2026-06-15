import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { requireTier } from "@/lib/permissions";
import { adminDb } from "@/lib/firebase-admin";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = req.nextUrl.searchParams.get("status") || "";
  const priority = req.nextUrl.searchParams.get("priority") || "";
  const limitParam = req.nextUrl.searchParams.get("limit") || "100";

  let query: any = adminDb.collection("issues").orderBy("createdAt", "desc");

  if (status) {
    query = adminDb.collection("issues").where("status", "==", status).orderBy("createdAt", "desc");
  }

  const snapshot = await query.limit(parseInt(limitParam)).get();
  const issues = snapshot.docs.map((doc: any) => {
    const data = doc.data();
    return {
      id: doc.id,
      summary: data.summary || null,
      text: data.text || null,
      status: data.status || "open",
      priority: data.priority || null,
      category: data.category || null,
      reporterName: data.reporterName || null,
      reporterId: data.reporterId || null,
      assigneeName: data.assigneeName || null,
      createdAt: data.createdAt ? { seconds: data.createdAt.seconds } : null,
      updatedAt: data.updatedAt ? { seconds: data.updatedAt.seconds } : null,
    };
  });

  // Client-side filter for priority (Firestore can't do two inequality/range filters)
  const filtered = priority ? issues.filter((i: any) => i.priority === priority) : issues;

  return NextResponse.json({ issues: filtered });
}
