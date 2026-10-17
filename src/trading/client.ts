import { useCallback, useEffect, useState } from "react";
import RUNTIME from "../../shared/public-runtime.json";

export interface Strategy {
  thesis: string;
  entryConditions: string;
  holdConditions: string;
  exitConditions: string;
  invalidation: string;
  memory: string;
  entryReadiness: number;
  exitUrgency: number;
  revision: number;
  updatedAt: number;
  marketAsOf: number;
  decisionId: string;
}
export interface Position {
  base: string;
  quantity: string;
  invested: string;
  averageEntry: string;
  entryFees: string;
  entryAt: number | null;
  lastEntryAt: number | null;
  mark: string | null;
  value: string | null;
  unrealized: string | null;
  unrealizedPercent: string | null;
  estimatedExitValue: string | null;
  estimatedNetPnl: string | null;
  received: number | null;
  stale: boolean;
}
export interface PaperOrder {
  id: string;
  base: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: string;
  remaining: string;
  limit: string | null;
  status: string;
  created: number;
  filled: string;
  total: string;
  fee: string;
  reason?: string;
  execution?: string;
  closed?: number;
}
export interface PaperFill {
  id: string;
  orderId: string;
  base: string;
  side: string;
  quantity: string;
  price: string;
  fee: string;
  time: number;
}
export interface JournalEntry {
  strategy?: Strategy;
  id: string;
  time: number;
  action?: string;
  rationale?: string;
  result: string;
  status?: string;
  asOf?: number;
  evidence?: {
    bid: string;
    ask: string;
    closedCandles: number;
    available: string;
  };
  inputTokens?: number;
  outputTokens?: number;
}
export interface TradingAccount {
  strategy?: Strategy;
  positions?: Position[];
  totalFees: string;
  fillCount: number;
  id: string;
  kind: "manual" | "ai";
  name: string;
  base: string;
  initial: string;
  cash: string;
  available: string;
  reserved: string;
  equity: string | null;
  reservedAssets: Record<string, string>;
  holdings: Record<
    string,
    { quantity: string; cost: string; realized: string }
  >;
  orders: PaperOrder[];
  fills: PaperFill[];
  journal: JournalEntry[];
  enabled: boolean;
  status: string;
  provider: string;
  model: string;
  maxOrderPercent: number;
  lossLimitPercent: number;
  calls: number;
  callDay: string;
  nextEvaluation: number;
  lastEvaluation?: number;
  inputTokens: number;
  outputTokens: number;
}
export interface TradingSnapshot {
  canWrite: boolean;
  serverTime: number;
  storage: string;
  storageError: string | null;
  rateLimits?: {
    nvidia: { usedLastMinute: number; queued: number; cooldownUntil: number };
  };
  symbols: string[];
  providers: { id: string; label: string; configured: boolean }[];
  accounts: TradingAccount[];
  markets: Record<
    string,
    {
      bid: string;
      ask: string;
      received: number;
      error: string | null;
      rules: { step: string; tick: string; minNotional: string };
    }
  >;
}
// A separate hosted worker can be attached without changing page components.
const API = (import.meta.env.VITE_TRADING_API_URL || "").replace(/\/$/, "");
let discovery: { url: string; until: number } | null = null;
async function tradingBase() {
  if (
    API ||
    import.meta.env.DEV ||
    ["localhost", "127.0.0.1"].includes(location.hostname)
  )
    return API;
  if (discovery && discovery.until > Date.now()) return discovery.url;
  const response = await fetch(RUNTIME.discoveryUrl, {
    headers: { apikey: RUNTIME.publishableKey },
    signal: AbortSignal.timeout(10000),
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error("The laptop connection could not be discovered.");
  const data = await response.json();
  if (
    !data ||
    typeof data.url !== "string" ||
    !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(data.url)
  )
    throw new Error("The laptop trading backend is offline.");
  discovery = { url: data.url, until: Date.now() + 10000 };
  return discovery.url;
}
let ownerToken = "";
export const setOwnerToken = (token: string) => {
  ownerToken = token;
};
export async function tradingRequest<T>(
  path = "",
  input?: unknown,
): Promise<T> {
  const base = await tradingBase();
  const response = await fetch(`${base}/api/trading${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      ...(input === undefined ? {} : { "Content-Type": "application/json" }),
      ...(ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {}),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: AbortSignal.timeout(20000),
  }).catch((error) => {
    discovery = null;
    throw error;
  });
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json"))
    throw new Error("Trading backend is not connected.");
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `Trading service HTTP ${response.status}`);
  return data as T;
}
export function useTrading(base: string) {
  const [data, setData] = useState<TradingSnapshot | null>(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false,
      busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await tradingRequest<TradingSnapshot>(
          `?base=${encodeURIComponent(base)}`,
        );
        if (!disposed) {
          setData(next);
          setError("");
        }
      } catch (e) {
        if (!disposed)
          setError(
            e instanceof Error ? e.message : "Trading backend is unavailable.",
          );
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [base, refresh]);
  return {
    data,
    error,
    reload: useCallback(() => setRefresh((v) => v + 1), []),
  };
}
