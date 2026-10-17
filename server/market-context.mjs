import { D } from "./ledger.mjs";

export function pendingOrderContext(
  account,
  book,
  observations = [],
  now = Date.now(),
) {
  const rows = observations.filter(
    (r) => r.time <= now && r.time >= now - 180000,
  );
  const gap = (points) =>
    points
      .slice(1)
      .reduce((max, r, i) => Math.max(max, r.time - points[i].time), 0);
  const range = (points, side) =>
    points.length
      ? {
          samples: points.length,
          observedSpanMs: points.at(-1).time - points[0].time,
          maxSampleGapMs: gap(points),
          low: points
            .reduce(
              (low, r) => (low.lt(r[side]) ? low : D(r[side])),
              D(points[0][side]),
            )
            .toFixed(),
          high: points
            .reduce(
              (high, r) => (high.gt(r[side]) ? high : D(r[side])),
              D(points[0][side]),
            )
            .toFixed(),
        }
      : null;
  return account.orders
    .filter((o) => ["open", "partial"].includes(o.status) && o.type === "limit")
    .map((o) => {
      const buy = o.side === "buy",
        side = buy ? "ask" : "bid",
        sinceOrder = rows.filter((r) => r.time >= o.created),
        price = D(buy ? book.asks[0][0] : book.bids[0][0]),
        distance = buy ? price.minus(o.limit) : D(o.limit).minus(price),
        quantity = D(o.remaining);
      return {
        orderId: o.id,
        side: o.side,
        ageMs: Math.max(0, now - o.created),
        remainingQuantity: o.remaining,
        limit: o.limit,
        executablePriceNow: price.toFixed(),
        unfavorableDistanceUSDT: distance.toFixed(),
        unfavorableDistanceBps: distance.div(o.limit).mul(10000).toFixed(4),
        additionalNotionalVsLimitUSDT: distance.mul(quantity).toFixed(),
        marketNotionalUSDT: price.mul(quantity).toFixed(),
        estimatedMarketFeeUSDT: price.mul(quantity).mul("0.001").toFixed(),
        estimatedRoundTripBreakEvenSellPrice: buy
          ? price.mul("1.001").div("0.999").toFixed(8)
          : null,
        observedRange: range(sinceOrder, side),
        last30Seconds: range(
          sinceOrder.filter((r) => r.time >= now - 30000),
          side,
        ),
      };
    });
}
