import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";
import { readBaseEquityUsd, saveBaseEquityUsd } from "@/lib/dashboard-settings";

type SettingsBody = {
  baseEquityUsd?: number | null;
};

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireUserId();
  if (!auth.ok) return auth.response;
  const baseEquityUsd = await readBaseEquityUsd(auth.userId);
  return NextResponse.json({ ok: true, baseEquityUsd });
}

export async function POST(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as SettingsBody;
  try {
    const value = body.baseEquityUsd;
    if (value != null) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return NextResponse.json({ ok: false, error: "baseEquityUsd must be a positive number." }, { status: 400 });
      }
      const result = await saveBaseEquityUsd(auth.userId, parsed);
      return NextResponse.json({
        ok: true,
        baseEquityUsd: parsed,
        persisted: result.persisted,
        warning: result.warning ?? null,
      });
    }
    const result = await saveBaseEquityUsd(auth.userId, null);
    return NextResponse.json({
      ok: true,
      baseEquityUsd: null,
      persisted: result.persisted,
      warning: result.warning ?? null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save dashboard settings.",
      },
      { status: 503 }
    );
  }
}

