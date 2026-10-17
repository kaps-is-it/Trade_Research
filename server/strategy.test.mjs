import test from "node:test";
import assert from "node:assert/strict";
import { strategy } from "./test-fixtures.mjs";
import { validateStrategy } from "./strategy.mjs";
import { parseDecision, decisionInput } from "./models.mjs";
import { newAccount, executeAIOrder, positionMetrics, D } from "./ledger.mjs";

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
  bids: [[bid, "0.001"]],
  asks: [[ask, "0.001"]],
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
const trade = (a, side, quantity, b = book()) =>
  executeAIOrder(a, { base: "BTC", side, type: "market", quantity }, b, rules);

test("AI fills fully now at ask/bid despite thin depth; exits are not capped by entry allocation", () => {
  const a = account();
  const buy = trade(a, "buy", "2");
  assert.equal(buy.status, "filled");
  assert.equal(buy.filled, "2");
  assert.equal(buy.total, "200");
  assert.equal(buy.closed, buy.created);
  assert.equal(a.cash, "799.8");
  assert.equal(a.holdings.BTC.cost, "200.2");
  const sell = trade(a, "sell", "2", book("200", "201"));
  assert.equal(sell.total, "400");
  assert.equal(a.holdings.BTC.quantity, "0");
  assert.equal(a.holdings.BTC.realized, "199.4");
  assert.equal(a.cash, "1199.4");
});
test("immediate execution rejects stale data, insufficient holdings/funds, limit orders atomically", () => {
  const a = account(),
    initial = structuredClone(a);
  assert.throws(() => trade(a, "sell", "1"), /holdings/);
  assert.throws(() => trade(a, "buy", "3"), /ceiling/);
  assert.throws(
    () => trade(a, "buy", "1", book("99", "100", Date.now() - 6000)),
    /fresh/,
  );
  assert.throws(
    () =>
      executeAIOrder(
        a,
        { base: "BTC", side: "buy", type: "limit", price: "90", quantity: "1" },
        book(),
        rules,
      ),
    /immediately/,
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
test("every decision requires bounded persistent strategy and market-only actions", () => {
  assert.throws(
    () => parseDecision('{"action":"hold","rationale":"wait"}'),
    /strategy/i,
  );
  for (const value of [NaN, -1, 101, "50"])
    assert.throws(() => validateStrategy({ ...strategy, exitUrgency: value }));
  assert.throws(() =>
    validateStrategy({ ...strategy, memory: "x".repeat(2001) }),
  );
  assert.throws(() =>
    parseDecision(
      JSON.stringify({
        action: "buy",
        type: "limit",
        quantity: "1",
        price: "90",
        rationale: "wait",
        strategy,
      }),
    ),
  );
  const a = account();
  a.strategy = { ...strategy, revision: 7 };
  a.journal = [];
  const input = decisionInput(a, {});
  assert.deepEqual(input.previousStrategy, a.strategy);
  assert.equal(input.previousStrategy.memory, strategy.memory);
});
