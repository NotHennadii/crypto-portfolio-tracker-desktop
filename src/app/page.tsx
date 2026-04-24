"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { FuturesMonitorResponse, TradeSignal } from "@/lib/futures-types";
import { buildTradeKey } from "@/lib/trade-key";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { hasSupabaseEnv } from "@/lib/supabase-env";

const BASE_POLL_MS = 45000;
const MAX_POLL_MS = 10 * 60 * 1000;
const ZERO_STORAGE_MODE = true;
const LOCAL_API_KEYS_STORAGE_KEY = "futures-local-api-keys-v1";
type ExchangeFilter = "ALL" | "BINGX" | "BITGET" | "BINANCE" | "BYBIT" | "MEXC" | "GATE";
type UiTheme = "dark" | "light";
const DEFAULT_SIGNAL_OPTIONS: { value: TradeSignal; label: string }[] = [
  { value: "SECRET", label: "Секрет" },
  { value: "OWN_TA", label: "Свой ТА" },
  { value: "AXON", label: "AXON" },
];
const CUSTOM_SIGNALS_STORAGE_KEY = "custom-signal-sources-v1";
const TRADE_TAGS_STORAGE_KEY = "trade-tags-v1";
const TELEGRAM_REPORT_SETTINGS_STORAGE_KEY = "telegram-report-settings-v1";

