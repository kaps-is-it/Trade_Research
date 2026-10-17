import { useEffect, useState } from "react";
import { Maximize2 } from "lucide-react";
import { PriceChart, numberPrice } from "../components/PriceChart";
import type { ChartKind, Indicator } from "../components/PriceChart";
import { market } from "../market/engine";
import { INTERVALS } from "../market/types";
import type { MarketState } from "../market/types";

const INDICATORS: Indicator[] = ["Volume"];

export function SimulationChart({
  base,
  state,
  dark,
}: {
  base: string;
  state: MarketState;
  dark: boolean;
}) {
  const [interval, setInterval] = useState(300),
    [kind, setKind] = useState<ChartKind>("Candles"),
    [fitSignal, setFitSignal] = useState(0);
  useEffect(() => {
    market.select(base, interval);
  }, [base, interval]);
  const matches =
    state.selected.venue === "binance" &&
    state.selected.base === base &&
    state.selected.interval === interval;
  const candles = matches ? state.candles : [],
    quote = state.quotes[`binance:${base}`],
    fresh = quote && Date.now() - quote.received <= 10000,
    streaming = matches && !state.paused && state.detail === "live";
  return (
    <section
      className="panel simulation-chart"
      aria-label="Simulation market chart"
    >
      <div className="panel-title simulation-chart-heading">
        <div>
          <h2>{base} / USDT</h2>
          <span className="trading-caption">
            {base === "BTC" ? "Bitcoin · " : ""}Binance spot · live market
          </span>
        </div>
        <div className="simulation-chart-quote">
          <strong className="mono">
            {quote ? numberPrice(quote.price) : "—"}
            <small> USDT</small>
          </strong>
          <span className="trading-caption">
            {state.paused
              ? "Chart feed paused"
              : fresh
                ? "Latest trade"
                : "Waiting for fresh price"}
          </span>
        </div>
      </div>
      <div className="chart-toolbar simulation-chart-toolbar">
        <div
          className="intervals"
          role="group"
          aria-label="Simulation chart timeframe"
        >
          {INTERVALS.map((i) => (
            <button
              key={i.seconds}
              className={interval === i.seconds ? "active" : ""}
              aria-pressed={interval === i.seconds}
              onClick={() => setInterval(i.seconds)}
            >
              {i.label}
            </button>
          ))}
        </div>
        <select
          className="chart-kind"
          aria-label="Simulation chart type"
          value={kind}
          onChange={(e) => setKind(e.target.value as ChartKind)}
        >
          {["Candles", "Line", "Area", "OHLC"].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <button
          className="toolbar-button simulation-chart-fit"
          aria-label="Fit simulation chart to data"
          title="Fit chart to data"
          onClick={() => setFitSignal((n) => n + 1)}
        >
          <Maximize2 size={15} />
        </button>
      </div>
      <div className="paper-chart-area">
        <PriceChart
          candles={candles}
          identity={`binance-${base}-simulation-${interval}`}
          kind={kind}
          indicators={INDICATORS}
          dark={dark}
          log={false}
          fitSignal={fitSignal}
          emptyLabel={
            state.paused
              ? "Market feeds paused"
              : matches && state.history === "error"
                ? "Chart history is unavailable"
                : "Connecting to the market"
          }
        />
      </div>
      <div className="chart-status">
        <span>
          <i className={streaming ? "live-dot" : "waiting-dot"} />
          {state.paused
            ? "Paused"
            : streaming
              ? "Streaming"
              : matches && state.detail === "error"
                ? "Connection issue"
                : "Connecting"}
        </span>
        <span>{candles.length} bars · UTC</span>
      </div>
      {matches && state.historyError && (
        <div className="inline-warning">{state.historyError}</div>
      )}
      <p className="simulation-chart-note">
        View any timeframe here. The AI continues assessing live prices and
        closed 5-minute candles; changing this chart does not change its trading
        inputs.
      </p>
    </section>
  );
}
