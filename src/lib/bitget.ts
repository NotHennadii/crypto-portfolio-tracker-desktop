import crypto from "node:crypto";
import { FuturesPosition, FuturesSnapshot, FuturesTrade } from "./futures-types";

const BASE_URL = process.env.BITGET_BASE_URL ?? "https://api.bitget.com";
const PRODUCT_TYPE = "USDT-FUTURES";
const REQUEST_TIMEOUT_MS = 10000;
const TRADE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const TRADE_PAGE_SIZE = 100;
const TRADE_MAX_PAGES = 10;
const MAX_RECENT_TRADES = 1000;

function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function extractArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  const candidates = [
    record.list,
    record.rows,
    record.items,
    record.data,
    record.result,
    record.orders,
    record.orderList,
    record.entrustedList,
    record.trades,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    const nested = asRecord(candidate);
    if (nested) {
      const deepCandidates = [
        nested.list,
        nested.rows,
        nested.items,
        nested.orders,
        nested.orderList,
        nested.entrustedList,
        nested.trades,
      ];
      for (const deep of deepCandidates) {
        if (Array.isArray(deep)) return deep;
      }
    }
  }
  return [];
}

function buildQuery(params: Record<string, string | number>): string {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

async function fetchJsonWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

async function signedGet<T>(
  path: string,
  params: Record<string, string | number>,
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<T> {
  const query = buildQuery(params);
  const fullPath = query ? `${path}?${query}` : path;
  const timestamp = Date.now().toString();
  const prehash = `${timestamp}GET${fullPath}`;
  const sign = crypto.createHmac("sha256", apiSecret).update(prehash).digest("base64");
  const response = await fetchJsonWithTimeout(`${BASE_URL}${fullPath}`, {
    method: "GET",
    headers: {
      "ACCESS-KEY": apiKey,
      "ACCESS-SIGN": sign,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": passphrase,
      "Content-Type": "application/json",
      locale: "en-US",
    },
  });
  const payload = (await response.json()) as {
    code?: string;
    msg?: string;
    data?: unknown;
  };
  if (!response.ok || (payload.code != null && payload.code !== "00000")) {
    throw new Error(payload.msg ?? `Bitget request failed (${response.status})`);
  }
  return payload.data as T;
}

function normalizePositions(raw: unknown): FuturesPosition[] {
  const rows = extractArray(raw);
  return rows
    .map((row): FuturesPosition | null => {
      if (!row || typeof row !== "object") return null;
      const rec = row as Record<string, unknown>;
      const qty = asNumber(rec.total ?? rec.size);
      const entry = asNumber(rec.openPriceAvg ?? rec.averageOpenPrice);
      const mark = asNumber(rec.markPrice);
      const notional = Math.abs(asNumber(rec.usdtEquity ?? rec.positionValue) || qty * mark);
      if (!qty || !notional) return null;
      const leverage = Math.max(asNumber(rec.leverage), 1);
      const unrealized = asNumber(rec.unrealizedPL ?? rec.unrealizedPnl);
      const margin = Math.max(asNumber(rec.marginSize ?? rec.margin), notional / leverage, 1);
      return {
        exchange: "BITGET",
        symbol: String(rec.symbol ?? "UNKNOWN"),
        side: String(rec.holdSide ?? rec.side ?? (qty > 0 ? "LONG" : "SHORT")).toUpperCase(),
        leverage,
        positionAmt: qty,
        entryPrice: entry,
        markPrice: mark || entry,
        unrealizedPnl: unrealized,
        realizedPnl: asNumber(rec.achievedProfits),
        marginType: String(rec.marginMode ?? "cross"),
        marginUsedUsd: margin,
        isolatedMargin: asNumber(rec.margin),
        notionalUsd: notional,
        liquidationPrice: asNumber(rec.liquidationPrice) || null,
        pnlPercent: (unrealized / margin) * 100,
        updatedAt: Date.now(),
      };
    })
    .filter((item): item is FuturesPosition => item !== null);
}

function normalizeTrades(raw: unknown): FuturesTrade[] {
  const rows = extractArray(raw);
  return rows
    .map((row): FuturesTrade | null => {
      if (!row || typeof row !== "object") return null;
      const rec = row as Record<string, unknown>;
      const qty = asNumber(rec.size ?? rec.baseVolume);
      const price = asNumber(rec.priceAvg ?? rec.price);
      if (!qty || !price) return null;
      const quoteQty = Math.abs(asNumber(rec.filledAmount) || qty * price);
      const leverage = Math.max(asNumber(rec.leverage), 1);
      const marginUsed = Math.max(quoteQty / leverage, 1);
      const realizedPnl = asNumber(rec.totalProfits ?? rec.pnl);
      return {
        exchange: "BITGET",
        symbol: String(rec.symbol ?? "UNKNOWN"),
        side: String(rec.side ?? rec.tradeSide ?? "UNKNOWN").toUpperCase(),
        positionSide: String(rec.posSide ?? rec.holdSide ?? "BOTH").toUpperCase(),
        leverage,
        marginUsed,
        price,
        qty,
        quoteQty,
        realizedPnl,
        pnlPercent: (realizedPnl / marginUsed) * 100,
        fee: asNumber(rec.totalFee ?? rec.fee),
        feeAsset: String(rec.feeCoin ?? "USDT"),
        time: asNumber(rec.uTime ?? rec.cTime ?? rec.createTime) || Date.now(),
        isLiquidation: false,
      };
    })
    .filter((item): item is FuturesTrade => item !== null)
    .sort((a, b) => b.time - a.time);
}

function tradeKey(trade: FuturesTrade): string {
  return `${trade.exchange}|${trade.symbol}|${trade.time}|${trade.side}|${trade.positionSide}|${trade.qty}|${trade.price}`;
}

async function fetchBitgetOrdersHistoryPaginated(
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<FuturesTrade[]> {
  const endTime = Date.now();
  const startTime = endTime - TRADE_LOOKBACK_MS;
  const merged: FuturesTrade[] = [];
  const seen = new Set<string>();

  for (let pageNo = 1; pageNo <= TRADE_MAX_PAGES; pageNo += 1) {
    const pageRaw = await signedGet<unknown[]>(
      "/api/v2/mix/order/orders-history",
      {
        productType: PRODUCT_TYPE,
        pageSize: TRADE_PAGE_SIZE,
        pageNo,
        startTime,
        endTime,
      },
      apiKey,
      apiSecret,
      passphrase
    ).catch(() => []);
    const normalized = normalizeTrades(pageRaw);
    if (normalized.length === 0) break;
    let added = 0;
    for (const trade of normalized) {
      const key = tradeKey(trade);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(trade);
      added += 1;
      if (merged.length >= MAX_RECENT_TRADES) break;
    }
    if (merged.length >= MAX_RECENT_TRADES) break;
    if (added === 0 || normalized.length < TRADE_PAGE_SIZE) break;
  }

  return merged.sort((a, b) => b.time - a.time).slice(0, MAX_RECENT_TRADES);
}

async function fetchBitgetOrdersHistorySafe(
  apiKey: string,
  apiSecret: string,
  passphrase: string
): Promise<FuturesTrade[]> {
  try {
    const paged = await fetchBitgetOrdersHistoryPaginated(apiKey, apiSecret, passphrase);
    if (paged.length > 0) return paged;
  } catch {
    // fallback below
  }
  const legacyRaw = await signedGet<unknown[]>(
    "/api/v2/mix/order/orders-history",
    { productType: PRODUCT_TYPE, pageSize: 100 },
    apiKey,
    apiSecret,
    passphrase
  ).catch(() => []);
  return normalizeTrades(legacyRaw).slice(0, 500);
}

export async function fetchBitgetFuturesSnapshotWithCredentials(credentials?: {
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
}): Promise<FuturesSnapshot> {
  const apiKey = credentials?.apiKey?.trim() || process.env.BITGET_API_KEY;
  const apiSecret = credentials?.apiSecret?.trim() || process.env.BITGET_API_SECRET;
  const passphrase = credentials?.passphrase?.trim() || process.env.BITGET_API_PASSPHRASE;
  if (!apiKey || !apiSecret || !passphrase) {
    throw new Error("Enter Bitget API key, secret and passphrase.");
  }

  const [accountsRaw, positionsRaw, recentTrades] = await Promise.all([
    signedGet<unknown[]>("/api/v2/mix/account/accounts", { productType: PRODUCT_TYPE }, apiKey, apiSecret, passphrase),
    signedGet<unknown[]>("/api/v2/mix/position/all-position", { productType: PRODUCT_TYPE, marginCoin: "USDT" }, apiKey, apiSecret, passphrase),
    fetchBitgetOrdersHistorySafe(apiKey, apiSecret, passphrase),
  ]);

  const accounts = extractArray(accountsRaw);
  const account = asRecord(accounts[0]) ?? asRecord(accountsRaw) ?? {};
  const reportedBalance = asNumber(
    account.usdtBalance ??
      account.marginBalance ??
      account.accountBalance ??
      account.walletBalance
  );
  const reportedEquity = asNumber(account.usdtEquity ?? account.accountEquity ?? account.equity);
  const availableBalance = asNumber(account.available ?? account.availableBalance);
  const totalRealizedPnl = asNumber(account.achievedProfits ?? account.realizedPL);

  const positions = normalizePositions(positionsRaw);
  const totalUnrealizedPnl = positions.reduce((sum, item) => sum + item.unrealizedPnl, 0);
  // Bitget account equity usually already includes unrealized PnL.
  // Normalize to "wallet" so global formula wallet + unrealized == equity.
  const walletBalance =
    reportedEquity > 0
      ? Math.max(reportedEquity - totalUnrealizedPnl, 0)
      : reportedBalance;
  const totalNotional = positions.reduce((sum, item) => sum + Math.abs(item.notionalUsd), 0);
  const usedMargin = positions.reduce((sum, item) => sum + Math.abs(item.notionalUsd) / Math.max(item.leverage, 1), 0);
  const equity = walletBalance + totalUnrealizedPnl;
  const marginRatio = usedMargin > 0 ? (usedMargin / Math.max(equity, 1)) * 100 : 0;

  return {
    timestamp: Date.now(),
    walletBalance,
    availableBalance,
    totalUnrealizedPnl,
    totalRealizedPnl,
    totalNotional,
    usedMargin,
    marginRatio,
    positions,
    recentTrades,
    diagnostics: ["exchange=BITGET", `recentTrades=${recentTrades.length}`],
    degraded: false,
  };
}
