export type FuturesPosition = {
  exchange: string;
  symbol: string;
  side: string;
  leverage: number;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  marginType: string;
  marginUsedUsd: number;
  isolatedMargin: number;
  notionalUsd: number;
  liquidationPrice: number | null;
  pnlPercent: number;
  updatedAt: number;
};

export type FuturesTrade = {
  exchange: string;
  symbol: string;
  side: string;
  positionSide: string;
  leverage: number;
  marginUsed: number;
  price: number;
  qty: number;
  quoteQty: number;
  realizedPnl: number;
  pnlPercent: number;
  fee: number;
  feeAsset: string;
  time: number;
  isLiquidation: boolean;
  liquidationReason?: string;
};

export type TradeSignal = "SECRET" | "OWN_TA" | "AXON" | (string & {});

export type FuturesSnapshot = {
  timestamp: number;
  walletBalance: number;
  availableBalance: number;
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  totalNotional: number;
  usedMargin: number;
  marginRatio: number;
  positions: FuturesPosition[];
  recentTrades: FuturesTrade[];
  diagnostics?: string[];
  degraded?: boolean;
};

export type FuturesMetrics = {
  equity: number;
  totalPnl: number;
  totalPnlPercent: number;
  winRatePercent: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  turnover24h: number;
  trades24h: number;
  expectancy: number;
};

export type FuturesMonitorResponse = {
  ok: boolean;
  warnings: string[];
  snapshot: FuturesSnapshot | null;
  history: FuturesSnapshot[];
  metrics: FuturesMetrics;
  tradeSignals: Record<string, TradeSignal>;
};
