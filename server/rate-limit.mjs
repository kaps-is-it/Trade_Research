import { setTimeout as delay } from "node:timers/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// One gate per provider connection, shared by every model, run and catalog call.
export class ProviderLimiter {
  states = new Map();
  tails = new Map();
  constructor({
    path,
    now = Date.now,
    wait = (ms, signal) => delay(ms, null, { signal }),
    limit = 30,
  } = {}) {
    this.path = path;
    this.now = now;
    this.wait = wait;
    this.limit = limit;
    if (path && existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      for (const [provider, state] of Object.entries(saved)) {
        if (
          !Array.isArray(state.starts) ||
          !state.starts.every(Number.isFinite) ||
          !Number.isFinite(state.cooldownUntil)
        )
          throw new Error(
            "Invalid provider rate history. Keep the worker stopped for 60 seconds before removing this file.",
          );
        this.states.set(provider, { ...state, queued: 0 });
      }
    }
  }
  state(provider) {
    if (!this.states.has(provider))
      this.states.set(provider, {
        starts: [],
        cooldownUntil: 0,
        failures: 0,
        queued: 0,
      });
    const state = this.states.get(provider);
    state.starts = state.starts.filter((time) => time > this.now() - 60000);
    return state;
  }
  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(
      this.path + ".tmp",
      JSON.stringify(
        Object.fromEntries(
          [...this.states].map(([key, value]) => [
            key,
            { ...value, queued: 0 },
          ]),
        ),
      ),
    );
    renameSync(this.path + ".tmp", this.path);
  }
  snapshot(provider) {
    const state = this.state(provider);
    return {
      requestsPerMinute: this.limit,
      usedLastMinute: state.starts.length,
      queued: state.queued,
      cooldownUntil: state.cooldownUntil,
    };
  }
  async acquire(provider, signal) {
    if (provider === "ollama") {
      signal?.throwIfAborted();
      return;
    }
    const state = this.state(provider);
    state.queued++;
    const turn = (this.tails.get(provider) || Promise.resolve()).then(
      async () => {
        while (true) {
          signal?.throwIfAborted();
          const current = this.state(provider),
            now = this.now();
          const readyAt = Math.max(
            current.cooldownUntil,
            (current.starts.at(-1) ?? -Infinity) + 2050,
            current.starts.length >= this.limit ? current.starts[0] + 60001 : 0,
          );
          if (readyAt > now) {
            await this.wait(readyAt - now, signal);
            continue;
          }
          current.starts.push(now);
          // Reserve durably before any HTTP request; restart preserves the window.
          this.save();
          return;
        }
      },
    );
    this.tails.set(
      provider,
      turn.catch(() => {}),
    );
    try {
      await turn;
    } finally {
      state.queued--;
    }
  }
  async request(provider, send, signal) {
    await this.acquire(provider, signal);
    signal?.throwIfAborted();
    const response = await send();
    const state = this.state(provider);
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const seconds =
        retry !== null && retry.trim() !== "" ? Number(retry) : NaN;
      const retryAt = Number.isFinite(seconds)
        ? this.now() + seconds * 1000
        : Date.parse(retry || "");
      state.failures++;
      state.cooldownUntil = Math.max(
        state.cooldownUntil,
        this.now() + Math.min(120000, 60000 * 2 ** (state.failures - 1)),
        Number.isFinite(retryAt) ? retryAt : 0,
      );
      this.save();
    } else if (response.ok) {
      state.failures = 0;
    }
    return response;
  }
}
