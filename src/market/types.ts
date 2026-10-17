export type Venue = "binance" | "coinbase" | "kraken";
export const VENUES: Venue[] = ["binance", "coinbase", "kraken"];
export const ASSETS = [
  { base: "BTC", name: "Bitcoin", color: "#f5a544", glyph: "₿" },
  { base: "ETH", name: "Ethereum", color: "#8c9cf1", glyph: "Ξ" },
  { base: "SOL", name: "Solana", color: "#9ac9b8", glyph: "◎" },
  { base: "XRP", name: "XRP", color: "#b6c7d6", glyph: "×" },
  { base: "DOGE", name: "Dogecoin", color: "#d6be70", glyph: "Ð" },
  { base: "ADA", name: "Cardano", color: "#73a5ed", glyph: "₳" },
  { base: "AVAX", name: "Avalanche", color: "#e3787e", glyph: "▲" },
  { base: "LINK", name: "Chainlink", color: "#83a6ed", glyph: "⬡" },
  { base: "DOT", name: "Polkadot", color: "#dd85b8", glyph: "●" },
  { base: "LTC", name: "Litecoin", color: "#a9c5d7", glyph: "Ł" },
  { base: "BCH", name: "Bitcoin Cash", color: "#8dc5a0", glyph: "Ƀ" },
  { base: "UNI", name: "Uniswap", color: "#e191b8", glyph: "U" },
  { base: "XMR", name: "Monero", color: "#ed8b42", glyph: "ɱ" },
  { base: "ABT", name: "Arcblock", color: "#78a3d9", glyph: "A" },
] as const;
export const PRIMARY_VENUE: Venue = "binance";
// Curated coverage exceptions, checked against the public spot instrument catalogs.
// A failed connection never changes the market's exchange or quote currency.
const COVERAGE_ROUTES: Record<string, { venue: Venue; reason: string }> = {
  XMR: {
    venue: "kraken",
    reason: "Monero spot coverage is unavailable on Binance.",
  },
  ABT: {
    venue: "coinbase",
    reason: "Arcblock spot coverage is unavailable on Binance and Kraken.",
  },
};
export const sourceFor = (base: string): Venue =>
  COVERAGE_ROUTES[base]?.venue ?? PRIMARY_VENUE;
export const sourceReason = (base: string): string =>
  COVERAGE_ROUTES[base]?.reason ?? "Primary spot market quoted in USDT.";
export const assetsForVenue = (venue: Venue) =>
  ASSETS.filter((a) => sourceFor(a.base) === venue);
export const INTERVALS = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
  { label: "1D", seconds: 86400 },
];
export const VENUE_META = {
  binance: {
    name: "Binance",
    quote: "USDT",
    color: "#e9bd50",
    url: "https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md",
    transport: "Market-data-only WebSocket",
    channels:
      "24h statistics · real-time best quotes · trades · native candles · top-20 depth",
  },
  coinbase: {
    name: "Coinbase",
    quote: "USD",
    color: "#789cf9",
    url: "https://docs.cdp.coinbase.com/exchange/websocket-feed/channels",
    transport: "Exchange public WebSocket",
    channels: "Ticker · matches · heartbeat · Level 2 batch",
  },
  kraken: {
    name: "Kraken",
    quote: "USD",
    color: "#b69af5",
    url: "https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker",
    transport: "Spot WebSocket v2",
    channels:
      "Ticker · trades · native OHLC · 100-level book with top-10 CRC32",
  },
} as const;
export const pair = (v: Venue, b: string) =>
  v === "binance" ? `${b}USDT` : v === "coinbase" ? `${b}-USD` : `${b}/USD`;
export const quoteKey = (v: Venue, b: string) => `${v}:${b}`;
export interface Quote {
  venue: Venue;
  base: string;
  price: number;
  bid?: number;
  ask?: number;
  change?: number;
  high?: number;
  low?: number;
  volume?: number;
  received: number;
  eventTime?: number;
  bookReceived?: number;
}
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  partial?: boolean;
}
export interface Trade {
  id: string;
  time: number;
  price: number;
  size: number;
  side: "buy" | "sell";
  venue: Venue;
}
export interface Level {
  price: number;
  size: number;
  rawPrice: string;
  rawSize: string;
}
export interface Book {
  bids: Level[];
  asks: Level[];
  received: number;
  verified: boolean;
  method: string;
}
export type Phase = "connecting" | "live" | "reconnecting" | "error" | "paused";
export interface FeedHealth {
  phase: Phase;
  messages: number;
  marketUpdates: number;
  lastMessage: number;
  reconnects: number;
  error?: string;
  connectedAt?: number;
}
export interface Log {
  time: number;
  venue: Venue;
  message: string;
  kind: "info" | "warning";
}
export interface MarketState {
  quotes: Record<string, Quote>;
  health: Record<Venue, FeedHealth>;
  candles: Candle[];
  trades: Trade[];
  book: Book;
  selected: { venue: Venue; base: string; interval: number };
  history: "loading" | "ready" | "error";
  historyError?: string;
  detail: Phase;
  detailError?: string;
  paused: boolean;
  logs: Log[];
  gaps: number;
}
export function emptyBook(): Book {
  return { bids: [], asks: [], received: 0, verified: false, method: "" };
}
