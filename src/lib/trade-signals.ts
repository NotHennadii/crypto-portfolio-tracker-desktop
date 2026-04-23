import { TradeSignal } from "./futures-types";
import { getSupabaseServerClient } from "./supabase-server";

const MAX_ROWS = 20000;
const fallbackSignals = new Map<string, Record<string, TradeSignal>>();
const TABLE_NAME = "user_trade_signals";

type TradeSignalRow = {
  user_id: string;
  trade_key: string;
  signal: TradeSignal;
  updated_at: string;
};

function normalizeScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export async function readTradeSignals(scope: string): Promise<Record<string, TradeSignal>> {
  const scopeKey = normalizeScope(scope);
  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("trade_key,signal")
      .eq("user_id", scope)
      .order("updated_at", { ascending: true })
      .limit(MAX_ROWS)
      .returns<Array<Pick<TradeSignalRow, "trade_key" | "signal">>>();
    if (error || !Array.isArray(data)) {
      return fallbackSignals.get(scopeKey) ?? {};
    }
    const signals: Record<string, TradeSignal> = {};
    for (const row of data) {
      if (!row.trade_key) continue;
      signals[row.trade_key] = row.signal;
    }
    fallbackSignals.set(scopeKey, signals);
    return signals;
  } catch {
    return fallbackSignals.get(scopeKey) ?? {};
  }
}

export async function setTradeSignal(scope: string, tradeKey: string, signal: TradeSignal): Promise<Record<string, TradeSignal>> {
  const scopeKey = normalizeScope(scope);
  try {
    const supabase = await getSupabaseServerClient();
    const { error } = await supabase.from(TABLE_NAME).upsert(
      {
        user_id: scope,
        trade_key: tradeKey,
        signal,
        updated_at: new Date().toISOString(),
      } satisfies TradeSignalRow,
      { onConflict: "user_id,trade_key" }
    );
    if (!error) {
      return await readTradeSignals(scope);
    }
  } catch {
    // fallback below
  }
  const current = { ...(fallbackSignals.get(scopeKey) ?? {}) };
  current[tradeKey] = signal;
  const entries = Object.entries(current).slice(-MAX_ROWS);
  const next = Object.fromEntries(entries) as Record<string, TradeSignal>;
  fallbackSignals.set(scopeKey, next);
  return next;
}
