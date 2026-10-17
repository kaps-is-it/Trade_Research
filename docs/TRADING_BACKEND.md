# Paper trading and model simulations

## Run locally without hosting fees

Use Node 24+ and pnpm. Open two terminals in `terminal/`:

```sh
pnpm backend
```

```sh
pnpm dev
```

Open http://127.0.0.1:5173. Vite proxies `/api/trading` to the backend on port 8787. The backend binds only to loopback by default. It saves accounts, orders, fills and decision audit records in `data/trading.sqlite`, excluded from Git. Keep this file and its WAL files backed up. Never run two worker processes against the same account database: the current account coordinator is single-process.

Manual accounts and each AI simulation receive independent initial USDT balances. Up to 32 total accounts are supported. The model, provider, market, initial capital and risk settings are fixed per run; create a new run for a different experiment. Multiple runs can be enabled simultaneously; at most six model evaluations are in flight at once. Browser tabs observe the same backend accounts, rather than starting duplicate agents.

For the configured cloud database, see [Supabase storage and deployment](SUPABASE.md).

## Connect models

Copy `.env.example` to `.env` and configure any providers you want to use. Restart the backend after changing environment variables.

- `OPENAI_API_KEY`: OpenAI Responses API, server-side only.
- `OPENROUTER_API_KEY`: OpenRouter's normalized Chat Completions interface for multiple vendors.
- `NVIDIA_NIM_API_KEY`: NVIDIA NIM (`https://integrate.api.nvidia.com/v1`), server-side only. The model selector includes `z-ai/glm-5.3`, `deepseek-ai/deepseek-v4.1-flash` and `nvidia/nemotron-3-ultra-550b-a55b`; custom model IDs and the live catalog are also supported. These three IDs were confirmed in the authenticated NVIDIA catalog on October 17, 2026. Model access still depends on the key's current permissions and quota. All three use Chat Completions with `stream: false`, `temperature: 0.5` and `top_p: 1`. The NVIDIA output allowance defaults to 32,768 tokens per request, including any reasoning generation counted by the endpoint. Configure `NVIDIA_NIM_MAX_TOKENS` from 1 to 32,768 on the backend. This is a ceiling, not a request to fill the budget; the final decision JSON and rationale stay bounded. NVIDIA/model/context limits still apply. Other providers use a 4,096-token allowance for the decision and saved strategy. Truncated responses are rejected without placing orders.
- `ENABLE_OLLAMA=true`: enables a local Ollama server; default URL is `http://127.0.0.1:11434/v1`. Override with server-side `OLLAMA_BASE_URL` if needed. Ollama must be running with the selected model already available. A hosted worker's loopback does not refer to your desktop.

Enter the exact provider model ID in the creation form, or load the connected provider's `/models` catalog. Catalog entries are not a guarantee of text-generation compatibility; reasoning-only or multimodal-only configurations may require different parameters. An unavailable/invalid model fails visibly and submits no order. Provider keys never pass through the browser or the Git repository. Owner tokens remain in tab memory and must be re-entered after refresh.

Runs continuously evaluate fresh snapshots using current executable prices and the last 100 closed five-minute candles. There is no daily request cap. Each run becomes eligible again after its last response; up to six runs evaluate concurrently. The shared provider gate allows at most 30 request starts per rolling minute, including NVIDIA catalog calls, and persists recent starts across restarts. HTTP 429 activates shared backoff and honors Retry-After. Runs can reassess within the same candle interval. Requests time out after 60 seconds, except NVIDIA NIM, which defaults to 300 seconds to allow longer generation; override `NVIDIA_NIM_TIMEOUT_MS` within 1,000-900,000 ms. Endpoint/network timeouts may be shorter. The count shown for today is informational, not a stop condition. Returned token counts are not a dollar spending budget. See [laptop hosting and continuous scheduling](LAPTOP_BACKEND.md).

No model call is made without a configured provider. Such a run remains **Awaiting model connection**. Local provider readiness means it was enabled in configuration, not that the model/server has been probed successfully.

