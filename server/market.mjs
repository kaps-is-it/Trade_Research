import { SYMBOLS, D, checkBook } from "./ledger.mjs";

const BASE = "https://data-api.binance.vision/api/v3";
export class TradingMarket {
  books = {};
  rules = {};
  errors = {};
  candles = {};
  lastRules = 0;
  pending = new Map();
  constructor(fetcher = fetch) {
    this.fetcher = fetcher;
  }
  async json(path) {
    if (this.blockedUntil > Date.now())
      throw new Error("Market-data rate limit cooldown is active.");
    const r = await this.fetcher(`${BASE}/${path}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      if ([418, 429].includes(r.status)) {
        const wait = Number(r.headers?.get("retry-after"));
        this.blockedUntil =
          Date.now() +
          (Number.isFinite(wait) && wait > 0
            ? Math.min(wait, 86400)
            : r.status === 418
              ? 900
              : 60) *
            1000;
      }
      throw new Error(`Binance market data HTTP ${r.status}.`);
    }
    return r.json();
  }
  async refreshRules() {
    if (this.lastRules > Date.now() - 3600000) return;
    if (this.rulesPending) return this.rulesPending;
    this.rulesPending = this.loadRules().finally(() => {
      this.rulesPending = null;
    });
    return this.rulesPending;
  }
  async loadRules() {
    if (this.lastRules > Date.now() - 3600000) return;
    const data = await this.json(
      `exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(SYMBOLS.map((s) => s + "USDT")))}`,
    );
    const rules = {};
    for (const symbol of data.symbols || []) {
      if (symbol.status !== "TRADING" || !symbol.isSpotTradingAllowed) continue;
      const f = Object.fromEntries(
        symbol.filters.map((f) => [f.filterType, f]),
      );
      if (!f.LOT_SIZE || !f.PRICE_FILTER) continue;
      rules[symbol.baseAsset] = {
        step: f.LOT_SIZE.stepSize,
        minQty: f.LOT_SIZE.minQty,
        maxQty: f.LOT_SIZE.maxQty,
        marketStep: f.MARKET_LOT_SIZE?.stepSize,
        marketMin: f.MARKET_LOT_SIZE?.minQty,
        marketMax: f.MARKET_LOT_SIZE?.maxQty,
        tick: f.PRICE_FILTER.tickSize,
        minPrice: f.PRICE_FILTER.minPrice,
        maxPrice: f.PRICE_FILTER.maxPrice,
        minNotional:
          f.NOTIONAL?.minNotional || f.MIN_NOTIONAL?.minNotional || "0",
        maxNotional: f.NOTIONAL?.maxNotional || null,
      };
    }
    if (!Object.keys(rules).length)
      throw new Error("No active Binance instrument rules returned.");
    this.rules = rules;
    this.lastRules = Date.now();
  }
  async refresh(base) {
    if (!SYMBOLS.includes(base)) throw new Error("Unsupported market.");
    if (this.pending.has(base)) return this.pending.get(base);
    const job = (async () => {
      await this.refreshRules();
      if (!this.rules[base])
        throw new Error(
          "This market is not currently available for spot trading.",
        );
      const data = await this.json(`depth?symbol=${base}USDT&limit=20`);
      const valid = (rows) =>
        Array.isArray(rows) &&
        rows.length &&
        rows.every(
          (r) =>
            Array.isArray(r) && r.length >= 2 && D(r[0]).gt(0) && D(r[1]).gt(0),
        );
      if (!valid(data.bids) || !valid(data.asks))
        throw new Error("Invalid market depth response.");
      // Receipt time is real wall time; exchange updateId controls liquidity reuse.
      const book = {
        bids: data.bids,
        asks: data.asks,
        received: Date.now(),
        step: this.rules[base].step,
        updateId: data.lastUpdateId,
      };
      checkBook(book, Date.now());
      this.books[base] = book;
      delete this.errors[base];
      return book;
    })()
      .catch((error) => {
        this.errors[base] = error.message;
        throw error;
      })
      .finally(() => this.pending.delete(base));
    this.pending.set(base, job);
    return job;
  }
  async history(base) {
    const boundary = Math.floor(Date.now() / 300000) * 300000;
    if (this.candles[base]?.boundary === boundary)
      return this.candles[base].rows;
    const data = await this.json(
      `klines?symbol=${base}USDT&interval=5m&limit=101`,
    );
    if (!Array.isArray(data))
      throw new Error("Historical candles unavailable.");
    const rows = data
      .filter((r) => r[6] < boundary)
      .slice(-100)
      .map((r) => ({
        time: r[0],
        open: r[1],
        high: r[2],
        low: r[3],
        close: r[4],
        volume: r[5],
        closedAt: r[6],
      }));
    if (rows.length < 30 || rows.at(-1).closedAt < boundary - 300001)
      throw new Error("Closed candle history is incomplete or stale.");
    this.candles[base] = { boundary, rows };
    return rows;
  }
  prices() {
    return Object.fromEntries(
      Object.entries(this.books)
        .filter(
          ([base, b]) =>
            !this.errors[base] &&
            b.received <= Date.now() &&
            Date.now() - b.received <= 5000,
        )
        .map(([s, b]) => [
          s,
          D(b.bids[0][0]).plus(b.asks[0][0]).div(2).toFixed(),
        ]),
    );
  }
}
