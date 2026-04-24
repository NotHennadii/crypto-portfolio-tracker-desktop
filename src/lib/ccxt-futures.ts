import ccxt from "ccxt";
import { FuturesPosition, FuturesSnapshot, FuturesTrade } from "./futures-types";

type SupportedCcxtExchange = "BINANCE" | "BYBIT" | "MEXC" | "GATE";

type ExchangeCredentials = {
  apiKey: string;
  secret: string;
};

const TRADE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const TRADE_PAGE_LIMIT = 200;
const TRADE_MAX_PAGES = 8;
const MAX_RECENT_TRADES = 1000;

function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeTrades(exchange: SupportedCcxtExchange, rows: Array<Record<string, unknown>>): FuturesTrade[] {
  return rows
    .map((trade): FuturesTrade | null => {
      const qty = asNumber(trade.amount);
      const price = asNumber(trade.price);
      if (!qty || !price) return null;
      const quoteQty = Math.abs(asNumber(trade.cost) || qty * price);
      const feeObj = (trade.fee as Record<string, unknown> | undefined) ?? {};
      const fee = asNumber(feeObj.cost);
      const feeAsset = String(feeObj.currency ?? "USDT").toUpperCase();
      const side = String(trade.side ?? "UNKNOWN").toUpperCase();
      const positionSide = side === "BUY" ? "LONG" : side === "SELL" ? "SHORT" : "BOTH";
      const info = (trade.info as Record<string, unknown> | undefined) ?? {};
      const realizedPnl = asNumber(info.realizedPnl) || asNumber(info.closedPnl);
      const marginUsed = Math.max(quoteQty, 1);
      return {
        exchange,
        symbol: String(trade.symbol ?? "UNKNOWN"),
        side,
        positionSide,
        leverage: 1,
        marginUsed,
        price,
        qty,
        quoteQty,
        realizedPnl,
        pnlPercent: (realizedPnl / marginUsed) * 100,
        fee,
        feeAsset,
        time: asNumber(trade.timestamp) || Date.now(),
        isLiquidation: false,
      };
    })
    .filter((item): item is FuturesTrade => item !== null)
    .sort((a, b) => b.time - a.time)
    .slice(0, 1000);
}

function normalizePositions(exchange: SupportedCcxtExchange, rows: Array<Record<string, unknown>>): FuturesPosition[] {
  return rows
    .map((position): FuturesPosition | null => {
      const contracts = asNumber(position.contracts);
      const entryPrice = asNumber(position.entryPrice);
      const markPrice = asNumber(position.markPrice) || entryPrice;
      const notional = Math.abs(asNumber(position.notional) || contracts * markPrice);
      if (!contracts || !notional) return null;
      const leverage = Math.max(asNumber(position.leverage), 1);
      const unrealized = asNumber(position.unrealizedPnl);
      const marginUsedUsd = Math.max(asNumber(position.initialMargin) || notional / leverage, 1);
      const side = String(position.side ?? (contracts > 0 ? "long" : "short")).toUpperCase();
      return {
        exchange,
        symbol: String(position.symbol ?? "UNKNOWN"),
        side,
        leverage,
        positionAmt: contracts,
        entryPrice,
        markPrice,
        unrealizedPnl: unrealized,
        realizedPnl: 0,
        marginType: String(position.marginMode ?? "cross"),
        marginUsedUsd,
        isolatedMargin: asNumber(position.initialMargin),
        notionalUsd: notional,
        liquidationPrice: asNumber(position.liquidationPrice) || null,
        pnlPercent: (unrealized / marginUsedUsd) * 100,
        updatedAt: Date.now(),
      };
    })
    .filter((item): item is FuturesPosition => item !== null);
}

