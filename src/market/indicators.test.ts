import { expect, it } from "vitest";
import { sma, ema, rsi } from "./indicators";
const candles = (prices: number[]) =>
  prices.map((close, i) => ({
    time: (i + 1) * 60,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
it("waits for indicator warm-up and computes moving averages", () => {
  expect(sma(candles([1, 2]), 3)).toEqual([]);
  expect(sma(candles([1, 2, 3, 4]), 3).map((x) => x.value)).toEqual([2, 3]);
  expect(ema(candles([1, 2, 3, 4]), 3).map((x) => x.value)).toEqual([2, 3]);
});
it("handles rising, falling and flat Wilder RSI without division errors", () => {
  expect(rsi(candles([1, 2, 3, 4]), 3)[0].value).toBe(100);
  expect(rsi(candles([4, 3, 2, 1]), 3)[0].value).toBe(0);
  expect(rsi(candles([2, 2, 2, 2]), 3)[0].value).toBe(50);
});
