import type { Candle } from "./types";
export function sma(data: Candle[], period = 20) {
  let sum = 0;
  return data.flatMap((c, i) => {
    sum += c.close;
    if (i >= period) sum -= data[i - period].close;
    return i >= period - 1 ? [{ time: c.time, value: sum / period }] : [];
  });
}
export function ema(data: Candle[], period = 50) {
  if (data.length < period) return [];
  let value = data.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  const out = [{ time: data[period - 1].time, value }];
  for (let i = period; i < data.length; i++) {
    value = (data[i].close * 2) / (period + 1) + value * (1 - 2 / (period + 1));
    out.push({ time: data[i].time, value });
  }
  return out;
}
export function rsi(data: Candle[], period = 14) {
  if (data.length <= period) return [];
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = data[i].close - data[i - 1].close;
    gain += Math.max(d, 0) / period;
    loss += Math.max(-d, 0) / period;
  }
  const value = () =>
    loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  const out = [{ time: data[period].time, value: value() }];
  for (let i = period + 1; i < data.length; i++) {
    const d = data[i].close - data[i - 1].close;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out.push({ time: data[i].time, value: value() });
  }
  return out;
}
