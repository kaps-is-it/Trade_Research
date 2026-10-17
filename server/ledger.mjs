import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });
export const SYMBOLS = [
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "DOGE",
  "ADA",
  "AVAX",
  "LINK",
  "DOT",
  "LTC",
  "BCH",
  "UNI",
];
export const FEE = new Decimal("0.001");
export const D = (value) => new Decimal(value);
export function positive(value, label = "Amount") {
  if (
    typeof value !== "string" ||
    !/^(?:\d{1,16}(?:\.\d{1,18})?|\.\d{1,18})$/.test(value) ||
    !D(value).isPositive()
  )
    throw new Error(
      `${label} must be a positive decimal, with up to 18 decimal places.`,
    );
  return D(value);
}
export function newAccount(input, now = Date.now()) {
  const initial = positive(input.capital, "Starting balance");
  if (initial.lt(1) || initial.gt("1000000000"))
    throw new Error(
      "Starting balance must be between 1 and 1,000,000,000 USDT.",
    );
  const kind = input.kind === "ai" ? "ai" : "manual";
  const name = String(
    input.name || (kind === "ai" ? "Strategy run" : "Manual account"),
  )
    .trim()
    .slice(0, 60);
  if (!name) throw new Error("Give the account a name.");
  const base = input.base || "BTC";
  if (!SYMBOLS.includes(base))
    throw new Error("Select a supported Binance USDT market.");
  const provider = input.provider || "openai",
    model = String(input.model || "").trim();
  if (
    kind === "ai" &&
    (!["openai", "openrouter", "ollama", "nvidia"].includes(provider) ||
      !/^[\w./:@+-]{1,160}$/.test(model))
  )
    throw new Error("Select a provider and enter its exact model ID.");
  const maxOrderPercent = Number(input.maxOrderPercent ?? 100),
    lossLimitPercent = Number(input.lossLimitPercent ?? 100);
  if (
    ![maxOrderPercent, lossLimitPercent].every(
      (n) => Number.isFinite(n) && n >= 1 && n <= 100,
    )
  )
    throw new Error("Risk percentages must be 1–100.");
  return {
    id: randomUUID(),
    kind,
    name,
    base,
    initial: initial.toFixed(),
    cash: initial.toFixed(),
    holdings: {},
    orders: [],
    fills: [],
    journal: [],
    created: now,
    enabled: kind === "ai",
    status: kind === "ai" ? "waiting" : "ready",
    provider,
    model,
    maxOrderPercent,
    lossLimitPercent,
    calls: 0,
    callDay: new Date(now).toISOString().slice(0, 10),
    lastCandle: 0,
    nextEvaluation: now,
    totalFees: "0",
    fillCount: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}
export function balances(account) {
  let reserved = D(0);
  const reservedAssets = {};
  for (const order of account.orders.filter(
    (o) => o.status === "open" || o.status === "partial",
  )) {
    if (order.side === "buy")
      reserved = reserved.plus(
        D(order.remaining).mul(order.reservePrice).mul(D(1).plus(FEE)),
      );
    else
      reservedAssets[order.base] = D(reservedAssets[order.base] || 0)
        .plus(order.remaining)
        .toFixed();
  }
  return {
    available: D(account.cash).minus(reserved).toFixed(),
    reserved: reserved.toFixed(),
    reservedAssets,
  };
}
export function equity(account, prices) {
  let value = D(account.cash);
  for (const [base, holding] of Object.entries(account.holdings)) {
    if (D(holding.quantity).gt(0) && !prices[base]) return null;
    value = value.plus(D(holding.quantity).mul(prices[base] || 0));
  }
  return value.toFixed();
}
export function checkBook(book, now) {
  if (
    !book ||
    now - book.received > 5000 ||
    now < book.received ||
    !book.bids?.length ||
    !book.asks?.length ||
    D(book.bids[0][0]).gte(book.asks[0][0])
  )
    throw new Error("A fresh, valid two-sided order book is required.");
}
function open(o) {
  return o.status === "open" || o.status === "partial";
}
export function submitOrder(account, input, book, rules, now = Date.now()) {
  if (
    !SYMBOLS.includes(input.base) ||
    !["buy", "sell"].includes(input.side) ||
    !["market", "limit"].includes(input.type)
  )
    throw new Error("Invalid order market, side or type.");
  if (account.orders.filter(open).length >= 50)
    throw new Error("Cancel an open order before adding more (limit: 50).");
  checkBook(book, now);
  if (!rules) throw new Error("Exchange instrument rules have not loaded.");
  const quantity = positive(input.quantity, "Quantity");
  const lot =
    input.type === "market" && D(rules.marketStep || 0).gt(0)
      ? rules.marketStep
      : rules.step;
  const minQty =
    input.type === "market" && D(rules.marketMin || 0).gt(0)
      ? rules.marketMin
      : rules.minQty;
  if (
    !quantity.mod(lot).isZero() ||
    quantity.lt(minQty) ||
    quantity.gt(rules.maxQty) ||
    (input.type === "market" &&
      D(rules.marketMax || 0).gt(0) &&
      quantity.gt(rules.marketMax))
  )
    throw new Error(
      `Quantity must follow step ${lot} and the exchange's size limits.`,
    );
  const price =
    input.type === "limit"
      ? positive(input.price, "Limit price")
      : D(input.side === "buy" ? book.asks[0][0] : book.bids[0][0]);
  if (
    input.type === "limit" &&
    (!price.mod(rules.tick).isZero() ||
      price.lt(rules.minPrice) ||
      price.gt(rules.maxPrice))
  )
    throw new Error(
      `Price must follow tick ${rules.tick} and the exchange's price limits.`,
    );
  if (
    quantity.mul(price).lt(rules.minNotional) ||
    (rules.maxNotional && quantity.mul(price).gt(rules.maxNotional))
  )
    throw new Error(
      `Order value must satisfy the exchange notional limits (minimum ${rules.minNotional} USDT).`,
    );
  const available = balances(account);
  if (
    input.side === "buy" &&
    quantity.mul(price).mul(D(1).plus(FEE)).gt(available.available)
  )
    throw new Error("Insufficient available USDT, including fees.");
  if (
    input.side === "sell" &&
    quantity.gt(
      D(account.holdings[input.base]?.quantity || 0).minus(
        available.reservedAssets[input.base] || 0,
      ),
    )
  )
    throw new Error("Insufficient available crypto holdings.");
  if (
    account.kind === "ai" &&
    input.side === "buy" &&
    quantity
      .mul(price)
      .gt(D(account.initial).mul(account.maxOrderPercent).div(100))
  )
    throw new Error("Order exceeds the run’s configured order ceiling.");
  const order = {
    id: randomUUID(),
    base: input.base,
    side: input.side,
    type: input.type,
    quantity: quantity.toFixed(),
    remaining: quantity.toFixed(),
    reservePrice: price.toFixed(),
    limit: input.type === "limit" ? price.toFixed() : null,
    status: "open",
    created: now,
    eligibleAt: now + 500,
    filled: "0",
    total: "0",
    fee: "0",
    decisionId: input.decisionId || null,
  };
  account.orders.unshift(order);
  // Only finished history is bounded; active orders must never disappear.
  account.orders = [
    ...account.orders.filter(open),
    ...account.orders.filter((o) => !open(o)).slice(0, 500),
  ];
  return order;
}
export function cancelOrder(account, id, now = Date.now()) {
  const order = account.orders.find((o) => o.id === id);
  if (!order || !open(order)) throw new Error("This order is no longer open.");
  order.status = "cancelled";
  order.closed = now;
}
export function processOrders(account, base, book, now = Date.now()) {
  const candidates = [...account.orders]
    .reverse()
    .filter((o) => open(o) && o.base === base && o.eligibleAt <= now);
  if (!candidates.length) return false;
  checkBook(book, now);
  // One book budget per account and snapshot. Experiments have independent liquidity.
  account.consumed ||= {};
  const previous = account.consumed[base],
    snapshotId = book.updateId ?? book.received;
  const budget =
    previous?.snapshotId === snapshotId
      ? previous
      : { snapshotId, buys: {}, sells: {} };
  account.consumed[base] = budget;
  let changed = false;
  for (const order of candidates) {
    let remaining = D(order.remaining);
    const levels = order.side === "buy" ? book.asks : book.bids;
    const used = order.side === "buy" ? budget.buys : budget.sells;
    for (const [rawPrice, rawSize] of levels) {
      const price = D(rawPrice);
      if (
        order.limit &&
        (order.side === "buy" ? price.gt(order.limit) : price.lt(order.limit))
      )
        break;
      let amount = Decimal.min(
        remaining,
        Decimal.max(0, D(rawSize).minus(used[rawPrice] || 0)),
      );
      if (order.side === "buy") {
        // Other limit orders retain their reservations even during a fill.
        const ownReserve = remaining
          .mul(order.reservePrice)
          .mul(D(1).plus(FEE));
        const spendable = D(balances(account).available).plus(ownReserve);
        amount = Decimal.min(
          amount,
          Decimal.max(0, spendable.div(price.mul(D(1).plus(FEE)))),
        );
      }
      if (account.kind === "ai" && order.side === "buy")
        amount = Decimal.min(
          amount,
          Decimal.max(
            0,
            D(account.initial)
              .mul(account.maxOrderPercent)
              .div(100)
              .minus(order.total)
              .div(price),
          ),
        );
      if (!amount.gt(0)) continue;
      // Never manufacture sub-step residual fills from affordability rounding.
      const step = book.step || "0.00000001";
      amount = amount.div(step).floor().mul(step);
      if (!amount.gt(0)) continue;
      const total = amount.mul(price),
        fee = total.mul(FEE),
        holding = (account.holdings[base] ||= {
          quantity: "0",
          cost: "0",
          realized: "0",
        });
      if (holding.entryValue === undefined) {
        holding.entryValue = D(holding.cost).div(D(1).plus(FEE)).toFixed();
        holding.entryFees = D(holding.cost).minus(holding.entryValue).toFixed();
      }
      if (order.side === "buy") {
        if (D(holding.quantity).isZero()) holding.entryAt = now;
        holding.lastEntryAt = now;
        holding.entryValue = D(holding.entryValue || 0)
          .plus(total)
          .toFixed();
        holding.entryFees = D(holding.entryFees || 0)
          .plus(fee)
          .toFixed();
        account.cash = D(account.cash).minus(total).minus(fee).toFixed();
        holding.quantity = D(holding.quantity).plus(amount).toFixed();
        holding.cost = D(holding.cost).plus(total).plus(fee).toFixed();
      } else {
        const proportion = amount.div(holding.quantity);
        const basis = D(holding.cost).mul(proportion);
        holding.entryValue = D(holding.entryValue || 0)
          .mul(D(1).minus(proportion))
          .toFixed();
        holding.entryFees = D(holding.entryFees || 0)
          .mul(D(1).minus(proportion))
          .toFixed();
        account.cash = D(account.cash).plus(total).minus(fee).toFixed();
        holding.realized = D(holding.realized)
          .plus(total)
          .minus(fee)
          .minus(basis)
          .toFixed();
        holding.quantity = D(holding.quantity).minus(amount).toFixed();
        holding.cost = D(holding.cost).minus(basis).toFixed();
      }
      remaining = remaining.minus(amount);
      used[rawPrice] = D(used[rawPrice] || 0)
        .plus(amount)
        .toFixed();
      order.remaining = remaining.toFixed();
      order.filled = D(order.filled).plus(amount).toFixed();
      order.total = D(order.total).plus(total).toFixed();
      order.fee = D(order.fee).plus(fee).toFixed();
      order.status = remaining.isZero() ? "filled" : "partial";
      account.fills.unshift({
        id: randomUUID(),
        orderId: order.id,
        base,
        side: order.side,
        quantity: amount.toFixed(),
        price: price.toFixed(),
        fee: fee.toFixed(),
        time: now,
        decisionId: order.decisionId,
      });
      account.totalFees = D(account.totalFees || 0)
        .plus(fee)
        .toFixed();
      account.fillCount = (account.fillCount || 0) + 1;
      changed = true;
      if (remaining.isZero()) {
        order.closed = now;
        break;
      }
    }
    if (order.type === "market" && remaining.gt(0)) {
      order.status = "cancelled";
      order.closed = now;
      order.reason =
        "Unfilled remainder cancelled: available depth or funds exhausted.";
      changed = true;
    }
  }
  account.fills = account.fills.slice(0, 1000);
  return changed;
}

// AI decisions execute in the same persisted update. This deliberately models
// a full quote fill, without depth/queue/market-impact simulation. Manual orders
// retain the depth-based engine above.
export function executeAIOrder(account, input, book, rules, now = Date.now()) {
  if (account.kind !== "ai")
    throw new Error("Immediate execution requires an AI account.");
  if (input.type !== "market")
    throw new Error(
      "AI trades execute immediately; use hold to wait for an entry condition.",
    );
  const working = structuredClone(account);
  const order = submitOrder(working, input, book, rules, now);
  order.eligibleAt = now;
  order.execution = "immediate_quote";
  const quoteBook = {
    ...book,
    updateId: order.id,
    step:
      rules.marketStep && D(rules.marketStep).gt(0)
        ? rules.marketStep
        : rules.step,
    asks: [[book.asks[0][0], order.quantity]],
    bids: [[book.bids[0][0], order.quantity]],
  };
  const allOrders = working.orders;
  working.orders = [order];
  processOrders(working, input.base, quoteBook, now);
  working.orders = allOrders;
  if (order.status !== "filled")
    throw new Error("Immediate order could not be fully executed.");
  Object.assign(account, working);
  return order;
}
export function positionMetrics(account, books, errors = {}, now = Date.now()) {
  return Object.entries(account.holdings)
    .filter(([, h]) => D(h.quantity).gt(0))
    .map(([base, h]) => {
      const book = books[base];
      const fresh =
        book &&
        !errors[base] &&
        now >= book.received &&
        now - book.received <= 5000;
      const qty = D(h.quantity),
        cost = D(h.cost);
      const entryValue =
        h.entryValue === undefined ? cost.div(D(1).plus(FEE)) : D(h.entryValue);
      const mark = fresh
        ? D(book.bids[0][0]).plus(book.asks[0][0]).div(2)
        : null;
      const value = mark?.mul(qty);
      const exitValue = fresh
        ? D(book.bids[0][0]).mul(qty).mul(D(1).minus(FEE))
        : null;
      return {
        base,
        quantity: h.quantity,
        invested: h.cost,
        averageEntry: entryValue.div(qty).toFixed(),
        entryFees: cost.minus(entryValue).toFixed(),
        entryAt: h.entryAt || null,
        lastEntryAt: h.lastEntryAt || null,
        mark: mark?.toFixed() ?? null,
        value: value?.toFixed() ?? null,
        unrealized: value?.minus(cost).toFixed() ?? null,
        unrealizedPercent:
          value && cost.gt(0)
            ? value.minus(cost).div(cost).mul(100).toFixed()
            : null,
        estimatedExitValue: exitValue?.toFixed() ?? null,
        estimatedNetPnl: exitValue?.minus(cost).toFixed() ?? null,
        received: book?.received || null,
        stale: !fresh,
      };
    });
}
