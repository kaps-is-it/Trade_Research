import { useEffect, useState } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  BrainCircuit,
  ChevronRight,
  CircleHelp,
  Download,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import Decimal from "decimal.js";
import MODEL_PRESETS from "../../shared/model-presets.json";
import { PriceChart, numberPrice } from "../components/PriceChart";
import type { Indicator } from "../components/PriceChart";
import { market } from "../market/engine";
import type { MarketState } from "../market/types";
import { tradingRequest, setOwnerToken, useTrading } from "./client";
import type { TradingAccount, TradingSnapshot } from "./client";
import "./trading.css";

const money = (v: string | number | null | undefined, digits = 2) =>
  v === null || v === undefined
    ? "—"
    : Number(v).toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const quantityText = (v: string) => new Decimal(v).toDecimalPlaces(8).toFixed();
const time = (v?: number) =>
  v
    ? new Date(v).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
const openOrder = (status: string) => ["open", "partial"].includes(status);
const PAPER_INDICATORS: Indicator[] = ["Volume"];
const STATUS: Record<string, string> = {
  awaiting_model: "Awaiting model connection",
  waiting: "Waiting for candle",
  reading_data: "Reading market data",
  evaluating: "Evaluating account",
  paused: "Paused",
  risk_blocked: "Order blocked by risk checks",
  risk_stopped: "Loss limit reached",
  daily_limit: "Daily call allowance reached",
  error: "Evaluation needs attention",
  ready: "Ready",
};
const safePnl = (a: TradingAccount) =>
  a.equity === null ? null : new Decimal(a.equity).minus(a.initial).toNumber();

