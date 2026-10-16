import type { Candle, Level, Quote, Trade, Venue } from "./types";

export function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
export function positive(value: unknown): number | undefined {
  const n = finite(value);
  return n !== undefined && n > 0 ? n : undefined;
}
export function normalizeQuote(
  venue: Venue,
  d: Record<string, any>,
  received = Date.now(),
): Quote | undefined {
  if (venue === "binance") {
    const price = positive(d.c);
    if (!price || typeof d.s !== "string" || !d.s.endsWith("USDT")) return;
    return {
      venue,
      base: d.s.slice(0, -4),
      price,
      bid: positive(d.b),
      ask: positive(d.a),
      change: finite(d.P),
      high: positive(d.h),
      low: positive(d.l),
      volume: finite(d.v),
      received,
      eventTime: finite(d.E),
    };
  }
  if (venue === "coinbase") {
    const price = positive(d.price);
    if (!price || typeof d.product_id !== "string") return;
    const open = positive(d.open_24h);
    return {
      venue,
      base: d.product_id.replace(/-USD$/, ""),
      price,
      bid: positive(d.best_bid),
      ask: positive(d.best_ask),
      change: open ? (price / open - 1) * 100 : undefined,
      high: positive(d.high_24h),
      low: positive(d.low_24h),
      volume: finite(d.volume_24h),
      received,
      eventTime: d.time ? Date.parse(d.time) : undefined,
    };
  }
  const price = positive(d.last);
  if (!price || typeof d.symbol !== "string") return;
  return {
    venue,
    base: d.symbol.replace(/\/USD$/, ""),
    price,
    bid: positive(d.bid),
    ask: positive(d.ask),
    change: finite(d.change_pct),
    high: positive(d.high),
    low: positive(d.low),
    volume: finite(d.volume),
    received,
    eventTime: d.timestamp ? Date.parse(d.timestamp) : undefined,
  };
}
export function normalizeTrade(
  venue: Venue,
  d: Record<string, any>,
): Trade | undefined {
  const price = positive(venue === "binance" ? d.p : d.price),
    size = positive(
      venue === "binance" ? d.q : venue === "coinbase" ? d.size : d.qty,
    );
  const time =
    venue === "binance"
      ? Number(d.T)
      : Date.parse(venue === "coinbase" ? d.time : d.timestamp);
  if (!price || !size || !Number.isFinite(time)) return;
  // Coinbase match.side is the maker's side; our tape consistently shows taker side.
  const side =
    venue === "binance"
      ? d.m
        ? "sell"
        : "buy"
      : venue === "coinbase"
        ? d.side === "buy"
          ? "sell"
          : "buy"
        : d.side;
  if (side !== "buy" && side !== "sell") return;
  const id = d.trade_id ?? d.t;
  if (id === undefined) return;
  return { venue, price, size, time, side, id: `${venue}:${id}` };
}
export function cleanCandles(rows: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of rows)
    if (
      [c.time, c.open, c.high, c.low, c.close, c.volume].every(
        Number.isFinite,
      ) &&
      c.time > 0 &&
      c.open > 0 &&
      c.low > 0 &&
      c.high >= Math.max(c.open, c.close, c.low) &&
      c.low <= Math.min(c.open, c.close) &&
      c.volume >= 0
    )
      map.set(c.time, c);
  return [...map.values()].sort((a, b) => a.time - b.time).slice(-1000);
}
export function upsertCandle(rows: Candle[], bar: Candle): Candle[] {
  return cleanCandles([...rows, bar]);
}
export function tradeCandle(
  rows: Candle[],
  trade: Trade,
  seconds: number,
): Candle[] {
  const time = Math.floor(trade.time / 1000 / seconds) * seconds;
  const prev = rows.find((c) => c.time === time);
  // Coinbase current bars contain only observed trades. Closed bars reconcile against REST.
  const c: Candle = prev
    ? {
        ...prev,
        high: Math.max(prev.high, trade.price),
        low: Math.min(prev.low, trade.price),
        close: trade.price,
        volume: prev.volume + trade.size,
        partial: true,
      }
    : {
        time,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.size,
        partial: true,
      };
  return upsertCandle(rows, c);
}
export function levels(rows: unknown[][]): Level[] {
  return rows
    .map(([p, q]) => ({
      price: Number(p),
      size: Number(q),
      rawPrice: String(p),
      rawSize: String(q),
    }))
    .filter(
      (l) =>
        l.price > 0 &&
        l.size > 0 &&
        Number.isFinite(l.price) &&
        Number.isFinite(l.size),
    );
}

// Tokenize JSON string/number tokens so Kraken's exact decimal spelling survives parsing.
// JSON.parse's standard number conversion would lose trailing zeros used by its CRC32.
export function parseDecimalJSON(text: string): any {
  return JSON.parse(
    text.replace(
      /("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (token, quoted, number) => quoted ?? JSON.stringify(number),
    ),
  );
}
export function expandDecimal(raw: string): string {
  if (!/[eE]/.test(raw)) return raw;
  const [coefficient, exp] = raw.toLowerCase().split("e");
  const [whole, frac = ""] = coefficient.split(".");
  const digits = whole + frac,
    point = whole.length + Number(exp);
  return point <= 0
    ? "0." + "0".repeat(-point) + digits
    : point >= digits.length
      ? digits + "0".repeat(point - digits.length)
      : digits.slice(0, point) + "." + digits.slice(point);
}
export function decimalKey(raw: string): string {
  return expandDecimal(raw)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}
export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i);
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function krakenChecksum(bids: Level[], asks: Level[]): number {
  const values = [
    ...asks
      .slice()
      .sort((a, b) => a.price - b.price)
      .slice(0, 10),
    ...bids
      .slice()
      .sort((a, b) => b.price - a.price)
      .slice(0, 10),
  ];
  return crc32(
    values
      .map((l) =>
        [l.rawPrice, l.rawSize]
          .map((x) => expandDecimal(x).replace(".", "").replace(/^0+/, ""))
          .join(""),
      )
      .join(""),
  );
}
export function updateBook(
  map: Map<string, Level>,
  rows: Record<string, any>[],
): void {
  for (const row of rows) {
    const rawPrice = String(row.price),
      rawSize = String(row.qty),
      key = decimalKey(rawPrice);
    const size = Number(rawSize),
      price = Number(rawPrice);
    if (
      !Number.isFinite(size) ||
      !Number.isFinite(price) ||
      price <= 0 ||
      size < 0
    )
      continue;
    if (size === 0) map.delete(key);
    else map.set(key, { price, size, rawPrice, rawSize });
  }
}
