import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  BarChart3,
  BookOpen,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Copy,
  Download,
  Expand,
  ExternalLink,
  Globe2,
  Grid2X2,
  Layers,
  Maximize2,
  Moon,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Star,
  Sun,
  Terminal,
  TrendingUp,
  Wifi,
  Zap,
  X,
  Wallet,
  FlaskConical,
} from "lucide-react";
import { market } from "./market/engine";
import {
  ASSETS,
  INTERVALS,
  VENUES,
  VENUE_META,
  PRIMARY_VENUE,
  assetsForVenue,
  sourceFor,
  sourceReason,
  pair,
  quoteKey,
} from "./market/types";
import type {
  Candle,
  FeedHealth,
  MarketState,
  Quote,
  Venue,
} from "./market/types";
import { PriceChart, numberPrice } from "./components/PriceChart";
import type { ChartKind, Indicator } from "./components/PriceChart";
import { TradingPages } from "./trading/TradingPages";

type Page = "workspace" | "overview" | "sources" | "lab" | "paper" | "ai";
const nfmt = (n: number | undefined, d = 2) =>
  n === undefined || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", {
        maximumFractionDigits: d,
        minimumFractionDigits: d,
      });
const compact = (n: number | undefined) =>
  n === undefined
    ? "—"
    : Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(n);
const pct = (n: number | undefined) =>
  n === undefined ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const age = (t: number, now: number) =>
  !t ? "Waiting" : `${Math.max(0, Math.floor((now - t) / 1000))}s ago`;
const utc = (t: number) =>
  new Date(t).toLocaleTimeString("en-GB", { timeZone: "UTC", hour12: false });
const colorClass = (n: number | undefined) =>
  n === undefined ? "muted" : n >= 0 ? "positive" : "negative";
