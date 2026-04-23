import crypto from "node:crypto";
import { FuturesPosition, FuturesSnapshot, FuturesTrade } from "./futures-types";

const BASE_URL = process.env.BINGX_BASE_URL ?? "https://open-api.bingx.com";
const SAFE_TRADES_LIMIT = 1000;
const TRADES_PAGE_LIMIT = 200;
const TRADES_MAX_PAGES = 6;
const DEFAULT_RECV_WINDOW = 10000;
const REQUEST_TIMEOUT_MS = 10000;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;
const JITTER_MS = 250;
const TIMESTAMP_RESYNC_MS = 120000;

type FetchOptions = {
  apiKey: string;
  secret: string;
  recvWindow?: number;
  diagnostics: string[];
};

class HttpError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

let serverTimeOffsetMs = 0;
let serverTimeCheckedAt = 0;

function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseLeverage(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[xX]/g, "").trim();
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 1;
}

function readLiquidationFlag(row: Record<string, unknown>): {
  isLiquidation: boolean;
  liquidationReason?: string;
} {
  const candidates = [
    row.closeType,
    row.tradeType,
    row.execType,
    row.orderType,
    row.status,
    row.orderStatus,
    row.text,
  ]
    .map((value) => String(value ?? "").toUpperCase())
    .filter(Boolean);
  const hit = candidates.find(
    (value) =>
      value.includes("LIQUID") ||
      value.includes("FORCE") ||
      value.includes("BURST") ||
      value.includes("ADL")
  );
  return hit ? { isLiquidation: true, liquidationReason: hit } : { isLiquidation: false };
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
    record.trades,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    const nested = asRecord(candidate);
    if (nested) {
      const deepCandidates = [nested.list, nested.rows, nested.items, nested.orders, nested.trades];
      for (const deep of deepCandidates) {
        if (Array.isArray(deep)) return deep;
      }
    }
  }
  return [];
}

function firstRecord(value: unknown): Record<string, unknown> {
  const arr = extractArray(value);
  if (arr.length > 0) {
    return asRecord(arr[0]) ?? {};
  }
  return asRecord(value) ?? {};
}

