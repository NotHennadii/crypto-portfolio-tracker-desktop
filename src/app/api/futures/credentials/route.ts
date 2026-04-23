import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";
import { clearPersistentCredentials } from "@/lib/persistent-credentials";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return auth.response;
  }
  await request.text().catch(() => "");
  return NextResponse.json({
    ok: true,
    storage: "none",
    message: "Server-side credential storage is disabled. Send exchange keys only in /api/futures/monitor request body.",
  });
}

export async function DELETE() {
  const auth = await requireUserId();
  if (!auth.ok) {
    return auth.response;
  }
  try {
    await clearPersistentCredentials(auth.userId);
  } catch {
    // cleanup is best effort
  }
  return NextResponse.json({ ok: true, storage: "none" });
}
