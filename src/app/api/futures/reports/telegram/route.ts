import { NextResponse } from "next/server";
import { FuturesTrade } from "@/lib/futures-types";
import { requireUserId } from "@/lib/require-user";

export const runtime = "nodejs";

type Body = {
  period?: "day" | "week" | "month";
  botToken?: string;
  chatId?: string;
  trades?: FuturesTrade[];
};

export async function POST(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as Body;
  const period = body.period ?? "week";
  const botToken = body.botToken?.trim() || process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = body.chatId?.trim() || process.env.TELEGRAM_CHAT_ID || "";
  const trades = Array.isArray(body.trades) ? body.trades : [];
  if (!botToken || !chatId) {
    return NextResponse.json(
      { ok: false, error: "Укажите Telegram bot token и chat id (или задайте TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)." },
      { status: 400 }
    );
  }

  const pnl = trades.reduce((sum, trade) => sum + (Number.isFinite(trade.realizedPnl) ? trade.realizedPnl : 0), 0);
  const wins = trades.filter((trade) => trade.realizedPnl > 0).length;
  const summary = [
    `📘 Trader report (${period})`,
    `Сделок: ${trades.length}`,
    `Winrate: ${trades.length ? ((wins / trades.length) * 100).toFixed(2) : "0.00"}%`,
    `PnL: ${pnl.toFixed(2)} USDT`,
  ].join("\n");

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: summary,
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    return NextResponse.json({ ok: false, error: `Telegram API error: ${details || response.statusText}` }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
