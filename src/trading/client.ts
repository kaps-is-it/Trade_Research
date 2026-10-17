import { useCallback, useEffect, useState } from "react";

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
  maxCalls: number;
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
let ownerToken = "";
export const setOwnerToken = (token: string) => {
  ownerToken = token;
};
export async function tradingRequest<T>(
  path = "",
  input?: unknown,
): Promise<T> {
  const response = await fetch(`${API}/api/trading${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      ...(input === undefined ? {} : { "Content-Type": "application/json" }),
      ...(ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {}),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: AbortSignal.timeout(20000),
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
    const timer = setInterval(() => void load(), 2000);
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
