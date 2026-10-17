import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderLimiter } from "./rate-limit.mjs";

function clock() {
  let time = 100000;
  return {
    now: () => time,
    wait: async (ms, signal) => {
      signal?.throwIfAborted();
      time += ms;
    },
  };
}
test("all concurrent NVIDIA requests share a paced rolling-minute budget without serializing responses", async () => {
  const c = clock(),
    limiter = new ProviderLimiter(c),
    starts = [];
  limiter.save = () => starts.push(c.now());
  let finish;
  const reply = new Promise((r) => {
    finish = r;
  });
  let entered = 0;
  const work = Array.from({ length: 65 }, () =>
    limiter.request("nvidia", () => {
      entered++;
      return reply;
    }),
  );
  while (entered < 65) await new Promise((r) => setImmediate(r));
  assert.equal(
    starts.length,
    65,
    "in-flight responses do not hold the request-start queue",
  );
  for (const start of starts)
    assert(starts.filter((t) => t > start - 60000 && t <= start).length <= 30);
  for (let i = 1; i < starts.length; i++)
    assert(starts[i] - starts[i - 1] >= 2050);
  finish(Response.json({}));
  await Promise.all(work);
});
test("429 applies a shared cooldown and honors Retry-After before another run can start", async () => {
  const c = clock(),
    limiter = new ProviderLimiter(c),
    initial = c.now();
  await limiter.request("nvidia", () =>
    Promise.resolve(
      new Response(null, { status: 429, headers: { "Retry-After": "90" } }),
    ),
  );
  assert.equal(limiter.snapshot("nvidia").cooldownUntil, initial + 90000);
  await limiter.request("nvidia", () => {
    assert(c.now() >= initial + 90000);
    return Promise.resolve(Response.json({}));
  });
});
test("aborted queued work never starts an HTTP request", async () => {
  const controller = new AbortController();
  controller.abort();
  const limiter = new ProviderLimiter(clock());
  await assert.rejects(
    limiter.request(
      "nvidia",
      () => {
        throw new Error("Must not send");
      },
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(limiter.snapshot("nvidia").queued, 0);
  assert.equal(limiter.snapshot("nvidia").usedLastMinute, 0);
});
test("request history survives worker restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runthispr-rate-")),
    path = join(dir, "history.json"),
    c = clock();
  try {
    await new ProviderLimiter({ ...c, path }).request("nvidia", () =>
      Promise.resolve(Response.json({})),
    );
    const reloaded = new ProviderLimiter({ ...c, path });
    assert.equal(reloaded.snapshot("nvidia").usedLastMinute, 1);
    const prior = c.now();
    await reloaded.request("nvidia", () => {
      assert(c.now() >= prior + 2050);
      return Promise.resolve(Response.json({}));
    });
  } finally {
    rmSync(path, { force: true });
    rmSync(path + ".tmp", { force: true });
    rmdirSync(dir);
  }
});
