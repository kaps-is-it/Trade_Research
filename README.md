# RunThisPR crypto terminal

React + TypeScript + Vite application. Live spot-crypto data comes directly from Binance market-data-only endpoints, Coinbase Exchange and Kraken Spot WebSocket v2. No exchange account credentials are collected and no orders can be submitted.

## Local development

Use Node 22+ (22.12+ for Vite) and pnpm 11.25.0:

```sh
pnpm install
pnpm dev
pnpm test
pnpm build
pnpm smoke:feeds
```

The development server is at http://127.0.0.1:5173. `pnpm preview` serves the production build locally. `pnpm smoke:feeds` performs real public REST/WebSocket requests; it may fail on a network or in a region that restricts an exchange. Normal unit tests use fixtures and fake sockets.

## Implemented

- Twelve tracked assets on each of three independent spot venues; Binance USDT pairs and Coinbase/Kraken USD pairs remain distinct.
- Live watchlists, search, favorites, venue switching, five intervals, candle/OHLC/line/area charts, volume, SMA20, EMA50, RSI14, log scale and CSV export.
- Taker-side trade tape, snapshot-based Binance top-20 depth, Coinbase Level 2 batching, and Kraken top-10 depth with exact-decimal CRC32 verification.
- Equal-size 24h return heatmap for the tracked universe, feed health/age diagnostics and connection logs.
- Pause/resume, bounded buffers, reconnect with backoff, stale-channel watchdog, abortable history requests and late-subscription-message protection.
- Dark/light themes, responsive layouts, and a building-in-public research roadmap.

## Data semantics and limits

- The UI is a browser-session terminal. It does not yet provide a shared ingestion backend, persistent raw tick recording, gap-complete replay, a simulator or an AI trader. Closing the page stops its feeds.
- Historical candles are fetched through public REST endpoints. Historical range is bounded by each provider. No interpolated/fabricated candles fill gaps.
- Coinbase match `side` describes the maker; the tape reverses it to show the taker. Its current candle includes only trades observed by this session and is explicitly marked partial. Closed candles reconcile from REST every minute. Detected trade-ID discontinuities are logged; full trade recovery is not implemented.
- Kraken JSON numeric lexemes are preserved before CRC32 calculation, including trailing zeroes. A checksum failure clears the visible book and triggers a new snapshot/reconnect.
- Binance partial-depth messages are complete top-20 snapshots. Coinbase depth starts from a full Level 2 snapshot and applies absolute-size updates. These synchronization methods do not establish order queue position or executable liquidity.
- Health represents channel transport. Per-quote timestamps separately disclose data freshness. Receive-minus-event time should not be described as precise network latency.
- Prices are display numbers; the application does not perform monetary accounting. A future simulator must use exact decimal accounting separately.

## Source documentation

- [Binance public market-data hosts](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md)
- [Binance streams](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams)
- [Coinbase channels](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels)
- [Coinbase candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles)
- [Kraken ticker](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker)
- [Kraken book](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/book)
- [Kraken book checksum](https://docs.kraken.com/exchange/guides/websockets/book-checksum)

Public-display and future AI-use permissions are separate from keyless access. The project owner confirmed having all permissions in the project conversation on October 16, 2026. No permission documents or credentials are included in this repository.

## Deployment

`.openai/hosting.json` binds this checkout to the RunThisPR Site and declares `dist/` as static output. Build, push the matching source, package that build, then save and deploy the exact version through Sites. Keep deployment write credentials in memory/stdin; never commit them. See the parent project's deployment notes for domain setup.

Charts are rendered using TradingView Lightweight Charts (Apache 2.0). Its built-in attribution remains enabled. Exchange brand names identify data provenance; this is an independent project.
