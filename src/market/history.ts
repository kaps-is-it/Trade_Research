import type { Candle, Venue } from "./types";
import { cleanCandles } from "./normalize";
import { pair } from "./types";

export async function fetchHistory(
  venue: Venue,
  base: string,
  seconds: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  let url: string;
  if (venue === "binance")
    url = `https://data-api.binance.vision/api/v3/klines?symbol=${pair(venue, base)}&interval=${seconds === 86400 ? "1d" : seconds === 3600 ? "1h" : `${seconds / 60}m`}&limit=300`;
  else if (venue === "coinbase")
    url = `https://api.exchange.coinbase.com/products/${pair(venue, base)}/candles?granularity=${seconds}`;
  else
    url = `https://api.kraken.com/0/public/OHLC?pair=${base === "BTC" ? "XBT" : base === "DOGE" ? "XDG" : base}USD&interval=${seconds / 60}`;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 15000);
  const abort = () => timeout.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { signal: timeout.signal });
    if (!response.ok)
      throw new Error(
        `History HTTP ${response.status}${response.status === 429 ? " — rate limited; retry shortly" : ""}`,
      );
    const data = await response.json();
    let rows: Candle[];
    if (venue === "binance") {
      if (!Array.isArray(data))
        throw new Error(data.msg || "Invalid Binance history");
      rows = data.map((r: any[]) => ({
        time: Number(r[0]) / 1000,
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      }));
    } else if (venue === "coinbase") {
      if (!Array.isArray(data))
        throw new Error(data.message || "Invalid Coinbase history");
      const current = Math.floor(Date.now() / 1000 / seconds) * seconds;
      rows = data
        .filter((r: any[]) => Number(r[0]) < current)
        .map((r: any[]) => ({
          time: Number(r[0]),
          low: Number(r[1]),
          high: Number(r[2]),
          open: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
        }));
    } else {
      if (data.error?.length) throw new Error(data.error.join("; "));
      const values = Object.entries(data.result ?? {}).find(
        ([k, v]) => k !== "last" && Array.isArray(v),
      )?.[1];
      if (!Array.isArray(values)) throw new Error("Invalid Kraken history");
      rows = values
        .slice(-300)
        .map((r: any[]) => ({
          time: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[6]),
        }));
    }
    const result = cleanCandles(rows);
    if (!result.length) throw new Error("No candles returned for this market");
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
