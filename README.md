# RunThisPR crypto terminal

React + TypeScript + Vite application with a Node paper-trading backend with SQLite or Supabase storage. Live spot-crypto research data comes from Binance market-data-only endpoints, Coinbase Exchange and Kraken Spot WebSocket v2. Orders are simulated inside the backend; no exchange trading credentials or live order endpoints are used.

## Local development

Use Node 24+ (including native SQLite) and pnpm 11.25.0:

```sh
pnpm install
pnpm dev
pnpm backend # in a second terminal
pnpm test
pnpm build
pnpm smoke:feeds
```

The development server is at http://127.0.0.1:5173. `pnpm preview` serves the production build locally. `pnpm smoke:feeds` performs real public REST/WebSocket requests; it may fail on a network or in a region that restricts an exchange. Normal unit tests use fixtures and fake sockets.

## Implemented

- Fourteen assets with automatic source routing: the original twelve use Binance USDT markets; Monero uses Kraken XMR/USD and Arcblock uses Coinbase ABT-USD, covering gaps in Binance's active spot catalog.
- Live watchlists, search, favorites, five intervals, candle/OHLC/line/area charts, volume, SMA20, EMA50, RSI14, log scale and CSV export. Users select assets; the source is assigned internally.
- Taker-side trade tape, real-time Binance best quotes and top-20 depth snapshots, Coinbase Level 2 batching (up to 100 displayed levels), and Kraken 100-level depth with exact-decimal CRC32 verification of the top ten levels.
- Equal-size 24h return heatmap for the tracked universe, feed health/age diagnostics and connection logs.
- Pause/resume, bounded buffers, reconnect with backoff, stale-channel watchdog, abortable history requests and late-subscription-message protection.
- Dark/light themes, responsive layouts, and a building-in-public research roadmap.
- Paper Trading page: independently funded accounts, Binance USDT market/limit orders, balance reservations, depth-based partial fills, cancellations, decimal accounting, fees, holdings, P&L and recent-fill CSV export.
- AI Simulations page: multiple simultaneous independent runs, custom starting capital and exact model IDs, provider catalogs, start/pause/resume, risk settings, continuous evaluations and shared provider throttling, immediate ask/bid paper execution, persistent entry/exit strategy memory and assessment meters, live position P&L with entry/fee details, and a bounded scrolling decision journal.
- Persistent Node 24 worker with SQLite or Supabase account/audit storage. Cloud storage uses atomic saves, revision checks and a single-worker lease. OpenAI, OpenRouter, NVIDIA NIM and local Ollama adapters; model keys remain server-side. NVIDIA's GLM 5.3, DeepSeek V4.1 Flash and Nemotron 3 Ultra presets are selectable per run. Without a configured provider, runs honestly wait for a model connection.

See [laptop hosting and continuous AI](docs/LAPTOP_BACKEND.md), [Supabase connection and migrations](docs/SUPABASE.md) and [backend setup, execution assumptions and hosting options](docs/TRADING_BACKEND.md) before connecting providers or deploying the backend. The loopback-only local worker runs without a hosting bill. A hosted backend and actual model credentials are not provisioned automatically.

## Data semantics and limits

- Source policy lives in `src/market/types.ts`: `sourceFor` assigns the exchange and `assetsForVenue` limits subscriptions to assigned assets. Watchlists and Overview always use that same mapping. There is no overlapping background subscription to all assets on every exchange and no automatic exchange substitution during an outage.
- Quotes, candles, trades and depth for each asset come from its assigned market. USDT and USD remain labeled separately; neither the UI nor CSV exports imply currency conversion or a composite executable price. Supplemental feeds are coverage extensions, not a replacement order book for Binance markets. Catalog assignments were checked on October 16, 2026 and should be reviewed as exchange listings change; dynamic universe discovery is not implemented.
- Source diagnostics separate market-data frames from total frames (including acknowledgements/heartbeats) across the watchlist and selected-market sockets. Counts are not comparable trading volume. Binance best-bid/ask updates do not reset the last trade-price receipt timestamp.
- Research charts remain browser-session feeds. A separate paper worker polls Binance depth for active runs, holdings and open orders even when charts are changed, paused or closed. The worker must be running. Raw tick/depth recording and gap-complete replay are not implemented.
- Historical candles are fetched through public REST endpoints. Historical range is bounded by each provider. No interpolated/fabricated candles fill gaps.
- Coinbase match `side` describes the maker; the tape reverses it to show the taker. Its current candle includes only trades observed by this session and is explicitly marked partial. Closed candles reconcile from REST every minute. Detected trade-ID discontinuities are logged; full trade recovery is not implemented.
- Kraken JSON numeric lexemes are preserved before CRC32 calculation, including trailing zeroes. A checksum failure clears the visible book and triggers a new snapshot/reconnect.
- Binance partial-depth messages are complete top-20 snapshots. Coinbase depth starts from a full Level 2 snapshot and applies absolute-size updates. These synchronization methods do not establish order queue position or executable liquidity.
- Health represents channel transport. Per-quote timestamps separately disclose data freshness. Receive-minus-event time should not be described as precise network latency.
- Chart prices remain display numbers. The backend uses `decimal.js` for money, quantities, fees and reservations, with raw decimal strings from exchange depth. The current engine is a disclosed approximation, not exchange-perfect execution.

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

Production frontend is hosted by the [runthispr Vercel project](https://vercel.com/kapil-patels-projects-dc94f2b1/runthispr), connected to this repository. Pushes to `main` trigger frontend deployments. Vercel uses the Vite preset, repository root `./`, `pnpm build`, and output directory `dist`. Research pages need no environment variables. Trading pages discover the active laptop backend through public Supabase connection metadata. A separate hosted worker can override this with `VITE_TRADING_API_URL`. The page displays a disconnected state when the backend is offline. A frontend deployment does not start the Node/SQLite worker.

The live site is https://www.runthispr.com; https://runthispr.com redirects there with HTTP 308. Namecheap DNS uses `A @ 216.198.79.1` and `CNAME www 2269b770111b2744.vercel-dns-017.com.`.

`.openai/hosting.json` is retained only as a record of the previous Sites deployment. Both custom domains have been detached from Sites; use Vercel for future production updates.

Charts are rendered using TradingView Lightweight Charts (Apache 2.0). Its built-in attribution remains enabled. Exchange brand names identify data provenance; this is an independent project.
