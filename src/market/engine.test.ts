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
  engine.select("coinbase", "BTC", 60);
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
  engine.select("coinbase", "BTC", 60);
  const old = FakeSocket.all.at(-1)!.onmessage!;
  engine.select("coinbase", "ETH", 300);
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