function read<T>(key: string, initial: T): T {
  try {
    const x = localStorage.getItem(key);
    return x ? JSON.parse(x) : initial;
  } catch {
    return initial;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Preferences are optional. */
  }
}
function Coin({ base, small = false }: { base: string; small?: boolean }) {
  const a = ASSETS.find((a) => a.base === base)!;
  return (
    <span
      className={`coin ${small ? "small" : ""}`}
      style={{ background: `${a.color}1e`, color: a.color }}
    >
      {a.glyph}
    </span>
  );
}
function VenueMark({ venue }: { venue: Venue }) {
  return (
    <span className={`venue-mark ${venue}`}>
      {venue === "binance" ? (
        <span className="binance-mark">◆</span>
      ) : venue === "coinbase" ? (
        "C"
      ) : (
        "K"
      )}
    </span>
  );
}
function Status({ health, now }: { health: FeedHealth; now: number }) {
  const stale = health.phase === "live" && now - health.lastMessage > 25000;
  const label = stale
    ? "Stale"
    : health.phase === "live"
      ? "Live"
      : health.phase === "error"
        ? "Unavailable"
        : health.phase === "connecting"
          ? "Connecting"
          : health.phase === "reconnecting"
            ? "Reconnecting"
            : "Paused";
  return (
    <span
      className={`status ${label === "Live" ? "ok" : label === "Paused" ? "idle" : "warn"}`}
    >
      <i />
      {label}
    </span>
  );
}
function exportCsv(
  candles: Candle[],
  venue: Venue,
  base: string,
  interval: number,
) {
  const lines = [
    "time_utc,open,high,low,close,volume_base,partial",
    ...candles.map((c) =>
      [
        new Date(c.time * 1000).toISOString(),
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume,
        !!c.partial,
      ].join(","),
    ),
  ];
  const url = URL.createObjectURL(
    new Blob([lines.join("\n")], { type: "text/csv" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${venue}-${base}-${interval}s.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  const state = useSyncExternalStore(market.subscribe, market.getSnapshot),
    [page, setPage] = useState<Page>("workspace"),
    [now, setNow] = useState(Date.now()),
    [search, setSearch] = useState(""),
    [dark, setDark] = useState(() => read("rtp-dark", false)),
    [favorites, setFavorites] = useState<string[]>(() =>
      read("rtp-favorites", ["BTC", "ETH", "SOL"]),
    ),
    [onlyFavorites, setOnlyFavorites] = useState(false),
    [kind, setKind] = useState<ChartKind>("Candles"),
    [indicators, setIndicators] = useState<Indicator[]>(["Volume", "SMA 20"]),
    [showIndicators, setShowIndicators] = useState(false),
    [fitSignal, setFitSignal] = useState(0),
    [log, setLog] = useState(false),
    [toast, setToast] = useState(""),
    [help, setHelp] = useState(false);
  const { venue, base, interval } = state.selected,
    q = state.quotes[quoteKey(venue, base)],
    asset = ASSETS.find((a) => a.base === base)!,
    meta = VENUE_META[venue];
  const liveCount = VENUES.filter(
    (v) =>
      state.health[v].phase === "live" &&
      now - state.health[v].lastMessage < 25000,
  ).length;
  useEffect(() => {
    market.start();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      market.stop();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    save("rtp-dark", dark);
  }, [dark]);
  useEffect(() => {
    save("rtp-favorites", favorites);
  }, [favorites]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHelp(false);
        setShowIndicators(false);
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, []);
  const select = (b: string) => market.select(b, interval);
  const navigate = (p: Page) => {
    setPage(p);
    setShowIndicators(false);
  };
  const title = {
    workspace: "Market workspace",
    overview: "Market overview",
    sources: "Data sources",
    lab: "The research lab",
    paper: "Paper trading",
    ai: "AI simulations",
  }[page];
  const subtitle = {
    workspace: "Your window into the crypto market.",
    overview: "The bigger picture, one market at a time.",
    sources: "Every connection. Every update. In the open.",
    lab: "An ambitious idea. Built one verified step at a time.",
    paper: "Real market data. A space to practice every decision.",
    ai: "Different models. Independent capital. Every decision in view.",
  }[page];
  const spread = q?.ask && q?.bid ? q.ask - q.bid : undefined;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("workspace");
          }}
          aria-label="RunThisPR home"
        >
          <span className="brand-symbol">
            <svg viewBox="0 0 26 26">
              <path d="M5 19V7h8c8 0 8 9 1 9l6 6M10 11h3c2 0 2 2 0 2h-3" />
            </svg>
          </span>
          <span>
            runthispr<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace-label">
          RESEARCH TERMINAL <span>v0.1</span>
        </div>
        <p className="nav-caption">WORKSPACE</p>
        <nav>
          {(
            [
              { id: "workspace", label: "Markets", icon: Grid2X2 },
              { id: "overview", label: "Overview", icon: BarChart3 },
              { id: "paper", label: "Paper trading", icon: Wallet },
              { id: "ai", label: "AI simulations", icon: FlaskConical },
              { id: "sources", label: "Data sources", icon: Radio },
              { id: "lab", label: "Research lab", icon: BrainCircuit },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              aria-label={item.label}
              title={item.label}
              aria-current={page === item.id ? "page" : undefined}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === "sources" && <span className="nav-count">3</span>}
              {page === item.id && (
                <ChevronRight size={13} className="nav-arrow" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="build-note">
            <span className="tiny-label">
              <i className="live-dot" /> BUILDING IN PUBLIC
            </span>
            <strong>
              A trading lab,
              <br />
              with an open door.
            </strong>
            <p>Follow the journey from live data to AI paper trading.</p>
            <button onClick={() => navigate("lab")}>
              Explore the project <ArrowUpRight size={14} />
            </button>
          </div>
          <button className="sidebar-help" onClick={() => setHelp(true)}>
            <CircleHelp size={16} /> About this terminal{" "}
            <ArrowUpRight size={13} />
          </button>
          <div className="sidebar-foot">
            <span className="avatar">R</span>
            <span>
              Public workspace<small>No account needed</small>
            </span>
            <Globe2 size={15} />
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <Terminal size={16} />
            <span>Workspace</span>
            <ChevronRight size={13} />
            <b>{page === "workspace" ? "Crypto markets" : title}</b>
          </div>
          <div className="topbar-right">
            <span className="mono clock">
              {utc(now)} <em>UTC</em>
            </span>
            <span
              className={`connection-pill ${liveCount ? "" : "unavailable"}`}
            >
              <i />
              {state.paused ? "Feeds paused" : `${liveCount}/3 sources live`}
            </span>
            <button
              className="icon-button theme-toggle"
              title={dark ? "Switch to light theme" : "Switch to dark theme"}
              aria-label={
                dark ? "Switch to light theme" : "Switch to dark theme"
              }
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                CRYPTO RESEARCH <span>/</span> LIVE MARKETS
              </div>
              <h1>
                {title}
                <span className="heading-dot">.</span>
              </h1>
              <p>{subtitle}</p>
            </div>
            {page !== "ai" && (
              <div className="page-actions">
                <button
                  className="button secondary"
                  onClick={() => market.pause()}
                >
                  {state.paused ? <Play size={14} /> : <Pause size={14} />}{" "}
                  {page === "paper"
                    ? state.paused
                      ? "Resume chart feeds"
                      : "Pause chart feeds"
                    : state.paused
                      ? "Resume feeds"
                      : "Pause feeds"}
                </button>
                <button
                  className="button primary"
                  onClick={() => {
                    market.reconnect();
                    setToast("Reconnecting all market feeds");
                  }}
                  disabled={state.paused}
                >
                  <RefreshCw size={14} />{" "}
                  {page === "paper" ? "Refresh chart feeds" : "Refresh feeds"}
                </button>
              </div>
            )}
          </div>
          {page === "workspace" && (
            <>
              <div className="metric-grid">
                <div className="metric-card primary-metric">
                  <div className="metric-label">
                    <Coin base={base} small />
                    {asset.name}{" "}
                    <span>
                      {base}/{meta.quote}
                    </span>
                  </div>
                  <div className="metric-value">
                    {q ? numberPrice(q.price) : "—"} <small>{meta.quote}</small>
                  </div>
                  <div className="metric-bottom">
                    <VenueMark venue={venue} />
                    {meta.name}
                    <span className="spacer" />
                    <span
                      className={
                        q && now - q.received < 15000 ? "positive" : "muted"
                      }
                    >
                      {q ? age(q.received, now) : "Awaiting first quote"}
                    </span>
                  </div>
                </div>
                <Metric
                  label="24h price change"
                  value={pct(q?.change)}
                  positive={q?.change}
                  icon={TrendingUp}
                  detail="Rolling 24-hour window"
                />
                <Metric
                  label="24h traded volume"
                  value={compact(q?.volume)}
                  unit={base}
                  icon={BarChart3}
                  detail={`${meta.name} venue volume`}
                />
                <Metric
                  label="Bid–ask spread"
                  value={
                    spread === undefined
                      ? "—"
                      : nfmt(spread, spread < 0.01 ? 6 : 2)
                  }
                  unit={meta.quote}
                  icon={Layers}
                  detail={
                    spread !== undefined && q
                      ? `${((spread / q.price) * 10000).toFixed(2)} basis points`
                      : "Awaiting two-sided quote"
                  }
                />
              </div>
              <div className="terminal-grid">
                <section className="panel watchlist">
                  <div className="panel-title">
                    <h2>
                      Markets <span>{ASSETS.length}</span>
                    </h2>
                    <button
                      className={`icon-button ${onlyFavorites ? "favorite-active" : ""}`}
                      aria-label={
                        onlyFavorites ? "Show all markets" : "Show favorites"
                      }
                      title="Toggle favorites"
                      onClick={() => setOnlyFavorites(!onlyFavorites)}
                    >
                      <Star
                        size={15}
                        fill={onlyFavorites ? "currentColor" : "none"}
                      />
                    </button>
                  </div>
                  <div className="market-search">
                    <Search size={14} />
                    <input
                      placeholder="Search markets…"
                      aria-label="Search markets"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <span>/</span>
                  </div>
                  <div className="list-caption">
                    <span>Asset</span>
                    <span>Price / 24h</span>
                  </div>
                  <div className="market-list">
                    {ASSETS.filter(
                      (a) =>
                        (!onlyFavorites || favorites.includes(a.base)) &&
                        `${a.base} ${a.name}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                    ).map((a) => {
                      const price =
                        state.quotes[quoteKey(sourceFor(a.base), a.base)];
                      return (
                        <div
                          className={`market-row ${a.base === base ? "selected" : ""}`}
                          key={a.base}
                        >
                          <button
                            className="market-select"
                            onClick={() => select(a.base)}
                            aria-label={`Select ${a.name}`}
                            aria-pressed={a.base === base}
                          >
                            <Coin base={a.base} />
                            <span className="market-name">
                              <b>
                                {a.base}
                                <small>
                                  {VENUE_META[sourceFor(a.base)].quote}
                                </small>
                              </b>
                              <span>{a.name}</span>
                            </span>
                            <span className="market-price mono">
                              <b>{price ? numberPrice(price.price) : "—"}</b>
                              <span className={colorClass(price?.change)}>
                                {pct(price?.change)}
                              </span>
                            </span>
                          </button>
                          <button
                            className={`favorite-button ${favorites.includes(a.base) ? "is-favorite" : ""}`}
                            aria-label={`${favorites.includes(a.base) ? "Remove" : "Add"} ${a.name} ${favorites.includes(a.base) ? "from" : "to"} favorites`}
                            onClick={() =>
                              setFavorites((f) =>
                                f.includes(a.base)
                                  ? f.filter((b) => b !== a.base)
                                  : [...f, a.base],
                              )
                            }
                          >
                            <Star
                              size={11}
                              fill={
                                favorites.includes(a.base)
                                  ? "currentColor"
                                  : "none"
                              }
                            />
                          </button>
                        </div>
                      );
                    })}
                    {!ASSETS.some(
                      (a) =>
                        (!onlyFavorites || favorites.includes(a.base)) &&
                        `${a.base} ${a.name}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                    ) && <div className="empty-small">No matching markets</div>}
                  </div>
                  <div className="watchlist-bottom">
                    <div>
                      <Globe2 size={14} />
                      <b>Crypto never sleeps</b>
                      <span>24 / 7</span>
                    </div>
                    <p>
                      Binance primary · extended coverage
                      <br />
                      Quote currency shown for every market.
                    </p>
                  </div>
                </section>
                <section className="panel chart-panel">
                  <div className="chart-header">
                    <div className="instrument-name">
                      <Coin base={base} />
                      <div>
                        <h2>
                          {base}
                          <span> / {meta.quote}</span>
                          <span className="tag">SPOT</span>
                        </h2>
                        <span>
                          {asset.name} <i>·</i> {meta.name}
                        </span>
                      </div>
                    </div>
                    <div className="chart-header-actions">
                      <button
                        className="icon-button"
                        title="Fit chart to data"
                        aria-label="Fit chart to data"
                        onClick={() => setFitSignal((x) => x + 1)}
                      >
                        <Maximize2 size={15} />
                      </button>
                      <button
                        className="icon-button"
                        title="Export candle CSV"
                        aria-label="Export candle CSV"
                        disabled={!state.candles.length}
                        onClick={() =>
                          exportCsv(state.candles, venue, base, interval)
                        }
                      >
                        <Download size={15} />
                      </button>
                    </div>
                  </div>
                  <div className="chart-toolbar">
                    <div className="intervals">
                      {INTERVALS.map((i) => (
                        <button
                          key={i.seconds}
                          aria-pressed={interval === i.seconds}
                          className={interval === i.seconds ? "active" : ""}
                          onClick={() => market.select(base, i.seconds)}
                        >
                          {i.label}
                        </button>
                      ))}
                    </div>
                    <div className="toolbar-divider" />
                    <select
                      className="chart-kind"
                      aria-label="Chart type"
                      value={kind}
                      onChange={(e) => setKind(e.target.value as ChartKind)}
                    >
                      {["Candles", "Line", "Area", "OHLC"].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                    <div className="indicator-control">
                      <button
                        className={`toolbar-button ${showIndicators ? "active" : ""}`}
                        onClick={() => setShowIndicators(!showIndicators)}
                        aria-expanded={showIndicators}
                      >
                        <Settings2 size={13} />
                        <span>Indicators</span>
                      </button>
                      {showIndicators && (
                        <div className="indicator-popover">
                          <strong>Chart indicators</strong>
                          {(
                            [
                              "Volume",
                              "SMA 20",
                              "EMA 50",
                              "RSI 14",
                            ] as Indicator[]
                          ).map((i) => (
                            <label key={i}>
                              <input
                                type="checkbox"
                                checked={indicators.includes(i)}
                                onChange={() =>
                                  setIndicators((x) =>
                                    x.includes(i)
                                      ? x.filter((a) => a !== i)
                                      : [...x, i],
                                  )
                                }
                              />
                              {i}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      className={`log-toggle ${log ? "active" : ""}`}
                      onClick={() => setLog(!log)}
                      aria-pressed={log}
                      title="Toggle logarithmic price scale"
                    >
                      log
                    </button>
                  </div>
                  <PriceChart
                    candles={state.candles}
                    identity={`${venue}:${base}:${interval}`}
                    kind={kind}
                    indicators={indicators}
                    dark={dark}
                    log={log}
                    fitSignal={fitSignal}
                    emptyLabel={
                      state.paused
                        ? "Market feeds paused"
                        : state.history === "error" && state.detail !== "live"
                          ? "Market data unavailable"
                          : "Connecting to the market"
                    }
                  />
                  <div className="chart-status">
                    <span>
                      <i
                        className={
                          state.detail === "live" ? "live-dot" : "waiting-dot"
                        }
                      />
                      {state.paused
                        ? "Paused"
                        : state.detail === "live"
                          ? "Streaming"
                          : state.detail === "error"
                            ? "Connection issue"
                            : "Connecting"}
                    </span>
                    <span>
                      {state.history === "loading"
                        ? "Loading history…"
                        : `${state.candles.length} bars`}{" "}
                      <i>·</i> UTC
                    </span>
                    <span className="chart-source">
                      {venue === "coinbase"
                        ? "Current bar: observed trades, may be partial"
                        : "Native exchange candles"}
                    </span>
                  </div>
                  {state.historyError && (
                    <div className="inline-warning">
                      {state.historyError}. Live updates continue where
                      available.{" "}
                      <button onClick={() => market.reconnect(venue)}>
                        Retry
                      </button>
                    </div>
                  )}
                  {state.detailError && state.detail !== "live" && (
                    <div className="inline-warning">{state.detailError}</div>
                  )}
                </section>
                <OrderBook state={state} now={now} />
                <section className="panel trades-panel">
                  <div className="panel-title">
                    <h2>
                      Recent trades{" "}
                      <span className="live-label">
                        <i
                          className={
                            state.detail === "live" ? "live-dot" : "waiting-dot"
                          }
                        />
                        {state.paused
                          ? "PAUSED"
                          : state.detail === "live"
                            ? "LIVE TAPE"
                            : "WAITING"}
                      </span>
                    </h2>
                    <span className="subtle-label">
                      {meta.name} · taker side
                    </span>
                  </div>
                  <div className="trade-table">
                    <div className="trade-row table-head">
                      <span>Price ({meta.quote})</span>
                      <span>Size ({base})</span>
                      <span>Side</span>
                      <span>Time (UTC)</span>
                    </div>
                    {state.trades.slice(0, 6).map((t) => (
                      <div className="trade-row mono" key={t.id}>
                        <b
                          className={t.side === "buy" ? "positive" : "negative"}
                        >
                          {numberPrice(t.price)}
                        </b>
                        <span>{nfmt(t.size, 6)}</span>
                        <span className={`trade-side ${t.side}`}>
                          {t.side === "buy" ? (
                            <ArrowUpRight size={11} />
                          ) : (
                            <ArrowDownLeft size={11} />
                          )}{" "}
                          {t.side}
                        </span>
                        <span className="muted">{utc(t.time)}</span>
                      </div>
                    ))}
                    {!state.trades.length && (
                      <div className="empty-small">
                        Waiting for trades on {pair(venue, base)}…
                      </div>
                    )}
                  </div>
                </section>
                <section className="panel venues-panel">
                  <div className="panel-title">
                    <h2>Market source</h2>
                    <Radio size={14} className="muted" />
                  </div>
                  <div className="venue-quote chosen">
                    <VenueMark venue={venue} />
                    <span>
                      <b>{meta.name}</b>
                      <small>{pair(venue, base)}</small>
                    </span>
                    <span className="source-role">
                      {venue === PRIMARY_VENUE ? "PRIMARY" : "EXTENDED"}
                    </span>
                  </div>
                  <p className="venue-note">
                    {sourceReason(base)} Prices, charts and liquidity all come
                    from this market.
                  </p>
                  <button
                    className="source-details"
                    onClick={() => navigate("sources")}
                  >
                    View source coverage <ArrowUpRight size={12} />
                  </button>
                </section>
              </div>
            </>
          )}
          {page === "overview" && (
            <Overview
              state={state}
              select={(b) => {
                select(b);
                navigate("workspace");
              }}
            />
          )}
          {page === "sources" && <Sources state={state} now={now} />}
          {(page === "paper" || page === "ai") && (
            <TradingPages
              key={page}
              mode={page === "paper" ? "manual" : "ai"}
              state={state}
              dark={dark}
            />
          )}
          {page === "lab" && (
            <Research
              onExplore={() => navigate("workspace")}
              onShare={async () => {
                try {
                  await navigator.clipboard.writeText(location.origin);
                  setToast("Project link copied");
                } catch {
                  setToast(`Project link: ${location.origin}`);
                }
              }}
            />
          )}
          <footer className="page-footer">
            <span>
              <ShieldCheck size={13} /> Research & paper trading · No real-money
              orders
            </span>
            <span>
              Built in public <span>✳</span> runthispr.com
            </span>
          </footer>
        </div>
      </main>
      {toast && (
        <div role="status" className="toast">
          <Check size={16} />
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
            className="about-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const focusable =
                event.currentTarget.querySelectorAll<HTMLElement>(
                  "button, a[href]",
                );
              const first = focusable[0],
                last = focusable[focusable.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close about terminal"
              autoFocus
              onClick={() => setHelp(false)}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">RUNTHISPR / BUILD 0.1</span>
            <h2 id="about-title">
              A clearer window
              <br />
              into real markets.
            </h2>
            <p>
              This is the first chapter of an AI paper-trading research
              platform. Today, explore live spot-crypto prices, historical
              charts, trades and liquidity. Binance is the primary source;
              Kraken and Coinbase extend coverage where Binance has no market.
            </p>
            <p>
              Feeds connect directly from your browser while this terminal is
              open. Availability can vary by network and region. Quotes retain
              their venue and currency; there is no combined execution price.
            </p>
            <p>
              Coinbase’s current candle is built from observed trades and may be
              partial. Kraken supplies 100 price levels per side with CRC32
              verification of the top ten; Binance depth uses complete top-20
              snapshots. Coinbase depth uses its snapshot/update protocol.
            </p>
            <p className="muted">
              Charts use{" "}
              <a
                href="https://www.tradingview.com/"
                target="_blank"
                rel="noreferrer"
              >
                TradingView Lightweight Charts
              </a>{" "}
              (Apache 2.0). This project is independent of the exchanges. No
              exchange credentials are collected.
            </p>
            <button
              className="button primary"
              onClick={() => {
                setHelp(false);
                navigate("lab");
              }}
            >
              See what’s next <ArrowRight size={15} />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  unit,
  detail,
  positive,
  icon: Icon,
}: {
  label: string;
  value: string;
  unit?: string;
  detail: string;
  positive?: number;
  icon: typeof Activity;
}) {
  return (
    <div className="metric-card">
      <div className="metric-label">
        {label}
        <Icon size={15} />
      </div>
      <div
        className={`metric-value ${positive === undefined ? "" : colorClass(positive)}`}
      >
        {value} {unit && <small>{unit}</small>}
      </div>
      <div className="metric-bottom">
        {positive !== undefined &&
          (positive >= 0 ? (
            <ArrowUpRight size={12} />
          ) : (
            <ArrowDownLeft size={12} />
          ))}
        {detail}
      </div>
    </div>
  );
}
function OrderBook({ state, now }: { state: MarketState; now: number }) {
  const [levelsShown, setLevelsShown] = useState(7);
  const {
      book,
      selected: { venue, base },
    } = state,
    quote = VENUE_META[venue].quote;
  const depthLimit = venue === "binance" ? 20 : 100;
  const visibleDepth = Math.min(levelsShown, depthLimit);
  const bids = book.bids.slice(0, visibleDepth),
    asks = book.asks.slice(0, visibleDepth);
  const max = Math.max(...[...bids, ...asks].map((l) => l.size), 1e-9);
  const mid =
    bids[0] && asks[0] ? (bids[0].price + asks[0].price) / 2 : undefined;
  const spread = bids[0] && asks[0] ? asks[0].price - bids[0].price : undefined;
  return (
    <section className="panel book-panel">
      <div className="panel-title">
        <h2>Order book</h2>
        <select
          className="book-depth"
          aria-label="Visible book levels"
          value={visibleDepth}
          onChange={(e) => setLevelsShown(Number(e.target.value))}
        >
          {[7, 20, 50, 100]
            .filter((n) => n <= depthLimit)
            .map((n) => (
              <option key={n} value={n}>
                {n} levels
              </option>
            ))}
        </select>
      </div>
      <div className="book-head">
        <span>Price ({quote})</span>
        <span>Size ({base})</span>
      </div>
      <div className="book-levels">
        {asks
          .slice()
          .reverse()
          .map((l) => (
            <div className="book-row ask mono" key={l.rawPrice}>
              <i style={{ width: `${(l.size / max) * 95}%` }} />
              <span>{numberPrice(l.price)}</span>
              <span>{nfmt(l.size, 4)}</span>
            </div>
          ))}
        {!asks.length && (
          <div className="empty-book">
            {state.paused ? "Feeds paused" : "Waiting for depth…"}
          </div>
        )}
      </div>
      <div className="book-mid">
        <strong className="mono">
          {mid ? numberPrice(mid) : "—"}
          <ArrowUpRight size={14} />
        </strong>
        <span>
          Spread{" "}
          <b className="mono">
            {spread === undefined ? "—" : nfmt(spread, spread < 0.01 ? 6 : 2)}
          </b>
        </span>
      </div>
      <div className="book-levels">
        {bids.map((l) => (
          <div className="book-row bid mono" key={l.rawPrice}>
            <i style={{ width: `${(l.size / max) * 95}%` }} />
            <span>{numberPrice(l.price)}</span>
            <span>{nfmt(l.size, 4)}</span>
          </div>
        ))}
      </div>
      <div
        className={`book-integrity ${book.received && now - book.received < 15000 ? "" : "muted"}`}
        title={book.method}
      >
        <ShieldCheck size={12} />
        {book.verified
          ? venue === "kraken"
            ? "CRC32 verified"
            : "Snapshot synchronized"
          : "Awaiting snapshot"}
        <span>{book.received ? age(book.received, now) : ""}</span>
      </div>
    </section>
  );
}
function Overview({
  state,
  select,
}: {
  state: MarketState;
  select: (base: string) => void;
}) {
  const rows = ASSETS.map((a) => ({
    ...a,
    q: state.quotes[quoteKey(sourceFor(a.base), a.base)],
  }));
  const valid = rows.filter((a) => a.q?.change !== undefined);
  const advancing = valid.filter((a) => (a.q?.change ?? 0) > 0).length;
  const [sort, setSort] = useState("name");
  const sorted =
    sort === "change"
      ? rows
          .slice()
          .sort(
            (a, b) => (b.q?.change ?? -Infinity) - (a.q?.change ?? -Infinity),
          )
      : rows;
  return (
    <>
      <div className="overview-tools">
        <span className="subtle-label">
          TRACKED SPOT UNIVERSE · {ASSETS.length} ASSETS
        </span>
        <div>
          <select
            aria-label="Sort overview"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="name">Default order</option>
            <option value="change">24h return</option>
          </select>
        </div>
      </div>
      <div className="overview-summary">
        <div>
          <span className="eyebrow">MARKET BREADTH</span>
          <h2>
            {advancing}
            <small> advancing</small>
            <span className="muted"> / {valid.length}</span>
          </h2>
          <p>Among tracked assets with live return data.</p>
        </div>
        <div className="breadth-track">
          <span
            style={{
              width: `${valid.length ? (advancing / valid.length) * 100 : 0}%`,
            }}
          />
          <i />
        </div>
        <p>
          Equal-size tiles · rolling 24h price change
          <br />
          Each asset retains its source and quote currency
        </p>
      </div>
      <div className="heatmap-grid">
        {sorted.map((a) => (
          <button
            className={`heat-tile ${(a.q?.change ?? 0) >= 0 ? "up" : "down"} ${!a.q ? "no-quote" : ""}`}
            key={a.base}
            onClick={() => select(a.base)}
          >
            <div>
              <Coin base={a.base} />
              <ArrowUpRight size={17} />
            </div>
            <h2>
              {a.base}
              <span>{a.name}</span>
            </h2>
            <strong className="mono">{pct(a.q?.change)}</strong>
            <span className="mono">
              {a.q ? numberPrice(a.q.price) : "Waiting for quote"}{" "}
              {VENUE_META[sourceFor(a.base)].quote}
            </span>
            <span className="heat-source">
              {VENUE_META[sourceFor(a.base)].name}
            </span>
          </button>
        ))}
      </div>
      <div className="info-strip">
        <Globe2 size={16} />
        <p>
          This view covers {assetsForVenue(PRIMARY_VENUE).length} Binance
          markets and {ASSETS.length - assetsForVenue(PRIMARY_VENUE).length}{" "}
          additional markets from specialist sources. It does not represent
          total market capitalization or the entire crypto market.
        </p>
      </div>
    </>
  );
}
function Sources({ state, now }: { state: MarketState; now: number }) {
  return (
    <>
      <div className="source-cards">
        {VENUES.map((v) => {
          const h = state.health[v],
            meta = VENUE_META[v],
            assigned = assetsForVenue(v),
            count = assigned.filter(
              (a) => state.quotes[quoteKey(v, a.base)],
            ).length;
          return (
            <section className="panel source-card" key={v}>
              <div className="source-heading">
                <VenueMark venue={v} />
                <div>
                  <h2>{meta.name}</h2>
                  <p>
                    {v === PRIMARY_VENUE
                      ? "Primary source"
                      : "Extended coverage"}{" "}
                    · {meta.quote}
                  </p>
                </div>
                <Status health={h} now={now} />
              </div>
              <div className="source-stats">
                <div>
                  <span>Quotes received</span>
                  <b className="mono">
                    {count}
                    <small> / {assigned.length}</small>
                  </b>
                </div>
                <div>
                  <span>Market data frames</span>
                  <b className="mono">{compact(h.marketUpdates)}</b>
                </div>
                <div>
                  <span>Last message</span>
                  <b className="mono">{age(h.lastMessage, now)}</b>
                </div>
                <div>
                  <span>Reconnects</span>
                  <b className="mono">{h.reconnects}</b>
                </div>
              </div>
              <p className="source-assignments">
                <b>Assigned markets</b>
                <br />
                {assigned.map((a) => `${a.base}/${meta.quote}`).join(" · ")}
              </p>
              <p className="source-transport">
                <Wifi size={14} />
                {meta.transport}
              </p>
              <p className="source-channel">{meta.channels}</p>
              <p className="source-channel">
                {compact(h.messages)} total frames across active channels,
                including control messages. Counts reflect each feed's batching
                and subscriptions, not comparable trading volume.
              </p>
              {h.error && <div className="inline-warning">{h.error}</div>}
              <div className="source-actions">
                <a href={meta.url} target="_blank" rel="noreferrer">
                  Official documentation <ExternalLink size={12} />
                </a>
                <button
                  className="icon-button"
                  disabled={state.paused}
                  title={`Reconnect ${meta.name}`}
                  aria-label={`Reconnect ${meta.name}`}
                  onClick={() => market.reconnect(v)}
                >
                  <RefreshCw size={14} />
                </button>
              </div>
            </section>
          );
        })}
      </div>
      <div className="source-bottom">
        <section className="panel event-log">
          <div className="panel-title">
            <h2>Connection activity</h2>
            <span className="subtle-label">THIS BROWSER SESSION</span>
          </div>
          {state.logs.length ? (
            state.logs.slice(0, 14).map((l, i) => (
              <div className="event-row" key={`${l.time}-${i}`}>
                <span className="mono muted">{utc(l.time)}</span>
                <span className={`event-dot ${l.kind}`} />
                <b>{VENUE_META[l.venue].name}</b>
                <span>{l.message}</span>
              </div>
            ))
          ) : (
            <div className="empty-small">No connection events yet.</div>
          )}
        </section>
        <section className="panel source-explainer">
          <span className="eyebrow">KNOW YOUR DATA</span>
          <h2>
            One workspace.
            <br />
            Sources with a purpose.
          </h2>
          <p>
            Binance supplies the core USDT markets. Kraken adds Monero and
            Coinbase adds Arcblock, which have no active Binance spot listing.
            Each asset is routed automatically to one source.
          </p>
          <p>
            The selected market supplies its own prices, candles, trades and
            order book. USD and USDT stay distinct. A source outage is shown
            explicitly; it never silently replaces the market with another
            exchange.
          </p>
          <div className="info-strip">
            <Radio size={16} />
            <p>
              Feeds run in your browser while the terminal is open. No API keys
              or exchange login required.
            </p>
          </div>
          <p className="muted">
            Raw tick storage, gap-complete trade recovery and an unattended
            ingestion server are planned for a later phase.
          </p>
        </section>
      </div>
    </>
  );
}
function Research({
  onExplore,
  onShare,
}: {
  onExplore: () => void;
  onShare: () => void;
}) {
  return (
    <>
      <section className="lab-hero">
        <div>
          <span className="lab-badge">
            <i className="live-dot" /> AN OPEN RESEARCH PROJECT
          </span>
          <h2>
            Real markets.
            <br />
            Curious machines.
            <br />
            <em>Everything to learn.</em>
          </h2>
          <p>
            We’re building a place where AI can observe markets, test ideas with
            paper trades, and learn from evidence. Live markets now connect to a
            paper-trading workspace and independent model experiments.
          </p>
          <div className="lab-actions">
            <button className="button primary" onClick={onExplore}>
              Explore live markets <ArrowUpRight size={15} />
            </button>
            <button className="button secondary" onClick={onShare}>
              <Copy size={14} /> Share the project
            </button>
          </div>
        </div>
        <div className="lab-diagram">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="lab-center">
            <BrainCircuit size={43} />
            <span>THE RESEARCH LOOP</span>
          </div>
          <span className="orbit-label label-one">
            <Radio size={15} /> Observe
          </span>
          <span className="orbit-label label-two">
            <Code2 size={15} /> Experiment
          </span>
          <span className="orbit-label label-three">
            <BookOpen size={15} /> Learn
          </span>
        </div>
      </section>
      <div className="roadmap-heading">
        <h2>The path ahead</h2>
        <span className="subtle-label">ONE VERIFIED STEP AT A TIME</span>
      </div>
      <div className="roadmap-grid">
        {[
          {
            n: "01",
            title: "Market intelligence",
            text: "Binance-led crypto data, wider coverage from specialist sources, charts and transparent feed health.",
            state: "LIVE NOW",
            icon: Radio,
          },
          {
            n: "02",
            title: "Paper execution",
            text: "Independently funded accounts, decimal accounting, reservations, fees and depth-based fills.",
            state: "LOCAL BACKEND READY",
            icon: Layers,
          },
          {
            n: "03",
            title: "Independent model runs",
            text: "Per-run models and capital, server risk checks and a readable decision journal. Provider connection required.",
            state: "INTEGRATION READY",
            icon: BrainCircuit,
          },
          {
            n: "04",
            title: "Evidence-led learning",
            text: "Versioned hypotheses, chronological experiments and honest comparisons.",
            state: "PLANNED",
            icon: BookOpen,
          },
        ].map((x, i) => (
          <section
            className={`panel roadmap-card ${i === 0 ? "current" : ""}`}
            key={x.n}
          >
            <div>
              <span className="mono">{x.n}</span>
              <x.icon size={21} />
            </div>
            <h3>{x.title}</h3>
            <p>{x.text}</p>
            <span className={`tag ${i === 0 ? "live-tag" : ""}`}>
              {x.state}
            </span>
          </section>
        ))}
      </div>
      <div className="research-note">
        <ShieldCheck size={21} />
        <div>
          <h3>Measured by evidence.</h3>
          <p>
            Future strategies will be evaluated after costs and against unseen
            data. Paper results will include their assumptions and limitations.
            Orders remain inside the paper engine; no real-money orders are sent
            to an exchange.
          </p>
        </div>
      </div>
    </>
  );
}