export function TradingPages({
  mode,
  state,
  dark,
}: {
  mode: "manual" | "ai";
  state: MarketState;
  dark: boolean;
}) {
  const [base, setBase] = useState("BTC"),
    { data, error, reload } = useTrading(base),
    [selected, setSelected] = useState(""),
    [showCreate, setShowCreate] = useState(false),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false),
    [owner, setOwner] = useState(false);
  const accounts = data?.accounts.filter((a) => a.kind === mode) || [],
    account = accounts.find((a) => a.id === selected) || accounts[0];
  const writable = !!data?.canWrite && !error && !data?.storageError;
  useEffect(() => {
    if (mode === "ai" && account) setBase(account.base);
  }, [mode, account?.id, account?.base]);
  useEffect(() => {
    market.select(base, 300);
  }, [base]);
  const mutate = async (path: string, input: unknown) => {
    setPending(true);
    setNotice("");
    try {
      const r = await tradingRequest<{ id?: string }>(path, input);
      if (r.id && path === "/accounts") {
        setSelected(r.id);
        setShowCreate(false);
      }
      reload();
      return true;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "The action failed.");
      return false;
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="trading-page">
      <div className={`trading-connection ${error ? "is-offline" : ""}`}>
        <span className="trading-connection-main">
          <i className={`live-dot ${error ? "offline-dot" : ""}`} />
          {error
            ? "Trading backend offline"
            : data
              ? data.storageError
                ? "Trading storage needs attention"
                : "Trading worker connected"
              : "Connecting to trading worker…"}
          <span className="trading-caption">
            {error
              ? "Accounts and trading controls will become available when it reconnects."
              : "Persistent accounts · Binance spot · USDT"}
          </span>
        </span>
        <button className="button secondary" onClick={() => setOwner(!owner)}>
          <LockKeyhole size={13} />
          {writable ? "Owner access" : "Owner sign in"}
        </button>
      </div>
      {data?.storageError && (
        <div className="trading-alert" role="alert">
          Trading is stopped because storage could not be confirmed. The account
          view may be out of date. The owner needs to restart the backend to
          reload saved records.
        </div>
      )}
      {error && (
        <div className="trading-setup">
          <Wallet size={22} />
          <div>
            <h2>The trading service is not connected yet.</h2>
            <p>
              {import.meta.env.DEV ? (
                <>
                  For local development, run <code>pnpm backend</code> alongside{" "}
                  <code>pnpm dev</code>. Connect a hosted worker to enable the
                  public workspace.
                </>
              ) : (
                <>
                  Live market research remains available. Trading accounts and
                  model simulations will become available here when the service
                  is online.
                </>
              )}
            </p>
            <button className="text-link" onClick={reload}>
              Retry connection <RefreshCw size={12} />
            </button>
          </div>
        </div>
      )}
      {owner && (
        <OwnerAccess
          connected={!!data && !error}
          writable={writable}
          done={() => {
            reload();
            setOwner(false);
          }}
        />
      )}
      {notice && (
        <div className="trading-alert" role="alert">
          {notice}
          <button aria-label="Dismiss message" onClick={() => setNotice("")}>
            <X size={15} />
          </button>
        </div>
      )}
      <div className="trading-section-title">
        <div>
          <span className="tiny-label">
            {mode === "ai" ? "INDEPENDENT EXPERIMENTS" : "YOUR TRADING DESK"}
          </span>
          <h2>
            {mode === "ai"
              ? "One workspace. Multiple strategies."
              : "Your capital. Your decisions."}
          </h2>
          <p>
            {mode === "ai"
              ? "Run models side by side, each with its own capital and account."
              : "Practice spot trading against live prices, with a persistent paper account."}
          </p>
        </div>
        <button
          className="button primary"
          disabled={!writable || pending}
          onClick={() => setShowCreate(!showCreate)}
        >
          <Plus size={15} />
          {mode === "ai" ? "New simulation" : "New account"}
        </button>
      </div>
      {(showCreate || (!!data && !accounts.length)) && (
        <CreateAccount
          mode={mode}
          data={data}
          disabled={!writable || pending}
          onCancel={accounts.length ? () => setShowCreate(false) : undefined}
          onCreate={(input) => mutate("/accounts", input)}
        />
      )}
      {mode === "ai" && (
        <div className="simulation-grid">
          {accounts.map((a) => (
            <button
              className={`simulation-card ${account?.id === a.id ? "is-selected" : ""}`}
              key={a.id}
              aria-pressed={account?.id === a.id}
              onClick={() => setSelected(a.id)}
            >
              <div className="simulation-card-head">
                <span className="simulation-avatar">
                  <BrainCircuit size={19} />
                </span>
                <span>
                  <strong>{a.name}</strong>
                  <small>
                    {a.base}/USDT ·{" "}
                    {data?.providers.find((p) => p.id === a.provider)?.label}
                  </small>
                </span>
                <ChevronRight size={15} />
              </div>
              <div className="simulation-model">{a.model}</div>
              <div className="simulation-capital">
                <span>
                  <small>Equity · USDT</small>
                  <b className="mono">{money(a.equity)}</b>
                </span>
                <span
                  className={
                    safePnl(a) === null
                      ? "muted"
                      : Number(safePnl(a)) >= 0
                        ? "positive"
                        : "negative"
                  }
                >
                  {safePnl(a) === null
                    ? "Awaiting valuation"
                    : `${Number(safePnl(a)) >= 0 ? "+" : ""}${money(safePnl(a))}`}
                </span>
              </div>
              <div className={`run-status ${a.enabled ? "enabled" : ""}`}>
                <i />
                {STATUS[a.status] || a.status}
              </div>
            </button>
          ))}
        </div>
      )}
      {account && (
        <>
          <div className="account-strip">
            <div>
              <span className="paper-badge">
                <ShieldCheck size={12} />
                PAPER ACCOUNT
              </span>
              {mode === "manual" ? (
                <select
                  aria-label="Manual account"
                  value={account.id}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              ) : (
                <h3>{account.name}</h3>
              )}
            </div>
            <span className="trading-caption">
              Starting balance {money(account.initial)} USDT
            </span>
          </div>
          <AccountMetrics account={account} />
          {mode === "manual" ? (
            <div className="paper-desk">
              <section className="panel paper-chart">
                <div className="panel-title">
                  <div className="paper-market">
                    <select
                      aria-label="Trading market"
                      value={base}
                      onChange={(e) => setBase(e.target.value)}
                    >
                      {(data?.symbols || ["BTC", "ETH"]).map((b) => (
                        <option key={b} value={b}>
                          {b} / USDT
                        </option>
                      ))}
                    </select>
                    <span className="trading-caption">Binance spot · 5m</span>
                  </div>
                  <span className="mono">
                    {state.quotes[`binance:${base}`]
                      ? numberPrice(state.quotes[`binance:${base}`].price)
                      : "—"}
                  </span>
                </div>
                <div className="paper-chart-area">
                  <PriceChart
                    candles={state.selected.base === base ? state.candles : []}
                    identity={`binance-${base}-paper-300`}
                    kind="Candles"
                    indicators={PAPER_INDICATORS}
                    dark={dark}
                    log={false}
                    fitSignal={0}
                    emptyLabel={
                      state.history === "error"
                        ? "Chart history is unavailable"
                        : "Connecting to the market"
                    }
                  />
                </div>
              </section>
              <OrderTicket
                account={account}
                base={base}
                data={data}
                disabled={!writable || pending}
                onOrder={(input) =>
                  mutate(`/accounts/${account.id}/orders`, input)
                }
              />
            </div>
          ) : (
            <AIActivity
              account={account}
              data={data}
              disabled={!writable || pending}
              onControl={(action) =>
                mutate(`/accounts/${account.id}/control`, { action })
              }
            />
          )}
          <AccountRecords
            key={account.id}
            account={account}
            data={data}
            disabled={!writable || pending}
            onCancel={(orderId) =>
              mutate(`/accounts/${account.id}/cancel`, { orderId })
            }
          />
          {mode === "ai" && <DecisionJournal account={account} />}
        </>
      )}
      {!account && !showCreate && (
        <div className="trading-empty">
          <BrainCircuit size={30} />
          <h3>
            {mode === "ai"
              ? "Your first strategy starts here."
              : "A clear view of every trade."}
          </h3>
          <p>
            {mode === "ai"
              ? "Choose a model, assign capital and start an independent simulation."
              : "Create a funded paper account to place your first order."}
          </p>
        </div>
      )}
      <details className="simulation-assumptions">
        <summary>
          <CircleHelp size={14} />
          How execution works
        </summary>
        <p>
          All orders stay inside this paper engine. Example fee: 0.10% per fill.
          Orders wait at least 500 ms and use the next available top-20 Binance
          order book, polled about every 2 seconds. Market orders consume
          displayed depth; unfilled remainders are cancelled. Limits fill only
          against executable opposite-side depth, with no queue-position claim.
          Fresh market data and exchange size/price rules are required. No
          market impact is modeled. Each simulation has an independent liquidity
          budget. USDT is the account currency; no USD conversion is implied.
        </p>
        <p>
          Pausing a run stops new AI decisions. Open orders continue to be
          monitored and can be cancelled separately. Backend monitoring
          continues when chart feeds are paused or the browser is closed, while
          the worker is running.
        </p>
      </details>
    </div>
  );
}
function OwnerAccess({
  connected,
  writable,
  done,
}: {
  connected: boolean;
  writable: boolean;
  done: () => void;
}) {
  const [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [checking, setChecking] = useState(false);
  return (
    <form
      className="trading-owner"
      onSubmit={async (e) => {
        e.preventDefault();
        setChecking(true);
        setError("");
        setOwnerToken(token);
        try {
          const response = await tradingRequest<TradingSnapshot>();
          if (!response.canWrite)
            throw new Error("Owner token was not accepted.");
          setToken("");
          done();
        } catch (e) {
          setOwnerToken("");
          setError(
            e instanceof Error ? e.message : "Could not verify owner access.",
          );
        } finally {
          setChecking(false);
        }
      }}
    >
      <LockKeyhole size={17} />
      <div>
        <h3>
          {writable ? "Owner controls are unlocked" : "Unlock owner controls"}
        </h3>
        <p>
          {writable
            ? "Local loopback access or a verified owner credential authorizes changes."
            : "Use the owner token configured on your trading backend. It stays in memory for this tab."}
        </p>
      </div>
      {!writable && (
        <>
          <input
            aria-label="Backend owner token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
          <button
            className="button secondary"
            disabled={!connected || checking}
          >
            {checking ? "Verifying…" : "Unlock"}
          </button>
          {error && (
            <span role="alert" className="negative">
              {error}
            </span>
          )}
        </>
      )}
      {writable && (
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setOwnerToken("");
            done();
          }}
        >
          Close
        </button>
      )}
    </form>
  );
}
function CreateAccount({
  mode,
  data,
  disabled,
  onCancel,
  onCreate,
}: {
  mode: "manual" | "ai";
  data: TradingSnapshot | null;
  disabled: boolean;
  onCancel?: () => void;
  onCreate: (input: unknown) => Promise<boolean>;
}) {
  const [name, setName] = useState(""),
    [capital, setCapital] = useState("1000"),
    [provider, setProvider] = useState(
      () => data?.providers.find((p) => p.configured)?.id || "nvidia",
    ),
    [model, setModel] = useState(""),
    [base, setBase] = useState("BTC"),
    [maxOrderPercent, setMaxOrder] = useState("25"),
    [lossLimitPercent, setLossLimit] = useState("10"),
    [maxCalls, setMaxCalls] = useState("24"),
    [models, setModels] = useState<{ id: string; label: string }[]>([]),
    [catalogError, setCatalogError] = useState(""),
    [loading, setLoading] = useState(false);
  const ready = data?.providers.find((p) => p.id === provider)?.configured;
  const presets =
    (MODEL_PRESETS as Record<string, { id: string; label: string }[]>)[
      provider
    ] || [];
  return (
    <form
      className="panel create-trading-account"
      onSubmit={async (e) => {
        e.preventDefault();
        if (
          await onCreate({
            kind: mode,
            name:
              name ||
              (mode === "ai" ? `${model} · ${base}` : "My paper account"),
            capital,
            provider,
            model,
            base,
            maxOrderPercent: Number(maxOrderPercent),
            lossLimitPercent: Number(lossLimitPercent),
            maxCalls: Number(maxCalls),
          })
        )
          setName("");
      }}
    >
      <div className="panel-title">
        <h2>
          {mode === "ai" ? "Create a simulation" : "Fund a new paper account"}
        </h2>
        {onCancel && (
          <button
            type="button"
            aria-label="Close creation form"
            onClick={onCancel}
          >
            <X size={16} />
          </button>
        )}
      </div>
      <div className="trading-form-grid">
        <label>
          Account name
          <input
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              mode === "ai"
                ? "e.g. Momentum experiment"
                : "e.g. My trading account"
            }
          />
        </label>
        <label>
          Starting balance · USDT
          <input
            type="number"
            value={capital}
            onChange={(e) => setCapital(e.target.value)}
            min="1"
            max="1000000000"
            step="0.01"
            required
          />
        </label>
        {mode === "ai" && (
          <>
            <label>
              Model provider
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setModel("");
                  setModels([]);
                  setCatalogError("");
                }}
              >
                {(
                  data?.providers || [
                    { id: "openai", label: "OpenAI" },
                    { id: "openrouter", label: "OpenRouter" },
                    { id: "ollama", label: "Local / Ollama" },
                    { id: "nvidia", label: "NVIDIA NIM" },
                  ]
                ).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {!!presets.length && (
              <label>
                Model selection
                <select
                  value={presets.some((p) => p.id === model) ? model : "custom"}
                  onChange={(e) =>
                    setModel(e.target.value === "custom" ? "" : e.target.value)
                  }
                >
                  <option value="custom">Enter a model ID</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Model ID
              <input
                list="trading-model-catalog"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Enter the exact provider model ID"
                maxLength={160}
                required
              />
              <datalist id="trading-model-catalog">
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </datalist>
            </label>
            <label>
              Market
              <select value={base} onChange={(e) => setBase(e.target.value)}>
                {(data?.symbols || ["BTC", "ETH"]).map((b) => (
                  <option key={b} value={b}>
                    {b} / USDT
                  </option>
                ))}
              </select>
            </label>
            <label>
              Maximum order · % of initial capital
              <input
                type="number"
                min="1"
                max="100"
                value={maxOrderPercent}
                onChange={(e) => setMaxOrder(e.target.value)}
                required
              />
            </label>
            <label>
              Stop new trading after loss · %
              <input
                type="number"
                min="1"
                max="100"
                value={lossLimitPercent}
                onChange={(e) => setLossLimit(e.target.value)}
                required
              />
            </label>
            <label>
              Maximum AI requests per day
              <input
                type="number"
                min="1"
                max="288"
                value={maxCalls}
                onChange={(e) => setMaxCalls(e.target.value)}
                required
              />
              <small>
                Per simulation. Resets at 00:00 UTC. Failed requests count too.
              </small>
            </label>
          </>
        )}
      </div>
      {mode === "ai" && (
        <div className="model-connection-note">
          <span className={ready ? "positive" : "muted"}>
            {ready
              ? "Provider configured on backend"
              : "Provider is not connected. The run will wait without making model calls."}
          </span>
          <button
            className="text-link"
            type="button"
            disabled={!ready || disabled || loading}
            onClick={async () => {
              setLoading(true);
              setCatalogError("");
              try {
                const r = await tradingRequest<{
                  models: { id: string; label: string }[];
                }>(`/models?provider=${provider}`);
                setModels(r.models);
              } catch (e) {
                setCatalogError(
                  e instanceof Error ? e.message : "Catalog unavailable.",
                );
              } finally {
                setLoading(false);
              }
            }}
          >
            <RefreshCw size={12} />
            {loading
              ? "Loading…"
              : models.length
                ? `${models.length} models loaded`
                : "Load available models"}
          </button>
          {catalogError && <span role="alert">{catalogError}</span>}
        </div>
      )}
      <div className="trading-form-footer">
        <span>
          {mode === "ai"
            ? "Separate capital · five-minute evaluations · neutral model-facing account data"
            : "Separate account · spot holdings · no exchange credentials"}
        </span>
        <button className="button primary" disabled={disabled}>
          {mode === "ai" ? <Play size={14} /> : <Plus size={14} />}
          {mode === "ai" ? "Create & start simulation" : "Create paper account"}
        </button>
      </div>
    </form>
  );
}
function AccountMetrics({ account: a }: { account: TradingAccount }) {
  const pnl = safePnl(a),
    fees = new Decimal(a.totalFees || 0),
    realized = Object.values(a.holdings).reduce(
      (s, h) => s.plus(h.realized),
      new Decimal(0),
    );
  return (
    <div className="paper-metrics">
      {[
        ["Equity · USDT", money(a.equity), "Cash and marked holdings"],
        [
          "Available · USDT",
          money(a.available),
          `${money(a.reserved)} reserved for orders`,
        ],
        [
          "Net P&L · USDT",
          pnl === null ? "—" : `${pnl >= 0 ? "+" : ""}${money(pnl)}`,
          `${money(realized.toFixed())} realized`,
        ],
        [
          "Trading fees · USDT",
          money(fees.toFixed(), 4),
          `${a.fillCount || a.fills.length} total fills`,
        ],
      ].map(([label, value, detail], i) => (
        <div className="panel paper-metric" key={label}>
          <span>{label}</span>
          <strong
            className={`mono ${i === 2 && pnl !== null ? (pnl >= 0 ? "positive" : "negative") : ""}`}
          >
            {value}
          </strong>
          <small>{detail}</small>
        </div>
      ))}
    </div>
  );
}
function OrderTicket({
  account,
  base,
  data,
  disabled,
  onOrder,
}: {
  account: TradingAccount;
  base: string;
  data: TradingSnapshot | null;
  disabled: boolean;
  onOrder: (input: unknown) => Promise<boolean>;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy"),
    [type, setType] = useState("market"),
    [quantity, setQuantity] = useState(""),
    [price, setPrice] = useState(""),
    [review, setReview] = useState(false);
  useEffect(() => {
    setQuantity("");
    setPrice("");
    setReview(false);
  }, [base, account.id]);
  const book = data?.markets[base],
    fresh = !!book && Date.now() - book.received < 5000 && !book.error;
  const estimatedPrice =
    type === "limit"
      ? price
      : book
        ? side === "buy"
          ? book.ask
          : book.bid
        : "";
  let subtotal = new Decimal(0);
  try {
    if (quantity && estimatedPrice)
      subtotal = new Decimal(quantity).mul(estimatedPrice);
  } catch {
    /* Incomplete decimal input. */
  }
  const fee = subtotal.mul(".001"),
    total = side === "buy" ? subtotal.plus(fee) : subtotal.minus(fee),
    held = new Decimal(account.holdings[base]?.quantity || 0).minus(
      account.reservedAssets[base] || 0,
    );
  const valid =
    !disabled &&
    fresh &&
    subtotal.gt(0) &&
    (side === "buy"
      ? total.lte(account.available)
      : new Decimal(quantity || 0).lte(held));
  return (
    <form
      className="panel paper-ticket"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!review) {
          setReview(true);
          return;
        }
        if (await onOrder({ base, side, type, quantity, price })) {
          setQuantity("");
          setReview(false);
        }
      }}
    >
      <h2>Place an order</h2>
      <span className="trading-caption">Paper execution · {base}/USDT</span>
      <div className="trade-side" role="group" aria-label="Order side">
        {(["buy", "sell"] as const).map((s) => (
          <button
            type="button"
            key={s}
            aria-pressed={side === s}
            className={s}
            onClick={() => {
              setSide(s);
              setReview(false);
            }}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      <label>
        Order type
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setReview(false);
          }}
        >
          <option value="market">Market</option>
          <option value="limit">Limit</option>
        </select>
      </label>
      {type === "limit" && (
        <label>
          Limit price · USDT
          <input
            type="number"
            min="0"
            step={book?.rules.tick || "any"}
            value={price}
            onChange={(e) => {
              setPrice(e.target.value);
              setReview(false);
            }}
            required
          />
        </label>
      )}
      <label>
        Quantity · {base}
        <input
          type="number"
          min="0"
          step={book?.rules.step || "any"}
          value={quantity}
          onChange={(e) => {
            setQuantity(e.target.value);
            setReview(false);
          }}
          placeholder="0.00"
          required
        />
      </label>
      <div className="order-presets">
        {[25, 50, 75, 100].map((percent) => (
          <button
            type="button"
            key={percent}
            disabled={!fresh}
            onClick={() => {
              const step = new Decimal(book?.rules.step || ".00000001"),
                p = new Decimal(estimatedPrice || (book?.ask ?? 1));
              if (!p.gt(0)) return;
              const amount =
                side === "buy"
                  ? new Decimal(account.available)
                      .mul(percent)
                      .div(100)
                      .div(p.mul("1.001"))
                  : held.mul(percent).div(100);
              setQuantity(amount.div(step).floor().mul(step).toFixed());
              setReview(false);
            }}
          >
            {percent}%
          </button>
        ))}
      </div>
      <div className="order-estimate">
        <div>
          <span>Available</span>
          <b>
            {side === "buy"
              ? `${money(account.available)} USDT`
              : `${quantityText(held.toFixed())} ${base}`}
          </b>
        </div>
        <div>
          <span>Estimated value</span>
          <b>{money(subtotal.toFixed())} USDT</b>
        </div>
        <div>
          <span>Fee · 0.10%</span>
          <b>{money(fee.toFixed(), 4)} USDT</b>
        </div>
        <div>
          <span>
            {side === "buy" ? "Estimated debit" : "Estimated proceeds"}
          </span>
          <b>{money(total.toFixed())} USDT</b>
        </div>
      </div>
      <div className={`ticket-freshness ${fresh ? "positive" : "negative"}`}>
        <Activity size={12} />
        {fresh ? "Execution data is fresh" : "Waiting for fresh execution data"}
      </div>
      {review && (
        <div className="order-review" aria-live="polite">
          {side === "buy" ? "Buy" : "Sell"} {quantity} {base} ·{" "}
          {type === "limit" ? `limit ${price} USDT` : "market price"}. Final
          fills and fees may differ from this estimate.
        </div>
      )}
      <button
        className={`button primary ticket-submit ${side}`}
        disabled={!valid}
      >
        {review ? `Confirm paper ${side}` : "Review paper order"}
        {side === "buy" ? (
          <ArrowDownLeft size={15} />
        ) : (
          <ArrowUpRight size={15} />
        )}
      </button>
      <p className="ticket-foot">
        Orders are validated by the backend against current funds and exchange
        rules.
      </p>
    </form>
  );
}
function AIActivity({
  account: a,
  data,
  disabled,
  onControl,
}: {
  account: TradingAccount;
  data: TradingSnapshot | null;
  disabled: boolean;
  onControl: (action: string) => Promise<boolean>;
}) {
  const steps = ["Observe", "Evaluate", "Validate", "Record"],
    active =
      a.status === "reading_data"
        ? 0
        : a.status === "evaluating"
          ? 1
          : ["risk_blocked", "risk_stopped"].includes(a.status)
            ? 2
            : a.status === "waiting"
              ? 0
              : -1,
    provider = data?.providers.find((p) => p.id === a.provider),
    today = new Date().toISOString().slice(0, 10),
    usedCalls = a.callDay === today ? a.calls : 0;
  return (
    <div className="ai-activity-layout">
      <section className="panel ai-activity">
        <div className="panel-title">
          <h2>
            <Activity size={16} />
            Current activity
          </h2>
          <span className="trading-caption">{a.base}/USDT · 5m</span>
        </div>
        <div className="ai-current">
          <span className="ai-status-icon">
            <BrainCircuit size={24} />
          </span>
          <div>
            <h3>{STATUS[a.status] || a.status}</h3>
            <p>
              {a.status === "awaiting_model"
                ? "Connect this provider to begin evaluations. Your capital and settings are saved."
                : a.status === "paused"
                  ? "New decisions are paused. Existing orders remain monitored."
                  : a.status === "evaluating"
                    ? "The selected model is evaluating a timestamped account and market snapshot."
                    : "Decisions use closed candles, account balances and executable market data."}
            </p>
          </div>
        </div>
        <div className="ai-stage-track">
          {steps.map((s, i) => (
            <span key={s} className={i === active ? "active" : ""}>
              <i>{i + 1}</i>
              {s}
            </span>
          ))}
        </div>
        <div className="ai-timing">
          <span>
            Last evaluation<b>{time(a.lastEvaluation)}</b>
          </span>
          <span>
            Next scheduled check
            <b>{a.enabled ? time(a.nextEvaluation) : "Paused"}</b>
          </span>
        </div>
        <div className="ai-last-decision">
          <span className="tiny-label">LATEST RECORDED EVENT</span>
          <p>
            {a.journal[0]?.rationale ||
              a.journal[0]?.result ||
              "No decisions recorded yet."}
          </p>
        </div>
      </section>
      <section className="panel ai-controls">
        <div className="panel-title">
          <h2>Run controls</h2>
          <LockKeyhole size={14} />
        </div>
        <dl>
          <div>
            <dt>Provider</dt>
            <dd>{provider?.label}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{a.model}</dd>
          </div>
          <div>
            <dt>Order ceiling</dt>
            <dd>
              {money(
                new Decimal(a.initial)
                  .mul(a.maxOrderPercent)
                  .div(100)
                  .toFixed(),
              )}{" "}
              USDT
            </dd>
          </div>
          <div>
            <dt>Loss stop</dt>
            <dd>{a.lossLimitPercent}% of initial capital</dd>
          </div>
          <div>
            <dt>Calls today · UTC</dt>
            <dd>
              {usedCalls} / {a.maxCalls}
            </dd>
          </div>
          <div>
            <dt>Tokens · input / output</dt>
            <dd>
              {a.inputTokens} / {a.outputTokens}
            </dd>
          </div>
        </dl>
        <button
          className="button primary"
          disabled={disabled}
          onClick={() => void onControl(a.enabled ? "pause" : "resume")}
        >
          {a.enabled ? <Pause size={14} /> : <Play size={14} />}
          {a.enabled ? "Pause simulation" : "Resume simulation"}
        </button>
        <p>
          Model requests contain neutral account data and trading instructions.
          Simulation labels stay in the interface and execution layer.
        </p>
      </section>
    </div>
  );
}
function AccountRecords({
  account: a,
  data,
  disabled,
  onCancel,
}: {
  account: TradingAccount;
  data: TradingSnapshot | null;
  disabled: boolean;
  onCancel: (id: string) => Promise<boolean>;
}) {
  const [tab, setTab] = useState("orders"),
    tabs = [
      [
        "orders",
        `Open orders · ${a.orders.filter((o) => openOrder(o.status)).length}`,
      ],
      ["holdings", "Holdings"],
      ["fills", "Fills"],
      ["history", "Order history"],
    ];
  const orders =
    tab === "orders" ? a.orders.filter((o) => openOrder(o.status)) : a.orders;
  return (
    <section className="panel trading-records">
      <div className="trading-record-toolbar">
        <div role="tablist" aria-label="Account records">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              id={`tab-${id}`}
              role="tab"
              aria-selected={tab === id}
              aria-controls="trading-record-panel"
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="icon-button"
          aria-label="Export fills CSV"
          title="Export fills CSV"
          disabled={!a.fills.length}
          onClick={() => {
            const csv = [
                "time_utc,market,side,quantity,price_usdt,fee_usdt,order_id",
                ...a.fills.map((f) =>
                  [
                    new Date(f.time).toISOString(),
                    `${f.base}/USDT`,
                    f.side,
                    f.quantity,
                    f.price,
                    f.fee,
                    f.orderId,
                  ].join(","),
                ),
              ].join("\n"),
              url = URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
              link = document.createElement("a");
            link.href = url;
            link.download = `paper-fills-${a.id}.csv`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download size={14} />
        </button>
      </div>
      <div
        id="trading-record-panel"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="trading-table-wrap"
      >
        {(tab === "orders" || tab === "history") &&
          (orders.length ? (
            <table>
              <thead>
                <tr>
                  <th>Market / time</th>
                  <th>Side / type</th>
                  <th>Quantity / filled</th>
                  <th>Limit · USDT</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <b>{o.base}/USDT</b>
                      <small>{time(o.created)}</small>
                    </td>
                    <td>
                      <span
                        className={o.side === "buy" ? "positive" : "negative"}
                      >
                        {o.side.toUpperCase()}
                      </span>
                      <small>{o.type}</small>
                    </td>
                    <td className="mono">
                      {quantityText(o.quantity)}
                      <small>{quantityText(o.filled)} filled</small>
                    </td>
                    <td className="mono">
                      {o.limit ? money(o.limit, 4) : "Market"}
                    </td>
                    <td>
                      {o.status}
                      <small>{o.reason}</small>
                    </td>
                    <td>
                      {openOrder(o.status) && (
                        <button
                          className="text-link"
                          disabled={disabled}
                          onClick={() => void onCancel(o.id)}
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="records-empty">
              {tab === "orders"
                ? "No open orders. Submitted orders and their fill progress appear here."
                : "Your order history will appear here."}
            </div>
          ))}
        {tab === "holdings" && (
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Balance</th>
                <th>Reserved</th>
                <th>Cost basis · USDT</th>
                <th>Realized P&L · USDT</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>USDT</td>
                <td className="mono">{money(a.cash)}</td>
                <td className="mono">{money(a.reserved)}</td>
                <td>—</td>
                <td>—</td>
              </tr>
              {Object.entries(a.holdings).map(([base, h]) => (
                <tr key={base}>
                  <td>
                    {base}
                    <small>
                      {data?.markets[base] ? "Binance spot" : "Awaiting price"}
                    </small>
                  </td>
                  <td className="mono">{quantityText(h.quantity)}</td>
                  <td className="mono">
                    {quantityText(a.reservedAssets[base] || "0")}
                  </td>
                  <td className="mono">{money(h.cost)}</td>
                  <td className="mono">{money(h.realized)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === "fills" &&
          (a.fills.length ? (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Market</th>
                  <th>Side</th>
                  <th>Quantity</th>
                  <th>Price · USDT</th>
                  <th>Fee · USDT</th>
                </tr>
              </thead>
              <tbody>
                {a.fills.map((f) => (
                  <tr key={f.id}>
                    <td>{time(f.time)}</td>
                    <td>{f.base}/USDT</td>
                    <td className={f.side === "buy" ? "positive" : "negative"}>
                      {f.side.toUpperCase()}
                    </td>
                    <td className="mono">{quantityText(f.quantity)}</td>
                    <td className="mono">{money(f.price, 4)}</td>
                    <td className="mono">{money(f.fee, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="records-empty">
              Every executed fill will appear here with its price, quantity and
              fee.
            </div>
          ))}
      </div>
    </section>
  );
}
function DecisionJournal({ account }: { account: TradingAccount }) {
  return (
    <section className="panel decision-journal">
      <div className="panel-title">
        <h2>Decision journal</h2>
        <span className="trading-caption">Evidence, actions and outcomes</span>
      </div>
      {account.journal.map((j) => (
        <details key={j.id}>
          <summary>
            <span
              className={`decision-action ${j.status === "risk_blocked" ? "negative" : ""}`}
            >
              {j.action?.toUpperCase() || "EVENT"}
            </span>
            <span>{j.rationale || j.result}</span>
            <time>{time(j.time)}</time>
          </summary>
          <div>
            <p>{j.result}</p>
            {j.evidence && (
              <p>
                Snapshot {time(j.asOf)} · {j.evidence.closedCandles} closed
                candles · bid {j.evidence.bid} / ask {j.evidence.ask} ·
                available {j.evidence.available} USDT
              </p>
            )}
            <small>
              Record {j.id}
              {j.inputTokens !== undefined
                ? ` · ${j.inputTokens} input / ${j.outputTokens} output tokens`
                : ""}
            </small>
          </div>
        </details>
      ))}
    </section>
  );
}
