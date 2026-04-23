import { NextResponse } from "next/server";
import { TradeSignal } from "@/lib/futures-types";
import { setTradeSignal } from "@/lib/trade-signals";
import { requireUserId } from "@/lib/require-user";

export const runtime = "nodejs";

type SignalBody = {
  tradeKey?: string;
  signal?: TradeSignal;
};

const SIGNAL_PATTERN = /^[A-Z0-9_]{2,32}$/;

export async function POST(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return auth.response;
  }
  const body = (await request.json().catch(() => ({}))) as SignalBody;
  const tradeKey = body.tradeKey?.trim() ?? "";
  if (!tradeKey) {
    return NextResponse.json({ ok: false, error: "tradeKey is required." }, { status: 400 });
  }
  if (!body.signal || !SIGNAL_PATTERN.test(body.signal)) {
    return NextResponse.json({ ok: false, error: "signal is invalid." }, { status: 400 });
  }
  const signals = await setTradeSignal(auth.userId, tradeKey, body.signal);
  return NextResponse.json({ ok: true, tradeSignals: signals });
}