For an opt-in NVIDIA integration check, run `pnpm smoke:nvidia`. This makes one inference request for each preset using public Binance market data, checks the structured decision response, and prints only the model ID, outcome and token counts. Pass an exact preset ID to test just one, e.g. `pnpm smoke:nvidia deepseek-ai/deepseek-v4.1-flash`. It does not create accounts or execute orders. It consumes provider credits/quota. Never paste real keys into source files or `.env.example`; keep them in the ignored `.env` or the hosted backend's secret settings.

GLM 5.3 explicitly uses `reasoning_effort: low` and `chat_template_kwargs: { clear_thinking: true }` for responsive reviews, retaining the 32,768-token ceiling. Set `NVIDIA_GLM_REASONING_EFFORT` to `low`, `high` or `max` to override it. These model-specific options are not sent to DeepSeek or Nemotron. NVIDIA documents `max` as its default; see the [GLM 5.3 reference](https://docs.api.nvidia.com/nim/reference/z-ai-glm-5-3).

GLM requests include `guided_json` with a decision schema, field length limits and an order-ID enum built from currently live orders. Local validation still rejects malformed decisions, overlong fields and obsolete IDs; it never repairs trade actions or truncates them into executable decisions. A rejected output submits no order, is recorded clearly, and supplies its validation error to the next fresh assessment. The other providers retain local validation without assuming this NVIDIA extension is supported. See NVIDIA's [structured generation documentation](https://docs.nvidia.com/nim/large-language-models/1.15.0/structured-generation.html).

Active-entry review adds up to three minutes of observed executable bid/ask samples (at most one per second), with the latest 60 samples in the prompt. Per-limit summaries include observed ranges, time spans, sampling gaps, order age, price distance, marginal notional, fees and an estimated fee-adjusted break-even exit. This is sampled depth data, not a complete trade tape. Gaps and worker downtime are never interpolated. After restart, observation history warms up from new quotes. The model may revise old entry conditions, reprice, cancel, hold, or atomically replace a limit with a market order when current evidence and net economics support it. Proximity alone never triggers a purchase; there is no hard-coded five-dollar chase or confidence threshold.

Run-3 audit on October 17 found 11 JSON syntax failures, three format/length failures and three attempts to replace a closed or incorrect order ID in its retained journal. Recorded decision latency ranged from 10 to 248 seconds (median 34 seconds). Two read-only live probes of the revised GLM contract completed valid bounded decisions: high reasoning took about 103 seconds and low about 21 seconds. This is a small functional check, not a latency or trading-quality benchmark. Neither probe changed the public account or placed orders. Controlled tests verify the near-miss context and limit-to-market replacement release reservations, cancel the old order and fill without a duplicate entry.

For an opt-in continuous-worker check, run `pnpm smoke:rig` (optionally followed by an exact model ID). It uses actual Binance data and NVIDIA inference, waits for three automatically scheduled decisions, pauses its account, and verifies strategy/order recovery. It creates its own SQLite database and JSON evidence under ignored `data/rig-audit-*`, never attaches to Supabase or the public worker, and consumes provider quota. It shares the NVIDIA key's quota with any other running worker; its limiter cannot count calls made by those other processes. The check allows ten minutes and fails if three decisions do not complete.

Live verification on October 17, 2026: authenticated discovery listed all three presets. The continuous GLM 5.3 check completed three decisions in three attempts, revised strategy memory three times, accepted a limit buy and recorded one paper fill. Strategy memory and orders survived coordinator reload. The test used an isolated SQLite account; the public Supabase accounts stayed paused and unchanged. A separate full-prompt GLM probe returned a valid strategy-bearing decision in about 50 seconds. Earlier GLM requests timed out, Nemotron returned HTTP 503 and DeepSeek timed out after 300 seconds; reliable inference for those other presets is not confirmed. Cancellation, replacement, partial fills, inference/fill races and automatic retry/recovery are additionally verified with controlled model responses. Availability and response time remain provider-dependent. NVIDIA's hosted API follows its [Chat Completions interface](https://docs.api.nvidia.com/nim/reference/llm-apis).

## Model-facing environment

`server/models.mjs` explicitly selects the fields sent to the model. It uses neutral trading/account instructions and supplies no simulation flags, paper/fake labels, account display names or infrastructure events. It does not assert that real money is involved, and cannot guarantee a model's beliefs. The user interface and server always identify paper execution. Models cannot change this execution boundary, retrieve exchange credentials, bypass validation or call an exchange trading endpoint.

Models see prices, closed candles, instrument rules, available cash, holdings, position valuation (including estimated exit fees), previous evaluation timestamps, open orders, limits, recent decisions and fills. They return one validated JSON decision: hold, buy, sell, cancel or replace, plus a complete revised strategy. Only the brief evidence-based rationale is displayed, not private reasoning.

Each successful evaluation persists a bounded strategy with thesis, entry/hold/exit conditions, invalidation, durable memory, and self-reported entry readiness/exit urgency from 0 to 100. The latest strategy is part of the account state in SQLite or Supabase and is always supplied on subsequent evaluations, independently of the recent journal buffer. Each revision is also copied into the decision audit record in the same database commit as execution. Conditions guide the model; no rule engine executes them. The model may hold through a pullback, reduce exposure, take profits, or cut losses based on new evidence. This is prompt/context memory, not model-weight training, a guarantee of learning, or autonomous code execution. Invalid/missing strategy output produces no trade.

The UI separates filled positions from pending orders, shows average entry price, remaining invested cost (including allocated entry fees), entry timestamps, unrealized P&L and percentage at the bid/ask midpoint, and estimated liquidation P&L using bid less the selling fee. Missing/stale quotes suppress position P&L. Position values refresh about every second while connected; strategy meters update only when a model evaluation completes and are not calibrated probabilities. The decision journal has a bounded internal scrolling area.

## Execution and risk model

- Binance's curated twelve USDT spot markets are executable. Kraken XMR/USD and Coinbase ABT-USD remain research coverage, with no implied currency conversion.
- The worker polls top-20 public REST depth about every second for active runs, holdings, open orders and recently viewed markets. Feeds are shared between runs. This is deliberately a lower-frequency first implementation, not a tick-level execution engine.
- Native instrument filters are loaded from `exchangeInfo`. Balances and monetary operations use `decimal.js` with 40-digit precision, not display floats.
- AI and manual accounts share the observed-depth execution engine. Both support market and limit orders; AI orders no longer receive guaranteed full quote fills. Funds, held quantities, fees, instrument rules and the configured entry ceiling are validated.
- Orders reserve cash/holdings, wait at least 500 ms, and require a fresh book observed after their eligibility time. Market orders consume opposite-side depth across prices; an unfilled remainder is cancelled. This permits partial fills and slippage.
- GTC limit buys fill only from available asks at or below the limit; limit sells require bids at or above it. Unfilled portions stay live with proportional reservations. Candle/last-trade price touches never trigger fills. Queue position against real exchange orders, market impact and hidden liquidity are not modeled.
- HOLD means no change: keep existing positions and pending orders. Watching a target in memory creates no order or reservation. A submitted limit remains monitored between AI evaluations, while new decisions are paused, and while the browser is closed (with the worker running).
- Every pending order is supplied on each model evaluation with original intent, creation time, filled/remaining quantities, reservations and latest AI review. HOLD updates its review without creating duplicate orders. The AI can cancel or atomically replace an order; replacement preserves side/market, specifies the desired remaining quantity and loses prior queue priority. Failed replacement validation leaves the original order live. Original/replacement IDs and reviews are persisted and visible in account records.
- If fills, cancellations or other economic account changes occur during model inference, the stale action and strategy update are discarded and journalled. The next evaluation reads the current position, preventing duplicate entries based on an already-filled order.
- Each account maintains an independent liquidity budget. Within that account, the same exchange snapshot cannot be repeatedly consumed. Separate accounts do not compete for one simulated liquidity pool.
- The illustrative fee is 0.10% in USDT for both sides of each fill. It is not a personalized Binance fee schedule. Changing this assumption requires a versioned experiment.
- Open orders reserve funds/holdings. Cancelling releases only the unfilled reservation. Selling more than available holdings and borrowing/shorting are rejected.
- Stale, crossed or unavailable data prevents execution. After model latency, execution uses a fresh snapshot and rechecks account limits. A model proposal cannot override order-size or loss checks.
- New runs default to a 100% entry ceiling and a 100% emergency loss threshold (no early account stop). Existing run settings are preserved. The AI buy-order ceiling is a percentage of initial capital, measured before fees. It is not a total portfolio exposure ceiling; sells can close the full available holding even after appreciation. A run's equity-loss stop disables new decisions and cancels open orders at the next fresh worker check; it does not liquidate holdings. Holdings and prices may move between checks, so the threshold is not a guaranteed maximum realized loss.
- Pause stops future AI decisions and aborts an in-flight response. It does not cancel existing orders or sell holdings. Order monitoring continues while the worker runs, regardless of browser/chart state.
- On restart, pending market orders are cancelled and resting limits are preserved against fresh depth; fills during downtime are not reconstructed. Account state, strategy, order intent/reviews and audit rows commit in one database transaction. Execution version 3 enables AI limit orders without resuming paused runs or recreating orders previously cancelled under version 2. No historical fills are invented.

The page displays up to 500 completed orders, 1,000 recent fills and 200 recent journal entries per account. Lifetime fee/count totals remain independent of those buffers. Database audit tables retain all saved records; the CSV button exports the visible recent-fill history. Market candles are cached in memory and refetched after restart. Continuous historical depth/tick archiving and gap-complete replay are not included yet.

## Hosting and access

The frontend can remain on Vercel. A separate worker must have Node 24+, Supabase storage or a persistent SQLite disk, and outbound access to the market/model endpoints. To attach it, set frontend build variable `VITE_TRADING_API_URL` to the HTTPS worker URL. The current SQLite store is for one persistent worker. The Supabase adapter supports external account storage and fences duplicate workers. The loop still requires a persistent process; Supabase Auth sign-in is not implemented.

For hosted binding set:

```dotenv
TRADING_HOST=0.0.0.0
TRADING_PORT=8787
TRADING_DB_PATH=/persistent-disk/trading.sqlite
TRADING_ALLOWED_ORIGINS=https://www.runthispr.com
TRADING_ADMIN_TOKEN=<random-secret-at-least-24-characters>
```

Terminate TLS at the host/reverse proxy. Public reads can observe the shared account records. All writes and model catalog requests require the owner token. CORS is restricted to configured frontend origins. Do not place backend secrets in `VITE_` variables, publicly writable configuration, or public logs. The loopback-only local development exception does not apply to hosted binding.

No hosting account, paid service or model credential is provisioned by this change. No public backend is deployed automatically by pushing the frontend.

## Free-tier assessment (checked October 16, 2026)

| Option                      | Current allowance / limit                                                               | Fit                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local worker + SQLite       | No hosting bill; machine must stay awake and connected                                  | Implemented development option.                                                                                                                                        |
| Supabase Free               | 500 MB database, authentication, 1 GB file storage; projects can pause after inactivity | Recommended first hosted account/identity database after adding a Postgres adapter. Not a continuously running worker by itself.                                       |
| Neon Free                   | 1 GB Postgres storage and 100 CU-hours per project per month; scale-to-zero             | Good database alternative. Continuously active queries can exceed the free compute allowance.                                                                          |
| Vercel Daemons beta / Hobby | 10 active CPU-hours/month; no inbound HTTP and no persistent local storage              | A possible future worker, paired with API functions/services and an external database. Current combined HTTP + SQLite worker cannot be deployed unchanged as a daemon. |

Model API usage is separate from hosting costs. Local models avoid per-token vendor fees but consume local hardware resources. No free tier is a promise of uninterrupted, unlimited 24/7 service.

Sources: [Supabase pricing](https://supabase.com/pricing), [Supabase pausing](https://supabase.com/docs/guides/platform/free-project-pausing), [Neon pricing](https://neon.com/pricing), [Vercel Daemon limits](https://vercel.com/docs/daemons/limits), [Binance market data](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints), [Binance filters](https://developers.binance.com/docs/binance-spot-api-docs/filters), [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [OpenRouter API](https://openrouter.ai/docs/api/reference/overview), [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility).

## Validation

`pnpm test` runs the market tests and Node backend tests; `pnpm test:trading` runs only backend tests. Tests cover decimal accounting, reservations, partial fills, snapshot reuse, risk ceilings, isolated accounts, provider payloads, malformed outputs, pause races, continuous evaluations and shared provider throttling, SQLite audit retention and owner/origin boundaries. Unit tests use fixtures and stub providers. Actual model behavior requires a configured provider and is not certified by those stubs.
