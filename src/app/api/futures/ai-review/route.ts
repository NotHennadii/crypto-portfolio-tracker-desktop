import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";

export const runtime = "nodejs";

type TradeTag = "setup" | "error" | "emotion";

type TradeReviewInput = {
  exchange: string;
  symbol: string;
  side: string;
  positionSide: string;
  leverage: number;
  price: number;
  qty: number;
  marginUsed: number;
  realizedPnl: number;
  pnlPercent: number;
  fee: number;
  time: number;
  isLiquidation: boolean;
  signal: string;
  tags: TradeTag[];
};

type ReviewBody = {
  period?: "day" | "week" | "month" | "single";
  trades?: TradeReviewInput[];
  exchangeFilter?: string;
  tagFilter?: string;
};

type ReviewPayload = {
  ok: true;
  mode: "heuristic" | "llm";
  summary: string;
  traderProfile: string;
  strengths: string[];
  mistakes: string[];
  recommendations: string[];
  metrics: {
    trades: number;
    winRate: number;
    netPnl: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    liquidations: number;
  };
  candleInsights: {
    analyzedTrades: number;
    tradesWithContext: number;
    potentialEarlyExits: number;
    momentumAgainstExecution: number;
    lateEntries: number;
    notes: string[];
  };
};

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function normalizeSymbolForKlines(raw: string): string | null {
  const upper = (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!upper) return null;
  if (upper.endsWith("USDT")) return upper;
  if (upper.includes("USDT")) {
    const idx = upper.indexOf("USDT");
    return upper.slice(0, idx + 4);
  }
  return null;
}

