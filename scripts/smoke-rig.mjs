// Opt-in live integration test. Uses its own SQLite account and random local
// HTTP port; never attaches to Supabase, the public worker or existing runs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { AccountStore } from "../server/store.mjs";
import { TradingMarket } from "../server/market.mjs";
import { TradingService } from "../server/service.mjs";
import { createTradingServer } from "../server/index.mjs";

if (!process.env.NVIDIA_NIM_API_KEY)
  throw new Error("Configure NVIDIA_NIM_API_KEY first.");
const model = process.argv.slice(2).find((a) => a !== "--") || "z-ai/glm-5.3";
mkdirSync("data", { recursive: true });
const path = `data/rig-audit-${Date.now()}.sqlite`;
const store = new AccountStore(path);
const market = new TradingMarket();
const service = new TradingService(store, market);
const server = createTradingServer(service, {
  TRADING_HOST: "127.0.0.1",
  TRADING_PUBLIC_MODE: "true",
  TRADING_ADMIN_TOKEN: randomUUID(),
});
let account, restored;
try {
  await service.ready;
  account = await service.create({
    kind: "ai",
    provider: "nvidia",
    model,
    capital: "1000",
    name: "Isolated live rig audit",
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  service.start();
  const url = `http://127.0.0.1:${server.address().port}/api/trading`;
  const completed = new Map();
  const deadline = Date.now() + 600000;
  let lastPhase;
  while (Date.now() < deadline) {
    const snapshot = await (await fetch(url)).json();
    const row = snapshot.accounts.find((a) => a.id === account.id);
    const phase = row.evaluation?.stage || row.status;
    if (phase !== lastPhase) {
      console.log(
        JSON.stringify({
          phase,
          attempts: row.calls,
          completed: completed.size,
        }),
      );
      lastPhase = phase;
    }
    for (const entry of row.journal.filter((j) => j.action))
      completed.set(entry.id, entry);
    if (completed.size >= 3 && row.strategy?.revision >= 2) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await service.control(account.id, "pause");
  await service.stop();
  const saved = structuredClone(service.accounts.get(account.id));
  assert(
    completed.size >= 3,
    "Three model decisions must complete under automatic scheduling.",
  );
  assert(
    saved.strategy?.revision >= 2,
    "Strategy memory must be revised across decisions.",
  );
  const evidence = {
    status: "ok",
    model,
    completedDecisions: completed.size,
    attempts: saved.calls,
    strategyRevision: saved.strategy.revision,
    actions: [...completed.values()].map((j) => ({
      action: j.action,
      status: j.status,
      stale: !!j.staleDecision,
      result: j.result,
    })),
    fills: saved.fills.length,
    finalStatus: saved.status,
    database: path,
  };
  // Reload through a new coordinator, with the live model disabled.
  restored = new TradingService(store, market, {});
  await restored.ready;
  const reloaded = restored.accounts.get(account.id);
  assert.deepEqual(reloaded.strategy, saved.strategy);
  assert.equal(reloaded.enabled, false);
  assert.equal(reloaded.orders.length, saved.orders.length);
  for (const order of saved.orders) {
    const current = reloaded.orders.find((o) => o.id === order.id);
    if (order.type === "market" && ["open", "partial"].includes(order.status))
      assert.equal(current.status, "cancelled");
    else assert.deepEqual(current, order);
  }
  evidence.memoryReloaded = true;
  writeFileSync(
    path.replace(".sqlite", ".json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  if (account && !service.closed)
    await service.control(account.id, "pause").catch(() => {});
  await service.stop();
  await restored?.stop();
  await new Promise((r) => server.close(r));
  store.close();
}
