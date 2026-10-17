import type { TradingAccount } from "./client";

const number = (v: string | number | null | undefined, digits = 2) =>
  v == null
    ? "—"
    : Number(v).toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const signed = (v: string | null) =>
  v == null ? "—" : `${Number(v) >= 0 ? "+" : ""}${number(v)}`;
const stamp = (v?: number | null) =>
  v ? new Date(v).toLocaleString() : "Unavailable for legacy fills";

export function PositionDashboard({
  account,
  offline,
}: {
  account: TradingAccount;
  offline: boolean;
}) {
  const positions = account.positions || [];
  const pending = account.orders.some(
    (o) => ["open", "partial"].includes(o.status) && o.side === "buy",
  );
  return (
    <section className="panel position-dashboard" aria-label="Live positions">
      <div className="panel-title">
        <h2>Live positions</h2>
        <span className="trading-caption">
          Binance · USDT · updates about every second
        </span>
      </div>
      {!positions.length ? (
        <div className="records-empty">
          {pending
            ? "Entry pending · funds reserved, no position filled yet."
            : "No open position · capital is in cash. A filled buy will appear here."}
        </div>
      ) : (
        positions.map((p) => {
          const stale =
            offline || p.stale || !p.received || Date.now() - p.received > 5000;
          return (
            <article className="position-card" key={p.base}>
              <div className="position-heading">
                <div>
                  <h3>
                    {p.base} / USDT{" "}
                    <span className="position-badge">Holding</span>
                  </h3>
                  <small>
                    {number(p.quantity, 8)} {p.base} · first entry{" "}
                    {stamp(p.entryAt)}
                  </small>
                </div>
                <div
                  className={`position-pnl ${!stale && Number(p.unrealized) >= 0 ? "positive" : "negative"}`}
                >
                  <small>Unrealized P&L · includes entry fees</small>
                  <strong>
                    {stale ? "—" : signed(p.unrealized)} <span>USDT</span>
                  </strong>
                  <span>
                    {stale
                      ? "Price unavailable or stale"
                      : `${signed(p.unrealizedPercent)}%`}
                  </span>
                </div>
              </div>
              <dl className="position-values">
                <div>
                  <dt>Average entry price</dt>
                  <dd>
                    {number(p.averageEntry, 4)} <small>USDT / {p.base}</small>
                  </dd>
                </div>
                <div>
                  <dt>Invested · remaining cost</dt>
                  <dd>
                    {number(p.invested)}{" "}
                    <small>
                      USDT · includes {number(p.entryFees, 4)} in entry fees
                    </small>
                  </dd>
                </div>
                <div>
                  <dt>Current mark · bid/ask midpoint</dt>
                  <dd>
                    {stale ? "—" : number(p.mark, 4)}{" "}
                    <small>USDT / {p.base}</small>
                  </dd>
                </div>
                <div>
                  <dt>Estimated P&L if sold now</dt>
                  <dd
                    className={
                      !stale && Number(p.estimatedNetPnl) >= 0
                        ? "positive"
                        : "negative"
                    }
                  >
                    {stale ? "—" : signed(p.estimatedNetPnl)}{" "}
                    <small>USDT · bid less selling fee</small>
                  </dd>
                </div>
              </dl>
              <div className="position-footnote">
                Quote as of{" "}
                {p.received ? new Date(p.received).toLocaleTimeString() : "—"} ·
                Last entry {stamp(p.lastEntryAt)} · Estimates change with the
                market; realized only on sale.
              </div>
            </article>
          );
        })
      )}
    </section>
  );
}

export function StrategyPanel({ account }: { account: TradingAccount }) {
  const s = account.strategy;
  const holding = Object.values(account.holdings).some(
    (h) => Number(h.quantity) > 0,
  );
  return (
    <section
      className="panel strategy-panel"
      aria-label="AI strategy and memory"
    >
      <div className="panel-title">
        <h2>Strategy & memory</h2>
        <span className="trading-caption">
          {s
            ? `Revision ${s.revision} · ${new Date(s.updatedAt).toLocaleString()}`
            : "Waiting for first evaluation"}
        </span>
      </div>
      {!s ? (
        <div className="records-empty">
          The next successful evaluation will save an entry plan, exit plan and
          durable memory. These are supplied to the model on every check.
        </div>
      ) : (
        <div className="strategy-content">
          <p className="strategy-thesis">{s.thesis}</p>
          <div className="strategy-meters">
            {[
              ["AI entry readiness", s.entryReadiness],
              ["AI exit urgency", holding ? s.exitUrgency : 0],
            ].map(([label, score]) => (
              <div key={String(label)}>
                <label>
                  {label}
                  <b>{score} / 100</b>
                </label>
                <meter
                  min={0}
                  max={100}
                  value={Number(score)}
                  aria-label={String(label)}
                />
                <small>
                  {label === "AI exit urgency" && !holding
                    ? "No position to sell"
                    : "Model assessment at last evaluation"}
                </small>
              </div>
            ))}
          </div>
          <div className="strategy-plans">
            {[
              ["When to enter", s.entryConditions],
              ["Why keep holding", s.holdConditions],
              ["When to reduce or exit", s.exitConditions],
              ["What invalidates the plan", s.invalidation],
            ].map(([label, text]) => (
              <div key={label}>
                <h3>{label}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
          <details className="strategy-memory">
            <summary>Persistent memory · available at every evaluation</summary>
            <p>{s.memory}</p>
          </details>
          <small className="strategy-disclaimer">
            These scores describe the AI's latest assessment, not probabilities
            or live price triggers. The AI revisits this plan on its next
            evaluation and submits market or limit orders itself. Submitted
            limits continue to be monitored by the engine between evaluations.
            No automatic take-profit or position stop-loss.{" "}
            {account.enabled
              ? "Evaluation enabled."
              : "Run paused; this plan is saved."}{" "}
            Market snapshot: {new Date(s.marketAsOf).toLocaleString()}.
          </small>
        </div>
      )}
    </section>
  );
}
