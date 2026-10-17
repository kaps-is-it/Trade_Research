import test from "node:test";
import assert from "node:assert/strict";
import { strategy } from "./test-fixtures.mjs";
import { validateStrategy } from "./strategy.mjs";
import { parseDecision, decisionInput } from "./models.mjs";
import {
  newAccount,
  submitAIOrder,
  processOrders,
  replaceAIOrder,
  balances,
  positionMetrics,
  D,
} from "./ledger.mjs";

const rules = {
  step: "0.001",
  minQty: "0.001",
  maxQty: "1000",
  marketStep: "0",
  tick: "0.01",
  minPrice: "0.01",
  maxPrice: "10000000",
  minNotional: "5",
};
const book = (bid = "99", ask = "100", received = Date.now()) => ({
  bids: [[bid, "10"]],
  asks: [[ask, "10"]],
  received,
  step: ".001",
});
const account = () =>
  newAccount({
    kind: "ai",
    capital: "1000",
    model: "test",
    maxOrderPercent: 25,
  });
const trade = (a, side, quantity, b = book()) => {
  const now = b.received;
  const order = submitAIOrder(
    a,
    { base: "BTC", side, type: "market", quantity },
    b,
    rules,
    now,
  );
  processOrders(
    a,
    "BTC",
    { ...b, received: now + 500, updateId: order.id },
    now + 500,
  );
  return order;
};

test("AI market orders fill against observed depth; exits are not capped by entry allocation", () => {
  const a = account();
  const buy = trade(a, "buy", "2");
  assert.equal(buy.status, "filled");
  assert.equal(buy.filled, "2");
  assert.equal(buy.total, "200");
  assert.equal(buy.closed, buy.created + 500);
  assert.equal(a.cash, "799.8");
  assert.equal(a.holdings.BTC.cost, "200.2");
  const sell = trade(a, "sell", "2", book("200", "201"));
  assert.equal(sell.total, "400");
  assert.equal(a.holdings.BTC.quantity, "0");
  assert.equal(a.holdings.BTC.realized, "199.4");
  assert.equal(a.cash, "1199.4");
});
test("AI submission rejects stale data and insufficient holdings/funds without mutations", () => {
  const a = account(),
    initial = structuredClone(a);
  assert.throws(() => trade(a, "sell", "1"), /holdings/);
  assert.throws(() => trade(a, "buy", "3"), /ceiling/);
  assert.throws(
    () =>
      submitAIOrder(
        a,
        { base: "BTC", side: "buy", type: "market", quantity: "1" },
        book("99", "100", Date.now() - 6000),
        rules,
      ),
    /fresh/,
  );
  a.cash = "10";
  assert.throws(() => trade(a, "buy", "1"), /Insufficient/);
  a.cash = initial.cash;
  assert.deepEqual(a, initial);
});
test("position valuation tracks changing P&L, fees, partial exits and new entry times", () => {
  const a = account();
  trade(a, "buy", "2");
  let p = positionMetrics(a, { BTC: book("110", "112") })[0];
  assert.equal(p.averageEntry, "100");
  assert.equal(p.invested, "200.2");
  assert.equal(p.unrealized, "21.8");
  assert.equal(p.estimatedNetPnl, "19.58");
  assert(p.entryAt);
  trade(a, "sell", "1", book("110", "112"));
  p = positionMetrics(a, { BTC: book("110", "112") })[0];
  assert.equal(p.quantity, "1");
  assert.equal(p.averageEntry, "100");
  assert.equal(p.invested, "100.1");
  assert.equal(p.entryFees, "0.1");
  assert.equal(
    positionMetrics(a, { BTC: book("110", "112", Date.now() - 6000) })[0]
      .unrealized,
    null,
  );
  trade(a, "sell", "1", book("110", "112"));
  assert.deepEqual(positionMetrics(a, {}), []);
  assert(D(a.holdings.BTC.cost).isZero());
});
test("every decision requires bounded persistent strategy and validates limit/replace fields", () => {
  assert.throws(
    () => parseDecision('{"action":"hold","rationale":"wait"}'),
    /strategy/i,
  );
  for (const value of [NaN, -1, 101, "50"])
    assert.throws(() => validateStrategy({ ...strategy, exitUrgency: value }));
  assert.throws(() =>
    validateStrategy({ ...strategy, memory: "x".repeat(2001) }),
  );
  const limit = {
    action: "buy",
    type: "limit",
    quantity: "1",
    price: "90",
    rationale: "wait",
    strategy,
  };
  assert.equal(parseDecision(JSON.stringify(limit)).type, "limit");
  assert.throws(() => parseDecision(JSON.stringify({ ...limit, price: null })));
  assert.throws(() =>
    parseDecision(JSON.stringify({ ...limit, action: "replace" })),
  );
  assert.equal(
    parseDecision(
      JSON.stringify({ ...limit, action: "replace", orderId: "pending" }),
    ).action,
    "replace",
  );
  const a = account();
  a.strategy = { ...strategy, revision: 7 };
  a.journal = [];
  const input = decisionInput(a, {});
  assert.deepEqual(input.previousStrategy, a.strategy);
  assert.equal(input.previousStrategy.memory, strategy.memory);
});