function buildQuery(params: Record<string, string | number>): string {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`)
    .join("&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTimestamp(): number {
  return Date.now() + serverTimeOffsetMs;
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableCode(code: number): boolean {
  return [418, 429, 500, 502, 503, 504].includes(code);
}

function getPayloadCode(payload: unknown): number | null {
  const record = asRecord(payload);
  if (!record) return null;
  if (typeof record.code === "number") return record.code;
  if (typeof record.code === "string") {
    const parsed = Number(record.code);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRetryableApiCode(code: number | null): boolean {
  if (code == null) return false;
  return [100001, 100004, 100400, 100421, 100500].includes(code);
}

async function refreshServerTimeOffset(): Promise<void> {
  const now = Date.now();
  if (now - serverTimeCheckedAt < TIMESTAMP_RESYNC_MS) return;
  try {
    const response = await fetchJsonWithTimeout(`${BASE_URL}/openApi/swap/v2/server/time`, { method: "GET" }, 5000);
    if (!response.ok) return;
    const payload = (await response.json()) as Record<string, unknown>;
    const data = asRecord(payload.data);
    const exchangeTime = asNumber(data?.serverTime ?? payload.serverTime ?? data?.time ?? payload.time);
    if (exchangeTime > 0) {
      serverTimeOffsetMs = exchangeTime - now;
      serverTimeCheckedAt = now;
    }
  } catch {
    // Best effort sync only.
  }
}

async function signedGet<T>(path: string, params: Record<string, string | number>, options: FetchOptions): Promise<T> {
  const recvWindow = options.recvWindow ?? DEFAULT_RECV_WINDOW;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 0) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * JITTER_MS));
      }
      await refreshServerTimeOffset();
      const timestamp = buildTimestamp();
      const query = buildQuery({ ...params, recvWindow, timestamp });
      const signature = crypto.createHmac("sha256", options.secret).update(query).digest("hex");
      const url = `${BASE_URL}${path}?${query}&signature=${signature}`;
      const response = await fetchJsonWithTimeout(
        url,
        {
          method: "GET",
          headers: { "X-BX-APIKEY": options.apiKey },
          cache: "no-store",
        },
        REQUEST_TIMEOUT_MS
      );
      const payload = (await response.json()) as {
        code?: number | string;
        msg?: string;
        data?: unknown;
      };
      const apiCode = getPayloadCode(payload);
      if (!response.ok || (apiCode != null && apiCode !== 0)) {
        if (response.status === 401 || response.status === 403 || apiCode === 100413) {
          throw new HttpError(payload.msg ?? "BingX authorization failed.", 401);
        }
        if (isRetryableCode(response.status) || isRetryableApiCode(apiCode)) {
          throw new Error(payload.msg ?? `BingX temporary failure (${response.status})`);
        }
        throw new HttpError(payload.msg ?? `BingX request failed (${response.status})`, 502);
      }
      return payload.data as T;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      lastError = error instanceof Error ? error : new Error("Unknown BingX request error");
      const message = lastError.message.toLowerCase();
      const nonRetryable = message.includes("authorization") || message.includes("forbidden");
      if (nonRetryable || attempt === RETRY_ATTEMPTS - 1) break;
      options.diagnostics.push(`retry_${path}_${attempt + 1}`);
    }
  }
  throw new HttpError(lastError?.message ?? "BingX endpoint unavailable.", 502);
}

function tradeKey(trade: FuturesTrade): string {
  return `${trade.symbol}|${trade.time}|${trade.qty}|${trade.price}|${trade.side}|${trade.positionSide}`;
}

async function fetchTradesPaginated(path: string, options: FetchOptions): Promise<FuturesTrade[]> {
  const merged: FuturesTrade[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= TRADES_MAX_PAGES; page += 1) {
    const data = await signedGet<unknown[]>(
      path,
      { pageIndex: page, pageSize: TRADES_PAGE_LIMIT, limit: TRADES_PAGE_LIMIT },
      options
    );
    const normalized = normalizeTrades(data);
    options.diagnostics.push(`${path}_page_${page}=${normalized.length}`);
    if (normalized.length === 0) break;
    let added = 0;
    for (const trade of normalized) {
      const key = tradeKey(trade);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(trade);
      added += 1;
      if (merged.length >= SAFE_TRADES_LIMIT) break;
    }
    if (merged.length >= SAFE_TRADES_LIMIT || added === 0 || normalized.length < TRADES_PAGE_LIMIT) break;
  }
  return merged.sort((a, b) => b.time - a.time).slice(0, SAFE_TRADES_LIMIT);
}

function normalizePositions(raw: unknown): FuturesPosition[] {
  const rows = extractArray(raw);
  return rows
    .map((item): FuturesPosition | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const positionAmt = asNumber(
        row.positionAmt ?? row.positionAmount ?? row.currentQty ?? row.positionAmtLong ?? row.positionAmtShort
      );
      const markPrice = asNumber(row.markPrice ?? row.currentPrice);
      const entryPrice = asNumber(row.entryPrice ?? row.avgPrice ?? row.averageOpenPrice);
      const entryNotional = Math.abs(positionAmt * entryPrice);
      const markNotional = Math.abs(asNumber(row.notional) || positionAmt * markPrice);
      const notional = markNotional || entryNotional;
      if (!notional || !positionAmt) return null;
      const unrealized = asNumber(
        row.unrealizedProfit ?? row.unRealizedProfit ?? row.unrealisedProfit ?? row.unrealizedPnl
      );
      const realized = asNumber(row.realizedProfit ?? row.realisedProfit ?? row.realizedPnl);
      const leverage = Math.max(asNumber(row.leverage) || 1, 1);
      const marginFromApi = asNumber(
        row.positionInitialMargin ??
          row.initialMargin ??
          row.posMargin ??
          row.positionMargin ??
          row.isolatedMargin
      );
      const marginBase = Math.max(
        marginFromApi > 0 ? marginFromApi : (entryNotional || notional) / leverage,
        1
      );
      return {
        exchange: "BINGX",
        symbol: String(row.symbol ?? "UNKNOWN"),
        side: String(row.positionSide ?? row.side ?? (positionAmt > 0 ? "LONG" : "SHORT")),
        leverage,
        positionAmt,
        entryPrice,
        markPrice,
        unrealizedPnl: unrealized,
        realizedPnl: realized,
        marginType: String(row.marginType ?? "cross"),
        marginUsedUsd: marginBase,
        isolatedMargin: asNumber(row.isolatedMargin),
        notionalUsd: notional,
        liquidationPrice: row.liquidationPrice != null ? asNumber(row.liquidationPrice) : null,
        pnlPercent: (unrealized / marginBase) * 100,
        updatedAt: asNumber(row.updateTime) || Date.now(),
      };
    })
    .filter((item): item is FuturesPosition => item !== null)
    .sort((a, b) => b.notionalUsd - a.notionalUsd);
}

function normalizeTrades(raw: unknown): FuturesTrade[] {
  const rows = extractArray(raw);
  return rows
    .map((item): FuturesTrade | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const qty = asNumber(
        row.qty ?? row.executedQty ?? row.cumQty ?? row.dealQty ?? row.volume ?? row.origQty
      );
      const price = asNumber(row.price ?? row.avgPrice ?? row.avgDealPrice ?? row.dealPrice);
      const quoteQty = asNumber(
        row.quoteQty ?? row.cumQuote ?? row.dealAmount ?? row.turnover
      );
      const realizedPnl = asNumber(
        row.realizedProfit ?? row.realizedPnl ?? row.closedPnl ?? row.profit
      );
      const fee = asNumber(row.commission ?? row.fee ?? row.tradeFee);
      const leverage = parseLeverage(
        row.leverage ?? row.positionLeverage ?? row.orderLeverage ?? row.lever
      );
      const resolvedPrice = price || (qty > 0 && quoteQty > 0 ? quoteQty / qty : 0);
      const resolvedQty = qty || (resolvedPrice > 0 && quoteQty > 0 ? quoteQty / resolvedPrice : 0);
      if (!resolvedQty || !resolvedPrice) return null;
      const resolvedQuote = quoteQty || resolvedQty * resolvedPrice;
      const marginUsed = Math.max(
        asNumber(row.initialMargin ?? row.positionMargin ?? row.margin ?? row.posMargin),
        resolvedQuote / Math.max(leverage, 1),
        1
      );
      const liquidationInfo = readLiquidationFlag(row);
      return {
        exchange: "BINGX",
        symbol: String(row.symbol ?? "UNKNOWN"),
        side: String(row.side ?? "UNKNOWN"),
        positionSide: String(row.positionSide ?? "BOTH"),
        leverage,
        marginUsed,
        price: resolvedPrice,
        qty: resolvedQty,
        quoteQty: resolvedQuote,
        realizedPnl,
        pnlPercent: (realizedPnl / marginUsed) * 100,
        fee,
        feeAsset: String(row.commissionAsset ?? row.feeAsset ?? "USDT"),
        time: asNumber(row.time ?? row.updateTime ?? row.createTime ?? row.tradeTime) || Date.now(),
        isLiquidation: liquidationInfo.isLiquidation,
        liquidationReason: liquidationInfo.liquidationReason,
      };
    })
    .filter((item): item is FuturesTrade => item !== null)
    .sort((a, b) => b.time - a.time);
}

export async function fetchBingXFuturesSnapshot(): Promise<FuturesSnapshot> {
  return fetchBingXFuturesSnapshotWithCredentials();
}

export async function fetchBingXFuturesSnapshotWithCredentials(credentials?: {
  apiKey?: string;
  apiSecret?: string;
}): Promise<FuturesSnapshot> {
  const apiKey = credentials?.apiKey?.trim() || process.env.BINGX_API_KEY;
  const secret = credentials?.apiSecret?.trim() || process.env.BINGX_API_SECRET;
  if (!apiKey || !secret) {
    throw new HttpError("Enter BingX API key and secret in the dashboard.", 400);
  }

  const diagnostics: string[] = [];
  const requestOptions: FetchOptions = { apiKey, secret, diagnostics };
  const [balanceResult, positionsResult, tradesResult] = await Promise.allSettled([
    signedGet<unknown[]>("/openApi/swap/v2/user/balance", {}, requestOptions),
    signedGet<unknown[]>("/openApi/swap/v2/user/positions", {}, requestOptions),
    fetchTradesPaginated("/openApi/swap/v2/trade/allOrders", requestOptions),
  ]);
  const failed = [balanceResult, positionsResult, tradesResult].filter((item) => item.status === "rejected");
  if (failed.length === 3) {
    const reason = failed[0];
    if (reason.status === "rejected" && reason.reason instanceof HttpError) {
      throw reason.reason;
    }
    throw new HttpError("Unable to fetch BingX snapshot.", 502);
  }
  const balanceData = balanceResult.status === "fulfilled" ? balanceResult.value : [];
  const positionsData = positionsResult.status === "fulfilled" ? positionsResult.value : [];
  let recentTrades = tradesResult.status === "fulfilled" ? tradesResult.value : [];
  const degraded = failed.length > 0;
  if (balanceResult.status === "rejected") diagnostics.push("balance_error");
  if (positionsResult.status === "rejected") diagnostics.push("positions_error");
  if (tradesResult.status === "rejected") diagnostics.push("allOrders_error");
  const balanceRows = extractArray(balanceData);
  const preferredBalance =
    balanceRows.find((item) => {
      const row = asRecord(item);
      const asset = String(row?.asset ?? row?.currency ?? row?.coin ?? row?.currencyName ?? "").toUpperCase();
      return asset === "USDT";
    }) ?? balanceRows[0];
  const balanceRoot = (preferredBalance ? asRecord(preferredBalance) : null) ?? firstRecord(balanceData);
  const balanceObj =
    asRecord(balanceRoot?.balance) ??
    asRecord(balanceRoot?.account) ??
    asRecord(balanceRoot?.data) ??
    balanceRoot;
  const reportedWalletBalance = asNumber(
    balanceObj.balance ??
      balanceObj.walletBalance ??
      balanceObj.accountBalance
  );
  const reportedEquity = asNumber(
    balanceObj.equity ??
      balanceObj.totalMarginBalance ??
      balanceObj.marginBalance
  );
  const availableBalance = asNumber(
    balanceObj.availableMargin ??
      balanceObj.availableBalance ??
      balanceObj.availableFunds ??
      balanceObj.available
  );
  const totalRealizedPnl = asNumber(
    balanceObj.realisedProfit ??
      balanceObj.realizedProfit ??
      balanceObj.realizedPnl
  );

  const positions = normalizePositions(positionsData);
  diagnostics.push(`positions_raw=${extractArray(positionsData).length}`);
  if (recentTrades.length === 0) {
    try {
      recentTrades = await fetchTradesPaginated("/openApi/swap/v2/trade/userTrades", requestOptions);
    } catch {
      recentTrades = [];
      diagnostics.push("userTrades_error=endpoint_failed_or_no_permission");
    }
  }
  recentTrades = recentTrades.slice(0, SAFE_TRADES_LIMIT);
  diagnostics.push(`recentTrades_normalized=${recentTrades.length}`);
  const totalUnrealizedPnl = positions.reduce((sum, item) => sum + item.unrealizedPnl, 0);
  // Some BingX balance fields are already equity (includes unrealized).
  // Normalize to wallet so wallet + unrealized equals final equity.
  let walletBalance = reportedWalletBalance;
  if (reportedEquity > 0 && reportedWalletBalance <= 0) {
    const derivedWalletFromEquity = reportedEquity - totalUnrealizedPnl;
    walletBalance = Math.max(derivedWalletFromEquity, 0);
  }
  const totalNotional = positions.reduce((sum, item) => sum + Math.abs(item.notionalUsd), 0);
  const usedMargin = positions.reduce((sum, item) => {
    const leverage = Math.max(item.leverage, 1);
    return sum + Math.abs(item.notionalUsd) / leverage;
  }, 0);
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
    diagnostics,
    degraded,
  };
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  return new HttpError(error instanceof Error ? error.message : "BingX API error", 502);
}