type TradeTag = "setup" | "error" | "emotion";
type TradeTagMap = Record<string, Record<TradeTag, boolean>>;
type ReportPeriod = "day" | "week" | "month";
type TagFilter = "ALL" | TradeTag;
type AiReviewPayload = {
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

type SecureCredentialsPayload = {
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

type UpdateState = {
  checking: boolean;
  installing: boolean;
  message: string | null;
  downloadUrl: string | null;
};

type GithubLatestRelease = {
  tag_name?: string;
  html_url?: string;
  assets?: Array<{
    name?: string;
    browser_download_url?: string;
  }>;
};

type GithubTag = {
  name?: string;
};

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0";
const UPDATE_REPO = process.env.NEXT_PUBLIC_DESKTOP_UPDATE_REPO ?? "NotHennadii/crypto-portfolio-tracker-desktop";

function normalizeVersion(raw: string): number[] {
  return raw
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number(part.replace(/[^0-9].*$/, "")) || 0);
}

function isRemoteVersionNewer(localVersion: string, remoteVersion: string): boolean {
  const local = normalizeVersion(localVersion);
  const remote = normalizeVersion(remoteVersion);
  const maxLength = Math.max(local.length, remote.length);
  for (let i = 0; i < maxLength; i += 1) {
    const l = local[i] ?? 0;
    const r = remote[i] ?? 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  return false;
}

function pickInstallerUrl(release: GithubLatestRelease): string | null {
  const assets = release.assets ?? [];
  const setupExe = assets.find(
    (asset) => asset.name?.toLowerCase().endsWith("-setup.exe") && asset.browser_download_url
  )?.browser_download_url;
  if (setupExe) return setupExe;
  const msi = assets.find(
    (asset) => asset.name?.toLowerCase().endsWith(".msi") && asset.browser_download_url
  )?.browser_download_url;
  if (msi) return msi;
  return release.html_url ?? null;
}

function toSignalValue(raw: string): TradeSignal | null {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned || cleaned.length < 2 || cleaned.length > 32) return null;
  return cleaned as TradeSignal;
}

function fmtUsd(value: number) {
  const normalized = Math.abs(value) < 0.005 ? 0 : value;
  return `$${normalized.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function fmtPct(value: number) {
  return `${value.toFixed(2)}%`;
}

function fmtPrice(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function csvEscape(value: string | number) {
  const text = String(value ?? "");
  if (text.includes('"') || text.includes(",") || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatTimeTick(timestamp: number) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function getTradeDirectionLabel(side: string, positionSide: string) {
  const normalizedPositionSide = String(positionSide).toUpperCase();
  if (normalizedPositionSide === "LONG" || normalizedPositionSide === "SHORT") {
    return normalizedPositionSide;
  }
  const normalizedSide = String(side).toUpperCase();
  if (normalizedSide === "BUY" || normalizedSide === "SELL") {
    return normalizedSide;
  }
  return normalizedSide || "UNKNOWN";
}

export default function Home() {
  const router = useRouter();
  const [data, setData] = useState<FuturesMonitorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [bingxApiKey, setBingxApiKey] = useState("");
  const [bingxApiSecret, setBingxApiSecret] = useState("");
  const [bitgetApiKey, setBitgetApiKey] = useState("");
  const [bitgetApiSecret, setBitgetApiSecret] = useState("");
  const [bitgetPassphrase, setBitgetPassphrase] = useState("");
  const [binanceApiKey, setBinanceApiKey] = useState("");
  const [binanceApiSecret, setBinanceApiSecret] = useState("");
  const [bybitApiKey, setBybitApiKey] = useState("");
  const [bybitApiSecret, setBybitApiSecret] = useState("");
  const [mexcApiKey, setMexcApiKey] = useState("");
  const [mexcApiSecret, setMexcApiSecret] = useState("");
  const [gateApiKey, setGateApiKey] = useState("");
  const [gateApiSecret, setGateApiSecret] = useState("");
  const [configured, setConfigured] = useState(false);
  const [showKeyEditor, setShowKeyEditor] = useState(false);
  const [activeView] = useState<"trading">("trading");
  const [showTradingRating, setShowTradingRating] = useState(false);
  const [showTradesHistory, setShowTradesHistory] = useState(false);
  const [savingTradeSignalKey, setSavingTradeSignalKey] = useState<string | null>(null);
  const [pollMs, setPollMs] = useState(BASE_POLL_MS);
  const [exchangeFilter, setExchangeFilter] = useState<ExchangeFilter>("ALL");
  const [uiTheme, setUiTheme] = useState<UiTheme>("dark");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [manualBaseEquityUsd, setManualBaseEquityUsd] = useState<number | null>(null);
  const [baseEquityInput, setBaseEquityInput] = useState("");
  const [savingBaseEquity, setSavingBaseEquity] = useState(false);
  const [customSignalOptions, setCustomSignalOptions] = useState<{ value: TradeSignal; label: string }[]>([]);
  const [newSignalSource, setNewSignalSource] = useState("");
  const [tradeTags, setTradeTags] = useState<TradeTagMap>({});
  const [tagFilter, setTagFilter] = useState<TagFilter>("ALL");
  const [privacyMode, setPrivacyMode] = useState(false);
  const [reportPeriod, setReportPeriod] = useState<ReportPeriod>("week");
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [sendingTelegramReport, setSendingTelegramReport] = useState(false);
  const [aiReview, setAiReview] = useState<AiReviewPayload | null>(null);
  const [loadingAiReview, setLoadingAiReview] = useState(false);
  const [loadingSingleTradeReviewKey, setLoadingSingleTradeReviewKey] = useState<string | null>(null);
  const [isPageVisible, setIsPageVisible] = useState(true);
  const [isOnline, setIsOnline] = useState(true);
  const [updateState, setUpdateState] = useState<UpdateState>({
    checking: false,
    installing: false,
    message: null,
    downloadUrl: null,
  });
  const skipNextAutoRefreshRef = useRef(false);
  const snapshot = data?.snapshot;

  const loadSecureCredentials = useCallback(async (): Promise<SecureCredentialsPayload | null> => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const payload = await invoke<SecureCredentialsPayload | null>("load_secure_credentials");
      return payload ?? null;
    } catch {
      return null;
    }
  }, []);

  const saveSecureCredentials = useCallback(async (payload: SecureCredentialsPayload) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_secure_credentials", { payload });
  }, []);

  const clearSecureCredentials = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("clear_secure_credentials");
    } catch {
      // best effort cleanup
    }
  }, []);

  useEffect(() => {
    if (!ZERO_STORAGE_MODE) return;
    void (async () => {
      const secure = await loadSecureCredentials();
      if (secure) {
        setBingxApiKey(secure.bingxApiKey ?? "");
        setBingxApiSecret(secure.bingxApiSecret ?? "");
        setBitgetApiKey(secure.bitgetApiKey ?? "");
        setBitgetApiSecret(secure.bitgetApiSecret ?? "");
        setBitgetPassphrase(secure.bitgetPassphrase ?? "");
        setBinanceApiKey(secure.binanceApiKey ?? "");
        setBinanceApiSecret(secure.binanceApiSecret ?? "");
        setBybitApiKey(secure.bybitApiKey ?? "");
        setBybitApiSecret(secure.bybitApiSecret ?? "");
        setMexcApiKey(secure.mexcApiKey ?? "");
        setMexcApiSecret(secure.mexcApiSecret ?? "");
        setGateApiKey(secure.gateApiKey ?? "");
        setGateApiSecret(secure.gateApiSecret ?? "");
        const hasAny =
          Boolean(secure.bingxApiKey && secure.bingxApiSecret) ||
          Boolean(secure.bitgetApiKey && secure.bitgetApiSecret && secure.bitgetPassphrase) ||
          Boolean(secure.binanceApiKey && secure.binanceApiSecret) ||
          Boolean(secure.bybitApiKey && secure.bybitApiSecret) ||
          Boolean(secure.mexcApiKey && secure.mexcApiSecret) ||
          Boolean(secure.gateApiKey && secure.gateApiSecret);
        if (hasAny) {
          setConfigured(true);
          setShowKeyEditor(false);
        }
        return;
      }
      try {
        const raw = window.localStorage.getItem(LOCAL_API_KEYS_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as SecureCredentialsPayload;
        setBingxApiKey(parsed.bingxApiKey ?? "");
        setBingxApiSecret(parsed.bingxApiSecret ?? "");
        setBitgetApiKey(parsed.bitgetApiKey ?? "");
        setBitgetApiSecret(parsed.bitgetApiSecret ?? "");
        setBitgetPassphrase(parsed.bitgetPassphrase ?? "");
        setBinanceApiKey(parsed.binanceApiKey ?? "");
        setBinanceApiSecret(parsed.binanceApiSecret ?? "");
        setBybitApiKey(parsed.bybitApiKey ?? "");
        setBybitApiSecret(parsed.bybitApiSecret ?? "");
        setMexcApiKey(parsed.mexcApiKey ?? "");
        setMexcApiSecret(parsed.mexcApiSecret ?? "");
        setGateApiKey(parsed.gateApiKey ?? "");
        setGateApiSecret(parsed.gateApiSecret ?? "");
      } catch {
        // ignore malformed local key storage
      }
    })();
  }, [loadSecureCredentials]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CUSTOM_SIGNALS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { value: string; label: string }[];
      const normalized = parsed
        .map((item) => ({ value: toSignalValue(item.value) ?? toSignalValue(item.label), label: item.label?.trim() ?? "" }))
        .filter((item): item is { value: TradeSignal; label: string } => Boolean(item.value) && Boolean(item.label));
      setCustomSignalOptions(normalized);
    } catch {
      // ignore broken local storage payloads
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(CUSTOM_SIGNALS_STORAGE_KEY, JSON.stringify(customSignalOptions));
  }, [customSignalOptions]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TRADE_TAGS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as TradeTagMap;
      setTradeTags(parsed ?? {});
    } catch {
      // ignore malformed tag storage
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(TRADE_TAGS_STORAGE_KEY, JSON.stringify(tradeTags));
  }, [tradeTags]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TELEGRAM_REPORT_SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { botToken?: string; chatId?: string };
      setTelegramBotToken(parsed.botToken ?? "");
      setTelegramChatId(parsed.chatId ?? "");
    } catch {
      // ignore malformed telegram settings
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      TELEGRAM_REPORT_SETTINGS_STORAGE_KEY,
      JSON.stringify({ botToken: telegramBotToken.trim(), chatId: telegramChatId.trim() })
    );
  }, [telegramBotToken, telegramChatId]);

  useEffect(() => {
    const syncVisibility = () => {
      setIsPageVisible(document.visibilityState === "visible");
    };
    const syncOnline = () => {
      setIsOnline(navigator.onLine);
    };
    syncVisibility();
    syncOnline();
    document.addEventListener("visibilitychange", syncVisibility);
    window.addEventListener("online", syncOnline);
    window.addEventListener("offline", syncOnline);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      window.removeEventListener("online", syncOnline);
      window.removeEventListener("offline", syncOnline);
    };
  }, []);

  useEffect(() => {
    setAiReview(null);
  }, [reportPeriod, exchangeFilter, tagFilter]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/futures/settings", { method: "GET", cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as { baseEquityUsd?: number | null };
        const next = payload.baseEquityUsd ?? null;
        setManualBaseEquityUsd(next);
        setBaseEquityInput(next != null ? String(next) : "");
      } catch {
        // Keep default auto mode if settings endpoint is unavailable.
      }
    })();
  }, []);

  const signalOptions = useMemo(() => {
    const map = new Map<string, { value: TradeSignal; label: string }>();
    for (const option of DEFAULT_SIGNAL_OPTIONS) {
      map.set(option.value, option);
    }
    for (const option of customSignalOptions) {
      map.set(option.value, option);
    }
    return Array.from(map.values());
  }, [customSignalOptions]);

  const saveBaseEquity = useCallback(async () => {
    const parsed = Number(baseEquityInput.trim().replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setRefreshError("База П/У должна быть положительным числом.");
      return;
    }
    setSavingBaseEquity(true);
    try {
      const response = await fetch("/api/futures/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseEquityUsd: parsed }),
      });
      if (!response.ok) throw new Error("Не удалось сохранить базу П/У.");
      setManualBaseEquityUsd(parsed);
      setRefreshError(null);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Не удалось сохранить базу П/У.");
    } finally {
      setSavingBaseEquity(false);
    }
  }, [baseEquityInput]);

  const resetBaseEquityToAuto = useCallback(async () => {
    setSavingBaseEquity(true);
    try {
      const response = await fetch("/api/futures/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseEquityUsd: null }),
      });
      if (!response.ok) throw new Error("Не удалось вернуть авто-базу.");
      setManualBaseEquityUsd(null);
      setBaseEquityInput("");
      setRefreshError(null);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Не удалось вернуть авто-базу.");
    } finally {
      setSavingBaseEquity(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!configured) {
      setLoading(false);
      return;
    }
    try {
      const response = await fetch("/api/futures/monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bingxApiKey: bingxApiKey.trim(),
          bingxApiSecret: bingxApiSecret.trim(),
          bitgetApiKey: bitgetApiKey.trim(),
          bitgetApiSecret: bitgetApiSecret.trim(),
          bitgetPassphrase: bitgetPassphrase.trim(),
          binanceApiKey: binanceApiKey.trim(),
          binanceApiSecret: binanceApiSecret.trim(),
          bybitApiKey: bybitApiKey.trim(),
          bybitApiSecret: bybitApiSecret.trim(),
          mexcApiKey: mexcApiKey.trim(),
          mexcApiSecret: mexcApiSecret.trim(),
          gateApiKey: gateApiKey.trim(),
          gateApiSecret: gateApiSecret.trim(),
        }),
        cache: "no-store",
      });
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Сессия API истекла. Повторно введите ключи.");
        }
        if (response.status === 502) {
          setPollMs((prev) => Math.min(prev * 2, MAX_POLL_MS));
        }
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as FuturesMonitorResponse;
      setData(payload);
      setRefreshError(payload.warnings[0] ?? null);
      setPollMs(BASE_POLL_MS);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Failed to refresh data");
    } finally {
      setLoading(false);
    }
  }, [
    configured,
    bingxApiKey,
    bingxApiSecret,
    bitgetApiKey,
    bitgetApiSecret,
    bitgetPassphrase,
    binanceApiKey,
    binanceApiSecret,
    bybitApiKey,
    bybitApiSecret,
    mexcApiKey,
    mexcApiSecret,
    gateApiKey,
    gateApiSecret,
  ]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/futures/monitor", { method: "GET", cache: "no-store" });
        if (!response.ok) {
          setLoading(false);
          return;
        }
        const payload = (await response.json()) as FuturesMonitorResponse;
        if (payload.ok || payload.snapshot || payload.history.length > 0) {
          skipNextAutoRefreshRef.current = true;
          setData(payload);
          setConfigured(true);
          setShowKeyEditor(false);
          setLoading(false);
        }
      } catch {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!configured || !isPageVisible || !isOnline) return;
    if (skipNextAutoRefreshRef.current) {
      skipNextAutoRefreshRef.current = false;
      return;
    }
    void refresh();
  }, [configured, isOnline, isPageVisible, refresh]);

  useEffect(() => {
    if (!configured || !isPageVisible || !isOnline) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [configured, isOnline, isPageVisible, pollMs, refresh]);

  const handleConnect = async () => {
    setLoading(true);
    const hasBingx = Boolean(bingxApiKey.trim() && bingxApiSecret.trim());
    const hasBitget = Boolean(bitgetApiKey.trim() && bitgetApiSecret.trim() && bitgetPassphrase.trim());
    const hasBinance = Boolean(binanceApiKey.trim() && binanceApiSecret.trim());
    const hasBybit = Boolean(bybitApiKey.trim() && bybitApiSecret.trim());
    const hasMexc = Boolean(mexcApiKey.trim() && mexcApiSecret.trim());
    const hasGate = Boolean(gateApiKey.trim() && gateApiSecret.trim());
    if (!hasBingx && !hasBitget && !hasBinance && !hasBybit && !hasMexc && !hasGate) {
      setRefreshError("Введите ключи хотя бы одной биржи (для Bitget нужен passphrase).");
      setLoading(false);
      return;
    }
    if (!ZERO_STORAGE_MODE) {
      try {
        const response = await fetch("/api/futures/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bingxApiKey: bingxApiKey.trim(),
            bingxApiSecret: bingxApiSecret.trim(),
            bitgetApiKey: bitgetApiKey.trim(),
            bitgetApiSecret: bitgetApiSecret.trim(),
            bitgetPassphrase: bitgetPassphrase.trim(),
            binanceApiKey: binanceApiKey.trim(),
            binanceApiSecret: binanceApiSecret.trim(),
            bybitApiKey: bybitApiKey.trim(),
            bybitApiSecret: bybitApiSecret.trim(),
            mexcApiKey: mexcApiKey.trim(),
            mexcApiSecret: mexcApiSecret.trim(),
            gateApiKey: gateApiKey.trim(),
            gateApiSecret: gateApiSecret.trim(),
          }),
        });
        if (!response.ok) {
          throw new Error("Не удалось сохранить защищенную сессию API.");
        }
      } catch (error) {
        setRefreshError(error instanceof Error ? error.message : "Не удалось подключить API.");
        setLoading(false);
        return;
      }
    }
    setRefreshError(null);
    if (ZERO_STORAGE_MODE) {
      const payload = {
        bingxApiKey: bingxApiKey.trim(),
        bingxApiSecret: bingxApiSecret.trim(),
        bitgetApiKey: bitgetApiKey.trim(),
        bitgetApiSecret: bitgetApiSecret.trim(),
        bitgetPassphrase: bitgetPassphrase.trim(),
        binanceApiKey: binanceApiKey.trim(),
        binanceApiSecret: binanceApiSecret.trim(),
        bybitApiKey: bybitApiKey.trim(),
        bybitApiSecret: bybitApiSecret.trim(),
        mexcApiKey: mexcApiKey.trim(),
        mexcApiSecret: mexcApiSecret.trim(),
        gateApiKey: gateApiKey.trim(),
        gateApiSecret: gateApiSecret.trim(),
      } satisfies SecureCredentialsPayload;
      try {
        await saveSecureCredentials(payload);
      } catch (error) {
        window.localStorage.setItem(LOCAL_API_KEYS_STORAGE_KEY, JSON.stringify(payload));
        setRefreshError(
          error instanceof Error
            ? `Не удалось сохранить ключи в защищённое хранилище: ${error.message}`
            : "Не удалось сохранить ключи в защищённое хранилище."
        );
      }
    }
    skipNextAutoRefreshRef.current = true;
    setConfigured(true);
    setShowKeyEditor(false);
    setLoading(true);
    void refresh();
  };

  const handleDisconnect = async () => {
    await fetch("/api/futures/credentials", { method: "DELETE" }).catch(() => null);
    setConfigured(false);
    setData(null);
    setBingxApiKey("");
    setBingxApiSecret("");
    setBitgetApiKey("");
    setBitgetApiSecret("");
    setBitgetPassphrase("");
    setBinanceApiKey("");
    setBinanceApiSecret("");
    setBybitApiKey("");
    setBybitApiSecret("");
    setMexcApiKey("");
    setMexcApiSecret("");
    setGateApiKey("");
    setGateApiSecret("");
    if (ZERO_STORAGE_MODE) {
      await clearSecureCredentials();
      window.localStorage.removeItem(LOCAL_API_KEYS_STORAGE_KEY);
    }
    setRefreshError(null);
    setShowKeyEditor(true);
  };

  const handleSignOut = async () => {
    if (hasSupabaseEnv()) {
      const supabase = getSupabaseBrowserClient();
      await supabase.auth.signOut();
      router.replace("/auth");
    }
    await fetch("/api/futures/credentials", { method: "DELETE" }).catch(() => null);
    await clearSecureCredentials();
    router.refresh();
  };

  const checkForUpdates = async () => {
    setUpdateState((prev) => ({ ...prev, checking: true, message: "Проверяем обновления...", downloadUrl: null }));
    try {
      const releasesUrl = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
      const tagsUrl = `https://api.github.com/repos/${UPDATE_REPO}/tags?per_page=1`;
      const response = await fetch(releasesUrl, {
        cache: "no-store",
      });
      if (response.status === 404) {
        const tagsResponse = await fetch(tagsUrl, { cache: "no-store" });
        if (!tagsResponse.ok) {
          throw new Error(`GitHub API ${tagsResponse.status}`);
        }
        const tags = (await tagsResponse.json()) as GithubTag[];
        const latestTag = tags[0]?.name?.trim() || "";
        if (!latestTag) {
          setUpdateState({
            checking: false,
            installing: false,
            message: "Релизы ещё не опубликованы. После создания Release проверка обновлений заработает автоматически.",
            downloadUrl: null,
          });
          return;
        }
        if (isRemoteVersionNewer(APP_VERSION, latestTag)) {
          setUpdateState({
            checking: false,
            installing: false,
            message: `Доступна версия ${latestTag.replace(/^v/i, "")}. Опубликуйте GitHub Release, чтобы скачать обновление в один клик.`,
            downloadUrl: `https://github.com/${UPDATE_REPO}/releases`,
          });
          return;
        }
        setUpdateState({
          checking: false,
          installing: false,
          message: `У вас актуальная версия ${APP_VERSION}.`,
          downloadUrl: null,
        });
        return;
      }
      if (!response.ok) {
        throw new Error(`GitHub API ${response.status}`);
      }
      const latest = (await response.json()) as GithubLatestRelease;
      const remoteVersion = latest.tag_name?.trim() || "";
      if (!remoteVersion) {
        throw new Error("Не удалось определить версию релиза.");
      }
      const installerUrl = pickInstallerUrl(latest);
      if (isRemoteVersionNewer(APP_VERSION, remoteVersion)) {
        setUpdateState({
          checking: false,
          installing: false,
          message: `Доступно обновление ${remoteVersion.replace(/^v/i, "")} (текущая ${APP_VERSION}).`,
          downloadUrl: installerUrl,
        });
        return;
      }
      setUpdateState({
        checking: false,
        installing: false,
        message: `У вас актуальная версия ${APP_VERSION}.`,
        downloadUrl: null,
      });
    } catch (error) {
      setUpdateState({
        checking: false,
        installing: false,
        message: error instanceof Error ? `Проверка обновлений не удалась: ${error.message}` : "Проверка обновлений не удалась.",
        downloadUrl: null,
      });
    }
  };

  const installUpdate = async () => {
    if (!updateState.downloadUrl || updateState.installing) return;
    setUpdateState((prev) => ({ ...prev, installing: true, message: "Скачиваем и запускаем установщик обновления..." }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("install_update_from_url", { url: updateState.downloadUrl });
      setUpdateState((prev) => ({
        ...prev,
        installing: false,
        message: "Установщик запущен. Завершите обновление и перезапустите приложение.",
      }));
    } catch (error) {
      setUpdateState((prev) => ({
        ...prev,
        installing: false,
        message: error instanceof Error ? `Не удалось запустить обновление: ${error.message}` : "Не удалось запустить обновление.",
      }));
    }
  };
  const goToSection = useCallback((sectionId: string) => {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const filteredHistory = useMemo(() => {
    return data?.history ?? [];
  }, [data?.history]);

  const exchangeMatches = useCallback(
    (exchange?: string) => {
      if (exchangeFilter === "ALL") return true;
      return (exchange || "BINGX").toUpperCase() === exchangeFilter;
    },
    [exchangeFilter]
  );

  const filteredPositions = useMemo(
    () => (snapshot?.positions ?? []).filter((position) => exchangeMatches(position.exchange)),
    [exchangeMatches, snapshot?.positions]
  );

  const mergedTrades = useMemo(() => {
    const seen = new Set<string>();
    const unique = [];
    const snapshots = [...(data?.history ?? [])].reverse();
    for (const snap of snapshots) {
      for (const trade of snap.recentTrades ?? []) {
        const normalizedTrade = { ...trade, exchange: trade.exchange || "BINGX" };
        const key = buildTradeKey(normalizedTrade);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(normalizedTrade);
        if (unique.length >= 3000) break;
      }
      if (unique.length >= 3000) break;
    }
    return unique.sort((a, b) => b.time - a.time);
  }, [data?.history]);

  const filteredMergedTrades = useMemo(
    () => mergedTrades.filter((trade) => exchangeMatches(trade.exchange)),
    [exchangeMatches, mergedTrades]
  );
  const inferredBaseEquityUsd = useMemo(() => {
    const first = filteredHistory[0];
    return first ? first.walletBalance + first.totalUnrealizedPnl : null;
  }, [filteredHistory]);
  const effectiveBaseEquityUsd = manualBaseEquityUsd ?? inferredBaseEquityUsd ?? 0;

  const tradeStats = useMemo(() => {
    const trades = filteredMergedTrades.filter((trade) => trade.realizedPnl !== 0);
    let profit = 0;
    let loss = 0;
    let win = 0;
    let lose = 0;
    let volume = 0;
    let marginVolume = 0;
    let feePaid = 0;
    let longTrades = 0;
    let shortTrades = 0;
    for (const t of trades) {
      volume += t.quoteQty;
      marginVolume += t.marginUsed;
      feePaid += Math.abs(t.fee);
      const direction = getTradeDirectionLabel(t.side, t.positionSide);
      if (direction === "LONG" || direction === "BUY") longTrades += 1;
      if (direction === "SHORT" || direction === "SELL") shortTrades += 1;
      if (t.realizedPnl > 0) {
        profit += t.realizedPnl;
        win += 1;
      } else if (t.realizedPnl < 0) {
        loss += Math.abs(t.realizedPnl);
        lose += 1;
      }
    }
    const closed = win + lose;
    return {
      closed,
      win,
      lose,
      winRate: closed > 0 ? (win / closed) * 100 : 0,
      profit,
      loss,
      volume,
      marginVolume,
      feePaid,
      longTrades,
      shortTrades,
      net: profit - loss,
      trades,
    };
  }, [filteredMergedTrades]);
  const longShortStats = useMemo(() => {
    const seed = {
      LONG: { trades: 0, wins: 0, pnl: 0 },
      SHORT: { trades: 0, wins: 0, pnl: 0 },
    };
    for (const trade of tradeStats.trades) {
      const direction = getTradeDirectionLabel(trade.side, trade.positionSide);
      const bucket = direction === "SHORT" || direction === "SELL" ? "SHORT" : "LONG";
      seed[bucket].trades += 1;
      seed[bucket].pnl += trade.realizedPnl;
      if (trade.realizedPnl > 0) seed[bucket].wins += 1;
    }
    return {
      LONG: {
        ...seed.LONG,
        winRate: seed.LONG.trades > 0 ? (seed.LONG.wins / seed.LONG.trades) * 100 : 0,
      },
      SHORT: {
        ...seed.SHORT,
        winRate: seed.SHORT.trades > 0 ? (seed.SHORT.wins / seed.SHORT.trades) * 100 : 0,
      },
    };
  }, [tradeStats.trades]);

  const signalStats = useMemo(() => {
    const grouped = new Map<TradeSignal, { trades: number; wins: number; pnl: number }>();
    for (const option of signalOptions) {
      grouped.set(option.value, { trades: 0, wins: 0, pnl: 0 });
    }
    const signals = data?.tradeSignals ?? {};
    for (const trade of tradeStats.trades) {
      const key = buildTradeKey(trade);
      const signal = signals[key] ?? "SECRET";
      if (!grouped.has(signal)) {
        grouped.set(signal, { trades: 0, wins: 0, pnl: 0 });
      }
      const row = grouped.get(signal);
      if (!row) continue;
      row.trades += 1;
      row.pnl += trade.realizedPnl;
      if (trade.realizedPnl > 0) row.wins += 1;
    }
    return signalOptions.map((option) => {
      const row = grouped.get(option.value) ?? { trades: 0, wins: 0, pnl: 0 };
      return {
        signal: option.value,
        label: option.label,
        trades: row.trades,
        winRate: row.trades > 0 ? (row.wins / row.trades) * 100 : 0,
        pnl: row.pnl,
      };
    });
  }, [data?.tradeSignals, signalOptions, tradeStats.trades]);

  const setTradeSignal = useCallback(
    async (tradeKey: string, signal: TradeSignal) => {
      setSavingTradeSignalKey(tradeKey);
      try {
        const response = await fetch("/api/futures/trade-signals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tradeKey, signal }),
        });
        if (!response.ok) {
          throw new Error("Не удалось сохранить сигнал сделки.");
        }
        const payload = (await response.json()) as { tradeSignals?: Record<string, TradeSignal> };
        const nextSignals = payload.tradeSignals;
        if (!nextSignals) return;
        setData((prev) => (prev ? { ...prev, tradeSignals: nextSignals } : prev));
      } catch (error) {
        setRefreshError(error instanceof Error ? error.message : "Не удалось сохранить сигнал.");
      } finally {
        setSavingTradeSignalKey(null);
      }
    },
    []
  );

  const toggleTradeTag = useCallback((tradeKey: string, tag: TradeTag) => {
    setTradeTags((prev) => {
      const current = prev[tradeKey] ?? { setup: false, error: false, emotion: false };
      return {
        ...prev,
        [tradeKey]: { ...current, [tag]: !current[tag] },
      };
    });
  }, []);

  const periodStartTime = useMemo(() => {
    const now = Date.now();
    if (reportPeriod === "day") return now - 24 * 60 * 60 * 1000;
    if (reportPeriod === "week") return now - 7 * 24 * 60 * 60 * 1000;
    return now - 30 * 24 * 60 * 60 * 1000;
  }, [reportPeriod]);

  const filteredHistoryTrades = useMemo(() => {
    return filteredMergedTrades
      .filter((trade) => trade.realizedPnl !== 0)
      .filter((trade) => {
        if (tagFilter === "ALL") return true;
        const key = buildTradeKey(trade);
        return Boolean(tradeTags[key]?.[tagFilter]);
      });
  }, [filteredMergedTrades, tagFilter, tradeTags]);
  const reportTrades = useMemo(
    () => filteredMergedTrades.filter((trade) => trade.realizedPnl !== 0 && trade.time >= periodStartTime),
    [filteredMergedTrades, periodStartTime]
  );
  const aiReviewTrades = useMemo(
    () => filteredHistoryTrades.filter((trade) => trade.time >= periodStartTime).slice(0, 1200),
    [filteredHistoryTrades, periodStartTime]
  );

  const tagStats = useMemo(() => {
    const tags: TradeTag[] = ["setup", "error", "emotion"];
    return tags.map((tag) => {
      let trades = 0;
      let wins = 0;
      let pnl = 0;
      for (const trade of filteredMergedTrades) {
        if (trade.realizedPnl === 0) continue;
        const key = buildTradeKey(trade);
        if (!tradeTags[key]?.[tag]) continue;
        trades += 1;
        pnl += trade.realizedPnl;
        if (trade.realizedPnl > 0) wins += 1;
      }
      return {
        tag,
        trades,
        pnl,
        winRate: trades > 0 ? (wins / trades) * 100 : 0,
      };
    });
  }, [filteredMergedTrades, tradeTags]);

  const exportCsvReport = useCallback(() => {
    const rows = [
      ["time", "exchange", "symbol", "side", "leverage", "marginUsd", "realizedPnl", "pnlPercent", "signal", "tags"].join(","),
      ...reportTrades.map((trade) => {
        const tradeKey = buildTradeKey(trade);
        const tags = tradeTags[tradeKey] ?? { setup: false, error: false, emotion: false };
        const selectedSignal = data?.tradeSignals?.[tradeKey] ?? "SECRET";
        const tagText = ["setup", "error", "emotion"].filter((tag) => tags[tag as TradeTag]).join("|");
        return [
          csvEscape(new Date(trade.time).toISOString()),
          csvEscape(trade.exchange || "BINGX"),
          csvEscape(trade.symbol),
          csvEscape(getTradeDirectionLabel(trade.side, trade.positionSide)),
          csvEscape(trade.leverage),
          csvEscape(trade.marginUsed.toFixed(2)),
          csvEscape(trade.realizedPnl.toFixed(2)),
          csvEscape(trade.pnlPercent.toFixed(2)),
          csvEscape(selectedSignal),
          csvEscape(tagText),
        ].join(",");
      }),
    ].join("\n");
    const blob = new Blob([rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `trader-report-${reportPeriod}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [data?.tradeSignals, reportPeriod, reportTrades, tradeTags]);

  const exportPdfReport = useCallback(() => {
    window.print();
  }, []);

  const sendTelegramReport = useCallback(async () => {
    setSendingTelegramReport(true);
    try {
      const response = await fetch("/api/futures/reports/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period: reportPeriod,
          botToken: telegramBotToken.trim(),
          chatId: telegramChatId.trim(),
          trades: reportTrades.slice(0, 500),
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Не удалось отправить отчёт в Telegram.");
      }
      setRefreshError(null);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Не удалось отправить отчёт в Telegram.");
    } finally {
      setSendingTelegramReport(false);
    }
  }, [reportPeriod, reportTrades, telegramBotToken, telegramChatId]);

  const toAiTradePayload = useCallback(
    (trade: (typeof filteredMergedTrades)[number]) => {
      const tradeKey = buildTradeKey(trade);
      const tags = tradeTags[tradeKey] ?? { setup: false, error: false, emotion: false };
      return {
        exchange: trade.exchange || "BINGX",
        symbol: trade.symbol,
        side: trade.side,
        positionSide: trade.positionSide,
        leverage: trade.leverage,
        price: trade.price,
        qty: trade.qty,
        marginUsed: trade.marginUsed,
        realizedPnl: trade.realizedPnl,
        pnlPercent: trade.pnlPercent,
        fee: trade.fee,
        time: trade.time,
        isLiquidation: trade.isLiquidation,
        signal: data?.tradeSignals?.[tradeKey] ?? "SECRET",
        tags: (["setup", "error", "emotion"] as TradeTag[]).filter((tag) => tags[tag]),
      };
    },
    [data?.tradeSignals, tradeTags]
  );

  const requestAiReview = useCallback(async () => {
    setLoadingAiReview(true);
    try {
      const payloadTrades = aiReviewTrades.map((trade) => toAiTradePayload(trade));
      const response = await fetch("/api/futures/ai-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period: reportPeriod,
          exchangeFilter,
          tagFilter,
          trades: payloadTrades,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "AI-разбор временно недоступен.");
      }
      const review = (await response.json()) as AiReviewPayload;
      setAiReview(review);
      setRefreshError(null);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "AI-разбор временно недоступен.");
    } finally {
      setLoadingAiReview(false);
    }
  }, [aiReviewTrades, exchangeFilter, reportPeriod, tagFilter, toAiTradePayload]);

  const requestSingleTradeAiReview = useCallback(
    async (trade: (typeof filteredMergedTrades)[number]) => {
      const tradeKey = buildTradeKey(trade);
      setLoadingSingleTradeReviewKey(tradeKey);
      try {
        const response = await fetch("/api/futures/ai-review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            period: "single",
            exchangeFilter: trade.exchange || "BINGX",
            tagFilter,
            trades: [toAiTradePayload(trade)],
          }),
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? "AI-разбор сделки временно недоступен.");
        }
        const review = (await response.json()) as AiReviewPayload;
        setAiReview(review);
        setRefreshError(null);
      } catch (error) {
        setRefreshError(error instanceof Error ? error.message : "AI-разбор сделки временно недоступен.");
      } finally {
        setLoadingSingleTradeReviewKey(null);
      }
    },
    [tagFilter, toAiTradePayload]
  );

  const symbolRating = useMemo(() => {
    const map = new Map<string, { pnl: number; count: number }>();
    for (const trade of tradeStats.trades) {
      const current = map.get(trade.symbol) ?? { pnl: 0, count: 0 };
      current.pnl += trade.realizedPnl;
      current.count += 1;
      map.set(trade.symbol, current);
    }
    return Array.from(map.entries())
      .map(([symbol, v]) => ({ symbol, pnl: v.pnl, count: v.count }))
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 10);
  }, [tradeStats.trades]);
  const hasTradeData = tradeStats.trades.length > 0;
  const liquidationTradesCount = useMemo(
    () => filteredMergedTrades.filter((trade) => trade.isLiquidation).length,
    [filteredMergedTrades]
  );

  const accountStats = useMemo(() => {
    const points = filteredHistory.map((item) => ({
      ts: item.timestamp,
      equity: item.walletBalance + item.totalUnrealizedPnl,
      wallet: item.walletBalance,
      unrealized: item.totalUnrealizedPnl,
    }));
    const latest = points[points.length - 1];
    if (!latest) {
      return {
        totalAssets: 0,
        totalPnl: 0,
        totalPnlPct: 0,
        dayPnl: 0,
        dayPnlPct: 0,
      };
    }
    const totalAssets = latest.equity;
    const totalPnl = totalAssets - effectiveBaseEquityUsd;
    const totalPnlPct = (totalPnl / Math.max(Math.abs(effectiveBaseEquityUsd), 1)) * 100;
    // «За сегодня» — от первого снимка календарного дня (локальное время), не rolling 24h:
    // иначе при дырке/ошибке в equity ~24ч назад получались нереальные $ и %.
    const startOfDay = new Date(latest.ts);
    startOfDay.setHours(0, 0, 0, 0);
    const startOfDayMs = startOfDay.getTime();
    let dayStartEquity: number | undefined;
    for (const item of points) {
      if (item.ts >= startOfDayMs) {
        dayStartEquity = item.equity;
        break;
      }
    }
    if (dayStartEquity === undefined) {
      const beforeToday = [...points].reverse().find((item) => item.ts < startOfDayMs);
      dayStartEquity = beforeToday?.equity ?? latest.equity;
    }
    const dayPnl = totalAssets - dayStartEquity;
    const dayPnlPct = (dayPnl / Math.max(Math.abs(dayStartEquity), 1)) * 100;
    return {
      totalAssets,
      totalPnl,
      totalPnlPct,
      dayPnl,
      dayPnlPct,
    };
  }, [effectiveBaseEquityUsd, filteredHistory]);
  const terminalSeries = useMemo(() => {
    return filteredHistory
      .slice(-36)
      .map((item) => ({
        ts: item.timestamp,
        value: item.walletBalance + item.totalUnrealizedPnl,
      }))
      .filter((item) => Number.isFinite(item.value) && Number.isFinite(item.ts));
  }, [filteredHistory]);
  const terminalChart = useMemo(() => {
    if (!terminalSeries.length) {
      return {
        polyline: "",
        areaPath: "",
        baselineY: 20,
        min: 0,
        max: 0,
        latest: 0,
        delta: 0,
        deltaPct: 0,
        axisTicks: ["--:--", "--:--", "--:--", "--:--", "--:--"],
      };
    }
    const values = terminalSeries.map((item) => item.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const latest = terminalSeries[terminalSeries.length - 1]?.value ?? 0;
    const first = terminalSeries[0]?.value ?? latest;
    const nowTs = terminalSeries[terminalSeries.length - 1]?.ts ?? Date.now();
    const cutoff24h = nowTs - 24 * 60 * 60 * 1000;
    const baselinePoint = terminalSeries.find((item) => item.ts >= cutoff24h) ?? terminalSeries[0];
    const baselineValue = baselinePoint?.value ?? first;
    const delta = latest - baselineValue;
    const deltaPct = (delta / Math.max(Math.abs(baselineValue), 1)) * 100;
    const span = Math.max(max - min, 1);
    const points = terminalSeries.map((item, index) => {
        const x = (index / Math.max(terminalSeries.length - 1, 1)) * 100;
        const y = 36 - ((item.value - min) / span) * 28;
        return { x, y };
      });
    const polyline = points.map((item) => `${item.x.toFixed(2)},${item.y.toFixed(2)}`).join(" ");
    const baselineY = 36 - ((first - min) / span) * 28;
    const areaPath = points.length
      ? `M ${points[0].x.toFixed(2)} ${baselineY.toFixed(2)} L ${points
          .map((item) => `${item.x.toFixed(2)} ${item.y.toFixed(2)}`)
          .join(" L ")} L ${points[points.length - 1].x.toFixed(2)} ${baselineY.toFixed(2)} Z`
      : "";
    const lastIndex = terminalSeries.length - 1;
    const tickIndexes = [0, Math.floor(lastIndex * 0.25), Math.floor(lastIndex * 0.5), Math.floor(lastIndex * 0.75), lastIndex];
    const axisTicks = tickIndexes.map((idx) => formatTimeTick(terminalSeries[idx]?.ts ?? Date.now()));
    return {
      polyline,
      areaPath,
      baselineY,
      min,
      max,
      latest,
      delta,
      deltaPct,
      axisTicks,
    };
  }, [terminalSeries]);

  const avgWin = tradeStats.win > 0 ? tradeStats.profit / tradeStats.win : 0;
  const avgLoss = tradeStats.lose > 0 ? tradeStats.loss / tradeStats.lose : 0;
  const dailyPnlHeat = useMemo(() => {
    const days = 14;
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const dayMap = new Map<string, number>();
    for (let index = 0; index < days; index += 1) {
      const current = new Date(now);
      current.setDate(now.getDate() - index);
      const key = current.toISOString().slice(0, 10);
      dayMap.set(key, 0);
    }
    for (const trade of filteredMergedTrades) {
      if (trade.realizedPnl === 0) continue;
      const dayStart = new Date(trade.time);
      dayStart.setHours(0, 0, 0, 0);
      const key = dayStart.toISOString().slice(0, 10);
      if (!dayMap.has(key)) continue;
      dayMap.set(key, (dayMap.get(key) ?? 0) + trade.realizedPnl);
    }
    const rows = Array.from(dayMap.entries())
      .map(([dayKey, pnl]) => ({ dayKey, pnl }))
      .sort((a, b) => a.dayKey.localeCompare(b.dayKey));
    const maxAbs = rows.reduce((max, row) => Math.max(max, Math.abs(row.pnl)), 0);
    return rows.map((row) => ({ ...row, intensity: maxAbs > 0 ? Math.abs(row.pnl) / maxAbs : 0 }));
  }, [filteredMergedTrades]);

  const dataHealth = useMemo(() => {
    const isLight = uiTheme === "light";
    if (!snapshot) {
      return {
        label: "Нет данных",
        className: isLight
          ? "border-slate-200 bg-slate-100 text-slate-600"
          : "border-[rgba(120,190,220,0.14)] bg-[#0C1822] text-[#7C96A3]",
      };
    }
    if (snapshot.degraded || (data?.warnings?.length ?? 0) > 0) {
      return {
        label: "Частичные данные",
        className: isLight
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : "border-[rgba(240,180,76,0.26)] bg-[#241F18] text-[#F0B44C]",
      };
    }
    return {
      label: "online",
      className: isLight
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : "border-[rgba(56,211,159,0.26)] bg-[#142521] text-[#38D39F]",
    };
  }, [data?.warnings?.length, snapshot, uiTheme]);

  const selectedUnrealizedPnl = useMemo(
    () => filteredPositions.reduce((sum, position) => sum + position.unrealizedPnl, 0),
    [filteredPositions]
  );
  const totalCurrentPnl = tradeStats.net + selectedUnrealizedPnl;
  const totalCurrentPnlPct = (totalCurrentPnl / Math.max(Math.abs(effectiveBaseEquityUsd), 1)) * 100;
  const fmtUsdValue = useCallback(
    (blockOrValue: number | string, maybeValue?: number) => {
      const value = typeof blockOrValue === "number" ? blockOrValue : (maybeValue ?? 0);
      return privacyMode ? "$••••" : fmtUsd(value);
    },
    [privacyMode]
  );
  const isLightTheme = uiTheme === "light";
  const pageClass = isLightTheme
    ? "min-h-screen bg-slate-200 text-slate-900"
    : "min-h-screen bg-[#050d14] text-[#EAF7FF]";
  const mutedTextClass = isLightTheme ? "text-slate-600" : "text-[#7C96A3]";
  const sectionTitleClass = isLightTheme ? "text-xl font-semibold text-slate-900" : "text-xl font-semibold text-[#EAF7FF]";
  const cardClass = isLightTheme
    ? "rounded-[20px] border border-slate-300 bg-slate-100/95 p-3"
    : "rounded-[20px] border border-[rgba(90,160,190,0.14)] bg-[linear-gradient(180deg,rgba(12,24,34,0.9),rgba(8,17,24,0.94))] p-3 backdrop-blur-sm";
  const insetPanelClass = isLightTheme
    ? "rounded-2xl border border-slate-300 bg-slate-100/95 p-2.5"
    : "rounded-2xl border border-[rgba(90,160,190,0.12)] bg-[#0D1B26]/85 p-2.5";
  const controlClass = isLightTheme
    ? "rounded-xl border border-slate-300 bg-slate-100 px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-700 outline-none"
    : "rounded-xl border border-[rgba(90,160,190,0.16)] bg-[#08141E]/90 px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-[#A7C3D1] outline-none";
  const sidebarClass = isLightTheme
    ? "w-16 shrink-0 rounded-2xl border border-slate-300 bg-slate-100/90 p-2"
    : "w-16 shrink-0 rounded-2xl border border-[rgba(90,160,190,0.16)] bg-[#07111A]/85 p-2";
  const iconBtnClass = isLightTheme
    ? "flex h-10 w-10 items-center justify-center rounded-xl text-slate-700 transition hover:bg-slate-100"
    : "flex h-10 w-10 items-center justify-center rounded-xl text-[#6F8A97] transition hover:bg-[#10202B] hover:text-[#77E7FF]";
  const exchangeBtnBaseClass =
    "inline-flex h-10 shrink-0 items-center justify-center rounded-xl px-4 text-sm font-semibold transition";
  const exchangeBtnInactiveClass = isLightTheme
    ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
    : "border border-[rgba(120,190,220,0.18)] bg-[#111822] text-[#D5E7F1] hover:border-[rgba(180,220,240,0.35)] hover:bg-[#182332]";
  const exchangeBtnActiveClass = isLightTheme
    ? "border border-sky-400 bg-sky-50 text-slate-900"
    : "border border-[rgba(84,214,255,0.45)] bg-[#1A2C3A] text-white shadow-[0_0_0_1px_rgba(84,214,255,0.18)_inset]";
  const tableHeadClass = isLightTheme ? "text-slate-600" : "text-[#8EA9B7]";
  const tableRowClass = isLightTheme ? "border-t border-slate-200" : "border-t border-[rgba(120,190,220,0.12)]";

  return (
    <main className={`${pageClass} relative w-full min-w-0`}>
      {!isLightTheme ? (
        <>
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(57,208,255,0.08),transparent_42%),radial-gradient(circle_at_bottom_left,rgba(25,194,180,0.08),transparent_36%)]" />
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(120deg,transparent_10%,rgba(119,231,255,0.05)_38%,transparent_62%)]" />
        </>
      ) : null}
      <div className="relative z-10 mx-auto w-full max-w-[1520px] p-2 sm:p-3 md:p-4">
        <div className="flex w-full min-w-0 flex-col gap-4 md:grid md:grid-cols-[4rem_minmax(0,1fr)] md:items-start md:gap-x-4">
        <nav
          aria-label="Разделы"
          className={`hidden self-start md:sticky md:top-4 md:z-20 md:flex md:flex-col md:items-center md:justify-start ${sidebarClass}`}
        >
          <div className="flex flex-col gap-2">
            <button type="button" className={iconBtnClass} title="Обзор" onClick={() => goToSection("overview-section")}>
              <MaterialIcon name="dashboard" />
            </button>
            <button type="button" className={iconBtnClass} title="Торговые данные" onClick={() => goToSection("trading-section")}>
              <MaterialIcon name="trending" />
            </button>
            <button type="button" className={iconBtnClass} title="Открытые позиции" onClick={() => goToSection("positions-section")}>
              <MaterialIcon name="work" />
            </button>
            <button type="button" className={iconBtnClass} title="История сделок" onClick={() => goToSection("history-section")}>
              <MaterialIcon name="history" />
            </button>
          </div>
          <div className="relative mt-6 flex flex-col gap-2">
            <button
              type="button"
              className={iconBtnClass}
              title="Настройки"
              onClick={() => {
                setShowSettingsMenu((prev) => !prev);
                setShowProfileMenu(false);
              }}
            >
              <MaterialIcon name="settings" />
            </button>
            {showSettingsMenu ? (
              <div className={`absolute bottom-12 left-12 z-50 w-44 rounded-xl border p-2 text-xs shadow-2xl ${isLightTheme ? "border-slate-200 bg-white text-slate-700" : "border-[rgba(120,190,220,0.16)] bg-[#0C1822] text-[#A7C3D1]"}`}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${isLightTheme ? "hover:bg-slate-100" : "hover:bg-[#132734]"}`}
                  onClick={() => setUiTheme((prev) => (prev === "dark" ? "light" : "dark"))}
                >
                  <MaterialIcon name={isLightTheme ? "light" : "dark"} />
                  <span>{isLightTheme ? "Светлая тема" : "Тёмная тема"}</span>
                </button>
                <div className={`my-1 h-px ${isLightTheme ? "bg-slate-200" : "bg-[rgba(120,190,220,0.16)]"}`} />
                <p className={`px-2 py-1 text-[10px] uppercase tracking-[0.12em] ${isLightTheme ? "text-slate-500" : "text-[#7C96A3]"}`}>
                  Источники сигналов
                </p>
                <div className="px-2 pb-1">
                  <input
                    value={newSignalSource}
                    onChange={(event) => setNewSignalSource(event.target.value)}
                    className={isLightTheme ? "w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] outline-none" : "w-full rounded-lg border border-[rgba(120,190,220,0.16)] bg-[#09141D] px-2 py-1 text-[11px] text-[#EAF7FF] outline-none"}
                    placeholder="Напр. CRYPTO_CREW"
                  />
                  <button
                    type="button"
                    className={isLightTheme ? "mt-1 w-full rounded-lg border border-slate-200 bg-slate-100 px-2 py-1 text-[11px] font-semibold" : "mt-1 w-full rounded-lg border border-[rgba(120,190,220,0.16)] bg-[#10202B] px-2 py-1 text-[11px] font-semibold text-[#A7C3D1]"}
                    onClick={() => {
                      const value = toSignalValue(newSignalSource);
                      if (!value) return;
                      if (DEFAULT_SIGNAL_OPTIONS.some((option) => option.value === value)) {
                        setNewSignalSource("");
                        return;
                      }
                      setCustomSignalOptions((prev) => {
                        if (prev.some((option) => option.value === value)) return prev;
                        return [...prev, { value, label: newSignalSource.trim() || value }];
                      });
                      setNewSignalSource("");
                    }}
                  >
                    Добавить источник
                  </button>
                  {customSignalOptions.length ? (
                    <div className="mt-1 max-h-24 space-y-1 overflow-y-auto">
                      {customSignalOptions.map((option) => (
                        <div key={option.value} className="flex items-center justify-between text-[11px]">
                          <span className={isLightTheme ? "text-slate-600" : "text-[#A7C3D1]"}>{option.label}</span>
                          <button
                            type="button"
                            className={isLightTheme ? "text-red-600" : "text-[#E15C5C]"}
                            onClick={() =>
                              setCustomSignalOptions((prev) => prev.filter((item) => item.value !== option.value))
                            }
                          >
                            удалить
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className={`my-1 h-px ${isLightTheme ? "bg-slate-200" : "bg-[rgba(120,190,220,0.16)]"}`} />
                <p className={`px-2 py-1 text-[10px] uppercase tracking-[0.12em] ${isLightTheme ? "text-slate-500" : "text-[#7C96A3]"}`}>
                  База П/У
                </p>
                <div className="px-2 pb-1">
                  <input
                    value={baseEquityInput}
                    onChange={(event) => setBaseEquityInput(event.target.value)}
                    className={isLightTheme ? "w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] outline-none" : "w-full rounded-lg border border-[rgba(120,190,220,0.16)] bg-[#09141D] px-2 py-1 text-[11px] text-[#EAF7FF] outline-none"}
                    placeholder={inferredBaseEquityUsd != null ? `Авто: ${inferredBaseEquityUsd.toFixed(2)}` : "Напр. 6200"}
                  />
                  <div className="mt-1 grid grid-cols-2 gap-1">
                    <button
                      type="button"
                      disabled={savingBaseEquity}
                      className={isLightTheme ? "rounded-lg border border-slate-200 bg-slate-100 px-2 py-1 text-[11px] font-semibold disabled:opacity-60" : "rounded-lg border border-[rgba(120,190,220,0.16)] bg-[#10202B] px-2 py-1 text-[11px] font-semibold text-[#A7C3D1] disabled:opacity-60"}
                      onClick={() => void saveBaseEquity()}
                    >
                      Сохранить
                    </button>
                    <button
                      type="button"
                      disabled={savingBaseEquity}
                      className={isLightTheme ? "rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] disabled:opacity-60" : "rounded-lg border border-[rgba(120,190,220,0.16)] bg-[#09141D] px-2 py-1 text-[11px] text-[#A7C3D1] disabled:opacity-60"}
                      onClick={() => void resetBaseEquityToAuto()}
                    >
                      Авто
                    </button>
                  </div>
                  <p className={`mt-1 text-[10px] ${isLightTheme ? "text-slate-500" : "text-[#6F8A97]"}`}>
                    Сейчас: {manualBaseEquityUsd != null ? `${manualBaseEquityUsd.toFixed(2)} (ручная)` : "авто из API/истории"}
                  </p>
                </div>
              </div>
            ) : null}
            <button
              type="button"
              className={iconBtnClass}
              title="Профиль"
              onClick={() => {
                setShowProfileMenu((prev) => !prev);
                setShowSettingsMenu(false);
              }}
            >
              <MaterialIcon name="person" />
            </button>
            {showProfileMenu ? (
              <div className={`absolute bottom-0 left-12 z-50 w-44 rounded-xl border p-2 text-xs shadow-2xl ${isLightTheme ? "border-slate-200 bg-white text-slate-700" : "border-[rgba(120,190,220,0.16)] bg-[#0C1822] text-[#A7C3D1]"}`}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${isLightTheme ? "hover:bg-slate-100" : "hover:bg-[#132734]"}`}
                  onClick={() => setShowKeyEditor((prev) => !prev)}
                >
                  <MaterialIcon name="key" />
                  <span>{showKeyEditor ? "Скрыть API" : "API ключи"}</span>
                </button>
                <button
                  type="button"
                  className={`mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${isLightTheme ? "hover:bg-slate-100" : "hover:bg-[#132734]"}`}
                  onClick={() => void checkForUpdates()}
                  disabled={updateState.checking}
                >
                  <MaterialIcon name="settings" />
                  <span>{updateState.checking ? "Проверка..." : "Проверить обновления"}</span>
                </button>
                <button
                  type="button"
                  className={`mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${isLightTheme ? "hover:bg-slate-100" : "hover:bg-[#132734]"} disabled:opacity-50`}
                  onClick={() => {
                    void installUpdate();
                  }}
                  disabled={!updateState.downloadUrl || updateState.installing}
                >
                  <MaterialIcon name="history" />
                  <span>{updateState.installing ? "Запуск..." : "Установить обновление"}</span>
                </button>
                <button
                  type="button"
                  className={`mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${isLightTheme ? "hover:bg-slate-100" : "hover:bg-[#132734]"}`}
                  onClick={() => void handleSignOut()}
                >
                  <MaterialIcon name="logout" />
                  <span>Выйти</span>
                </button>
              </div>
            ) : null}
          </div>
        </nav>

        <div className="flex min-w-0 w-full flex-col gap-4">
        <div className="flex items-center justify-end gap-2 md:hidden">
          {configured ? (
            <button
              type="button"
              onClick={() => void requestAiReview()}
              disabled={loadingAiReview}
              className="relative inline-flex h-11 w-11 items-center justify-center rounded-full border border-[rgba(168,139,250,0.7)] bg-[radial-gradient(circle_at_30%_25%,rgba(34,211,238,0.95),rgba(29,78,216,0.9)_38%,rgba(109,40,217,0.92)_72%,rgba(6,10,20,0.95)_100%)] text-sm font-extrabold text-white shadow-[0_0_22px_rgba(99,102,241,0.55)] transition hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-70"
              title="AI Аналитика"
            >
              <span className="tracking-tight">{loadingAiReview ? "..." : "AI"}</span>
            </button>
          ) : null}
          <button
            type="button"
            className={isLightTheme ? "rounded-xl border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700" : "rounded-xl border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-2 py-1 text-xs font-semibold text-[#A7C3D1]"}
            onClick={() => setPrivacyMode((prev) => !prev)}
          >
            {privacyMode ? "private" : "public"}
          </button>
          <button
            type="button"
            className={iconBtnClass}
            title="Меню"
            onClick={() => setShowMobileMenu(true)}
          >
            <MaterialIcon name="settings" />
          </button>
        </div>
        {showMobileMenu ? (
          <div className="fixed inset-0 z-40 md:hidden">
            <button
              type="button"
              className="absolute inset-0 bg-black/50"
              aria-label="Закрыть меню"
              onClick={() => setShowMobileMenu(false)}
            />
            <div className={`absolute right-0 top-0 h-full w-[84%] max-w-[320px] overflow-y-auto p-3 ${isLightTheme ? "bg-slate-100 text-slate-900" : "bg-[#08131D] text-[#EAF7FF]"}`}>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-semibold">Быстрое меню</p>
                <button type="button" className={iconBtnClass} onClick={() => setShowMobileMenu(false)}>
                  <MaterialIcon name="logout" className="h-4 w-4 rotate-180" />
                </button>
              </div>
              <div className="space-y-2">
                {updateState.message ? (
                  <p className={isLightTheme ? "rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600" : "rounded-lg border border-[rgba(120,190,220,0.16)] bg-[#0C1822] px-2 py-1 text-[11px] text-[#A7C3D1]"}>
                    {updateState.message}
                  </p>
                ) : null}
                <button type="button" className={`${controlClass} w-full text-left`} onClick={() => { goToSection("overview-section"); setShowMobileMenu(false); }}>Обзор</button>
                <button type="button" className={`${controlClass} w-full text-left`} onClick={() => { goToSection("trading-section"); setShowMobileMenu(false); }}>Торговые данные</button>
                <button type="button" className={`${controlClass} w-full text-left`} onClick={() => { goToSection("positions-section"); setShowMobileMenu(false); }}>Открытые позиции</button>
                <button type="button" className={`${controlClass} w-full text-left`} onClick={() => { goToSection("history-section"); setShowMobileMenu(false); }}>История сделок</button>
                {configured ? (
                  <button
                    type="button"
                    className={`${controlClass} w-full text-left`}
                    onClick={() => {
                      void refresh();
                      setShowMobileMenu(false);
                    }}
                  >
                    Обновить
                  </button>
                ) : null}
                <button type="button" className={`${controlClass} w-full text-left`} onClick={() => { setShowKeyEditor((prev) => !prev); setShowMobileMenu(false); }}>API ключи</button>
                <button
                  type="button"
                  className={`${controlClass} w-full text-left disabled:opacity-50`}
                  onClick={() => {
                    void checkForUpdates();
                  }}
                  disabled={updateState.checking}
                >
                  {updateState.checking ? "Проверка обновлений..." : "Проверить обновления"}
                </button>
                <button
                  type="button"
                  className={`${controlClass} w-full text-left disabled:opacity-50`}
                  onClick={() => {
                    void installUpdate();
                  }}
                  disabled={!updateState.downloadUrl || updateState.installing}
                >
                  {updateState.installing ? "Запуск обновления..." : "Установить обновление"}
                </button>
                <button type="button" className={`${controlClass} w-full text-left`} onClick={() => { void handleSignOut(); setShowMobileMenu(false); }}>Выйти</button>
              </div>
            </div>
          </div>
        ) : null}
        {updateState.message ? (
          <p className={isLightTheme ? "rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600" : "rounded-xl border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-3 py-2 text-xs text-[#A7C3D1]"}>
            {updateState.message}
          </p>
        ) : null}
        <section className="py-1">
          {configured ? (
            <div className="mb-2 hidden items-start justify-between gap-3 md:flex">
              <div className="min-w-0">
                <p className={isLightTheme ? "text-xl font-semibold text-slate-900" : "text-xl font-semibold text-[#EAF7FF]"}>
                  Трейдинг Блокнот
                </p>
                <p className={isLightTheme ? "text-xs text-slate-500" : "text-xs text-[#7C96A3]"}>
                  Быстрый обзор портфеля, сделок и AI-аналитики
                </p>
              </div>
              <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void requestAiReview()}
                disabled={loadingAiReview}
                className="relative inline-flex h-14 w-14 items-center justify-center rounded-full border border-[rgba(168,139,250,0.78)] bg-[radial-gradient(circle_at_30%_25%,rgba(34,211,238,0.95),rgba(29,78,216,0.9)_38%,rgba(109,40,217,0.92)_72%,rgba(6,10,20,0.95)_100%)] text-base font-extrabold text-white shadow-[0_0_28px_rgba(99,102,241,0.6)] transition hover:scale-[1.04] disabled:cursor-not-allowed disabled:opacity-70"
                title="AI Аналитика"
              >
                <span className="tracking-tight">{loadingAiReview ? "..." : "AI"}</span>
              </button>
              <button
                type="button"
                className={isLightTheme ? "rounded-xl border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700" : "rounded-xl border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-2 py-1 text-xs font-semibold text-[#A7C3D1]"}
                onClick={() => setPrivacyMode((prev) => !prev)}
              >
                {privacyMode ? "private" : "public"}
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                className={`px-2 py-1 text-xs underline underline-offset-4 ${isLightTheme ? "text-slate-600 hover:text-slate-900" : "text-zinc-300 hover:text-white"}`}
              >
                Обновить
              </button>
              </div>
            </div>
          ) : null}
          {configured && aiReview ? (
            <div className="mb-3">
              <div className={`w-full rounded-2xl border p-3 ${isLightTheme ? "border-violet-200 bg-gradient-to-r from-white via-violet-50 to-cyan-50" : "border-[rgba(167,139,250,0.36)] bg-[linear-gradient(100deg,rgba(18,23,38,0.96),rgba(42,27,70,0.85),rgba(14,42,58,0.84))]"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className={`text-[11px] uppercase tracking-[0.14em] ${mutedTextClass}`}>AI-разбор ({aiReview.mode === "llm" ? "LLM" : "heuristic"})</p>
                    <p className={`mt-1 text-sm font-semibold ${isLightTheme ? "text-slate-900" : "text-[#EAF7FF]"}`}>{aiReview.summary}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={isLightTheme ? "rounded-full border border-violet-200 bg-violet-100 px-2 py-1 text-xs font-semibold text-violet-700" : "rounded-full border border-[rgba(167,139,250,0.5)] bg-[rgba(109,40,217,0.25)] px-2 py-1 text-xs font-semibold text-violet-200"}>
                      Портрет: {aiReview.traderProfile}
                    </span>
                    <button
                      type="button"
                      onClick={() => setAiReview(null)}
                      className={isLightTheme ? "rounded-full border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100" : "rounded-full border border-[rgba(120,190,220,0.2)] bg-[#0C1822]/80 px-2 py-1 text-xs font-semibold text-[#A7C3D1] hover:bg-[#132734]"}
                      title="Закрыть AI-анализ"
                    >
                      Закрыть
                    </button>
                  </div>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div className={isLightTheme ? "rounded-xl border border-emerald-200 bg-emerald-50 p-2" : "rounded-xl border border-[rgba(56,211,159,0.3)] bg-[rgba(20,58,45,0.35)] p-2"}>
                    <p className={`text-[10px] uppercase tracking-wide ${mutedTextClass}`}>Winrate</p>
                    <p className="text-lg font-semibold text-[#38D39F]">{aiReview.metrics.winRate.toFixed(2)}%</p>
                  </div>
                  <div className={isLightTheme ? "rounded-xl border border-sky-200 bg-sky-50 p-2" : "rounded-xl border border-[rgba(84,214,255,0.3)] bg-[rgba(10,47,68,0.35)] p-2"}>
                    <p className={`text-[10px] uppercase tracking-wide ${mutedTextClass}`}>Profit Factor</p>
                    <p className={isLightTheme ? "text-lg font-semibold text-slate-900" : "text-lg font-semibold text-[#77E7FF]"}>{aiReview.metrics.profitFactor.toFixed(2)}</p>
                  </div>
                  <div className={isLightTheme ? "rounded-xl border border-violet-200 bg-violet-50 p-2" : "rounded-xl border border-[rgba(167,139,250,0.35)] bg-[rgba(76,29,149,0.28)] p-2"}>
                    <p className={`text-[10px] uppercase tracking-wide ${mutedTextClass}`}>Net PnL</p>
                    <p className={`text-lg font-semibold ${aiReview.metrics.netPnl >= 0 ? "text-[#38D39F]" : "text-[#E15C5C]"}`}>{fmtUsd(aiReview.metrics.netPnl)}</p>
                  </div>
                  <div className={isLightTheme ? "rounded-xl border border-amber-200 bg-amber-50 p-2" : "rounded-xl border border-[rgba(240,180,76,0.35)] bg-[rgba(65,47,16,0.3)] p-2"}>
                    <p className={`text-[10px] uppercase tracking-wide ${mutedTextClass}`}>Свечной контекст</p>
                    <p className={isLightTheme ? "text-lg font-semibold text-slate-900" : "text-lg font-semibold text-[#F0B44C]"}>{aiReview.candleInsights.tradesWithContext}/{aiReview.candleInsights.analyzedTrades}</p>
                  </div>
                </div>

                <div className="mt-3 grid gap-2 md:grid-cols-3">
                  <div className={isLightTheme ? "rounded-xl border border-slate-200 bg-white/80 p-2" : "rounded-xl border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/70 p-2"}>
                    <p className={`text-[11px] font-semibold uppercase tracking-wide ${mutedTextClass}`}>Сильные стороны</p>
                    <ul className="mt-1 space-y-1 text-xs">
                      {aiReview.strengths.map((item, index) => (
                        <li key={`top-s-${index}`}>- {item}</li>
                      ))}
                    </ul>
                  </div>
                  <div className={isLightTheme ? "rounded-xl border border-slate-200 bg-white/80 p-2" : "rounded-xl border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/70 p-2"}>
                    <p className={`text-[11px] font-semibold uppercase tracking-wide ${mutedTextClass}`}>Повторяющиеся ошибки</p>
                    <ul className="mt-1 space-y-1 text-xs">
                      {aiReview.mistakes.map((item, index) => (
                        <li key={`top-m-${index}`}>- {item}</li>
                      ))}
                    </ul>
                  </div>
                  <div className={isLightTheme ? "rounded-xl border border-slate-200 bg-white/80 p-2" : "rounded-xl border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/70 p-2"}>
                    <p className={`text-[11px] font-semibold uppercase tracking-wide ${mutedTextClass}`}>Что улучшить</p>
                    <ul className="mt-1 space-y-1 text-xs">
                      {aiReview.recommendations.map((item, index) => (
                        <li key={`top-r-${index}`}>- {item}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className={`mt-2 rounded-xl border p-2 text-xs ${isLightTheme ? "border-slate-200 bg-white/70 text-slate-700" : "border-[rgba(120,190,220,0.16)] bg-[#09141D]/75 text-[#A7C3D1]"}`}>
                  <span className="font-semibold">Свечной контекст:</span> поздние входы {aiReview.candleInsights.lateEntries}, ранние выходы{" "}
                  {aiReview.candleInsights.potentialEarlyExits}, импульс против сделки {aiReview.candleInsights.momentumAgainstExecution}.
                  {aiReview.candleInsights.notes.length ? ` ${aiReview.candleInsights.notes.join(" ")}` : ""}
                </div>
              </div>
            </div>
          ) : null}
          {!configured || showKeyEditor ? (
            <div className="mt-3 grid gap-2.5 md:grid-cols-2">
              <div className="md:col-span-2">
                <div className="overflow-hidden rounded-3xl shadow-none">
                  <Image
                    src="/auth-preview.png"
                    alt="Превью интерфейса трейдинг блокнота"
                    width={1024}
                    height={576}
                    priority
                    className="h-full w-full object-cover"
                  />
                </div>
              </div>
              <label className="space-y-1 text-sm">
                <span className={`text-sm font-semibold ${isLightTheme ? "text-slate-700" : "text-zinc-200"}`}>BingX API Key</span>
                <input
                  value={bingxApiKey}
                  onChange={(event) => setBingxApiKey(event.target.value)}
                  className="w-full bg-transparent px-0 py-2 font-mono text-xs outline-none"
                  placeholder="Опционально: BingX key"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className={`text-sm font-semibold ${isLightTheme ? "text-slate-700" : "text-zinc-200"}`}>BingX API Secret</span>
                <input
                  type="password"
                  value={bingxApiSecret}
                  onChange={(event) => setBingxApiSecret(event.target.value)}
                  className="w-full bg-transparent px-0 py-2 font-mono text-xs outline-none"
                  placeholder="Опционально: BingX secret"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className={`text-sm font-semibold ${isLightTheme ? "text-slate-700" : "text-zinc-200"}`}>Bitget API Key</span>
                <input
                  value={bitgetApiKey}
                  onChange={(event) => setBitgetApiKey(event.target.value)}
                  className="w-full bg-transparent px-0 py-2 font-mono text-xs outline-none"
                  placeholder="Опционально: Bitget key"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className={`text-sm font-semibold ${isLightTheme ? "text-slate-700" : "text-zinc-200"}`}>Bitget API Secret</span>
                <input
                  type="password"
                  value={bitgetApiSecret}
                  onChange={(event) => setBitgetApiSecret(event.target.value)}
                  className="w-full bg-transparent px-0 py-2 font-mono text-xs outline-none"
                  placeholder="Опционально: Bitget secret"
                />
              </label>
              <label className="space-y-1 text-sm md:col-span-2">
                <span className={`text-sm font-semibold ${isLightTheme ? "text-slate-700" : "text-zinc-200"}`}>Bitget Passphrase</span>
                <input
                  type="password"
                  value={bitgetPassphrase}
                  onChange={(event) => setBitgetPassphrase(event.target.value)}
                  className="w-full bg-transparent px-0 py-2 font-mono text-xs outline-none"
                  placeholder="Обязательно для Bitget"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className={`text-sm font-semibold ${isLightTheme ? "text-slate-700" : "text-zinc-200"}`}>Binance API Key</span>
                <input
                  value={binanceApiKey}
                  onChange={(event) => setBinanceApiKey(event.target.value)}
                  className="w-full bg-transparent px-0 py-2 font-mono text-xs outline-none"
                  placeholder="Опционально: Binance key"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className={`text-sm font-semibold ${isLightTheme ? "text-slate-700" : "text-zinc-200"}`}>Binance API Secret</span>
                <input
                  type="password"
                  value={binanceApiSecret}
                  onChange={(event) => setBinanceApiSecret(event.target.value)}
                  className="w-full bg-transparent px-0 py-2 font-mono text-xs outline-none"
                  placeholder="Опционально: Binance secret"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className={`text-sm font-semibold ${isLightTheme ? "text-slate-700" : "text-zinc-200"}`}>Bybit API Key</span>
                <input
                  value={bybitApiKey}
                  onChange={(event) => setBybitApiKey(event.target.value)}
                  className="w-full bg-transparent px-0 py-2 font-mono text-xs outline-none"
                  placeholder="Опционально: Bybit key"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className={`text-sm font-semibold ${isLightTheme ? "text-slate-700" : "text-zinc-200"}`}>Bybit API Secret</span>
                <input
                  type="password"
                  value={bybitApiSecret}
                  onChange={(event) => setBybitApiSecret(event.target.value)}
                  className="w-full bg-transparent px-0 py-2 font-mono text-xs outline-none"
                  placeholder="Опционально: Bybit secret"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className={`text-sm font-semibold ${isLightTheme ? "text-slate-700" : "text-zinc-200"}`}>MEXC API Key</span>
                <input
                  value={mexcApiKey}
                  onChange={(event) => setMexcApiKey(event.target.value)}
                  className="w-full bg-transparent px-0 py-2 font-mono text-xs outline-none"
                  placeholder="Опционально: MEXC key"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className={`text-sm font-semibold ${isLightTheme ? "text-slate-700" : "text-zinc-200"}`}>MEXC API Secret</span>
                <input
                  type="password"
                  value={mexcApiSecret}
                  onChange={(event) => setMexcApiSecret(event.target.value)}
                  className="w-full bg-transparent px-0 py-2 font-mono text-xs outline-none"
                  placeholder="Опционально: MEXC secret"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className={`text-sm font-semibold ${isLightTheme ? "text-slate-700" : "text-zinc-200"}`}>Gate API Key</span>
                <input
                  value={gateApiKey}
                  onChange={(event) => setGateApiKey(event.target.value)}
                  className="w-full bg-transparent px-0 py-2 font-mono text-xs outline-none"
                  placeholder="Опционально: Gate key"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className={`text-sm font-semibold ${isLightTheme ? "text-slate-700" : "text-zinc-200"}`}>Gate API Secret</span>
                <input
                  type="password"
                  value={gateApiSecret}
                  onChange={(event) => setGateApiSecret(event.target.value)}
                  className="w-full bg-transparent px-0 py-2 font-mono text-xs outline-none"
                  placeholder="Опционально: Gate secret"
                />
              </label>
              <div className="md:col-span-2">
                {ZERO_STORAGE_MODE ? (
                  <p className={`mb-2 text-xs ${mutedTextClass}`}>
                    Приватный режим: ключи не сохраняются на сервере, используются только в текущей сессии браузера.
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleConnect()}
                  className="px-0 py-1 text-sm font-medium text-cyan-400 underline underline-offset-4 hover:text-cyan-300"
                  >
                    {configured ? "Сохранить новый ключ" : "Подключить"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDisconnect()}
                    className="px-0 py-1 text-sm font-medium text-zinc-400 underline underline-offset-4 hover:text-zinc-200"
                  >
                    Очистить
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {refreshError ? (
            <p className={isLightTheme ? "mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" : "mt-3 rounded-md border border-[rgba(225,92,92,0.26)] bg-[#271B22] px-3 py-2 text-sm text-[#E15C5C]"}>
              {refreshError}
            </p>
          ) : null}
          
        </section>

        {!configured ? (
          <section className={`py-2 text-sm ${mutedTextClass}`}>
            Введите ключи API бирж, чтобы запустить общий мониторинг.
          </section>
        ) : null}

        {configured && activeView === "trading" ? (
          <section className="py-1" id="overview-section">
            <div className="mb-2 flex items-center justify-between">
              <h2 className={sectionTitleClass}>Обзор фьючерсного портфеля</h2>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <div className="flex max-w-full items-center gap-2 overflow-x-auto pb-1">
                  <button
                    type="button"
                    onClick={() => setExchangeFilter("ALL")}
                    className={`${exchangeBtnBaseClass} ${exchangeFilter === "ALL" ? exchangeBtnActiveClass : exchangeBtnInactiveClass}`}
                    title="Все биржи"
                  >
                    <span>ALL</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setExchangeFilter("BINGX")}
                    className={`${exchangeBtnBaseClass} ${exchangeFilter === "BINGX" ? exchangeBtnActiveClass : exchangeBtnInactiveClass}`}
                    title="BingX"
                  >
                    <span>BingX</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setExchangeFilter("BITGET")}
                    className={`${exchangeBtnBaseClass} ${exchangeFilter === "BITGET" ? exchangeBtnActiveClass : exchangeBtnInactiveClass}`}
                    title="Bitget"
                  >
                    <span>Bitget</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setExchangeFilter("BINANCE")}
                    className={`${exchangeBtnBaseClass} ${exchangeFilter === "BINANCE" ? exchangeBtnActiveClass : exchangeBtnInactiveClass}`}
                    title="Binance"
                  >
                    <span>Binance</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setExchangeFilter("BYBIT")}
                    className={`${exchangeBtnBaseClass} ${exchangeFilter === "BYBIT" ? exchangeBtnActiveClass : exchangeBtnInactiveClass}`}
                    title="Bybit"
                  >
                    <span>Bybit</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setExchangeFilter("MEXC")}
                    className={`${exchangeBtnBaseClass} ${exchangeFilter === "MEXC" ? exchangeBtnActiveClass : exchangeBtnInactiveClass}`}
                    title="MEXC"
                  >
                    <span>MEXC</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setExchangeFilter("GATE")}
                    className={`${exchangeBtnBaseClass} ${exchangeFilter === "GATE" ? exchangeBtnActiveClass : exchangeBtnInactiveClass}`}
                    title="Gate"
                  >
                    <span>Gate</span>
                  </button>
                </div>
                <span className={`rounded-lg border px-2 py-1 text-xs font-semibold ${dataHealth.className}`}>
                  {dataHealth.label}
                </span>
              </div>
            </div>
            <div className={cardClass}>
              <div className="grid gap-3 lg:grid-cols-12">
                <div className={`lg:col-span-8 rounded-2xl border p-3 ${isLightTheme ? "border-slate-200 bg-white" : "border-[rgba(120,190,220,0.14)] bg-[#0C1822]/85"}`}>
                  <div className="mb-2 flex items-center justify-between">
                    <p className={`text-xs uppercase tracking-[0.16em] ${mutedTextClass}`}>Баланс</p>
                  </div>
                  <div className={`rounded-xl border p-3 ${isLightTheme ? "border-slate-200 bg-slate-50/90" : "border-[rgba(120,190,220,0.14)] bg-[#09141D]/80"}`}>
                    <p className={`text-3xl font-semibold [font-variant-numeric:tabular-nums] ${isLightTheme ? "text-slate-900" : "text-[#EAF7FF]"}`}>
                      {fmtUsdValue("summary", terminalChart.latest)}
                    </p>
                    <p className={`mt-0.5 text-xs [font-variant-numeric:tabular-nums] ${terminalChart.delta >= 0 ? "text-[#38D39F]" : "text-[#E15C5C]"}`}>
                      {privacyMode
                        ? "$••••"
                        : `${terminalChart.delta >= 0 ? "+" : ""}${fmtUsd(terminalChart.delta)} (${fmtPct(terminalChart.deltaPct)}) за 24ч`}
                    </p>
                    <div className="mt-2 h-24 w-full overflow-hidden rounded-lg">
                      {terminalChart.polyline ? (
                        <svg viewBox="0 0 100 40" className="h-full w-full">
                          <defs>
                            <linearGradient id="equity-line" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#19C2B4" stopOpacity="0.95" />
                              <stop offset="100%" stopColor="#39D0FF" stopOpacity="0.85" />
                            </linearGradient>
                            <clipPath id="equity-above">
                              <rect x="0" y="0" width="100" height={terminalChart.baselineY} />
                            </clipPath>
                            <clipPath id="equity-below">
                              <rect x="0" y={terminalChart.baselineY} width="100" height={40 - terminalChart.baselineY} />
                            </clipPath>
                          </defs>
                          <path d={terminalChart.areaPath} fill="rgba(56, 211, 159, 0.22)" clipPath="url(#equity-above)" />
                          <path d={terminalChart.areaPath} fill="rgba(225, 92, 92, 0.18)" clipPath="url(#equity-below)" />
                          <line
                            x1="0"
                            y1={terminalChart.baselineY}
                            x2="100"
                            y2={terminalChart.baselineY}
                            stroke={isLightTheme ? "rgba(100,116,139,0.4)" : "rgba(120,190,220,0.28)"}
                            strokeWidth="0.5"
                            strokeDasharray="2 2"
                          />
                          <polyline
                            points={terminalChart.polyline}
                            fill="none"
                            stroke="url(#equity-line)"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : (
                        <div className={`text-xs ${mutedTextClass}`}>Недостаточно истории для графика.</div>
                      )}
                    </div>
                    <div className="mt-1 flex items-center justify-between [font-variant-numeric:tabular-nums]">
                      {terminalChart.axisTicks.map((tick, idx) => (
                        <span key={`${tick}-${idx}`} className={isLightTheme ? "text-[10px] text-slate-500" : "text-[10px] text-[#6F8A97]"}>
                          {tick}
                        </span>
                      ))}
                    </div>
                    <div className="mt-1 flex items-center justify-between [font-variant-numeric:tabular-nums]">
                      <span className={isLightTheme ? "text-[10px] text-slate-500" : "text-[10px] text-[#6F8A97]"}>{fmtUsd(terminalChart.min).replace("$", "")}</span>
                      <span className={isLightTheme ? "text-[10px] text-slate-500" : "text-[10px] text-[#6F8A97]"}>{fmtUsd(terminalChart.max).replace("$", "")}</span>
                    </div>
                  </div>
                  <div className="mt-2.5">
                    <p className={`mb-2 text-[11px] uppercase tracking-wide ${mutedTextClass}`}>Heat-strip PnL (14д)</p>
                    <HeatStrip
                      days={dailyPnlHeat}
                      formatValue={(value) =>
                        privacyMode ? "$••••" : `${value >= 0 ? "+" : ""}${fmtUsd(value).replace("$", "")}`
                      }
                    />
                  </div>
                </div>
                <div className="grid gap-2.5 sm:grid-cols-2 lg:col-span-4">
                  <div className={insetPanelClass}>
                    <p className={`text-[11px] ${isLightTheme ? "text-slate-500" : "text-[#6F8A97]"}`}>Победы / Поражения</p>
                    <p className={`mt-1 text-lg font-semibold ${isLightTheme ? "text-slate-900" : "text-[#EAF7FF]"}`}>
                      {hasTradeData ? `${tradeStats.win} / ${tradeStats.lose}` : "-"}
                    </p>
                    <p className={`mt-1 text-xs ${isLightTheme ? "text-slate-500" : "text-[#6F8A97]"}`}>
                      Суммарная прибыль:{" "}
                      <span className="text-[#38D39F]">{hasTradeData ? fmtUsdValue("summary", tradeStats.profit) : "-"}</span>
                    </p>
                    <p className={`text-xs ${isLightTheme ? "text-slate-500" : "text-[#6F8A97]"}`}>
                      Суммарный убыток:{" "}
                      <span className="text-[#E15C5C]">{hasTradeData ? fmtUsdValue("summary", -tradeStats.loss) : "-"}</span>
                    </p>
                  </div>
                  <div className={insetPanelClass}>
                    <Metric
                      label="Реализованная П/У"
                      value={fmtUsdValue("summary", tradeStats.net)}
                      positive={tradeStats.net >= 0}
                      isLightTheme={isLightTheme}
                    />
                  </div>
                  <div className={insetPanelClass}>
                    <p className={`text-[11px] ${isLightTheme ? "text-slate-500" : "text-[#6F8A97]"}`}>Средний профит / лосс</p>
                    <p className={`mt-1 text-lg font-semibold ${isLightTheme ? "text-slate-900" : "text-[#EAF7FF]"}`}>
                      {hasTradeData ? `${fmtUsdValue("summary", avgWin)} / ${fmtUsdValue("summary", -avgLoss)}` : "-"}
                    </p>
                    <p className={`mt-1 text-xs ${isLightTheme ? "text-slate-500" : "text-[#6F8A97]"}`}>
                      Винрейт:{" "}
                      <span className={tradeStats.winRate >= 50 ? "text-[#38D39F]" : "text-[#E15C5C]"}>
                        {hasTradeData ? fmtPct(tradeStats.winRate) : "-"}
                      </span>
                    </p>
                  </div>
                  <div className={insetPanelClass}>
                    <Metric
                      label="Общая П/У"
                      value={`${fmtUsdValue("summary", totalCurrentPnl)} (${fmtPct(totalCurrentPnlPct)})`}
                      positive={totalCurrentPnl >= 0}
                      isLightTheme={isLightTheme}
                    />
                  </div>
                  <div className={`${insetPanelClass} sm:col-span-2`}>
                    <p className={`text-[11px] uppercase tracking-[0.16em] ${mutedTextClass}`}>Мини-аналитика</p>
                    <div className="mt-1.5 grid gap-1.5 sm:grid-cols-3">
                      <MiniStat
                        label="Профит-фактор"
                        value={Number.isFinite(tradeStats.loss) && tradeStats.loss > 0 ? (tradeStats.profit / tradeStats.loss).toFixed(2) : "-"}
                        isLightTheme={isLightTheme}
                      />
                      <MiniStat
                        label="Матожидание"
                        value={hasTradeData ? fmtUsd((tradeStats.net || 0) / Math.max(tradeStats.closed, 1)) : "-"}
                        isLightTheme={isLightTheme}
                      />
                      <MiniStat
                        label="Сделки 24ч"
                        value={String(data?.metrics.trades24h ?? 0)}
                        isLightTheme={isLightTheme}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {configured && activeView === "trading" ? (
          <section className="py-1" id="trading-section">
            <div className="mb-2 flex items-center justify-between">
              <h2 className={sectionTitleClass}>Торговые данные</h2>
            </div>
            {!hasTradeData ? (
              <p className={`mb-2 text-xs ${mutedTextClass}`}>
                Нет данных по сделкам от API ключа (права/endpoint). Метрики сделок не рассчитаны.
              </p>
            ) : null}
            <div className={cardClass}>
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <Row label="Оборот торгов (USDT)" value={hasTradeData ? fmtUsdValue("tradingData", tradeStats.volume) : "-"} isLightTheme={isLightTheme} />
                <Row label="Маржа в сделках (USDT)" value={hasTradeData ? fmtUsdValue("tradingData", tradeStats.marginVolume) : "-"} isLightTheme={isLightTheme} />
                <Row label="Комиссии (fees) USDT" value={hasTradeData ? fmtUsdValue("tradingData", -tradeStats.feePaid) : "-"} neg isLightTheme={isLightTheme} />
                <Row label="Закрытые сделки" value={hasTradeData ? `${tradeStats.closed}` : "-"} isLightTheme={isLightTheme} />
                <Row label="Лонг / Шорт" value={hasTradeData ? `${tradeStats.longTrades} / ${tradeStats.shortTrades}` : "-"} isLightTheme={isLightTheme} />
                {liquidationTradesCount > 0 ? (
                  <Row label="Ликвидации (по данным API)" value={String(liquidationTradesCount)} neg isLightTheme={isLightTheme} />
                ) : null}
                <Row label="Винрейт" value={hasTradeData ? fmtPct(tradeStats.closed > 0 ? tradeStats.winRate : data?.metrics.winRatePercent ?? 0) : "-"} isLightTheme={isLightTheme} />
                <Row label="Прибыль (USDT)" value={hasTradeData ? fmtUsdValue("tradingData", tradeStats.profit) : "-"} pos isLightTheme={isLightTheme} />
                <Row label="Убыток (USDT)" value={hasTradeData ? fmtUsdValue("tradingData", -tradeStats.loss) : "-"} neg isLightTheme={isLightTheme} />
              </div>
            </div>
            <div className="mt-3 grid gap-3 xl:grid-cols-3">
              <div className={insetPanelClass}>
                <p className={`mb-2 text-[11px] uppercase tracking-[0.16em] ${mutedTextClass}`}>Статистика Лонг / Шорт</p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[320px] table-fixed border-collapse text-left text-sm [font-variant-numeric:tabular-nums]">
                    <colgroup>
                      <col style={{ width: "46%" }} />
                      <col style={{ width: "18%" }} />
                      <col style={{ width: "18%" }} />
                      <col style={{ width: "18%" }} />
                    </colgroup>
                    <thead className={tableHeadClass}>
                      <tr>
                        <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Направление</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Сделки</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Винрейт</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">П/У</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(["LONG", "SHORT"] as const).map((side) => {
                        const row = longShortStats[side];
                        return (
                          <tr key={side} className={tableRowClass}>
                            <td className="px-3 py-2">{side === "LONG" ? "Лонг" : "Шорт"}</td>
                            <td className="px-3 py-2 text-right">{row.trades}</td>
                            <td className="px-3 py-2 text-right">{fmtPct(row.winRate)}</td>
                            <td className={`px-3 py-2 text-right ${row.pnl >= 0 ? "text-[#38D39F]" : "text-[#E15C5C]"}`}>
                              {fmtUsdValue("tradingData", row.pnl)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className={insetPanelClass}>
                <p className={`mb-2 text-[11px] uppercase tracking-[0.16em] ${mutedTextClass}`}>Статистика по сигналам</p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[320px] table-fixed border-collapse text-left text-sm [font-variant-numeric:tabular-nums]">
                    <colgroup>
                      <col style={{ width: "46%" }} />
                      <col style={{ width: "18%" }} />
                      <col style={{ width: "18%" }} />
                      <col style={{ width: "18%" }} />
                    </colgroup>
                    <thead className={tableHeadClass}>
                      <tr>
                        <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Сигнал</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Сделки</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Винрейт</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {signalStats.map((row) => (
                        <tr key={row.signal} className={tableRowClass}>
                          <td className="px-3 py-2">{row.label}</td>
                          <td className="px-3 py-2 text-right">{row.trades}</td>
                          <td className="px-3 py-2 text-right">{fmtPct(row.winRate)}</td>
                          <td className={`px-3 py-2 text-right ${row.pnl >= 0 ? "text-[#38D39F]" : "text-[#E15C5C]"}`}>{fmtUsdValue("tradingData", row.pnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className={insetPanelClass}>
                <p className={`mb-2 text-[11px] uppercase tracking-[0.16em] ${mutedTextClass}`}>Статистика по тегам сделок</p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[320px] table-fixed border-collapse text-left text-sm [font-variant-numeric:tabular-nums]">
                    <colgroup>
                      <col style={{ width: "46%" }} />
                      <col style={{ width: "18%" }} />
                      <col style={{ width: "18%" }} />
                      <col style={{ width: "18%" }} />
                    </colgroup>
                    <thead className={tableHeadClass}>
                      <tr>
                        <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Тег</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Сделки</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Винрейт</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tagStats.map((row) => (
                        <tr key={row.tag} className={tableRowClass}>
                          <td className="px-3 py-2">{row.tag}</td>
                          <td className="px-3 py-2 text-right">{row.trades}</td>
                          <td className="px-3 py-2 text-right">{fmtPct(row.winRate)}</td>
                          <td className={`px-3 py-2 text-right ${row.pnl >= 0 ? "text-[#38D39F]" : "text-[#E15C5C]"}`}>{fmtUsdValue("tradingData", row.pnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {configured && activeView === "trading" ? <section className="py-1" id="positions-section">
          <div className="mb-2 flex items-center justify-between">
            <h2 className={sectionTitleClass}>Открытые позиции</h2>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3 2xl:grid-cols-4">
            {filteredPositions.map((item) => (
              <div
                key={`${item.symbol}:${item.side}`}
                className={`rounded-2xl border p-3 text-sm ${
                  item.pnlPercent >= 0
                    ? isLightTheme
                      ? "border-sky-200 bg-sky-50/70"
                      : "border-[rgba(56,211,159,0.22)] bg-[#10202B]/80"
                    : isLightTheme
                      ? "border-red-200 bg-red-50/70"
                      : "border-[rgba(225,92,92,0.22)] bg-[#1B1A22]/80"
                }`}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className={isLightTheme ? "text-sm font-bold text-slate-900" : "text-sm font-bold text-[#EAF7FF]"}>{item.symbol}</span>
                  <span className={isLightTheme ? "text-xs font-semibold text-slate-600" : "text-xs font-semibold text-[#A7C3D1]"}>{item.leverage}x</span>
                </div>
                <p className={`mb-1 text-[10px] uppercase tracking-wide ${mutedTextClass}`}>{item.exchange || "BINGX"}</p>
                <div className="mb-2">
                  {(() => {
                    const label = getTradeDirectionLabel(item.side, item.side);
                    const isShortOrSell = label === "SHORT" || label === "SELL";
                    return (
                      <span
                        className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ${
                          isShortOrSell ? "bg-red-700/70 text-red-100" : "bg-emerald-700/70 text-emerald-100"
                        }`}
                      >
                        {label}
                      </span>
                    );
                  })()}
                </div>
                <div className="grid grid-cols-2 gap-1 text-xs text-zinc-400">
                  <span>Вход: {fmtPrice(item.entryPrice)}</span>
                  <span>Текущая: {fmtPrice(item.markPrice)}</span>
                  <span>Маржа сделки: {fmtUsdValue("positions", item.marginUsedUsd)}</span>
                  <span className={item.unrealizedPnl >= 0 ? "text-[#38D39F]" : "text-[#E15C5C]"}>
                    PnL $: {fmtUsdValue("positions", item.unrealizedPnl)} ({fmtPct(item.pnlPercent)})
                  </span>
                </div>
              </div>
            ))}
          </div>
          {!filteredPositions.length ? (
            <p className="mt-3 text-sm text-zinc-500">Открытых позиций нет.</p>
          ) : null}
        </section> : null}


        {configured && activeView === "trading" ? (
          <section className="py-1" id="rating-section">
            <div className="mb-2 flex w-full items-center justify-between gap-2 px-1 py-1">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowTradingRating((prev) => !prev)}
                  className={isLightTheme ? "truncate text-left text-xl font-semibold text-slate-900 hover:text-slate-700" : "truncate text-left text-xl font-semibold text-[#EAF7FF] hover:text-white"}
                >
                  Торговый рейтинг
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowTradingRating((prev) => !prev)}
                className={isLightTheme ? "shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700 hover:bg-slate-100" : "shrink-0 rounded-lg border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-[#77E7FF] hover:bg-[#10202B]"}
              >
                {showTradingRating ? "Свернуть" : "Развернуть"}
              </button>
            </div>
            {showTradingRating ? (
              <>
            {!hasTradeData ? (
              <p className="mb-2 text-xs text-zinc-500">
                Рейтинг строится по закрытым сделкам. Сейчас API не вернул сделки.
              </p>
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm [font-variant-numeric:tabular-nums]">
                <thead className={tableHeadClass}>
                  <tr>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Торговая пара</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">П/У</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Закрытые сделки</th>
                  </tr>
                </thead>
                <tbody>
                  {symbolRating.map((item) => (
                    <tr key={item.symbol} className={tableRowClass}>
                      <td className="px-3 py-2">{item.symbol}</td>
                      <td className={`px-3 py-2 ${item.pnl >= 0 ? "text-[#38D39F]" : "text-[#E15C5C]"}`}>
                        {fmtUsdValue("rating", item.pnl)}
                      </td>
                      <td className="px-3 py-2">{item.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {hasTradeData && symbolRating.length === 0 ? (
              <p className="mt-2 text-xs text-zinc-500">Нет закрытых сделок за период.</p>
            ) : null}
              </>
            ) : (
              <p className={isLightTheme ? "text-xs font-semibold text-slate-700" : "text-xs font-semibold text-[#77E7FF]"}>Нажмите «Развернуть», чтобы показать блок.</p>
            )}
          </section>
        ) : null}

        {configured && activeView === "trading" ? (
          <section className="py-1" id="history-section">
            <div className="mb-2 flex w-full items-center justify-between gap-2 px-1 py-1">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowTradesHistory((prev) => !prev)}
                  className={isLightTheme ? "truncate text-left text-xl font-semibold text-slate-900 hover:text-slate-700" : "truncate text-left text-xl font-semibold text-[#EAF7FF] hover:text-white"}
                >
                  История сделок
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowTradesHistory((prev) => !prev)}
                className={isLightTheme ? "shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700 hover:bg-slate-100" : "shrink-0 rounded-lg border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-[#77E7FF] hover:bg-[#10202B]"}
              >
                {showTradesHistory ? "Свернуть" : "Развернуть"}
              </button>
            </div>
            {showTradesHistory ? (
              <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <select
                value={tagFilter}
                onChange={(event) => setTagFilter(event.target.value as TagFilter)}
                className={isLightTheme ? "rounded-xl border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none" : "rounded-xl border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-2 py-1 text-xs text-[#A7C3D1] outline-none"}
              >
                <option value="ALL">Все теги</option>
                <option value="setup">setup</option>
                <option value="error">error</option>
                <option value="emotion">emotion</option>
              </select>
              <select
                value={reportPeriod}
                onChange={(event) => setReportPeriod(event.target.value as ReportPeriod)}
                className={isLightTheme ? "rounded-xl border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none" : "rounded-xl border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-2 py-1 text-xs text-[#A7C3D1] outline-none"}
              >
                <option value="day">Отчёт за день</option>
                <option value="week">Отчёт за неделю</option>
                <option value="month">Отчёт за месяц</option>
              </select>
              <button type="button" className={controlClass} onClick={exportCsvReport}>CSV</button>
              <button type="button" className={controlClass} onClick={exportPdfReport}>PDF</button>
              <input
                value={telegramBotToken}
                onChange={(event) => setTelegramBotToken(event.target.value)}
                className={isLightTheme ? "min-w-[180px] rounded-xl border border-slate-200 bg-white px-2 py-1 text-xs outline-none" : "min-w-[180px] rounded-xl border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-2 py-1 text-xs text-[#A7C3D1] outline-none"}
                placeholder="Telegram bot token (optional)"
              />
              <input
                value={telegramChatId}
                onChange={(event) => setTelegramChatId(event.target.value)}
                className={isLightTheme ? "min-w-[140px] rounded-xl border border-slate-200 bg-white px-2 py-1 text-xs outline-none" : "min-w-[140px] rounded-xl border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-2 py-1 text-xs text-[#A7C3D1] outline-none"}
                placeholder="Chat ID"
              />
              <button type="button" disabled={sendingTelegramReport} className={controlClass} onClick={() => void sendTelegramReport()}>
                {sendingTelegramReport ? "Отправка..." : "В Telegram"}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] text-left text-sm [font-variant-numeric:tabular-nums]">
                <thead className={tableHeadClass}>
                  <tr>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Время</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Биржа</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Инструмент</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Сторона</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Плечо</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Маржа</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">PnL</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">PnL %</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Сигнал</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Теги</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">AI</th>
                    {liquidationTradesCount > 0 ? (
                      <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide">Ликвидация</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {filteredHistoryTrades.map((trade) => {
                      const tradeKey = buildTradeKey(trade);
                      const selectedSignal = data?.tradeSignals?.[tradeKey] ?? signalOptions[0]?.value ?? "SECRET";
                      const tags = tradeTags[tradeKey] ?? { setup: false, error: false, emotion: false };
                      return (
                    <tr key={`${trade.symbol}:${trade.time}:${trade.qty}:${trade.positionSide}`} className={tableRowClass}>
                      <td className="px-3 py-2">{new Date(trade.time).toLocaleString()}</td>
                      <td className="px-3 py-2">{trade.exchange || "BINGX"}</td>
                      <td className="px-3 py-2">{trade.symbol}</td>
                      <td className="px-3 py-2">
                        {(() => {
                          const label = getTradeDirectionLabel(trade.side, trade.positionSide);
                          const isShortOrSell = label === "SHORT" || label === "SELL";
                          return (
                            <span
                              className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ${
                                isShortOrSell
                                  ? "bg-red-700/70 text-red-100"
                                  : "bg-emerald-700/70 text-emerald-100"
                              }`}
                            >
                              {label}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2">{trade.leverage}x</td>
                      <td className="px-3 py-2">{fmtUsdValue("history", trade.marginUsed)}</td>
                      <td className={`px-3 py-2 ${trade.realizedPnl >= 0 ? "text-[#38D39F]" : "text-[#E15C5C]"}`}>
                        {fmtUsdValue("history", trade.realizedPnl)}
                      </td>
                      <td className={`px-3 py-2 ${trade.realizedPnl >= 0 ? "text-[#38D39F]" : "text-[#E15C5C]"}`}>
                        {fmtPct(trade.pnlPercent)}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={selectedSignal}
                          onChange={(event) => void setTradeSignal(tradeKey, event.target.value as TradeSignal)}
                          disabled={savingTradeSignalKey === tradeKey}
                          className={isLightTheme ? "rounded-xl border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none" : "rounded-xl border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-2 py-1 text-xs text-[#A7C3D1] outline-none"}
                        >
                          {signalOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {(["setup", "error", "emotion"] as TradeTag[]).map((tag) => (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => toggleTradeTag(tradeKey, tag)}
                              className={tags[tag]
                                ? "rounded-md bg-sky-600 px-2 py-0.5 text-[10px] font-semibold text-white"
                                : isLightTheme
                                  ? "rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] text-slate-600"
                                  : "rounded-md border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-2 py-0.5 text-[10px] text-[#A7C3D1]"}
                            >
                              {tag}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className={controlClass}
                          disabled={loadingSingleTradeReviewKey === tradeKey}
                          onClick={() => void requestSingleTradeAiReview(trade)}
                        >
                          {loadingSingleTradeReviewKey === tradeKey ? "..." : "Разобрать"}
                        </button>
                      </td>
                      {liquidationTradesCount > 0 ? (
                        <td className={`px-3 py-2 ${trade.isLiquidation ? "text-red-400" : "text-zinc-500"}`}>
                          {trade.isLiquidation ? `ДА${trade.liquidationReason ? ` (${trade.liquidationReason})` : "-"}` : "-"}
                        </td>
                      ) : null}
                    </tr>
                  );
                  })}
                </tbody>
              </table>
            </div>
            {!filteredHistoryTrades.length ? (
              <p className="mt-3 text-sm text-zinc-500">Сделки с realized PnL пока не получены из API.</p>
            ) : null}
              </>
            ) : (
              <p className={isLightTheme ? "text-xs font-semibold text-slate-700" : "text-xs font-semibold text-[#77E7FF]"}>Нажмите «Развернуть», чтобы показать блок.</p>
            )}
          </section>
        ) : null}

        {loading ? <LoadingOverlay /> : null}
        </div>
        </div>
      </div>
    </main>
  );
}

function Row({
  label,
  value,
  pos = false,
  neg = false,
  isLightTheme = false,
}: {
  label: string;
  value: string;
  pos?: boolean;
  neg?: boolean;
  isLightTheme?: boolean;
}) {
  const labelClass = isLightTheme ? "text-slate-600" : "text-[#7C96A3]";
  const valueClass = pos ? "text-[#38D39F]" : neg ? "text-[#E15C5C]" : isLightTheme ? "text-slate-900" : "text-[#EAF7FF]";
  return (
    <div className="flex items-center justify-between px-1 py-1.5">
      <span className={labelClass}>{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

function Metric({
  label,
  value,
  positive,
  accent = false,
  isLightTheme = false,
}: {
  label: string;
  value: string;
  positive?: boolean;
  accent?: boolean;
  isLightTheme?: boolean;
}) {
  const colorClass = accent
    ? "text-[#39D0FF]"
    : positive == null
      ? isLightTheme
        ? "text-slate-900"
        : "text-[#EAF7FF]"
      : positive
        ? "text-[#38D39F]"
        : "text-[#E15C5C]";
  return (
    <div className="px-1 py-1">
      <p className={`text-[11px] ${isLightTheme ? "text-slate-500" : "text-[#6F8A97]"}`}>{label}</p>
      <p className={`mt-1 text-lg font-semibold ${colorClass}`}>{value}</p>
    </div>
  );
}

function HeatStrip({
  days,
  formatValue,
}: {
  days: { dayKey: string; pnl: number; intensity: number }[];
  formatValue: (value: number) => string;
}) {
  return (
    <div className="grid w-full grid-cols-4 gap-1.5 sm:gap-2 lg:grid-cols-7 xl:grid-cols-14">
      {days.map((day) => {
        const alpha = day.pnl === 0 ? 0.2 : 0.2 + day.intensity * 0.45;
        const backgroundColor =
          day.pnl > 0
            ? `rgba(56, 211, 159, ${alpha.toFixed(3)})`
            : day.pnl < 0
              ? `rgba(225, 92, 92, ${alpha.toFixed(3)})`
              : "rgba(16, 32, 43, 0.9)";
        const borderColor =
          day.pnl > 0 ? "rgba(56, 211, 159, 0.35)" : day.pnl < 0 ? "rgba(225, 92, 92, 0.35)" : "rgba(120, 190, 220, 0.14)";
        const title = `${day.dayKey}: ${formatValue(day.pnl)}`;
        return (
          <div
            key={day.dayKey}
            title={title}
            className="flex h-12 min-w-0 items-center justify-center rounded-xl border px-1 text-center text-[10px] font-semibold text-[#EAF7FF] sm:h-14 sm:text-[11px]"
            style={{ backgroundColor, borderColor }}
          >
            <span className="truncate">{formatValue(day.pnl)}</span>
          </div>
        );
      })}
    </div>
  );
}

function LoadingOverlay() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#050A10]/70 px-4 backdrop-blur-sm">
      <div className="w-full max-w-[640px] overflow-hidden rounded-2xl border border-[rgba(120,190,220,0.16)]">
        <Image
          src="/loading-preview.png"
          alt="Обновление данных"
          width={1024}
          height={576}
          className="h-auto w-full object-cover"
          priority
        />
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  isLightTheme,
}: {
  label: string;
  value: string;
  isLightTheme: boolean;
}) {
  return (
    <div className={`rounded-lg border px-2 py-1.5 ${isLightTheme ? "border-slate-200 bg-white" : "border-[rgba(120,190,220,0.14)] bg-[#09141D]/80"}`}>
      <p className={isLightTheme ? "text-[10px] uppercase tracking-[0.12em] text-slate-500" : "text-[10px] uppercase tracking-[0.12em] text-[#6F8A97]"}>
        {label}
      </p>
      <p className={isLightTheme ? "mt-1 text-sm font-semibold text-slate-900 [font-variant-numeric:tabular-nums]" : "mt-1 text-sm font-semibold text-[#EAF7FF] [font-variant-numeric:tabular-nums]"}>
        {value}
      </p>
    </div>
  );
}

function MaterialIcon({
  name,
  className = "h-5 w-5",
}: {
  name:
    | "dashboard"
    | "trending"
    | "work"
    | "history"
    | "settings"
    | "person"
    | "key"
    | "logout"
    | "hub"
    | "light"
    | "dark";
  className?: string;
}) {
  const pathMap: Record<string, string> = {
    dashboard: "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z",
    trending: "M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6.58-6.59 4 4L19.71 9.7 22 12V6z",
    work: "M10 4H4v16h16V4h-6V2h-4v2zm0 2V4h4v2h-4z",
    history: "M13 3a9 9 0 1 0 8.95 10h-2.02A7 7 0 1 1 13 5c1.93 0 3.68.78 4.95 2.05L15 10h7V3l-2.69 2.69A8.96 8.96 0 0 0 13 3zm-1 5v6l5.25 3.15.75-1.23-4.5-2.67V8H12z",
    settings: "M19.14,12.94a7.43,7.43,0,0,0,.05-.94,7.43,7.43,0,0,0-.05-.94l2.11-1.65a.5.5,0,0,0,.12-.64l-2-3.46a.5.5,0,0,0-.6-.22l-2.49,1a7.25,7.25,0,0,0-1.63-.94l-.38-2.65A.5.5,0,0,0,13.78,2H10.22a.5.5,0,0,0-.49.42L9.35,5.07a7.25,7.25,0,0,0-1.63.94l-2.49-1a.5.5,0,0,0-.6.22l-2,3.46a.5.5,0,0,0,.12.64L4.86,11.06a7.43,7.43,0,0,0-.05.94,7.43,7.43,0,0,0,.05.94L2.75,14.59a.5.5,0,0,0-.12.64l2,3.46a.5.5,0,0,0,.6.22l2.49-1a7.25,7.25,0,0,0,1.63.94l.38,2.65a.5.5,0,0,0,.49.42h3.56a.5.5,0,0,0,.49-.42l.38-2.65a7.25,7.25,0,0,0,1.63-.94l2.49,1a.5.5,0,0,0,.6-.22l2-3.46a.5.5,0,0,0-.12-.64ZM12,15.5A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Z",
    person: "M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8V22h19.2v-2.8c0-3.2-6.4-4.8-9.6-4.8z",
    key: "M7 14a5 5 0 1 1 4.9-6H22v4h-2v2h-2v2h-2v2h-4.1A5 5 0 0 1 7 14zm0-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    logout: "M16 13v-2H7V8l-5 4 5 4v-3zM20 3H10v2h10v14H10v2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z",
    hub: "M12 2a2 2 0 1 0 .001 3.999A2 2 0 0 0 12 2zm0 16a2 2 0 1 0 .001 3.999A2 2 0 0 0 12 18zM4 10a2 2 0 1 0 .001 3.999A2 2 0 0 0 4 10zm16 0a2 2 0 1 0 .001 3.999A2 2 0 0 0 20 10zM6 12h4v2H6zm8 0h4v2h-4zm-3 2h2v4h-2zm0-8h2v4h-2z",
    light: "M6.76 4.84 5.34 3.42 3.93 4.83l1.41 1.41 1.42-1.4zM1 13h3v-2H1v2zm10 9h2v-3h-2v3zm8.07-17.17-1.41-1.41-1.42 1.42 1.41 1.41 1.42-1.42zM17.24 19.16l1.41 1.41 1.42-1.41-1.42-1.41-1.41 1.41zM20 11v2h3v-2h-3zM12 6a6 6 0 1 0 .001 12.001A6 6 0 0 0 12 6zm-1-5h2v3h-2V1zM4.22 17.66l1.42 1.41 1.41-1.41-1.41-1.42-1.42 1.42z",
    dark: "M9.37 5.51A7 7 0 0 0 18.49 14.63 7 7 0 1 1 9.37 5.51z",
  };
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d={pathMap[name]} />
    </svg>
  );
}