function createClient(exchange: SupportedCcxtExchange, credentials: ExchangeCredentials) {
  const common = {
    apiKey: credentials.apiKey,
    secret: credentials.secret,
    enableRateLimit: true,
  };
  switch (exchange) {
    case "BINANCE":
      return new ccxt.binance({ ...common, options: { defaultType: "future" } });
    case "BYBIT":
      return new ccxt.bybit({ ...common, options: { defaultType: "linear" } });
    case "MEXC":
      return new ccxt.mexc({ ...common, options: { defaultType: "swap" } });
    case "GATE":
      return new ccxt.gate({ ...common, options: { defaultType: "swap" } });
  }
}

function tradeKey(trade: FuturesTrade): string {
  return `${trade.exchange}|${trade.symbol}|${trade.time}|${trade.side}|${trade.positionSide}|${trade.qty}|${trade.price}`;
}

async function fetchRecentTradesPaginated(
  client: { fetchMyTrades: (symbol?: string, since?: number, limit?: number) => Promise<unknown[]> },
  exchange: SupportedCcxtExchange
): Promise<FuturesTrade[]> {
  const merged: FuturesTrade[] = [];
  const seen = new Set<string>();
  let since = Date.now() - TRADE_LOOKBACK_MS;

  for (let page = 0; page < TRADE_MAX_PAGES; page += 1) {
    const rows = (await client.fetchMyTrades(undefined, since, TRADE_PAGE_LIMIT).catch(() => [])) as Array<
      Record<string, unknown>
    >;
    const normalized = normalizeTrades(exchange, rows);
    if (normalized.length === 0) break;
    let maxTs = since;
    let added = 0;
    for (const trade of normalized) {
      maxTs = Math.max(maxTs, trade.time);
      const key = tradeKey(trade);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(trade);
      added += 1;
      if (merged.length >= MAX_RECENT_TRADES) break;
    }
    if (merged.length >= MAX_RECENT_TRADES) break;
    if (added === 0 || normalized.length < TRADE_PAGE_LIMIT) break;
    since = maxTs + 1;
  }

  return merged.sort((a, b) => b.time - a.time).slice(0, MAX_RECENT_TRADES);
}

export async function fetchCcxtFuturesSnapshot(
  exchange: SupportedCcxtExchange,
  credentials: ExchangeCredentials
): Promise<FuturesSnapshot> {
  const client = createClient(exchange, credentials);
  await client.loadMarkets();

  const [balance, positionsRaw, recentTrades] = await Promise.all([
    client.fetchBalance(),
    client.fetchPositions().catch(() => []),
    fetchRecentTradesPaginated(client, exchange),
  ]);

  const usdtTotal = asNumber(
    ((balance.total as unknown as Record<string, unknown> | undefined)?.USDT) ??
      ((balance.info as unknown as { totalWalletBalance?: unknown })?.totalWalletBalance)
  );
  const usdtFree = asNumber(
    ((balance.free as unknown as Record<string, unknown> | undefined)?.USDT) ??
      ((balance.info as unknown as { availableBalance?: unknown })?.availableBalance)
  );

  const positions = normalizePositions(exchange, positionsRaw as Array<Record<string, unknown>>);
  const totalUnrealizedPnl = positions.reduce((sum, item) => sum + item.unrealizedPnl, 0);
  const totalNotional = positions.reduce((sum, item) => sum + Math.abs(item.notionalUsd), 0);
  const usedMargin = positions.reduce((sum, item) => sum + item.marginUsedUsd, 0);
  const equity = usdtTotal + totalUnrealizedPnl;

  return {
    timestamp: Date.now(),
    walletBalance: usdtTotal,
    availableBalance: usdtFree,
    totalUnrealizedPnl,
    totalRealizedPnl: 0,
    totalNotional,
    usedMargin,
    marginRatio: usedMargin > 0 ? (usedMargin / Math.max(equity, 1)) * 100 : 0,
    positions,
    recentTrades,
    diagnostics: [`exchange=${exchange}`, `recentTrades=${recentTrades.length}`],
    degraded: false,
  };
}
