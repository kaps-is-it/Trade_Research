// Public market endpoints only. No keys, orders, accounts, or private channels.
const rest = {
  binance:
    "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=5",
  coinbase:
    "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60",
  kraken: "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1",
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
        ? "wss://data-stream.binance.vision/stream?streams=btcusdt@ticker/btcusdt@trade/btcusdt@kline_1m/btcusdt@depth20@100ms"
        : venue === "coinbase"
          ? "wss://ws-feed.exchange.coinbase.com"
          : "wss://ws.kraken.com/v2";
    const ws = new WebSocket(url);
    const channels = new Set();
    let count = 0;
    const timer = setTimeout(
      () =>
        finish(
          channels.size >= 3
            ? null
            : Error(`${venue}: only channels ${[...channels]}`),
        ),
      20000,
    );
    function finish(error) {
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
            product_ids: ["BTC-USD"],
            channels: ["ticker", "matches", "level2_batch", "heartbeat"],
          }),
        );
      if (venue === "kraken")
        for (const params of [
          { channel: "ticker", symbol: ["BTC/USD"], event_trigger: "bbo" },
          { channel: "trade", symbol: ["BTC/USD"] },
          { channel: "ohlc", symbol: ["BTC/USD"], interval: 1 },
          { channel: "book", symbol: ["BTC/USD"], depth: 10 },
        ])
          ws.send(JSON.stringify({ method: "subscribe", params }));
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
      if (
        channel &&
        !["subscriptions", "heartbeat", "status"].includes(channel)
      )
        channels.add(channel);
      count++;
      if (channels.size >= 4) finish();
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
