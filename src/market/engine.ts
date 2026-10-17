import {
  ASSETS,
  INTERVALS,
  VENUES,
  assetsForVenue,
  sourceFor,
  pair,
  quoteKey,
  emptyBook,
} from "./types";
import type {
  Book,
  Candle,
  FeedHealth,
  Level,
  MarketState,
  Phase,
  Quote,
  Trade,
  Venue,
} from "./types";
import {
  cleanCandles,
  krakenChecksum,
  levels,
  normalizeQuote,
  normalizeTrade,
  parseDecimalJSON,
  tradeCandle,
  updateBook,
  upsertCandle,
} from "./normalize";
import { fetchHistory } from "./history";

type Connection = { socket?: WebSocket; stop: () => void };
const health = (): FeedHealth => ({
  phase: "connecting",
  messages: 0,
  marketUpdates: 0,
  lastMessage: 0,
  reconnects: 0,
});
export class MarketEngine {
  private state: MarketState = {
    quotes: {},
    health: { binance: health(), coinbase: health(), kraken: health() },
    candles: [],
    trades: [],
    book: emptyBook(),
    selected: { venue: sourceFor("BTC"), base: "BTC", interval: 60 },
    history: "loading",
    detail: "connecting",
    paused: false,
    logs: [],
    gaps: 0,
  };
  private snapshot = this.state;
  private listeners = new Set<() => void>();
  private dirty = true;
  private connections = new Map<Venue, Connection>();
  private focused?: Connection;
  private flush?: ReturnType<typeof setInterval>;
  private reconcile?: ReturnType<typeof setInterval>;
  private abort?: AbortController;
  private generation = 0;
  private historyRunning = false;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snapshot;
  private mark() {
    this.dirty = true;
  }
  private emit() {
    if (!this.dirty) return;
    this.snapshot = {
      ...this.state,
      quotes: { ...this.state.quotes },
      health: { ...this.state.health },
    };
    this.dirty = false;
    this.listeners.forEach((fn) => fn());
  }
  private log(
    venue: Venue,
    message: string,
    kind: "info" | "warning" = "info",
  ) {
    this.state.logs = [
      { venue, message, kind, time: Date.now() },
      ...this.state.logs,
    ].slice(0, 60);
    this.mark();
  }
  start() {
    if (this.flush) return;
    this.flush = setInterval(() => this.emit(), 200);
    this.connectAll();
    this.startFocus();
    this.reconcile = setInterval(() => {
      if (!this.state.paused && this.state.selected.venue === "coinbase")
        void this.loadHistory(true);
    }, 60000);
  }
  stop() {
    this.connections.forEach((c) => c.stop());
    this.connections.clear();
    this.focused?.stop();
    this.abort?.abort();
    clearInterval(this.flush);
    clearInterval(this.reconcile);
    this.flush = undefined;
  }
  select(base: string, interval: number) {
    if (
      !ASSETS.some((a) => a.base === base) ||
      !INTERVALS.some((i) => i.seconds === interval)
    )
      return;
    const venue = sourceFor(base);
    const p = this.state.selected;
    if (p.venue === venue && p.base === base && p.interval === interval) return;
    this.state.selected = { venue, base, interval };
    this.startFocus();
    this.emit();
  }
  pause() {
    this.state.paused = !this.state.paused;
    if (this.state.paused) {
      this.connections.forEach((c) => c.stop());
      this.connections.clear();
      this.focused?.stop();
      this.abort?.abort();
      for (const v of VENUES) this.setHealth(v, { phase: "paused" });
      this.state.detail = "paused";
      if (this.state.history === "loading") this.state.history = "ready";
    } else {
      this.connectAll();
      this.startFocus();
    }
    this.mark();
    this.emit();
  }
  reconnect(venue?: Venue) {
    if (this.state.paused) return;
    for (const v of venue ? [venue] : VENUES) {
      this.connections.get(v)?.stop();
      this.connectTicker(v);
    }
    if (!venue || venue === this.state.selected.venue) this.startFocus();
  }
  private setHealth(v: Venue, update: Partial<FeedHealth>) {
    this.state.health[v] = { ...this.state.health[v], ...update };
    this.mark();
  }
  private connectAll() {
    for (const v of VENUES) this.connectTicker(v);
  }
  private connection(
    v: Venue,
    url: string,
    onOpen: (ws: WebSocket) => void,
    onData: (d: any) => void,
    focused = false,
  ): Connection {
    let ended = false,
      attempt = 0,
      timer: ReturnType<typeof setTimeout> | undefined,
      watch: ReturnType<typeof setInterval> | undefined,
      last = Date.now();
    let ws: WebSocket;
    const phase = (phase: Phase, error?: string) => {
      if (ended) return;
      if (focused) {
        this.state.detail = phase;
        this.state.detailError = error;
        this.mark();
      } else this.setHealth(v, { phase, error });
    };
    const connect = () => {
      if (ended) return;
      phase(attempt ? "reconnecting" : "connecting");
      last = Date.now();
      ws = new WebSocket(url);
      handle.socket = ws;
      ws.onopen = () => {
        if (ended) {
          ws.close();
          return;
        }
        last = Date.now();
        onOpen(ws);
        if (!focused) this.setHealth(v, { connectedAt: Date.now() });
        this.log(
          v,
          `${focused ? "Market channels" : "Ticker stream"} connected`,
        );
      };
      ws.onmessage = (e) => {
        if (ended) return;
        last = Date.now();
        try {
          const d =
            v === "kraken"
              ? parseDecimalJSON(String(e.data))
              : JSON.parse(String(e.data));
          if (d.type === "error" || d.success === false) {
            phase(
              "error",
              String(d.message ?? d.error ?? "Subscription rejected"),
            );
            this.log(v, String(d.message ?? d.error), "warning");
            return;
          }
          const payload = d.data ?? d;
          const isMarketData =
            v === "binance"
              ? !!(
                  payload.e ||
                  payload.lastUpdateId ||
                  d.stream?.includes("@bookTicker")
                )
              : v === "coinbase"
                ? [
                    "ticker",
                    "match",
                    "last_match",
                    "snapshot",
                    "l2update",
                  ].includes(d.type)
                : ["ticker", "trade", "book", "ohlc"].includes(d.channel) &&
                  ["snapshot", "update"].includes(d.type);
          this.setHealth(v, {
            messages: this.state.health[v].messages + 1,
            marketUpdates:
              this.state.health[v].marketUpdates + Number(isMarketData),
            lastMessage: last,
          });
          // Control acknowledgements and heartbeats establish transport health, not quote freshness.
          onData(d);
          if (
            (focused ? this.state.detail : this.state.health[v].phase) !==
            "error"
          )
            phase("live");
          attempt = 0;
        } catch (error) {
          phase(
            "error",
            error instanceof Error ? error.message : "Invalid market message",
          );
          this.log(v, "Market message rejected; reconnecting", "warning");
          ws.close();
        }
      };
      ws.onerror = () =>
        phase(
          "error",
          "Connection unavailable. Check network or regional availability.",
        );
      ws.onclose = () => {
        if (ended) return;
        attempt++;
        phase("reconnecting", "Disconnected; automatically retrying");
        if (focused) this.state.book = emptyBook();
        this.setHealth(v, {
          reconnects: this.state.health[v].reconnects + 1,
        });
        this.mark();
        timer = setTimeout(
          connect,
          Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5)) +
            Math.random() * 400,
        );
      };
      clearInterval(watch);
      watch = setInterval(() => {
        if (Date.now() - last > 25000) {
          phase("reconnecting", "No channel messages for 25 seconds");
          ws.close();
        }
      }, 5000);
    };
    const handle: Connection = {
      stop: () => {
        ended = true;
        clearTimeout(timer);
        clearInterval(watch);
        if (ws) {
          ws.onclose = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.close();
        }
      },
    };
    connect();
    return handle;
  }
  private connectTicker(v: Venue) {
    const assigned = assetsForVenue(v);
    const symbols = assigned.map((a) => pair(v, a.base));
    if (!symbols.length) return;
    const seedAbort = new AbortController();
    const acceptQuote = (q: Quote | undefined) => {
      if (!q || !assigned.some((a) => a.base === q.base)) return;
      const key = quoteKey(v, q.base),
        old = this.state.quotes[key];
      if (old?.eventTime && q.eventTime && q.eventTime < old.eventTime) return;
      this.state.quotes[key] =
        old?.bookReceived && v === "binance"
          ? { ...q, bid: old.bid, ask: old.ask, bookReceived: old.bookReceived }
          : q;
      this.mark();
    };
    const url =
      v === "binance"
        ? `wss://data-stream.binance.vision/stream?streams=${symbols.flatMap((s) => [s.toLowerCase() + "@ticker", s.toLowerCase() + "@bookTicker"]).join("/")}`
        : v === "coinbase"
          ? "wss://ws-feed.exchange.coinbase.com"
          : "wss://ws.kraken.com/v2";
    const c = this.connection(
      v,
      url,
      (ws) => {
        if (v === "binance") {
          // Binance's ticker has no initial snapshot: seed quiet markets too.
          void fetch(
            `https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`,
            {
              signal: AbortSignal.any([
                seedAbort.signal,
                AbortSignal.timeout(15000),
              ]),
            },
          )
            .then(async (response) => {
              if (!response.ok)
                throw new Error(`Quote snapshot HTTP ${response.status}`);
              const rows = await response.json();
              if (seedAbort.signal.aborted) return;
              if (!Array.isArray(rows))
                throw new Error("Invalid quote snapshot");
              for (const row of rows)
                acceptQuote(
                  normalizeQuote(v, {
                    s: row.symbol,
                    c: row.lastPrice,
                    b: row.bidPrice,
                    a: row.askPrice,
                    P: row.priceChangePercent,
                    h: row.highPrice,
                    l: row.lowPrice,
                    v: row.volume,
                    E: row.closeTime,
                  }),
                );
            })
            .catch(() => {
              if (!seedAbort.signal.aborted)
                this.log(
                  v,
                  "Initial quotes unavailable; waiting for stream updates",
                  "warning",
                );
            });
        }
        if (v === "coinbase")
          ws.send(
            JSON.stringify({
              type: "subscribe",
              product_ids: symbols,
              channels: ["ticker", "heartbeat"],
            }),
          );
        if (v === "kraken")
          ws.send(
            JSON.stringify({
              method: "subscribe",
              params: {
                channel: "ticker",
                symbol: symbols,
                event_trigger: "bbo",
                snapshot: true,
              },
            }),
          );
      },
      (d) => {
        if (v === "binance" && d.stream?.includes("@bookTicker")) {
          const m = d.data;
          const base = m.s?.replace(/USDT$/, "");
          const old = this.state.quotes[quoteKey(v, base)];
          if (
            old &&
            assigned.some((a) => a.base === base) &&
            Number(m.b) > 0 &&
            Number(m.a) >= Number(m.b)
          ) {
            this.state.quotes[quoteKey(v, base)] = {
              ...old,
              bid: +m.b,
              ask: +m.a,
              bookReceived: Date.now(),
            };
            this.mark();
          }
          return;
        }
        const values =
          v === "binance"
            ? [d.data ?? d]
            : v === "coinbase"
              ? d.type === "ticker"
                ? [d]
                : []
              : d.channel === "ticker"
                ? d.data
                : [];
        for (const value of values ?? []) {
          acceptQuote(normalizeQuote(v, value));
        }
      },
    );
    this.connections.set(v, {
      stop: () => {
        seedAbort.abort();
        c.stop();
      },
    });
  }
  private startFocus() {
    this.focused?.stop();
    this.abort?.abort();
    this.generation++;
    this.historyRunning = false;
    this.state.candles = [];
    this.state.trades = [];
    this.state.book = emptyBook();
    this.state.gaps = 0;
    this.state.detailError = undefined;
    if (this.state.paused) {
      this.state.detail = "paused";
      this.state.history = "ready";
      this.mark();
      return;
    }
    this.state.history = "loading";
    this.state.detail = "connecting";
    this.mark();
    void this.loadHistory();
    const { venue: v, base, interval } = this.state.selected;
    const symbol = pair(v, base);
    let bidMap = new Map<string, Level>(),
      askMap = new Map<string, Level>(),
      hasSnapshot = false;
    let lastTrade = 0,
      lastTime = 0;
    const seen = new Set<string>();
    const addTrade = (t: Trade | undefined) => {
      if (!t || seen.has(t.id)) return;
      seen.add(t.id);
      if (seen.size > 2000) seen.delete(seen.values().next().value!);
      this.state.trades = [t, ...this.state.trades]
        .sort((a, b) => b.time - a.time)
        .slice(0, 60);
      if (v === "coinbase") {
        const id = Number(t.id.split(":")[1]);
        if (lastTrade && id > lastTrade + 1) {
          this.state.gaps++;
          this.log(
            v,
            "Possible trade gap; current candle is partial",
            "warning",
          );
        }
        lastTrade = Math.max(lastTrade, id);
        if (t.time >= lastTime) {
          this.state.candles = tradeCandle(this.state.candles, t, interval);
          lastTime = t.time;
        }
      }
      this.mark();
    };
    const publishBook = (
      bids: Level[],
      asks: Level[],
      verified: boolean,
      method: string,
    ) => {
      this.state.book = {
        bids: bids
          .sort((a, b) => b.price - a.price)
          .slice(0, v === "binance" ? 20 : 100),
        asks: asks
          .sort((a, b) => a.price - b.price)
          .slice(0, v === "binance" ? 20 : 100),
        verified,
        method,
        received: Date.now(),
      };
      this.mark();
    };
    const intervalName =
      interval === 86400
        ? "1d"
        : interval === 3600
          ? "1h"
          : `${interval / 60}m`;
    const url =
      v === "binance"
        ? `wss://data-stream.binance.vision/stream?streams=${symbol.toLowerCase()}@trade/${symbol.toLowerCase()}@kline_${intervalName}/${symbol.toLowerCase()}@depth20@100ms`
        : v === "coinbase"
          ? "wss://ws-feed.exchange.coinbase.com"
          : "wss://ws.kraken.com/v2";
    this.focused = this.connection(
      v,
      url,
      (ws) => {
        // A new socket always needs a new snapshot and history reconciliation.
        bidMap = new Map();
        askMap = new Map();
        hasSnapshot = false;
        lastTrade = 0;
        lastTime = 0;
        if (v === "coinbase")
          ws.send(
            JSON.stringify({
              type: "subscribe",
              product_ids: [symbol],
              channels: ["matches", "level2_batch", "heartbeat"],
            }),
          );
        if (v === "kraken")
          for (const params of [
            { channel: "trade", symbol: [symbol], snapshot: true },
            {
              channel: "ohlc",
              symbol: [symbol],
              interval: interval / 60,
              snapshot: true,
            },
            { channel: "book", symbol: [symbol], depth: 100, snapshot: true },
          ])
            ws.send(JSON.stringify({ method: "subscribe", params }));
        void this.loadHistory(true);
      },
      (d) => {
        if (v === "binance") {
          const m = d.data ?? d;
          if (m.s && m.s !== symbol) return;
          if (m.e === "trade") addTrade(normalizeTrade(v, m));
          if (m.e === "kline") {
            const k = m.k;
            this.state.candles = upsertCandle(this.state.candles, {
              time: Number(k.t) / 1000,
              open: +k.o,
              high: +k.h,
              low: +k.l,
              close: +k.c,
              volume: +k.v,
            });
            this.mark();
          }
          if (m.lastUpdateId && m.bids && m.asks)
            publishBook(
              levels(m.bids),
              levels(m.asks),
              true,
              "Complete top-20 snapshots · 100 ms",
            );
        } else if (v === "coinbase") {
          if (d.product_id && d.product_id !== symbol) return;
          if (d.type === "match" || d.type === "last_match") {
            if (d.type === "last_match") {
              const t = normalizeTrade(v, d);
              if (t && !seen.has(t.id)) {
                seen.add(t.id);
                this.state.trades = [t, ...this.state.trades].slice(0, 60);
                this.mark();
              }
            } else addTrade(normalizeTrade(v, d));
          }
          if (d.type === "snapshot") {
            bidMap = new Map(levels(d.bids).map((l) => [String(l.price), l]));
            askMap = new Map(levels(d.asks).map((l) => [String(l.price), l]));
            hasSnapshot = true;
          }
          if (d.type === "l2update" && hasSnapshot)
            for (const [side, p, q] of d.changes) {
              const map = side === "buy" ? bidMap : askMap;
              const price = Number(p),
                size = Number(q);
              if (size === 0) map.delete(String(price));
              else if (price > 0 && size > 0)
                map.set(String(price), {
                  price,
                  size,
                  rawPrice: p,
                  rawSize: q,
                });
            }
          if ((d.type === "snapshot" || d.type === "l2update") && hasSnapshot)
            publishBook(
              [...bidMap.values()],
              [...askMap.values()],
              true,
              "Level 2 snapshot + 50 ms updates",
            );
        } else {
          if (d.channel === "trade")
            for (const t of d.data ?? []) addTrade(normalizeTrade(v, t));
          if (d.channel === "ohlc")
            for (const b of d.data ?? []) {
              this.state.candles = upsertCandle(this.state.candles, {
                time: Math.floor(Date.parse(b.interval_begin) / 1000),
                open: +b.open,
                high: +b.high,
                low: +b.low,
                close: +b.close,
                volume: +b.volume,
              });
              this.mark();
            }
          if (d.channel === "book")
            for (const b of d.data ?? []) {
              if (d.type === "snapshot") {
                bidMap.clear();
                askMap.clear();
                hasSnapshot = true;
              }
              if (!hasSnapshot) continue;
              updateBook(bidMap, b.bids ?? []);
              updateBook(askMap, b.asks ?? []);
              const bids = [...bidMap.values()]
                  .sort((a, b) => b.price - a.price)
                  .slice(0, 100),
                asks = [...askMap.values()]
                  .sort((a, b) => a.price - b.price)
                  .slice(0, 100);
              bidMap = new Map(bids.map((l) => [String(l.price), l]));
              askMap = new Map(asks.map((l) => [String(l.price), l]));
              if (
                b.checksum === undefined ||
                krakenChecksum(bids, asks) !== Number(b.checksum)
              ) {
                this.state.book = emptyBook();
                throw new Error(
                  "Book checksum mismatch; rebuilding from snapshot",
                );
              }
              publishBook(
                bids,
                asks,
                true,
                "100 levels · CRC32 top 10 verified",
              );
            }
        }
      },
      true,
    );
  }
  private async loadHistory(background = false) {
    if (this.historyRunning || this.state.paused) return;
    this.historyRunning = true;
    const generation = this.generation,
      { venue, base, interval } = this.state.selected;
    this.abort = new AbortController();
    if (!background) this.state.history = "loading";
    try {
      const history = await fetchHistory(
        venue,
        base,
        interval,
        this.abort.signal,
      );
      if (generation !== this.generation) return;
      const current = Math.floor(Date.now() / 1000 / interval) * interval;
      // Closed REST candles are authoritative. Keep native streaming current bars;
      // Coinbase's current trade-built candle is explicitly incomplete.
      const h = new Map(history.map((c) => [c.time, c]));
      for (const c of this.state.candles)
        if (c.time >= current || (!h.has(c.time) && c.partial))
          h.set(c.time, c);
      this.state.candles = cleanCandles([...h.values()]);
      this.state.history = "ready";
      this.state.historyError = undefined;
      if (!background)
        this.log(venue, `${history.length} historical candles loaded`);
    } catch (e) {
      if (generation !== this.generation || this.abort?.signal.aborted) return;
      this.state.historyError =
        e instanceof Error ? e.message : "Historical data unavailable";
      this.state.history = "error";
      this.log(venue, this.state.historyError, "warning");
    } finally {
      if (generation === this.generation) {
        this.historyRunning = false;
        this.mark();
      }
    }
  }
}
export const market = new MarketEngine();
