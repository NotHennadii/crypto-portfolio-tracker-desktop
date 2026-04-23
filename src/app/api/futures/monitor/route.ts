import { NextResponse } from "next/server";
import { toHttpError } from "@/lib/bingx";
import { appendSnapshot, computeMetrics, readHistory } from "@/lib/futures-history";
import { FuturesMonitorResponse } from "@/lib/futures-types";
import { readTradeSignals } from "@/lib/trade-signals";
import { fetchCombinedFuturesSnapshot } from "@/lib/futures-aggregator";
import { requireUserId } from "@/lib/require-user";

export const runtime = "nodejs";
const HISTORY_LIMIT = 600;
const TRADES_PER_SNAPSHOT_LIMIT = 250;

function compactHistoryForPayload(history: FuturesMonitorResponse["history"]): FuturesMonitorResponse["history"] {
  return history.slice(-HISTORY_LIMIT).map((snapshot) => ({
    ...snapshot,
    recentTrades: snapshot.recentTrades.slice(0, TRADES_PER_SNAPSHOT_LIMIT),
  }));
}

type MonitorBody = {
  bingxApiKey?: string;
  bingxApiSecret?: string;
  bitgetApiKey?: string;
  bitgetApiSecret?: string;
  bitgetPassphrase?: string;
  binanceApiKey?: string;
  binanceApiSecret?: string;
  bybitApiKey?: string;
  bybitApiSecret?: string;
  mexcApiKey?: string;
  mexcApiSecret?: string;
  gateApiKey?: string;
  gateApiSecret?: string;
};

async function handleMonitor(body?: MonitorBody) {
  const auth = await requireUserId();
  if (!auth.ok) {
    return auth.response;
  }
  const warnings: string[] = [];

  try {
    const resolvedCredentials = {
      bingxApiKey: body?.bingxApiKey?.trim() || "",
      bingxApiSecret: body?.bingxApiSecret?.trim() || "",
      bitgetApiKey: body?.bitgetApiKey?.trim() || "",
      bitgetApiSecret: body?.bitgetApiSecret?.trim() || "",
      bitgetPassphrase: body?.bitgetPassphrase?.trim() || "",
      binanceApiKey: body?.binanceApiKey?.trim() || "",
      binanceApiSecret: body?.binanceApiSecret?.trim() || "",
      bybitApiKey: body?.bybitApiKey?.trim() || "",
      bybitApiSecret: body?.bybitApiSecret?.trim() || "",
      mexcApiKey: body?.mexcApiKey?.trim() || "",
      mexcApiSecret: body?.mexcApiSecret?.trim() || "",
      gateApiKey: body?.gateApiKey?.trim() || "",
      gateApiSecret: body?.gateApiSecret?.trim() || "",
    };
    const hasAnyCredentials = Boolean(
      (resolvedCredentials.bingxApiKey && resolvedCredentials.bingxApiSecret) ||
      (resolvedCredentials.bitgetApiKey && resolvedCredentials.bitgetApiSecret && resolvedCredentials.bitgetPassphrase) ||
      (resolvedCredentials.binanceApiKey && resolvedCredentials.binanceApiSecret) ||
      (resolvedCredentials.bybitApiKey && resolvedCredentials.bybitApiSecret) ||
      (resolvedCredentials.mexcApiKey && resolvedCredentials.mexcApiSecret) ||
      (resolvedCredentials.gateApiKey && resolvedCredentials.gateApiSecret)
    );
    if (!hasAnyCredentials) {
      const history = await readHistory(auth.userId);
      const tradeSignals = await readTradeSignals(auth.userId);
      const trimmedHistory = compactHistoryForPayload(history);
      const payload: FuturesMonitorResponse = {
        ok: true,
        warnings: [
          "API ключи не переданы в запросе. Биржевой снапшот не обновлялся; возвращены последние доступные данные.",
        ],
        snapshot: history[history.length - 1] ?? null,
        history: trimmedHistory,
        metrics: computeMetrics(history),
        tradeSignals,
      };
      return NextResponse.json(payload);
    }
    const snapshot = await fetchCombinedFuturesSnapshot({
      bingxApiKey: resolvedCredentials.bingxApiKey,
      bingxApiSecret: resolvedCredentials.bingxApiSecret,
      bitgetApiKey: resolvedCredentials.bitgetApiKey,
      bitgetApiSecret: resolvedCredentials.bitgetApiSecret,
      bitgetPassphrase: resolvedCredentials.bitgetPassphrase,
      binanceApiKey: resolvedCredentials.binanceApiKey,
      binanceApiSecret: resolvedCredentials.binanceApiSecret,
      bybitApiKey: resolvedCredentials.bybitApiKey,
      bybitApiSecret: resolvedCredentials.bybitApiSecret,
      mexcApiKey: resolvedCredentials.mexcApiKey,
      mexcApiSecret: resolvedCredentials.mexcApiSecret,
      gateApiKey: resolvedCredentials.gateApiKey,
      gateApiSecret: resolvedCredentials.gateApiSecret,
    });
    if (snapshot.degraded) {
      warnings.push(
        "Часть эндпоинтов бирж временно недоступна. Показаны данные по тем биржам, ответившим успешно."
      );
    }
    const history = await appendSnapshot(auth.userId, snapshot);
    const tradeSignals = await readTradeSignals(auth.userId);
    const trimmedHistory = compactHistoryForPayload(history);
    const payload: FuturesMonitorResponse = {
      ok: true,
      warnings,
      snapshot,
      history: trimmedHistory,
      metrics: computeMetrics(history),
      tradeSignals,
    };
    return NextResponse.json(payload);
  } catch (error) {
    const normalized = toHttpError(error);
    warnings.push(normalized.message);
    const history = await readHistory(auth.userId);
    const tradeSignals = await readTradeSignals(auth.userId);
    const trimmedHistory = compactHistoryForPayload(history);
    const payload: FuturesMonitorResponse = {
      ok: false,
      warnings,
      snapshot: history[history.length - 1] ?? null,
      history: trimmedHistory,
      metrics: computeMetrics(history),
      tradeSignals,
    };
    return NextResponse.json(payload, { status: normalized.statusCode });
  }
}

export async function GET() {
  return handleMonitor();
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as MonitorBody;
  return handleMonitor(body);
}
