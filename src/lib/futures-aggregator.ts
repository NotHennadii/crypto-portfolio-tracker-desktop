import { fetchBingXFuturesSnapshotWithCredentials } from "./bingx";
import { fetchBitgetFuturesSnapshotWithCredentials } from "./bitget";
import { fetchCcxtFuturesSnapshot } from "./ccxt-futures";
import { FuturesSnapshot } from "./futures-types";

type MultiExchangeCredentials = {
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

function combineSnapshots(snapshots: FuturesSnapshot[]): FuturesSnapshot {
  const now = Date.now();
  const positions = snapshots.flatMap((item) => item.positions);
  const recentTrades = snapshots.flatMap((item) => item.recentTrades).sort((a, b) => b.time - a.time).slice(0, 3000);
  const diagnostics = snapshots.flatMap((item) => item.diagnostics ?? []);
  const walletBalance = snapshots.reduce((sum, item) => sum + item.walletBalance, 0);
  const availableBalance = snapshots.reduce((sum, item) => sum + item.availableBalance, 0);
  const totalUnrealizedPnl = snapshots.reduce((sum, item) => sum + item.totalUnrealizedPnl, 0);
  const totalRealizedPnl = snapshots.reduce((sum, item) => sum + item.totalRealizedPnl, 0);
  const totalNotional = snapshots.reduce((sum, item) => sum + item.totalNotional, 0);
  const usedMargin = snapshots.reduce((sum, item) => sum + item.usedMargin, 0);
  const equity = walletBalance + totalUnrealizedPnl;
  return {
    timestamp: now,
    walletBalance,
    availableBalance,
    totalUnrealizedPnl,
    totalRealizedPnl,
    totalNotional,
    usedMargin,
    marginRatio: usedMargin > 0 ? (usedMargin / Math.max(equity, 1)) * 100 : 0,
    positions,
    recentTrades,
    diagnostics,
    degraded: snapshots.some((item) => Boolean(item.degraded)),
  };
}

export async function fetchCombinedFuturesSnapshot(credentials: MultiExchangeCredentials): Promise<FuturesSnapshot> {
  const tasks: Promise<FuturesSnapshot>[] = [];
  if (credentials.bingxApiKey && credentials.bingxApiSecret) {
    tasks.push(
      fetchBingXFuturesSnapshotWithCredentials({
        apiKey: credentials.bingxApiKey,
        apiSecret: credentials.bingxApiSecret,
      })
    );
  }
  if (credentials.bitgetApiKey && credentials.bitgetApiSecret && credentials.bitgetPassphrase) {
    tasks.push(
      fetchBitgetFuturesSnapshotWithCredentials({
        apiKey: credentials.bitgetApiKey,
        apiSecret: credentials.bitgetApiSecret,
        passphrase: credentials.bitgetPassphrase,
      })
    );
  }
  if (credentials.binanceApiKey && credentials.binanceApiSecret) {
    tasks.push(
      fetchCcxtFuturesSnapshot("BINANCE", {
        apiKey: credentials.binanceApiKey,
        secret: credentials.binanceApiSecret,
      })
    );
  }
  if (credentials.bybitApiKey && credentials.bybitApiSecret) {
    tasks.push(
      fetchCcxtFuturesSnapshot("BYBIT", {
        apiKey: credentials.bybitApiKey,
        secret: credentials.bybitApiSecret,
      })
    );
  }
  if (credentials.mexcApiKey && credentials.mexcApiSecret) {
    tasks.push(
      fetchCcxtFuturesSnapshot("MEXC", {
        apiKey: credentials.mexcApiKey,
        secret: credentials.mexcApiSecret,
      })
    );
  }
  if (credentials.gateApiKey && credentials.gateApiSecret) {
    tasks.push(
      fetchCcxtFuturesSnapshot("GATE", {
        apiKey: credentials.gateApiKey,
        secret: credentials.gateApiSecret,
      })
    );
  }
  if (tasks.length === 0) {
    throw new Error("Введите ключи хотя бы одной биржи: BingX, Bitget, Binance, Bybit, MEXC или Gate.");
  }
  const settled = await Promise.allSettled(tasks);
  const success = settled.filter((item): item is PromiseFulfilledResult<FuturesSnapshot> => item.status === "fulfilled");
  if (success.length === 0) {
    const firstError = settled.find((item) => item.status === "rejected");
    throw new Error(firstError?.status === "rejected" ? String(firstError.reason?.message ?? firstError.reason) : "Exchanges unavailable.");
  }
  const snapshots = success.map((item) => item.value);
  const combined = combineSnapshots(snapshots);
  if (success.length !== settled.length) {
    combined.degraded = true;
    combined.diagnostics = [...(combined.diagnostics ?? []), "one_or_more_exchanges_failed"];
  }
  return combined;
}
