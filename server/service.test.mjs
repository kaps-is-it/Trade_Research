import test from "node:test";
import assert from "node:assert/strict";
import { AccountStore } from "./store.mjs";
import { TradingService } from "./service.mjs";
import { submitOrder } from "./ledger.mjs";

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
function fixture(decide, env = { OPENAI_API_KEY: "test-only" }) {
  const store = new AccountStore(":memory:");
  const market = {
    books: {},
    rules: { BTC: rules },
    errors: {},
    prices: () => ({ BTC: "100" }),
    async refresh(base) {
      const b = {
        received: Date.now(),
        bids: [["99", "10"]],
        asks: [["100", "10"]],
        step: ".001",
        updateId: Date.now(),
      };
      this.books[base] = b;
      return b;
    },
    async history() {
      return [
        {
          time: Math.floor(Date.now() / 300000) * 300000 - 300000,
          close: "100",
        },
      ];
    },
  };
  const service = new TradingService(store, market, env, decide);
  return {
    store,
    market,
    service,
    create: (capital) =>
      service.create({ kind: "ai", capital, model: "test-model" }),
  };
}
test("two runs evaluate independently and orders use a refreshed execution snapshot", async () => {
  const seen = [],
    f = fixture(async (a, s) => {
      seen.push([a.id, s.available]);
      return {
        decision: {
          action: "buy",
          type: "market",
          quantity: "0.1",
          rationale: "Test signal",
        },
        inputTokens: 4,
        outputTokens: 2,
      };
    });
  try {
    const a = await f.create("1000"),
      b = await f.create("300");
    await Promise.all([f.service.evaluate(a.id), f.service.evaluate(b.id)]);
    assert.deepEqual(seen.map((s) => s[1]).sort(), ["1000", "300"]);
    for (const id of [a.id, b.id]) {
      const row = f.service.accounts.get(id);
      assert.equal(row.orders.length, 1);
      assert.equal(row.calls, 1);
      assert.equal(row.journal[0].action, "buy");
      assert.equal(row.inputTokens, 4);
    }
    await f.service.evaluate(a.id);
    assert.equal(
      seen.length,
      3,
      "fresh snapshots can be evaluated within the same closed candle",
    );
  } finally {
    await f.service.stop();
    f.store.close();
  }
});
test("pausing while a model is in flight prevents its order from being placed", async () => {
  let release, entered;
  const started = new Promise((r) => {
      entered = r;
    }),
    reply = new Promise((r) => {
      release = r;
    });
  const f = fixture(async () => {
    entered();
    return reply;
  });
  try {
    const a = await f.create("1000"),
      evaluating = f.service.evaluate(a.id);
    await started;
    await f.service.control(a.id, "pause");
    release({
      decision: {
        action: "buy",
        type: "market",
        quantity: "1",
        rationale: "Late reply",
      },
      inputTokens: 1,
      outputTokens: 1,
    });
    await evaluating;
    assert.equal(f.service.accounts.get(a.id).orders.length, 0);
    assert.equal(f.service.accounts.get(a.id).status, "paused");
  } finally {
    await f.service.stop();
    f.store.close();
  }
});
test("large daily counts never stop continuous evaluation; unconfigured providers wait", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return {
      decision: { action: "hold", rationale: "Observe live prices" },
      inputTokens: 1,
      outputTokens: 1,
    };
  });
  try {
    const a = await f.create("1000");
    await f.service.update(a.id, (r) => {
      r.calls = 100000;
    });
    await f.service.evaluate(a.id);
    assert.equal(f.service.accounts.get(a.id).status, "waiting");
    assert.equal(calls, 1);
    f.service.env = {};
    const b = await f.create("300");
    await f.service.evaluate(b.id);
    assert.equal(f.service.accounts.get(b.id).status, "awaiting_model");
    assert.equal(calls, 1);
  } finally {
    await f.service.stop();
    f.store.close();
  }
});
test("worker loss checks stop a run and cancel pending orders before further execution", async () => {
  const f = fixture(async () => {
    throw new Error("Must not call");
  });
  try {
    const a = await f.create("1000");
    await f.service.update(a.id, (r) => {
      r.cash = "800";
      r.nextEvaluation = 0;
      submitOrder(
        r,
        { base: "BTC", side: "buy", type: "limit", price: "90", quantity: "1" },
        { received: Date.now(), bids: [["99", "10"]], asks: [["100", "10"]] },
        rules,
      );
    });
    await f.service.tick();
    const row = f.service.accounts.get(a.id);
    assert.equal(row.status, "risk_stopped");
    assert.equal(row.enabled, false);
    assert.equal(row.orders[0].status, "cancelled");
    assert.equal(row.fills.length, 0);
  } finally {
    await f.service.stop();
    f.store.close();
  }
});
test("SQLite retains audit records beyond bounded page histories", async () => {
  const f = fixture(async () => {});
  try {
    const a = await f.create("1000");
    await f.service.update(a.id, (r) => {
      r.journal.unshift({ id: "audit-only", time: 1, result: "Old entry" });
    });
    await f.service.update(a.id, (r) => {
      r.journal = [];
    });
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS count FROM decisions WHERE id=?")
        .get("audit-only").count,
      1,
    );
  } finally {
    f.store.close();
  }
});
