import test from "node:test";
import assert from "node:assert/strict";
import { AccountStore } from "./store.mjs";
import { TradingService } from "./service.mjs";
import { createTradingServer } from "./index.mjs";

test("hosted API is public-read/owner-write, rejects cross-origin mutations and persists distinct accounts", async () => {
  const store = new AccountStore(":memory:"),
    market = { books: {}, rules: {}, errors: {}, prices: () => ({}) },
    service = new TradingService(store, market, {}),
    token = "test-token-at-least-24-characters";
  const server = createTradingServer(service, {
    TRADING_HOST: "0.0.0.0",
    TRADING_ADMIN_TOKEN: token,
    TRADING_ALLOWED_ORIGINS: "https://www.runthispr.com",
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/api/trading`;
  const post = (input, headers = {}) =>
    fetch(url + "/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(input),
    });
  try {
    assert.equal((await fetch(url).then((r) => r.json())).canWrite, false);
    assert.equal((await post({ capital: "1000" })).status, 401);
    assert.equal(
      (
        await post(
          { capital: "1000" },
          {
            Authorization: `Bearer ${token}`,
            Origin: "https://untrusted.example",
          },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          { capital: "1000" },
          { Authorization: "Bearer ééééééééééééééééééééééééééééééééééééééé" },
        )
      ).status,
      401,
    );
    for (const [capital, model] of [
      ["1000", "model-a"],
      ["300", "vendor/model-b"],
    ]) {
      const response = await post(
        { kind: "ai", capital, model },
        {
          Authorization: `Bearer ${token}`,
          Origin: "https://www.runthispr.com",
        },
      );
      assert.equal(response.status, 201);
    }
    const snapshot = await fetch(url).then((r) => r.json());
    assert.equal(snapshot.accounts.length, 2);
    assert.equal(snapshot.accounts[1].cash, "300");
    assert.equal(snapshot.accounts[0].status, "awaiting_model");
    assert.equal(store.all().length, 2);
    const reloaded = new TradingService(store, market, {});
    await reloaded.ready;
    assert.equal(reloaded.accounts.size, 2);
    await reloaded.stop();
    assert(!JSON.stringify(snapshot).includes(token));
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
test("public binding requires a long owner credential", () => {
  assert.throws(
    () => createTradingServer({}, { TRADING_HOST: "0.0.0.0" }),
    /24 characters/,
  );
});
