import test from "node:test";
import assert from "node:assert/strict";
import { SupabaseStore } from "./supabase-store.mjs";
import { TradingService } from "./service.mjs";
import { strategy } from "./test-fixtures.mjs";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_test-only",
};
const market = { books: {}, rules: {}, errors: {}, prices: () => ({}) };
function mockCloud({ refuseLease = false } = {}) {
  const rows = new Map(),
    requests = [];
  let rejectSave = false,
    gate;
  const request = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    requests.push({ url, options, body });
    if (url.includes("trading_claim_worker"))
      return Response.json(!refuseLease);
    if (url.includes("trading_release_worker"))
      return new Response(null, { status: 204 });
    if (url.includes("trading_accounts?"))
      return Response.json([...rows.values()]);
    if (url.includes("trading_save_account")) {
      if (gate) await gate;
      if (rejectSave) throw new Error("Network response lost");
      const a = body.p_account,
        old = rows.get(a.id);
      assert.equal(body.p_revision, old?.revision || 0);
      const revision = body.p_revision + 1;
      rows.set(a.id, { id: a.id, state: a, revision });
      return Response.json(revision);
    }
    throw new Error("Unexpected request");
  };
  return {
    rows,
    requests,
    request,
    fail: () => {
      rejectSave = true;
    },
    block: (promise) => {
      gate = promise;
    },
  };
}

test("cloud commits precede visibility, queued edits preserve one another and durable accounts reload", async () => {
  const cloud = mockCloud(),
    store = await SupabaseStore.open(env, cloud.request);
  const service = new TradingService(store, market, {});
  try {
    let release;
    cloud.block(
      new Promise((r) => {
        release = r;
      }),
    );
    const creating = service.create({ capital: "1000" });
    await new Promise((r) => setImmediate(r));
    assert.equal(
      service.snapshot().accounts.length,
      0,
      "uncommitted account remains invisible",
    );
    release();
    const account = await creating;
    await Promise.all([
      service.update(account.id, (a) => {
        a.cash = "900";
      }),
      service.update(account.id, (a) => {
        a.cash = String(Number(a.cash) - 100);
      }),
    ]);
    assert.equal(service.accounts.get(account.id).cash, "800");
    assert.equal(cloud.rows.get(account.id).state.cash, "800");
    assert.equal(store.all()[0].cash, "800");
    await service.update(account.id, (a) => {
      a.strategy = {
        ...strategy,
        revision: 3,
        updatedAt: Date.now(),
        marketAsOf: 1000,
        decisionId: "strategy-audit",
      };
      service.record(a, {
        id: "strategy-audit",
        action: "hold",
        result: "No order submitted.",
        strategy: structuredClone(a.strategy),
      });
    });
    const committed = cloud.requests
      .filter((r) => r.url.includes("trading_save_account"))
      .at(-1).body.p_account;
    assert.equal(committed.strategy.memory, strategy.memory);
    assert.deepEqual(
      committed.journal[0].strategy,
      committed.strategy,
      "plan and decision audit share one account transaction",
    );
    assert.equal(service.snapshot(true).storage, "supabase");
    assert.equal(
      cloud.requests[0].options.headers.apikey,
      env.SUPABASE_SECRET_KEY,
    );
    assert.equal(cloud.requests[0].options.headers.Authorization, undefined);
    assert(
      !JSON.stringify(service.snapshot()).includes(env.SUPABASE_SECRET_KEY),
    );
    await service.stop();
    await store.close();
    const reloaded = await SupabaseStore.open(env, cloud.request);
    assert.equal(reloaded.all()[0].cash, "800");
    assert.equal(reloaded.all()[0].strategy.memory, strategy.memory);
    assert.equal(reloaded.all()[0].strategy.revision, 3);
    await reloaded.close();
  } finally {
    await service.stop();
    await store.close();
  }
});

test("uncertain cloud saves stop further writes and prevent unconfirmed balance publication", async () => {
  const cloud = mockCloud(),
    store = await SupabaseStore.open(env, cloud.request);
  const service = new TradingService(store, market, {});
  try {
    const a = await service.create({ capital: "1000" });
    cloud.fail();
    await assert.rejects(
      service.update(a.id, (r) => {
        r.cash = "1";
      }),
      /not confirmed/,
    );
    assert.equal(service.accounts.get(a.id).cash, "1000");
    const count = cloud.requests.length;
    await assert.rejects(service.create({ capital: "300" }), /not confirmed/);
    await service.tick();
    assert.equal(
      cloud.requests.length,
      count,
      "failed storage cannot retry stale mutations",
    );
    assert.equal(service.snapshot(true).canWrite, false);
    assert.match(service.snapshot().storageError, /stopped/);
  } finally {
    await service.stop();
    await store.close();
  }
});

test("an occupied worker lease prevents account loading or writes", async () => {
  const cloud = mockCloud({ refuseLease: true });
  await assert.rejects(
    SupabaseStore.open(env, cloud.request),
    /Another trading worker/,
  );
  assert.equal(cloud.requests.length, 1);
});

test("legacy service keys use JWT authorization and incomplete cloud configuration fails", async () => {
  const cloud = mockCloud();
  const store = await SupabaseStore.open(
    { ...env, SUPABASE_SECRET_KEY: "legacy-test-jwt" },
    cloud.request,
  );
  assert.equal(
    cloud.requests[0].options.headers.Authorization,
    "Bearer legacy-test-jwt",
  );
  await store.close();
  await assert.rejects(
    SupabaseStore.open({ SUPABASE_URL: env.SUPABASE_URL }),
    /required/,
  );
  await assert.rejects(
    SupabaseStore.open({ ...env, SUPABASE_URL: "https://untrusted.example" }),
    /supabase.co/,
  );
});
