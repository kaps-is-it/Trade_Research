import test from "node:test";
import assert from "node:assert/strict";
import { pendingOrderContext } from "./market-context.mjs";

test("pending entry review reports observed dwell range, gaps and the actual marginal market cost", () => {
  const now = 1000000;
  const account = {
    orders: [
      {
        id: "live",
        status: "open",
        type: "limit",
        side: "buy",
        limit: "81210",
        remaining: "0.06",
        created: now - 90000,
      },
    ],
  };
  const quotes = [
    { time: now - 50000, bid: "81212.99", ask: "81213" },
    { time: now - 29000, bid: "81217.99", ask: "81218" },
    { time: now - 10000, bid: "81213.99", ask: "81214" },
    { time: now, bid: "81214.99", ask: "81215" },
    { time: now + 1, bid: "1", ask: "1" },
  ];
  const [r] = pendingOrderContext(
    account,
    { bids: [["81214.99", "1"]], asks: [["81215", "1"]] },
    quotes,
    now,
  );
  assert.equal(r.ageMs, 90000);
  assert.equal(r.unfavorableDistanceUSDT, "5");
  assert.equal(r.additionalNotionalVsLimitUSDT, "0.3");
  assert.equal(r.marketNotionalUSDT, "4872.9");
  assert.equal(r.estimatedMarketFeeUSDT, "4.8729");
  assert.equal(r.observedRange.low, "81213");
  assert.equal(r.observedRange.high, "81218");
  assert.equal(r.observedRange.observedSpanMs, 50000);
  assert.equal(r.observedRange.maxSampleGapMs, 21000);
  assert.equal(r.last30Seconds.samples, 3);
  assert.equal(pendingOrderContext({ orders: [] }, {}, [], now).length, 0);
});

test("sell reviews use executable bids and no fabricated observations", () => {
  const [r] = pendingOrderContext(
    {
      orders: [
        {
          id: "sell",
          status: "partial",
          type: "limit",
          side: "sell",
          limit: "105",
          remaining: "2",
          created: 1,
        },
      ],
    },
    { bids: [["104", "2"]], asks: [["104.01", "2"]] },
    [],
    100,
  );
  assert.equal(r.executablePriceNow, "104");
  assert.equal(r.additionalNotionalVsLimitUSDT, "2");
  assert.equal(r.observedRange, null);
  assert.equal(r.estimatedRoundTripBreakEvenSellPrice, null);
});
