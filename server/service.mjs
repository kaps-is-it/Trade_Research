import { validateStrategy } from "./strategy.mjs";
import { randomUUID } from "node:crypto";
import { ProviderLimiter } from "./rate-limit.mjs";
import {
  SYMBOLS,
  D,
  newAccount,
  balances,
  equity,
  submitOrder,
  submitAIOrder,
  replaceAIOrder,
  accountOrderState,
  positionMetrics,
  cancelOrder,
  processOrders,
  checkBook,
} from "./ledger.mjs";
import {
  PROVIDERS,
  MODEL_PRESETS,
  modelTimeoutMs,
  modelOutputTokens,
  modelReasoningOptions,
  providerReady,
  modelConnection,
  requestDecision,
} from "./models.mjs";

export class TradingService {
  busy = new Map();
  progress = new Map();
  startedAt = Date.now();
  lastTickStartedAt = null;
  lastTickCompletedAt = null;
  lastTickError = null;
  watched = new Map();
  running = false;
  closed = false;
  pending = Promise.resolve();
  constructor(
    store,
    market,
    env = process.env,
    decide = requestDecision,
    limiter = new ProviderLimiter(),
  ) {
    this.store = store;
    this.market = market;
    this.env = env;
    this.decide = decide;
    this.limiter = limiter;
    this.accounts = new Map(store.all().map((a) => [a.id, a]));
    this.ready = this.recover();
  }
  async recover() {
    for (const account of this.accounts.values()) {
      const legacyDailyCap = "maxCalls" in account;
      delete account.maxCalls;
      if (
        account.kind === "ai" &&
        !account.enabled &&
        account.status === "error"
      )
        account.status = "paused";
      if (
        legacyDailyCap ||
        ["daily_limit", "reading_data", "evaluating"].includes(account.status)
      )
        account.nextEvaluation = Date.now();
      account.totalFees ??= account.fills
        .reduce((sum, f) => sum.plus(f.fee), D(0))
        .toFixed();
      account.fillCount ??= account.fills.length;
      if (
        ["evaluating", "daily_limit", "reading_data"].includes(account.status)
      ) {
        account.status = "waiting";
        this.record(account, {
          result:
            "Worker recovered. Continuous evaluation will use a fresh market snapshot.",
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
      if (account.kind === "ai" && account.executionVersion !== 3) {
        account.executionVersion = 3;
        this.record(account, {
          result:
            "AI market and GTC limit orders enabled with observed-depth fills. Existing resting limits are preserved; saved run controls are unchanged.",
        });
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
      if (account.kind === "ai") account.executionVersion = 3;
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
      cadenceSeconds: 1,
      worker: {
        startedAt: this.startedAt,
        lastTickStartedAt: this.lastTickStartedAt,
        lastTickCompletedAt: this.lastTickCompletedAt,
        lastError: this.lastTickError,
        inFlight: this.busy.size,
      },
      evaluationMode: "continuous",
      rateLimits: { nvidia: this.limiter.snapshot("nvidia") },
      symbols: SYMBOLS,
      assumptions: {
        feePercent: "0.10",
        minimumLatencyMs: 500,
        depth: 20,
        limitFills:
          "Only executable opposite-side depth; no candle-touch or queue-position fills.",
        aiExecution:
          "Market and GTC limit orders use observed top-20 depth after 500 ms. Partial fills supported; queue position and market impact are approximations.",
        quote: "USDT",
      },
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({
        id,
        label: p.label,
        configured: providerReady(id, this.env),
        models: MODEL_PRESETS[id] || [],
        maxOutputTokens: modelOutputTokens(id, this.env),
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
        return {
          ...publicAccount,
          ...balances(a),
          equity: equity(a, prices),
          positions: positionMetrics(a, this.market.books, this.market.errors),
          evaluation: this.progress.get(a.id) || null,
          inferenceSettings: {
            outputTokens: modelOutputTokens(a.provider, this.env),
            timeoutMs: modelTimeoutMs(a.provider, this.env),
            reasoningEffort:
              modelReasoningOptions(a.provider, a.model, this.env)
                .reasoning_effort || null,
          },
        };
      }),
    };
  }
  async catalog(provider) {
    if (!providerReady(provider, this.env)) return [];
    const { base, headers } = modelConnection(provider, this.env);
    const signal = AbortSignal.timeout(60000);
    const r = await this.limiter.request(
      provider,
      () => fetch(`${base}/models`, { headers, signal }),
      signal,
    );
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
      a.nextEvaluation = Date.now();
      if (!a.enabled) this.busy.get(id)?.abort();
      this.record(a, {
        result: a.enabled
          ? "Run resumed. Continuous market evaluation enabled."
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
    this.lastTickStartedAt = Date.now();
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
      for (const account of [...this.accounts.values()].sort(
        (a, b) =>
          a.nextEvaluation - b.nextEvaluation ||
          (a.lastEvaluation || 0) - (b.lastEvaluation || 0),
      ))
        if (
          this.busy.size < 6 &&
          account.kind === "ai" &&
          account.enabled &&
          !this.busy.has(account.id) &&
          Date.now() >= account.nextEvaluation
        )
          void this.evaluate(account.id).catch((error) => {
            this.lastError = error.message;
          });
      this.lastTickError = null;
    } catch (error) {
      this.lastError = error.message;
      this.lastTickError = error.message;
    } finally {
      this.lastTickCompletedAt = Date.now();
      this.running = false;
    }
  }
  async evaluate(id) {
    if (this.closed || this.busy.has(id)) return;
    const controller = new AbortController();
    this.busy.set(id, controller);
    const startedAt = Date.now();
    const deadlineAt =
      startedAt + modelTimeoutMs(this.accounts.get(id)?.provider, this.env);
    const onStage = (stage) => {
      if (!controller.signal.aborted && !this.closed)
        this.progress.set(id, {
          stage,
          startedAt,
          stageStartedAt: Date.now(),
          deadlineAt,
        });
    };
    onStage("reading_data");
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
        a.nextEvaluation = Date.now();
        a.status = "reading_data";
      });
      // History may take seconds; get the executable quote after it completes.
      const candles = await this.market.history(account.base),
        book = await this.market.refresh(account.base);
      checkBook(book, Date.now());
      account = this.accounts.get(id);
      if (!account.enabled || controller.signal.aborted) return;
      const candleTime = candles.at(-1).time;
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
      let snapshot;
      const evaluatedAccount = await this.update(id, (a) => {
        if (!a.enabled || controller.signal.aborted) return null;
        checkBook(book, Date.now());
        snapshot = {
          asOf: Date.now(),
          previousEvaluationAt: a.lastEvaluation || null,
          positions: positionMetrics(a, this.market.books, this.market.errors),
          bid: book.bids[0][0],
          ask: book.asks[0][0],
          candles,
          rules: this.market.rules[a.base],
          available: balances(a).available,
          orderCeiling: D(a.initial).mul(a.maxOrderPercent).div(100).toFixed(),
          minimumEquity: minimum.toFixed(),
        };
        a.status = "evaluating";
        a.calls++;
        a.lastCandle = candleTime;
        a.lastEvaluation = Date.now();
        return structuredClone(a);
      });
      if (!evaluatedAccount || controller.signal.aborted) return;
      const evaluatedState = accountOrderState(evaluatedAccount);
      this.store.assertHealthy?.();
      onStage("provider_queue");
      const result = await this.decide(evaluatedAccount, snapshot, {
        env: this.env,
        signal: controller.signal,
        limiter: this.limiter,
        onStage,
      });
      onStage("execution_check");
      if (
        this.closed ||
        controller.signal.aborted ||
        !this.accounts.get(id)?.enabled
      )
        return;
      // A hold/cancel does not need new execution liquidity. Preserve its journal
      // even if the exchange becomes unavailable after the model responded.
      let executionBook, executionError;
      if (["buy", "sell", "replace"].includes(result.decision.action)) {
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
        const strategy = validateStrategy(d.strategy);
        const changed = evaluatedState !== accountOrderState(a);
        if (!changed) {
          if (!D(a.holdings[a.base]?.quantity || 0).gt(0))
            strategy.exitUrgency = 0;
          a.strategy = {
            ...strategy,
            revision: (a.strategy?.revision || 0) + 1,
            updatedAt: Date.now(),
            marketAsOf: snapshot.asOf,
            decisionId,
          };
        }
        a.inputTokens += result.inputTokens;
        a.outputTokens += result.outputTokens;
        let outcome = "No order submitted.",
          status = "waiting";
        let orderId;
        if (changed) {
          outcome =
            "Account orders or holdings changed during this evaluation. Outdated action and strategy discarded; a fresh evaluation will follow.";
        } else
          try {
            const review = {
              time: Date.now(),
              decisionId,
              strategyRevision: a.strategy.revision,
              rationale: d.rationale,
            };
            if (d.action === "cancel") {
              const target = a.orders.find((o) => o.id === d.orderId);
              cancelOrder(a, d.orderId);
              target.lastReview = review;
              orderId = d.orderId;
              outcome = `Order cancelled: ${d.orderId}. Unfilled reservations released.`;
            }
            if (["buy", "sell", "replace"].includes(d.action)) {
              if (executionError) throw executionError;
              const currentValue = equity(a, this.market.prices());
              if (currentValue === null || D(currentValue).lte(minimum))
                throw new Error(
                  "Account valuation failed the execution-time loss check.",
                );
              const input = {
                base: a.base,
                side: d.action,
                type: d.type,
                quantity: d.quantity,
                price: d.price,
                decisionId,
              };
              const order =
                d.action === "replace"
                  ? replaceAIOrder(
                      a,
                      d.orderId,
                      input,
                      executionBook,
                      this.market.rules[a.base],
                    )
                  : submitAIOrder(
                      a,
                      input,
                      executionBook,
                      this.market.rules[a.base],
                    );
              orderId = order.id;
              order.intent = {
                strategyRevision: a.strategy.revision,
                rationale: d.rationale,
                condition:
                  order.side === "buy"
                    ? a.strategy.entryConditions
                    : a.strategy.exitConditions,
                invalidation: a.strategy.invalidation,
              };
              order.lastReview = review;
              if (d.action === "replace")
                a.orders.find((o) => o.id === d.orderId).lastReview = review;
              outcome = `${d.action === "replace" ? "Order replaced" : "Order accepted"}: ${order.id}. ${order.side} ${order.quantity} ${order.base} ${order.type === "limit" ? `at ${order.limit} USDT or better (GTC)` : "at available market depth (IOC)"}; pending execution after at least 500 ms.`;
            }
            if (d.action === "hold") {
              for (const order of a.orders.filter((o) =>
                ["open", "partial"].includes(o.status),
              ))
                order.lastReview = review;
              outcome =
                "No change. Existing positions and pending orders retained.";
            }
          } catch (error) {
            outcome = error.message;
            status = "risk_blocked";
          }
        a.status = status;
        a.consecutiveErrors = 0;
        a.lastError = null;
        a.lastDecisionAt = Date.now();
        a.lastDecisionAction = changed ? "discarded" : d.action;
        this.record(a, {
          id: decisionId,
          strategy: changed ? undefined : structuredClone(a.strategy),
          staleDecision: changed,
          orderId,
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
          if (!a.enabled || this.closed) return;
          a.status = "error";
          a.consecutiveErrors = (a.consecutiveErrors || 0) + 1;
          a.lastError = error.message;
          this.record(a, { result: error.message });
        });
      else if (!this.closed && this.accounts.get(id)?.enabled)
        await this.update(id, (a) => {
          if (!a.enabled || this.closed) return;
          a.status = "error";
          a.consecutiveErrors = (a.consecutiveErrors || 0) + 1;
          a.lastError =
            "Evaluation timed out. The run will retry automatically.";
          this.record(a, {
            result: "Evaluation timed out. No model order was executed.",
          });
        });
    } finally {
      clearTimeout(timeout);
      try {
        if (
          !this.closed &&
          !this.store.failed &&
          this.accounts.get(id)?.enabled
        )
          await this.update(id, (a) => {
            a.nextEvaluation =
              Date.now() +
              (a.status === "awaiting_model"
                ? 30000
                : a.consecutiveErrors
                  ? Math.min(
                      120000,
                      15000 * 2 ** Math.min(3, a.consecutiveErrors - 1),
                    )
                  : 1000);
          });
      } finally {
        this.busy.delete(id);
        this.progress.delete(id);
      }
    }
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 1000);
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
