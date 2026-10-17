import { randomUUID } from "node:crypto";
import {
  SYMBOLS,
  D,
  newAccount,
  balances,
  equity,
  submitOrder,
  cancelOrder,
  processOrders,
  checkBook,
} from "./ledger.mjs";
import {
  PROVIDERS,
  MODEL_PRESETS,
  modelTimeoutMs,
  providerReady,
  modelConnection,
  requestDecision,
} from "./models.mjs";

export class TradingService {
  busy = new Map();
  watched = new Map();
  running = false;
  closed = false;
  pending = Promise.resolve();
  constructor(store, market, env = process.env, decide = requestDecision) {
    this.store = store;
    this.market = market;
    this.env = env;
    this.decide = decide;
    this.accounts = new Map(store.all().map((a) => [a.id, a]));
    this.ready = this.recover();
  }
  async recover() {
    for (const account of this.accounts.values()) {
      account.totalFees ??= account.fills
        .reduce((sum, f) => sum.plus(f.fee), D(0))
        .toFixed();
      account.fillCount ??= account.fills.length;
      if (account.status === "evaluating") {
        account.status = "waiting";
        this.record(account, {
          result: "Interrupted evaluation was not replayed after restart.",
        });
      }
      for (const order of account.orders)
        if (
          ["open", "partial"].includes(order.status) &&
          order.type === "market"
        ) {
          order.status = "cancelled";
          order.reason = "Worker restarted before this market order completed.";
        }
      await this.store.save(account);
    }
  }
  record(account, entry) {
    account.journal.unshift({ id: randomUUID(), time: Date.now(), ...entry });
    account.journal = account.journal.slice(0, 200);
  }
  enqueue(fn) {
    const operation = this.pending.then(async () => {
      await this.ready;
      if (this.closed) throw new Error("Trading backend is stopping.");
      this.store.assertHealthy?.();
      return fn();
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  update(id, fn) {
    return this.enqueue(async () => {
      const original = this.accounts.get(id);
      if (!original) throw new Error("Account not found.");
      const next = structuredClone(original);
      const result = fn(next);
      if (JSON.stringify(next) !== JSON.stringify(original)) {
        await this.store.save(next);
        this.accounts.set(id, next);
      }
      return result;
    });
  }
  create(input) {
    return this.enqueue(async () => {
      if (this.accounts.size >= 32)
        throw new Error("This workspace supports up to 32 accounts.");
      const account = newAccount(input);
      if (account.kind === "ai" && !providerReady(account.provider, this.env))
        account.status = "awaiting_model";
      this.record(account, {
        result:
          account.kind === "ai"
            ? "Run created. Independent account and limits saved."
            : "Manual paper account created.",
      });
      await this.store.save(account);
      this.accounts.set(account.id, account);
      return account;
    });
  }
  snapshot(canWrite = false) {
    const prices = this.market.prices();
    return {
      canWrite: canWrite && !this.store.failed,
      serverTime: Date.now(),
      storage: this.store.kind || "sqlite",
      storageError: this.store.failed?.message || null,
      cadenceSeconds: 300,
      symbols: SYMBOLS,
      assumptions: {
        feePercent: "0.10",
        minimumLatencyMs: 500,
        depth: 20,
        limitFills:
          "Only executable opposite-side depth; no candle-touch or queue-position fills.",
        quote: "USDT",
      },
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({
        id,
        label: p.label,
        configured: providerReady(id, this.env),
        models: MODEL_PRESETS[id] || [],
      })),
      markets: Object.fromEntries(
        Object.entries(this.market.books).map(([base, b]) => [
          base,
          {
            bid: b.bids[0][0],
            ask: b.asks[0][0],
            received: b.received,
            error: this.market.errors[base] || null,
            rules: this.market.rules[base],
          },
        ]),
      ),
      accounts: [...this.accounts.values()].map((a) => {
        const { consumed, ...publicAccount } = a;
        return { ...publicAccount, ...balances(a), equity: equity(a, prices) };
      }),
    };
  }
  async catalog(provider) {
    if (!providerReady(provider, this.env)) return [];
    const { base, headers } = modelConnection(provider, this.env);
    const r = await fetch(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`Model catalog returned HTTP ${r.status}.`);
    const data = await r.json();
    return (data.data || [])
      .map((m) => ({ id: m.id, label: m.name || m.id }))
      .filter((m) => typeof m.id === "string")
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 2000);
  }
  async order(id, input) {
    const account = this.accounts.get(id);
    if (!account || account.kind !== "manual")
      throw new Error("Manual orders require a manual account.");
    const book = await this.market.refresh(input.base);
    return this.update(id, (a) =>
      submitOrder(a, input, book, this.market.rules[input.base]),
    );
  }
  control(id, action) {
    return this.update(id, (a) => {
      if (a.kind !== "ai" || !["pause", "resume"].includes(action))
        throw new Error("Invalid run control.");
      a.enabled = action === "resume";
      a.status = !a.enabled
        ? "paused"
        : providerReady(a.provider, this.env)
          ? "waiting"
          : "awaiting_model";
      a.nextEvaluation = Math.ceil((Date.now() + 1) / 300000) * 300000;
      if (!a.enabled) this.busy.get(id)?.abort();
      this.record(a, {
        result: a.enabled
          ? "Run resumed. Awaiting the next closed candle."
          : "Run paused. Existing orders remain monitored.",
      });
    });
  }
  cancel(id, orderId) {
    return this.update(id, (a) => cancelOrder(a, orderId));
  }
  watch(base) {
    if (SYMBOLS.includes(base)) this.watched.set(base, Date.now());
  }
  async tick() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      await this.ready;
      this.store.assertHealthy?.();
      const needed = new Set(
        [...this.watched]
          .filter(([, t]) => Date.now() - t < 15000)
          .map(([b]) => b),
      );
      for (const a of this.accounts.values()) {
        if (a.kind === "ai" && a.enabled) needed.add(a.base);
        for (const [b, h] of Object.entries(a.holdings))
          if (D(h.quantity).gt(0)) needed.add(b);
        for (const o of a.orders)
          if (["open", "partial"].includes(o.status)) needed.add(o.base);
      }
      // Bound exchange concurrency; do not launch one feed per simulation.
      const bases = [...needed];
      for (let i = 0; i < bases.length; i += 3)
        await Promise.allSettled(
          bases.slice(i, i + 3).map((b) => this.market.refresh(b)),
        );
      for (const a of [...this.accounts.values()]) {
        if (a.kind === "ai" && a.enabled) {
          const value = equity(a, this.market.prices());
          if (
            value !== null &&
            D(value).lte(
              D(a.initial).mul(D(100).minus(a.lossLimitPercent)).div(100),
            )
          ) {
            await this.update(a.id, (next) => {
              next.enabled = false;
              next.status = "risk_stopped";
              this.busy.get(a.id)?.abort();
              for (const o of next.orders.filter((o) =>
                ["open", "partial"].includes(o.status),
              ))
                cancelOrder(next, o.id);
              this.record(next, {
                result:
                  "Equity loss limit reached. Run stopped; open orders cancelled. Holdings remain in the account.",
              });
            });
            continue;
          }
        }
        // Read the latest account inside the mutation queue, after any API writes.
        await this.update(a.id, (next) => {
          for (const b of needed) {
            if (
              !next.orders.some(
                (o) => o.base === b && ["open", "partial"].includes(o.status),
              )
            )
              continue;
            const book = this.market.books[b];
            if (
              !book ||
              Date.now() - book.received > 5000 ||
              this.market.errors[b]
            )
              continue;
            processOrders(next, b, book);
          }
        });
      }
      for (const account of this.accounts.values())
        if (
          this.busy.size < 2 &&
          account.kind === "ai" &&
          account.enabled &&
          !this.busy.has(account.id) &&
          Date.now() >= account.nextEvaluation
        )
          void this.evaluate(account.id).catch((error) => {
            this.lastError = error.message;
          });
    } catch (error) {
      this.lastError = error.message;
    } finally {
      this.running = false;
    }
  }
  async evaluate(id) {
    if (this.closed || this.busy.has(id)) return;
    const controller = new AbortController();
    this.busy.set(id, controller);
    const timeout = setTimeout(
      () => controller.abort(),
      modelTimeoutMs(this.accounts.get(id)?.provider, this.env),
    );
    try {
      await this.ready;
      this.store.assertHealthy?.();
      let account = this.accounts.get(id);
      if (!account?.enabled) return;
      if (!providerReady(account.provider, this.env)) {
        await this.update(id, (a) => {
          a.status = "awaiting_model";
          a.nextEvaluation = Date.now() + 30000;
        });
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      await this.update(id, (a) => {
        if (!a.enabled || controller.signal.aborted) return;
        if (a.callDay !== today) {
          a.callDay = today;
          a.calls = 0;
        }
        a.nextEvaluation = Math.ceil((Date.now() + 1) / 300000) * 300000;
        if (a.calls >= a.maxCalls) {
          a.status = "daily_limit";
          return;
        }
        a.status = "reading_data";
      });
      if (this.accounts.get(id).status === "daily_limit") return;
      const book = await this.market.refresh(account.base),
        candles = await this.market.history(account.base);
      checkBook(book, Date.now());
      account = this.accounts.get(id);
      if (!account.enabled || controller.signal.aborted) return;
      const candleTime = candles.at(-1).time;
      if (account.lastCandle >= candleTime) {
        await this.update(id, (a) => {
          a.status = "waiting";
        });
        return;
      }
      const value = equity(account, this.market.prices()),
        minimum = D(account.initial)
          .mul(D(100).minus(account.lossLimitPercent))
          .div(100);
      if (value === null) throw new Error("Holding valuation is stale.");
      if (D(value).lte(minimum)) {
        await this.update(id, (a) => {
          a.enabled = false;
          a.status = "risk_stopped";
          for (const o of a.orders.filter((o) =>
            ["open", "partial"].includes(o.status),
          ))
            cancelOrder(a, o.id);
          this.record(a, {
            result:
              "Equity loss limit reached. Run stopped; open orders cancelled. Holdings remain in the account.",
          });
        });
        return;
      }
      const snapshot = {
        asOf: Date.now(),
        bid: book.bids[0][0],
        ask: book.asks[0][0],
        candles,
        rules: this.market.rules[account.base],
        available: balances(account).available,
        orderCeiling: D(account.initial)
          .mul(account.maxOrderPercent)
          .div(100)
          .toFixed(),
        minimumEquity: minimum.toFixed(),
      };
      await this.update(id, (a) => {
        if (!a.enabled || controller.signal.aborted) return;
        a.status = "evaluating";
        a.calls++;
        a.lastCandle = candleTime;
        a.lastEvaluation = Date.now();
      });
      if (controller.signal.aborted || !this.accounts.get(id)?.enabled) return;
      this.store.assertHealthy?.();
      const result = await this.decide(this.accounts.get(id), snapshot, {
        env: this.env,
        signal: controller.signal,
      });
      if (
        this.closed ||
        controller.signal.aborted ||
        !this.accounts.get(id)?.enabled
      )
        return;
      // A hold/cancel does not need new execution liquidity. Preserve its journal
      // even if the exchange becomes unavailable after the model responded.
      let executionBook, executionError;
      if (["buy", "sell"].includes(result.decision.action)) {
        try {
          executionBook = await this.market.refresh(account.base);
        } catch (error) {
          executionError = error;
        }
      }
      if (
        this.closed ||
        controller.signal.aborted ||
        !this.accounts.get(id)?.enabled
      )
        return;
      await this.update(id, (a) => {
        if (controller.signal.aborted || !a.enabled) return;
        const decisionId = randomUUID(),
          d = result.decision;
        a.inputTokens += result.inputTokens;
        a.outputTokens += result.outputTokens;
        let outcome = "No order submitted.",
          status = "waiting";
        try {
          if (d.action === "cancel") {
            cancelOrder(a, d.orderId);
            outcome = "Order cancelled.";
          }
          if (d.action === "buy" || d.action === "sell") {
            if (executionError) throw executionError;
            const currentValue = equity(a, this.market.prices());
            if (currentValue === null || D(currentValue).lte(minimum))
              throw new Error(
                "Account valuation failed the execution-time loss check.",
              );
            const order = submitOrder(
              a,
              {
                base: a.base,
                side: d.action,
                type: d.type,
                quantity: d.quantity,
                price: d.price,
                decisionId,
              },
              executionBook,
              this.market.rules[a.base],
            );
            outcome = `Order accepted: ${order.id}`;
          }
        } catch (error) {
          outcome = error.message;
          status = "risk_blocked";
        }
        a.status = status;
        this.record(a, {
          id: decisionId,
          action: d.action,
          rationale: d.rationale,
          result: outcome,
          status,
          asOf: snapshot.asOf,
          candleTime,
          evidence: {
            bid: snapshot.bid,
            ask: snapshot.ask,
            closedCandles: candles.length,
            available: snapshot.available,
          },
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
      });
    } catch (error) {
      if (this.store.failed) {
        this.lastError = this.store.failed.message;
        return;
      }
      if (
        !this.closed &&
        this.accounts.get(id)?.enabled &&
        !controller.signal.aborted
      )
        await this.update(id, (a) => {
          a.status = "error";
          this.record(a, { result: error.message });
        });
      else if (!this.closed && this.accounts.get(id)?.enabled)
        await this.update(id, (a) => {
          a.status = "error";
          this.record(a, {
            result: "Evaluation timed out. No model order was executed.",
          });
        });
    } finally {
      clearTimeout(timeout);
      this.busy.delete(id);
    }
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 2000);
    void this.tick();
  }
  async stop() {
    this.closed = true;
    clearInterval(this.timer);
    for (const c of this.busy.values()) c.abort();
    while (this.running || this.busy.size)
      await new Promise((r) => setTimeout(r, 25));
    await this.pending;
  }
}