async function fetchBinanceKlines(symbol: string, startTime: number, endTime: number): Promise<number[][]> {
  const params = new URLSearchParams({
    symbol,
    interval: "5m",
    startTime: String(startTime),
    endTime: String(endTime),
    limit: "80",
  });
  const response = await fetch(`https://api.binance.com/api/v3/klines?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) return [];
  const data = (await response.json().catch(() => [])) as unknown;
  return Array.isArray(data) ? (data as number[][]) : [];
}

async function analyzeCandleContexts(trades: TradeReviewInput[]) {
  const sample = trades.slice(0, 40);
  const evaluations = await Promise.all(
    sample.map(async (trade) => {
      const symbol = normalizeSymbolForKlines(trade.symbol);
      if (!symbol) return null;
      const start = trade.time - 60 * 60 * 1000;
      const end = trade.time + 60 * 60 * 1000;
      const candles = await fetchBinanceKlines(symbol, start, end);
      if (candles.length < 8) return null;
      const firstOpen = Number(candles[0]?.[1] ?? 0);
      const nearest = candles.reduce((best, candle) => {
        const openTime = Number(candle[0] ?? 0);
        if (!best) return candle;
        return Math.abs(openTime - trade.time) < Math.abs(Number(best[0]) - trade.time) ? candle : best;
      }, null as number[] | null);
      const nextCandles = candles.filter((candle) => Number(candle[0]) > trade.time).slice(0, 6);
      const lastClose = Number((nextCandles[nextCandles.length - 1] ?? candles[candles.length - 1])?.[4] ?? 0);
      const executionPrice = safeNumber(trade.price);
      if (!firstOpen || !executionPrice || !lastClose || !nearest) return null;
      const beforeMovePct = ((executionPrice - firstOpen) / firstOpen) * 100;
      const afterMovePct = ((lastClose - executionPrice) / executionPrice) * 100;
      const side = String(trade.positionSide || trade.side || "").toUpperCase();
      const isLong = side.includes("LONG") || side === "BUY";
      const isShort = side.includes("SHORT") || side === "SELL";
      const lateEntry = (isLong && beforeMovePct > 1.2) || (isShort && beforeMovePct < -1.2);
      const momentumAgainstExecution = (isLong && afterMovePct < -0.8) || (isShort && afterMovePct > 0.8);
      const potentialEarlyExit = (isLong && afterMovePct > 1) || (isShort && afterMovePct < -1);
      return {
        symbol,
        lateEntry,
        momentumAgainstExecution,
        potentialEarlyExit,
      };
    })
  );
  const valid = evaluations.filter((item): item is NonNullable<typeof item> => Boolean(item));
  const lateEntries = valid.filter((item) => item.lateEntry).length;
  const momentumAgainstExecution = valid.filter((item) => item.momentumAgainstExecution).length;
  const potentialEarlyExits = valid.filter((item) => item.potentialEarlyExit).length;
  const topSymbols = Array.from(
    valid.reduce((map, item) => map.set(item.symbol, (map.get(item.symbol) ?? 0) + 1), new Map<string, number>())
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([symbol]) => symbol);
  return {
    analyzedTrades: sample.length,
    tradesWithContext: valid.length,
    potentialEarlyExits,
    momentumAgainstExecution,
    lateEntries,
    notes: topSymbols.length ? [`Контекст свечей рассчитан по: ${topSymbols.join(", ")}.`] : [],
  };
}

async function buildHeuristicReview(
  period: string,
  trades: TradeReviewInput[],
  exchangeFilter: string,
  tagFilter: string
): Promise<ReviewPayload> {
  const closed = trades.filter((trade) => safeNumber(trade.realizedPnl) !== 0);
  const wins = closed.filter((trade) => trade.realizedPnl > 0);
  const losses = closed.filter((trade) => trade.realizedPnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.realizedPnl, 0);
  const grossLoss = losses.reduce((sum, trade) => sum + Math.abs(trade.realizedPnl), 0);
  const netPnl = closed.reduce((sum, trade) => sum + trade.realizedPnl, 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? grossProfit : 0;
  const liquidations = closed.filter((trade) => trade.isLiquidation).length;
  const highLeverageLosses = closed.filter((trade) => trade.realizedPnl < 0 && trade.leverage >= 15).length;
  const emotionTagged = closed.filter((trade) => trade.tags.includes("emotion")).length;
  const errorTagged = closed.filter((trade) => trade.tags.includes("error")).length;
  const setupTagged = closed.filter((trade) => trade.tags.includes("setup")).length;

  const symbolMap = new Map<string, { pnl: number; count: number }>();
  for (const trade of closed) {
    const current = symbolMap.get(trade.symbol) ?? { pnl: 0, count: 0 };
    current.pnl += trade.realizedPnl;
    current.count += 1;
    symbolMap.set(trade.symbol, current);
  }
  const topSymbols = Array.from(symbolMap.entries())
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .slice(0, 3)
    .map(([symbol, row]) => `${symbol} (${row.pnl.toFixed(2)} USDT / ${row.count} сделок)`);

  const candleInsights = await analyzeCandleContexts(closed);
  const strengths: string[] = [];
  const mistakes: string[] = [];
  const recommendations: string[] = [];

  if (winRate >= 55) strengths.push(`Винрейт ${winRate.toFixed(2)}%: входы в целом качественные.`);
  if (profitFactor >= 1.4) strengths.push(`Profit factor ${profitFactor.toFixed(2)}: положительное матожидание стратегии.`);
  if (setupTagged > 0 && setupTagged >= errorTagged) strengths.push(`Теги setup используются чаще ошибок (${setupTagged} vs ${errorTagged}).`);
  if (topSymbols.length) strengths.push(`Лучшие инструменты периода: ${topSymbols.join(", ")}.`);
  if (candleInsights.tradesWithContext > 0 && candleInsights.momentumAgainstExecution <= Math.max(1, candleInsights.tradesWithContext * 0.2)) {
    strengths.push("По свечному контексту большинство исполнений не против краткосрочного импульса.");
  }

  if (avgLoss > avgWin && losses.length > 0) mistakes.push(`Средний убыток (${avgLoss.toFixed(2)}) выше среднего профита (${avgWin.toFixed(2)}).`);
  if (highLeverageLosses > 0) mistakes.push(`${highLeverageLosses} убыточных сделок были с повышенным плечом (>=15x).`);
  if (liquidations > 0) mistakes.push(`Были ликвидации (${liquidations}), нужен жестче стоп-менеджмент.`);
  if (emotionTagged > 0) mistakes.push(`Есть эмоциональные сделки (${emotionTagged}) — вероятны импульсные входы.`);
  if (errorTagged > 0) mistakes.push(`Отмечено ошибок: ${errorTagged} — полезно разобрать паттерн повторений.`);
  if (candleInsights.lateEntries > 0) mistakes.push(`Обнаружены вероятные поздние входы/исполнения по контексту свечей: ${candleInsights.lateEntries}.`);
  if (candleInsights.momentumAgainstExecution > 0) mistakes.push(`В ${candleInsights.momentumAgainstExecution} случаях рынок шел против сделки сразу после исполнения.`);
  if (candleInsights.potentialEarlyExits > 0) mistakes.push(`Возможные ранние выходы: ${candleInsights.potentialEarlyExits} (после закрытия движение продолжалось).`);

  recommendations.push("Перед входом фиксируй invalidation-уровень и риск на сделку в % от капитала.");
  if (avgLoss > avgWin) recommendations.push("Смести приоритет в сторону раннего частичного тейка и более короткого стопа.");
  if (highLeverageLosses > 0) recommendations.push("Ограничь рабочее плечо и снизь размер позиции после серии убыточных трейдов.");
  if (emotionTagged > 0 || errorTagged > 0) recommendations.push("Сделай правило: после 2 подряд минусов перерыв 20-30 минут и ревизия сетапа.");
  recommendations.push("Сфокусируйся на 2-3 инструментах с лучшим PnL и исключи пары с системным минусом.");
  if (candleInsights.lateEntries > 0) recommendations.push("Добавь фильтр: вход только после отката/ретеста, а не после импульсной свечи.");
  if (candleInsights.potentialEarlyExits > 0) recommendations.push("Тестируй частичный выход + трейлинг для удержания движения после первой фиксации.");

  const profile =
    winRate >= 55 && profitFactor >= 1.2
      ? "Дисциплинированный трендовый исполнитель с рабочей базовой системой."
      : winRate >= 45
        ? "Активный трейдер с потенциалом роста через контроль риска и фильтрацию входов."
        : "Агрессивный экспериментатор: ключ к росту — стабилизировать риск и сократить импульсные сделки.";

  const periodLabel = period === "single" ? "сделку" : period;
  const summary = `AI-разбор за ${periodLabel}: ${closed.length} сделок, PnL ${netPnl.toFixed(2)} USDT, winrate ${winRate.toFixed(
    2
  )}%, PF ${profitFactor.toFixed(2)}. Свечной контекст: ${candleInsights.tradesWithContext}/${candleInsights.analyzedTrades} сделок. Фильтры: биржа=${exchangeFilter}, тег=${tagFilter}.`;

  return {
    ok: true,
    mode: "heuristic",
    summary,
    traderProfile: profile,
    strengths: strengths.length ? strengths : ["Недостаточно выборки для выделения сильных паттернов."],
    mistakes: mistakes.length ? mistakes : ["Критичных повторяющихся ошибок по текущей выборке не найдено."],
    recommendations: recommendations.slice(0, 5),
    metrics: {
      trades: closed.length,
      winRate,
      netPnl,
      profitFactor,
      avgWin,
      avgLoss,
      liquidations,
    },
    candleInsights,
  };
}

async function tryLlmRewrite(base: ReviewPayload): Promise<ReviewPayload> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return base;
  const model = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free";
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Ты торговый риск-аналитик. На входе структурные метрики, на выходе короткий практичный обзор для трейдера на русском языке.",
        },
        {
          role: "user",
          content: `Перепиши этот отчет в сжатый actionable формат JSON с полями summary,traderProfile,strengths,mistakes,recommendations. ${JSON.stringify(
            base
          )}`,
        },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) return base;
  const payload = (await response.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = payload.choices?.[0]?.message?.content;
  if (!raw) return base;
  const parsed = JSON.parse(raw) as Partial<ReviewPayload>;
  return {
    ...base,
    mode: "llm",
    summary: typeof parsed.summary === "string" ? parsed.summary : base.summary,
    traderProfile: typeof parsed.traderProfile === "string" ? parsed.traderProfile : base.traderProfile,
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String).slice(0, 5) : base.strengths,
    mistakes: Array.isArray(parsed.mistakes) ? parsed.mistakes.map(String).slice(0, 5) : base.mistakes,
    recommendations: Array.isArray(parsed.recommendations)
      ? parsed.recommendations.map(String).slice(0, 5)
      : base.recommendations,
  };
}

export async function POST(request: Request) {
  const auth = await requireUserId();
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => ({}))) as ReviewBody;
  const period = body.period ?? "week";
  const trades = Array.isArray(body.trades) ? body.trades.slice(0, 1500) : [];
  const exchangeFilter = body.exchangeFilter ?? "ALL";
  const tagFilter = body.tagFilter ?? "ALL";
  if (!trades.length) {
    return NextResponse.json({ ok: false, error: "Нет сделок для AI-разбора по выбранным фильтрам." }, { status: 400 });
  }

  const heuristic = await buildHeuristicReview(period, trades, exchangeFilter, tagFilter);
  const result = await tryLlmRewrite(heuristic).catch(() => heuristic);
  return NextResponse.json(result);
}
