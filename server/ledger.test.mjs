import test from "node:test";
import assert from "node:assert/strict";
import {
  newAccount,
  balances,
  submitOrder,
  processOrders,
  cancelOrder,
  D,
} from "./ledger.mjs";

export const rules = {
  step: "0.001",
  minQty: "0.001",
  maxQty: "1000",
  marketStep: "0",
  tick: "0.01",
  minPrice: "0.01",
  maxPrice: "10000000",
  minNotional: "5",
};
const account = (capital) =>
  newAccount({ kind: "manual", capital: capital || "1000" }, 1000);
const book = (
  received = 1000,
  asks = [
    ["100", "1"],
    ["101", "10"],
  ],
  bids = [["99", "10"]],
  updateId = received,
) => ({ received, asks, bids, step: rules.step, updateId });
const buy = (a, input = {}, b = book()) =>
  submitOrder(
    a,
    { base: "BTC", side: "buy", type: "market", quantity: "2", ...input },
    b,
    rules,
    1000,
  );

test("market orders reserve money, wait for latency, walk depth and keep exact accounting", () => {
  const a = account(),
    o = buy(a);
  assert.equal(balances(a).reserved, "200.2");
  assert.equal(processOrders(a, "BTC", book(1200), 1200), false);
  processOrders(a, "BTC", book(1600), 1600);
  assert.equal(o.status, "filled");
  assert.equal(o.total, "201");
  assert.equal(o.fee, "0.201");
  assert.equal(a.cash, "798.799");
  assert.equal(a.holdings.BTC.quantity, "2");
  assert.equal(balances(a).reserved, "0");
});
test("reserved funds cannot be spent by another order; cancellation releases them", () => {
  const a = account("300"),
    o = buy(a, { type: "limit", price: "90" });
  assert.equal(balances(a).available, "119.82");
  assert.throws(() => buy(a, { quantity: "2" }), /Insufficient/);
  cancelOrder(a, o.id);
  assert.equal(balances(a).available, "300");
});
test("resting limits do not fill from candle touches; only crossing opposite depth fills", () => {
  const a = account(),
    o = buy(a, { type: "limit", price: "98", quantity: "1" });
  processOrders(a, "BTC", book(1600), 1600);
  assert.equal(o.status, "open");
  processOrders(a, "BTC", book(1800, [["98", ".4"]], [["97", "4"]]), 1800);
  assert.equal(o.status, "partial");
  assert.equal(o.remaining, "0.6");
  assert.equal(balances(a).reserved, "58.8588");
  cancelOrder(a, o.id);
  assert.equal(balances(a).reserved, "0");
});
test("same exchange snapshot cannot be reused by repeated orders", () => {
  const a = account();
  buy(a, { type: "limit", price: "100", quantity: "1" });
  processOrders(
    a,
    "BTC",
    book(1600, [["100", ".5"]], [["99", "10"]], 77),
    1600,
  );
  processOrders(
    a,
    "BTC",
    book(1700, [["100", ".5"]], [["99", "10"]], 77),
    1700,
  );
  assert.equal(a.holdings.BTC.quantity, "0.5");
  processOrders(
    a,
    "BTC",
    book(1800, [["100", ".5"]], [["99", "10"]], 78),
    1800,
  );
  assert.equal(a.holdings.BTC.quantity, "1");
});
test("market remainders cancel and account balances never become negative", () => {
  const a = account("200.2"),
    o = buy(a);
  processOrders(a, "BTC", book(1600), 1600);
  assert.equal(o.status, "cancelled");
  assert(D(a.cash).gte(0));
  assert(D(o.filled).lt(2));
  assert.equal(balances(a).reserved, "0");
});
test("sell reservations prevent shorting and realized P&L includes fees", () => {
  const a = account();
  buy(a, { quantity: "1" });
  processOrders(a, "BTC", book(1600), 1600);
  const order = submitOrder(
    a,
    { base: "BTC", side: "sell", type: "limit", quantity: "1", price: "110" },
    book(2000),
    rules,
    2000,
  );
  assert.throws(
    () =>
      submitOrder(
        a,
        { base: "BTC", side: "sell", type: "market", quantity: "1" },
        book(2000),
        rules,
        2000,
      ),
    /Insufficient/,
  );
  processOrders(a, "BTC", book(2600, [["112", "10"]], [["111", "10"]]), 2600);
  assert.equal(order.status, "filled");
  assert.equal(a.holdings.BTC.quantity, "0");
  assert.equal(a.holdings.BTC.realized, "10.789");
  assert.equal(a.cash, "1010.789");
});
test("stale/crossed data, bad increments and undersized orders fail closed", () => {
  const a = account();
  assert.throws(
    () =>
      submitOrder(
        a,
        { base: "BTC", side: "buy", type: "market", quantity: "1" },
        book(1000),
        rules,
        7000,
      ),
    /fresh/,
  );
  assert.throws(
    () => buy(a, {}, book(1000, [["98", "1"]], [["99", "1"]])),
    /valid/,
  );
  assert.throws(() => buy(a, { quantity: ".0005" }), /positive decimal|step/);
  assert.throws(() => buy(a, { quantity: "0.001" }), /minimum/);
  assert.throws(() => buy(a, { type: "limit", price: "99.001" }), /tick/);
  assert.throws(() => buy(a, { quantity: "NaN" }), /decimal/);
});
test("accounts have independent money, models, holdings and liquidity budgets", () => {
  const a = newAccount({
      kind: "ai",
      capital: "1000",
      model: "model-a",
      maxOrderPercent: 25,
    }),
    b = newAccount({
      kind: "ai",
      capital: "300",
      provider: "openrouter",
      model: "vendor/model-b",
      maxOrderPercent: 25,
    });
  buy(a, { quantity: "1" });
  buy(b, { quantity: ".5" });
  processOrders(a, "BTC", book(1600), 1600);
  processOrders(b, "BTC", book(1600), 1600);
  assert.equal(a.model, "model-a");
  assert.equal(b.initial, "300");
  assert.equal(b.cash, "249.95");
  assert.equal(a.cash, "899.9");
  assert.throws(() => buy(b, { quantity: "1" }), /ceiling/);
});

test("new AI runs leave strategy choices open unless the owner sets tighter limits", () => {
  const a = newAccount({ kind: "ai", capital: "1000", model: "test" });
  assert.equal(a.maxOrderPercent, 100);
  assert.equal(a.lossLimitPercent, 100);
});
