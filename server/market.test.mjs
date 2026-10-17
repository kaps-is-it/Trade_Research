import test from "node:test";
import assert from "node:assert/strict";
import { TradingMarket } from "./market.mjs";

test("simultaneous runs share instrument metadata and same-market depth requests", async () => {
  const urls = [];
  const market = new TradingMarket(async (url) => {
    urls.push(url);
    if (url.includes("exchangeInfo"))
      return Response.json({
        symbols: ["BTC", "ETH"].map((baseAsset) => ({
          baseAsset,
          status: "TRADING",
          isSpotTradingAllowed: true,
          filters: [
            {
              filterType: "LOT_SIZE",
              minQty: ".001",
              maxQty: "1000",
              stepSize: ".001",
            },
            {
              filterType: "PRICE_FILTER",
              minPrice: ".01",
              maxPrice: "1000000",
              tickSize: ".01",
            },
            { filterType: "MIN_NOTIONAL", minNotional: "5" },
          ],
        })),
      });
    return Response.json({
      bids: [["99", "1"]],
      asks: [["100", "1"]],
      lastUpdateId: 123,
    });
  });
  await Promise.all([
    market.refresh("BTC"),
    market.refresh("BTC"),
    market.refresh("ETH"),
  ]);
  assert.equal(urls.filter((u) => u.includes("exchangeInfo")).length, 1);
  assert.equal(urls.filter((u) => u.includes("depth")).length, 2);
  assert.equal(market.rules.BTC.minNotional, "5");
});
test("AI history uses only closed candles and reuses the same closed interval", async () => {
  const boundary = Math.floor(Date.now() / 300000) * 300000;
  let calls = 0;
  const rows = Array.from({ length: 101 }, (_, i) => {
    const start = boundary - (100 - i) * 300000;
    return [start, "100", "101", "99", "100", "1", start + 299999];
  });
  const market = new TradingMarket(async () => {
    calls++;
    return Response.json(rows);
  });
  const first = await market.history("BTC"),
    second = await market.history("BTC");
  assert.equal(first.length, 100);
  assert(first.every((r) => r.closedAt < boundary));
  assert.equal(first.at(-1).closedAt, boundary - 1);
  assert.equal(calls, 1);
  assert.equal(first, second);
});
test("exchange rate limits activate a cooldown rather than repeated immediate requests", async () => {
  let requests = 0;
  const market = new TradingMarket(async () => {
    requests++;
    return new Response("{}", {
      status: 429,
      headers: { "retry-after": "60" },
    });
  });
  await assert.rejects(market.json("depth?symbol=BTCUSDT"), /429/);
  await assert.rejects(market.json("depth?symbol=BTCUSDT"), /cooldown/);
  assert.equal(requests, 1);
});

test("valuations reject stale, failed and future-dated books", () => {
  const m = new TradingMarket(),
    now = Date.now();
  const book = (received) => ({
    received,
    bids: [["99", "1"]],
    asks: [["101", "1"]],
  });
  m.books = {
    BTC: book(now),
    ETH: book(now - 6000),
    SOL: book(now + 60000),
    XRP: book(now),
  };
  m.errors.XRP = "Feed unavailable";
  assert.deepEqual(m.prices(), { BTC: "100" });
});
