import { FuturesMetrics, FuturesSnapshot } from "./futures-types";
import { getSupabaseServerClient } from "./supabase-server";

const MAX_READ_ROWS = 5000;
const fallbackHistory = new Map<string, FuturesSnapshot[]>();
const TABLE_NAME = "user_futures_history";

type HistoryRow = {
  user_id: string;
  snapshot_ts: number;
  snapshot: FuturesSnapshot;
  created_at: string;
};

function normalizeScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sanitizeSnapshot(value: unknown): FuturesSnapshot | null {
  if (!value || typeof value !== "object") return null;
  return value as FuturesSnapshot;
}

export async function readHistory(scope: string): Promise<FuturesSnapshot[]> {
  const scopeKey = normalizeScope(scope);
  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("snapshot,snapshot_ts")
      .eq("user_id", scope)
      .order("snapshot_ts", { ascending: false })
      .limit(MAX_READ_ROWS)
      .returns<Array<Pick<HistoryRow, "snapshot" | "snapshot_ts">>>();
    if (error || !Array.isArray(data)) {
      return fallbackHistory.get(scopeKey) ?? [];
    }
    const rows = data
      .slice()
      .reverse()
      .map((row) => sanitizeSnapshot(row.snapshot))
      .filter((row): row is FuturesSnapshot => row !== null);
    fallbackHistory.set(scopeKey, rows);
    return rows;
  } catch {
    return fallbackHistory.get(scopeKey) ?? [];
  }
}

export async function appendSnapshot(scope: string, snapshot: FuturesSnapshot): Promise<FuturesSnapshot[]> {
  const scopeKey = normalizeScope(scope);
  try {
    const supabase = await getSupabaseServerClient();
    const { error } = await supabase.from(TABLE_NAME).insert({
      user_id: scope,
      snapshot_ts: snapshot.timestamp,
      snapshot,
      created_at: new Date().toISOString(),
    } satisfies HistoryRow);
    if (error) {
      const rows = [...(fallbackHistory.get(scopeKey) ?? []), snapshot].slice(-MAX_READ_ROWS);
      fallbackHistory.set(scopeKey, rows);
      return rows;
    }
    return await readHistory(scope);
  } catch {
    const rows = [...(fallbackHistory.get(scopeKey) ?? []), snapshot].slice(-MAX_READ_ROWS);
    fallbackHistory.set(scopeKey, rows);
    return rows;
  }
}

export function computeMetrics(history: FuturesSnapshot[]): FuturesMetrics {
  const latest = history[history.length - 1];
  if (!latest) {
    return {
      equity: 0,
      totalPnl: 0,
      totalPnlPercent: 0,
      winRatePercent: 0,
      profitFactor: 0,
      maxDrawdownPercent: 0,
      turnover24h: 0,
      trades24h: 0,
      expectancy: 0,
    };
  }

  const equitySeries = history.map((row) => row.walletBalance + row.totalUnrealizedPnl);
  const firstEquity = equitySeries[0] || 1;
  const equity = equitySeries[equitySeries.length - 1] || 0;
  const totalPnl = equity - firstEquity;
  // Use "current balance + accumulated loss" as reference when total PnL is negative.
  // Example: equity=6200 and totalPnl=-826 => reference=7026, pnl%=-11.76%.
  const percentReferenceBalance = totalPnl < 0 ? equity + Math.abs(totalPnl) : Math.max(equity - totalPnl, 0);
  const totalPnlPercent = (totalPnl / Math.max(Math.abs(percentReferenceBalance), 1)) * 100;

  let peak = equitySeries[0] || 0;
  let maxDrawdown = 0;
  for (const value of equitySeries) {
    peak = Math.max(peak, value);
    const dd = peak > 0 ? ((peak - value) / peak) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, dd);
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const tradeMap = new Map<string, (typeof latest.recentTrades)[number]>();
  for (const snapshotRow of history) {
    for (const trade of snapshotRow.recentTrades) {
      if (trade.time < cutoff) continue;
      const exchange = trade.exchange || "BINGX";
      const key = `${exchange}|${trade.symbol}|${trade.time}|${trade.side}|${trade.positionSide}`;
      if (!tradeMap.has(key)) {
        tradeMap.set(key, { ...trade, exchange });
      }
    }
  }
  const trades24h = Array.from(tradeMap.values());
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let turnover24h = 0;
  for (const trade of trades24h) {
    turnover24h += trade.quoteQty;
    if (trade.realizedPnl > 0) {
      wins += 1;
      grossProfit += trade.realizedPnl;
    } else if (trade.realizedPnl < 0) {
      losses += 1;
      grossLoss += Math.abs(trade.realizedPnl);
    }
  }

  const closedTrades = wins + losses;
  const winRatePercent = closedTrades > 0 ? (wins / closedTrades) * 100 : 0;
  const averageWin = wins > 0 ? grossProfit / wins : 0;
  const averageLoss = losses > 0 ? grossLoss / losses : 0;
  const expectancy = closedTrades > 0 ? (grossProfit - grossLoss) / closedTrades : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? grossProfit : 0;

  return {
    equity,
    totalPnl,
    totalPnlPercent,
    winRatePercent,
    profitFactor,
    maxDrawdownPercent: maxDrawdown,
    turnover24h,
    trades24h: trades24h.length,
    expectancy: Number.isFinite(expectancy) ? expectancy : averageWin - averageLoss,
  };
}
