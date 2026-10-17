import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarketEngine } from "./engine";
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen?: () => void;
  onmessage?: ((e: { data: string }) => void) | null;
  onclose?: (() => void) | null;
  onerror?: (() => void) | null;
  closed = false;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
let engine: MarketEngine;
beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  engine = new MarketEngine();
});
afterEach(() => {
  engine.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("opens bounded connections, pauses all of them, and resumes without orphan sockets", () => {
  engine.start();
  expect(FakeSocket.all).toHaveLength(4);
  engine.pause();
  expect(FakeSocket.all.every((s) => s.closed)).toBe(true);
  expect(engine.getSnapshot().health.binance.phase).toBe("paused");
  vi.advanceTimersByTime(60000);
  expect(FakeSocket.all).toHaveLength(4);
  engine.pause();
  expect(FakeSocket.all).toHaveLength(8);
  expect(engine.getSnapshot().paused).toBe(false);
  engine.stop();
  expect(FakeSocket.all.every((s) => s.closed)).toBe(true);
});
it("deduplicates matches, identifies trade discontinuities, and labels current bars partial", () => {
  engine.start();
  engine.select("ABT", 60);
  const socket = FakeSocket.all.at(-1)!;
  const match = {
    type: "match",
    trade_id: 100,
    side: "buy",
    price: "100",
    size: "1",
    time: "2026-10-16T20:00:01Z",
  };
  socket.message(match);
  socket.message(match);
  socket.message({ ...match, trade_id: 102, price: "101" });
  vi.advanceTimersByTime(200);
  const state = engine.getSnapshot();
  expect(state.trades).toHaveLength(2);
  expect(state.trades[0].side).toBe("sell");
  expect(state.gaps).toBe(1);
  expect(state.candles[0]).toMatchObject({
    open: 100,
    high: 101,
    close: 101,
    volume: 2,
    partial: true,
  });
});
it("ignores late messages from a previous instrument subscription", () => {
  engine.start();
  engine.select("ABT", 60);
  const old = FakeSocket.all.at(-1)!.onmessage!;
  engine.select("ETH", 300);
  old({
    data: JSON.stringify({
      type: "match",
      trade_id: 1,
      side: "buy",
      price: "80000",
      size: "1",
      time: "2026-10-16T20:00:01Z",
    }),
  });
  vi.advanceTimersByTime(200);
  expect(engine.getSnapshot().trades).toEqual([]);
  expect(engine.getSnapshot().selected.base).toBe("ETH");
});
it("routes each asset to one source and subscribes secondary feeds only to coverage gaps", () => {
  engine.start();
  expect(engine.getSnapshot().selected).toMatchObject({
    venue: "binance",
    base: "BTC",
  });
  const binance = FakeSocket.all.find((s) => s.url.includes("@ticker"))!;
  expect(binance.url).toContain("btcusdt@bookTicker");
  expect(binance.url).not.toMatch(/xmr|abt/i);
  const coinbase = FakeSocket.all.find((s) => s.url.includes("coinbase"))!;
  const kraken = FakeSocket.all.find((s) => s.url.includes("kraken"))!;
  coinbase.onopen?.();
  kraken.onopen?.();
  expect(JSON.parse(coinbase.sent[0]).product_ids).toEqual(["ABT-USD"]);
  expect(JSON.parse(kraken.sent[0]).params.symbol).toEqual(["XMR/USD"]);
  engine.select("XMR", 60);
  const detail = FakeSocket.all.at(-1)!;
  detail.onopen?.();
  expect(JSON.parse(detail.sent.at(-1)!).params).toMatchObject({
    channel: "book",
    depth: 100,
    symbol: ["XMR/USD"],
  });
  engine.select("BTC", 60);
  expect(engine.getSnapshot().selected.venue).toBe("binance");
  expect(engine.getSnapshot().book.bids).toEqual([]);
  expect(engine.getSnapshot().candles).toEqual([]);
});
it("reconnects a failed primary market without silently replacing its venue or quote currency", () => {
  engine.start();
  const detail = FakeSocket.all.at(-1)!;
  detail.onclose?.();
  vi.advanceTimersByTime(1500);
  expect(FakeSocket.all.at(-1)!.url).toContain("btcusdt@trade");
  expect(engine.getSnapshot().selected.venue).toBe("binance");
});
it("counts both active sockets but separates market frames from control messages", () => {
  engine.start();
  const coinbase = FakeSocket.all.find((s) => s.url.includes("coinbase"))!;
  coinbase.message({ type: "heartbeat", product_id: "ABT-USD" });
  engine.select("ABT", 60);
  FakeSocket.all.at(-1)!.message({
    type: "match",
    product_id: "ABT-USD",
    trade_id: 1,
    side: "buy",
    price: "1",
    size: "1",
    time: "2026-10-16T20:00:01Z",
  });
  vi.advanceTimersByTime(200);
  expect(engine.getSnapshot().health.coinbase).toMatchObject({
    messages: 2,
    marketUpdates: 1,
  });
});
it("updates Binance best quotes without pretending a new trade price arrived", () => {
  engine.start();
  const socket = FakeSocket.all.find((s) => s.url.includes("@ticker"))!;
  socket.message({
    stream: "btcusdt@ticker",
    data: { s: "BTCUSDT", c: "100", b: "99", a: "101", E: 1000 },
  });
  vi.advanceTimersByTime(200);
  const received = engine.getSnapshot().quotes["binance:BTC"].received;
  socket.message({
    stream: "btcusdt@bookTicker",
    data: { s: "BTCUSDT", b: "100", a: "102" },
  });
  socket.message({
    stream: "ethusdt@bookTicker",
    data: { s: "ETHUSDT", b: "20", a: "21" },
  });
  vi.advanceTimersByTime(200);
  expect(engine.getSnapshot().quotes["binance:BTC"]).toMatchObject({
    price: 100,
    bid: 100,
    ask: 102,
    received,
  });
  expect(engine.getSnapshot().quotes["binance:ETH"]).toBeUndefined();
});
it("does not let a late startup REST snapshot overwrite a newer streaming price", async () => {
  let complete!: (response: Response) => void;
  vi.mocked(fetch).mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  engine.start();
  const socket = FakeSocket.all.find((s) => s.url.includes("@ticker"))!;
  socket.onopen?.();
  socket.message({
    stream: "btcusdt@ticker",
    data: { s: "BTCUSDT", c: "200", E: 2000 },
  });
  complete(
    new Response(
      JSON.stringify([
        { symbol: "BTCUSDT", lastPrice: "100", closeTime: 1000 },
      ]),
    ),
  );
  await vi.advanceTimersByTimeAsync(200);
  expect(engine.getSnapshot().quotes["binance:BTC"].price).toBe(200);
});
it("ignores a startup snapshot that completes after feeds are paused", async () => {
  let complete!: (response: Response) => void;
  vi.mocked(fetch).mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  engine.start();
  FakeSocket.all.find((s) => s.url.includes("@ticker"))!.onopen?.();
  engine.pause();
  complete(
    new Response(
      JSON.stringify([
        { symbol: "BTCUSDT", lastPrice: "100", closeTime: 1000 },
      ]),
    ),
  );
  await vi.advanceTimersByTimeAsync(200);
  expect(engine.getSnapshot().quotes).toEqual({});
});