test("AI limit buys wait for executable asks, partially fill, reserve only remaining funds and survive snapshots", () => {
  const a = account(),
    start = 1000;
  const b = { ...book("81854", "81855", start), step: ".001" };
  const o = submitAIOrder(
    a,
    {
      base: "BTC",
      side: "buy",
      type: "limit",
      price: "81790",
      quantity: "0.001",
    },
    b,
    rules,
    start,
  );
  assert.equal(o.status, "open");
  assert.equal(o.timeInForce, "GTC");
  assert.equal(balances(a).reserved, "81.87179");
  processOrders(a, "BTC", { ...b, received: 1600 }, 1600);
  assert.equal(
    o.filled,
    "0",
    "a target in memory does not fill an unmarketable order",
  );
  processOrders(
    a,
    "BTC",
    {
      ...b,
      received: 1700,
      bids: [["81789", "1"]],
      asks: [["81790", "0.001"]],
    },
    1700,
  );
  assert.equal(o.status, "filled");
  assert.equal(o.total, "81.79");
  assert.equal(a.holdings.BTC.quantity, "0.001");
  assert.equal(balances(a).reserved, "0");
  const p = submitAIOrder(
    a,
    { base: "BTC", side: "buy", type: "limit", price: "100", quantity: "1" },
    book("99", "101", 2000),
    rules,
    2000,
  );
  processOrders(
    a,
    "BTC",
    { ...book("98", "99", 2600), asks: [["99", "0.4"]] },
    2600,
  );
  assert.equal(p.status, "partial");
  assert.equal(p.remaining, "0.6");
  assert.equal(balances(a).reserved, "60.06");
});

test("AI market depth limits fills and pre-latency books cannot execute an order", () => {
  const a = account();
  const b = {
    ...book("99", "100", 1000),
    asks: [
      ["100", "0.1"],
      ["101", "0.2"],
    ],
  };
  const o = submitAIOrder(
    a,
    { base: "BTC", side: "buy", type: "market", quantity: "1" },
    b,
    rules,
    1000,
  );
  assert.equal(processOrders(a, "BTC", b, 1600), false);
  assert.equal(o.filled, "0");
  processOrders(a, "BTC", { ...b, received: 1600 }, 1600);
  assert.equal(o.status, "cancelled");
  assert.equal(o.filled, "0.3");
  assert.equal(o.total, "30.2");
  assert.equal(o.fee, "0.0302");
  assert.equal(balances(a).reserved, "0");
});

test("replace is atomic, retains side/market, uses remaining quantity and releases old reservations", () => {
  const a = account(),
    b = book("99", "100", 1000);
  const original = submitAIOrder(
    a,
    { base: "BTC", side: "buy", type: "limit", quantity: "2", price: "90" },
    b,
    rules,
    1000,
  );
  const before = structuredClone(a);
  assert.throws(() =>
    replaceAIOrder(
      a,
      original.id,
      { type: "limit", quantity: "100", price: "91" },
      b,
      rules,
      1000,
    ),
  );
  assert.deepEqual(
    a,
    before,
    "a failed replacement must leave the old order untouched",
  );
  const next = replaceAIOrder(
    a,
    original.id,
    { base: "ETH", side: "sell", type: "limit", quantity: "1", price: "91" },
    b,
    rules,
    1000,
  );
  assert.equal(next.side, "buy");
  assert.equal(next.base, "BTC");
  assert.equal(next.remaining, "1");
  assert.equal(next.replacesOrderId, original.id);
  assert.equal(a.orders.find((o) => o.id === original.id).status, "cancelled");
  assert.equal(balances(a).reserved, "91.091");
  assert.equal(a.fills.length, 0);
});

test("AI limit exits reserve held assets and wait for bids at the target or better", () => {
  const a = account();
  trade(a, "buy", "1");
  const b = book("99", "100", 1000);
  const o = submitAIOrder(
    a,
    { base: "BTC", side: "sell", type: "limit", quantity: "1", price: "110" },
    b,
    rules,
    1000,
  );
  assert.equal(balances(a).reservedAssets.BTC, "1");
  assert.throws(
    () =>
      submitAIOrder(
        a,
        { base: "BTC", side: "sell", type: "market", quantity: "1" },
        b,
        rules,
        1000,
      ),
    /holdings/,
  );
  processOrders(a, "BTC", book("109", "110", 1600), 1600);
  assert.equal(o.status, "open");
  processOrders(a, "BTC", book("110", "111", 1700), 1700);
  assert.equal(o.status, "filled");
  assert.equal(a.holdings.BTC.quantity, "0");
  assert.equal(a.holdings.BTC.realized, "9.79");
});

test("replacing a partially filled limit changes only the desired remaining quantity", () => {
  const a = account(),
    b = book("99", "101", 1000);
  const o = submitAIOrder(
    a,
    { base: "BTC", side: "buy", type: "limit", quantity: "1", price: "100" },
    b,
    rules,
    1000,
  );
  processOrders(
    a,
    "BTC",
    { ...book("98", "99", 1600), asks: [["99", "0.4"]] },
    1600,
  );
  assert.equal(o.filled, "0.4");
  const next = replaceAIOrder(
    a,
    o.id,
    { type: "limit", quantity: "0.3", price: "98" },
    book("99", "101", 1700),
    rules,
    1700,
  );
  assert.equal(a.holdings.BTC.quantity, "0.4");
  assert.equal(next.quantity, "0.3");
  assert.equal(next.filled, "0");
  assert.equal(a.orders.find((row) => row.id === o.id).filled, "0.4");
  assert.equal(balances(a).reserved, "29.4294");
});
