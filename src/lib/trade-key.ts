import { FuturesTrade } from "./futures-types";

export function buildTradeKey(trade: FuturesTrade): string {
  // Keep key stable across refreshes even if qty/price precision shifts.
  const exchange = trade.exchange || "BINGX";
  return `${exchange}|${trade.symbol}|${trade.time}|${trade.side}|${trade.positionSide}`;
}
