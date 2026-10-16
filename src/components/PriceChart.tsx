import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  PriceScaleMode,
  createChart,
} from "lightweight-charts";
import type {
  IChartApi,
  ISeriesApi,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../market/types";
import { sma, ema, rsi } from "../market/indicators";

export type ChartKind = "Candles" | "Line" | "Area" | "OHLC";
export type Indicator = "SMA 20" | "EMA 50" | "RSI 14" | "Volume";
export function numberPrice(n: number) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: n < 1 ? 4 : 2,
    maximumFractionDigits: n < 1 ? 6 : 2,
  });
}
export function PriceChart({
  candles,
  identity,
  kind,
  indicators,
  dark,
  log,
  fitSignal,
  emptyLabel,
}: {
  candles: Candle[];
  identity: string;
  kind: ChartKind;
  indicators: Indicator[];
  dark: boolean;
  log: boolean;
  fitSignal: number;
  emptyLabel: string;
}) {
  const container = useRef<HTMLDivElement>(null),
    api = useRef<IChartApi | undefined>(undefined),
    series = useRef<ISeriesApi<any> | undefined>(undefined),
    volume = useRef<ISeriesApi<"Histogram"> | undefined>(undefined),
    smaSeries = useRef<ISeriesApi<"Line"> | undefined>(undefined),
    emaSeries = useRef<ISeriesApi<"Line"> | undefined>(undefined),
    rsiSeries = useRef<ISeriesApi<"Line"> | undefined>(undefined),
    didFit = useRef(false),
    rows = useRef(candles);
  const [hover, setHover] = useState<Candle | undefined>(undefined);
  rows.current = candles;
  useEffect(() => {
    if (!container.current) return;
    didFit.current = false;
    setHover(undefined);
    const chart = createChart(container.current, {
      autoSize: true,
      layout: {
        background: {
          type: ColorType.Solid,
          color: dark ? "#161c20" : "#ffffff",
        },
        textColor: dark ? "#8d9b9f" : "#82908c",
        fontFamily: '"SFMono-Regular", Consolas, monospace',
        fontSize: 10,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: dark ? "#222b30" : "#f1f3f0" },
        horzLines: { color: dark ? "#222b30" : "#edf0ec" },
      },
      rightPriceScale: {
        borderColor: dark ? "#2a3438" : "#e7ebe5",
        mode: log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: dark ? "#2a3438" : "#e7ebe5",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 7,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#9baa9a", labelBackgroundColor: "#344436" },
        horzLine: { color: "#9baa9a", labelBackgroundColor: "#344436" },
      },
      localization: { locale: "en-US", priceFormatter: numberPrice },
    });
    api.current = chart;
    const common = { priceLineColor: "#2a9a80", priceLineWidth: 1 as const };
    if (kind === "Candles")
      series.current = chart.addSeries(CandlestickSeries, {
        ...common,
        upColor: "#2c9e84",
        downColor: "#df726b",
        wickUpColor: "#2c9e84",
        wickDownColor: "#df726b",
        borderVisible: false,
      });
    else if (kind === "OHLC")
      series.current = chart.addSeries(BarSeries, {
        ...common,
        upColor: "#2c9e84",
        downColor: "#df726b",
      });
    else if (kind === "Area")
      series.current = chart.addSeries(AreaSeries, {
        ...common,
        lineColor: "#369e87",
        topColor: dark ? "#359d872d" : "#38a68b22",
        bottomColor: "#38a68b00",
        lineWidth: 2,
      });
    else
      series.current = chart.addSeries(LineSeries, {
        ...common,
        color: "#369e87",
        lineWidth: 2,
      });
    let pane = 1;
    if (indicators.includes("Volume")) {
      volume.current = chart.addSeries(
        HistogramSeries,
        {
          priceFormat: { type: "volume" },
          priceLineVisible: false,
          lastValueVisible: false,
        },
        pane++,
      );
      chart.panes()[1].setHeight(72);
    }
    if (indicators.includes("SMA 20"))
      smaSeries.current = chart.addSeries(LineSeries, {
        color: "#d7ac51",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
    if (indicators.includes("EMA 50"))
      emaSeries.current = chart.addSeries(LineSeries, {
        color: "#8d8fd1",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
    if (indicators.includes("RSI 14")) {
      rsiSeries.current = chart.addSeries(
        LineSeries,
        {
          color: "#9992d0",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          priceFormat: {
            type: "custom",
            formatter: (n: number) => n.toFixed(1),
          },
        },
        pane,
      );
      chart.panes()[pane].setHeight(80);
      rsiSeries.current.createPriceLine({
        price: 70,
        color: "#929a9a66",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
      });
      rsiSeries.current.createPriceLine({
        price: 30,
        color: "#929a9a66",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
      });
    }
    chart.subscribeCrosshairMove((p) => {
      setHover(
        typeof p.time === "number"
          ? rows.current.find((c) => c.time === p.time)
          : undefined,
      );
    });
    return () => {
      chart.remove();
      api.current = undefined;
      series.current = undefined;
      volume.current = undefined;
      smaSeries.current = undefined;
      emaSeries.current = undefined;
      rsiSeries.current = undefined;
    };
  }, [identity, kind, indicators, dark]);
  useEffect(() => {
    api.current?.priceScale("right").applyOptions({
      mode: log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [log]);
  useEffect(() => {
    if (!series.current || !api.current) return;
    const data = candles.map((c) => ({ ...c, time: c.time as UTCTimestamp }));
    series.current.setData(
      kind === "Candles" || kind === "OHLC"
        ? data
        : data.map((c) => ({ time: c.time, value: c.close })),
    );
    volume.current?.setData(
      data.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? "#2f9e843b" : "#df726b35",
      })),
    );
    const points = (p: { time: number; value: number }[]) =>
      p.map((d) => ({ ...d, time: d.time as Time }));
    smaSeries.current?.setData(points(sma(candles)));
    emaSeries.current?.setData(points(ema(candles)));
    rsiSeries.current?.setData(points(rsi(candles)));
    if (candles.length > 10 && !didFit.current) {
      api.current.timeScale().setVisibleLogicalRange({
        from: Math.max(0, candles.length - 100),
        to: candles.length + 5,
      });
      didFit.current = true;
    }
  }, [candles, identity, kind, indicators, dark]);
  useEffect(() => {
    if (fitSignal) api.current?.timeScale().fitContent();
  }, [fitSignal]);
  const c = hover ?? candles.at(-1);
  return (
    <div className="chart-inner">
      <div className="ohlc mono" aria-label="Candle details">
        {c ? (
          <>
            {(["open", "high", "low", "close"] as const).map((k) => (
              <span key={k}>
                <em>{k[0].toUpperCase()}</em> <b>{numberPrice(c[k])}</b>
              </span>
            ))}
            <span className={c.close >= c.open ? "positive" : "negative"}>
              {((c.close / c.open - 1) * 100).toFixed(2)}%
            </span>
          </>
        ) : (
          <span>Waiting for market data…</span>
        )}
        {indicators
          .filter((i) => i !== "Volume")
          .map((i) => (
            <span className="indicator-legend" key={i}>
              {i}
            </span>
          ))}
      </div>
      <div
        ref={container}
        className="chart-canvas"
        aria-label={`${identity} ${kind} price chart`}
      />
      {!candles.length && (
        <div className="chart-loading">
          {emptyLabel === "Connecting to the market" && (
            <span className="loader" />
          )}
          {emptyLabel}
        </div>
      )}
    </div>
  );
}
