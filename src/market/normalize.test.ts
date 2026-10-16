import { describe, it, expect } from "vitest";
import {
  cleanCandles,
  crc32,
  krakenChecksum,
  normalizeQuote,
  normalizeTrade,
  parseDecimalJSON,
  updateBook,
  upsertCandle,
  tradeCandle,
} from "./normalize";
import type { Candle, Level } from "./types";

describe("provider semantics", () => {
  it("preserves quote currency and rolling 24h change", () => {
    expect(
      normalizeQuote(
        "binance",
        { s: "BTCUSDT", c: "100", P: "2.5", v: "12" },
        10,
      ),
    ).toMatchObject({ base: "BTC", price: 100, change: 2.5, received: 10 });
    expect(
      normalizeQuote(
        "coinbase",
        { product_id: "BTC-USD", price: "110", open_24h: "100" },
        10,
      )?.change,
    ).toBeCloseTo(10);
    expect(
      normalizeQuote(
        "kraken",
        { symbol: "BTC/USD", last: "101", change_pct: "1.2" },
        10,
      )?.change,
    ).toBe(1.2);
    expect(
      normalizeQuote("coinbase", { price: "NaN", product_id: "BTC-USD" }),
    ).toBeUndefined();
  });
  it("converts Coinbase maker side to taker side and uses trade IDs", () => {
    expect(
      normalizeTrade("coinbase", {
        trade_id: 42,
        side: "buy",
        price: "100",
        size: "0.2",
        time: "2026-10-16T20:00:00Z",
      }),
    ).toMatchObject({ id: "coinbase:42", side: "sell", size: 0.2 });
    expect(
      normalizeTrade("binance", { t: 1, m: false, p: "100", q: "2", T: 1000 })
        ?.side,
    ).toBe("buy");
    expect(
      normalizeTrade("kraken", {
        trade_id: "5",
        side: "buy",
        price: "100",
        qty: "0.3",
        timestamp: "2026-10-16T20:00:00Z",
      })?.side,
    ).toBe("buy");
  });
});
describe("candles", () => {
  const bar: Candle = {
    time: 120,
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 5,
  };
  it("sorts, deduplicates and rejects corrupt bars", () => {
    expect(
      cleanCandles([
        { ...bar, time: 180 },
        bar,
        { ...bar, close: 12 },
        { ...bar, time: 240, high: 1 },
      ]),
    ).toEqual([
      { ...bar, close: 12 },
      { ...bar, time: 180 },
    ]);
    expect(upsertCandle([bar], { ...bar, volume: 7 })).toHaveLength(1);
  });
  it("builds explicitly partial trade bars at UTC interval boundaries", () => {
    const rows = tradeCandle(
      [bar],
      {
        id: "c:1",
        time: 125000,
        price: 12,
        size: 2,
        side: "buy",
        venue: "coinbase",
      },
      60,
    );
    expect(rows[0]).toMatchObject({
      time: 120,
      open: 10,
      close: 12,
      volume: 7,
      partial: true,
    });
  });
});
describe("order-book integrity", () => {
  it("retains the exact decimal lexemes, including trailing zeroes", () => {
    const d = parseDecimalJSON(
      '{"price":1.2300,"qty":0.00001000,"label":"123.45 \\"ok\\"","checksum":123}',
    );
    expect(d.price).toBe("1.2300");
    expect(d.qty).toBe("0.00001000");
    expect(Number(d.checksum)).toBe(123);
  });
  it("uses the standard IEEE CRC32 and Kraken asks-then-bids ordering", () => {
    expect(crc32("123456789")).toBe(0xcbf43926);
    const level = (p: string, q: string): Level => ({
      price: +p,
      size: +q,
      rawPrice: p,
      rawSize: q,
    });
    expect(
      krakenChecksum([level("99.00", "0.100")], [level("100.00", "0.020")]),
    ).toBe(crc32("10000209900100"));
  });
  it("removes zero-size levels and treats equivalent decimal prices as one level", () => {
    const book = new Map<string, Level>();
    updateBook(book, [{ price: "100.00", qty: "1.000" }]);
    updateBook(book, [{ price: "100", qty: "2.0" }]);
    expect(book.size).toBe(1);
    updateBook(book, [{ price: "100.0", qty: "0.000" }]);
    expect(book.size).toBe(0);
  });
});
