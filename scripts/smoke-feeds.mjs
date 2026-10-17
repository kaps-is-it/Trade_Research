// Public market endpoints only. No keys, orders, accounts, or private channels.
const rest = {
  binance:
    "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=5",
  coinbase:
    "https://api.exchange.coinbase.com/products/ABT-USD/candles?granularity=60",
  kraken: "https://api.kraken.com/0/public/OHLC?pair=XMRUSD&interval=1",
};
async function history(venue, url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw Error(`${venue} REST HTTP ${res.status}`);
  const d = await res.json();
  const count = Array.isArray(d)
    ? d.length
    : Object.entries(d.result ?? {}).find(
        ([k, v]) => k !== "last" && Array.isArray(v),
      )?.[1].length;
  if (!count) throw Error(`${venue}: empty history`);
  return { venue, historyRows: count };
}
function stream(venue) {
  return new Promise((resolve, reject) => {
    const url =
      venue === "binance"
        ? "wss://data-stream.binance.vision/stream?streams=btcusdt@ticker/btcusdt@bookTicker/btcusdt@trade/btcusdt@kline_1m/btcusdt@depth20@100ms"
        : venue === "coinbase"
          ? "wss://ws-feed.exchange.coinbase.com"
          : "wss://ws.kraken.com/v2";
    const ws = new WebSocket(url);
    const channels = new Set();
    const required =
      venue === "binance"
        ? ["ticker", "bookTicker", "kline_1m", "depth20"]
        : venue === "kraken"
          ? ["ticker", "trade", "ohlc", "book"]
          : ["ticker", "snapshot", "heartbeat"];
    let finished = false;
    let count = 0;
    const timer = setTimeout(
      () =>
        finish(
          required.every((c) => channels.has(c))
            ? null
            : Error(`${venue}: only channels ${[...channels]}`),
        ),
      20000,
    );
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      error
        ? reject(error)
        : resolve({ venue, channels: [...channels], messages: count });
    }
    ws.onopen = () => {
      if (venue === "coinbase")
        ws.send(
          JSON.stringify({
            type: "subscribe",
            product_ids: ["ABT-USD"],
            channels: ["ticker", "matches", "level2_batch", "heartbeat"],
          }),
        );
      if (venue === "kraken")
        for (const params of [
          { channel: "ticker", symbol: ["XMR/USD"], event_trigger: "bbo" },
          { channel: "trade", symbol: ["XMR/USD"] },
          { channel: "ohlc", symbol: ["XMR/USD"], interval: 1 },
          { channel: "book", symbol: ["XMR/USD"], depth: 100 },
        ])
          ws.send(
            JSON.stringify({
              method: "subscribe",
              params: { snapshot: true, ...params },
            }),
          );
    };
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.type === "error" || d.success === false)
        return finish(Error(`${venue}: ${d.message ?? d.error}`));
      const m = d.data ?? d;
      let channel =
        venue === "binance"
          ? d.stream?.split("@")[1]
          : venue === "kraken"
            ? d.channel
            : d.type;
      if (channel && !["subscriptions", "status"].includes(channel))
        channels.add(channel);
      count++;
      if (required.every((c) => channels.has(c))) finish();
    };
    ws.onerror = () => finish(Error(`${venue}: WebSocket unavailable`));
  });
}
const results = await Promise.allSettled([
  ...Object.entries(rest).map(([v, u]) => history(v, u)),
  ...Object.keys(rest).map(stream),
]);
for (const r of results)
  console.log(
    JSON.stringify(
      r.status === "fulfilled" ? r.value : { error: r.reason.message },
    ),
  );
if (results.some((r) => r.status === "rejected")) process.exitCode = 1;
