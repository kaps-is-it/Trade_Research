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

Manual accounts and each AI simulation receive independent initial USDT balances. Up to 32 total accounts are supported. The model, provider, market, initial capital and risk settings are fixed per run; create a new run for a different experiment. Multiple runs can be enabled simultaneously; at most two model evaluations are in flight at once. Browser tabs observe the same backend accounts, rather than starting duplicate agents.

For the configured cloud database, see [Supabase storage and deployment](SUPABASE.md).

## Connect models

Copy `.env.example` to `.env` and configure any providers you want to use. Restart the backend after changing environment variables.

- `OPENAI_API_KEY`: OpenAI Responses API, server-side only.
- `OPENROUTER_API_KEY`: OpenRouter's normalized Chat Completions interface for multiple vendors.
- `NVIDIA_NIM_API_KEY`: NVIDIA NIM (`https://integrate.api.nvidia.com/v1`), server-side only. The model selector includes `z-ai/glm-5.3`, `deepseek-ai/deepseek-v4.1-flash` and `nvidia/nemotron-3-ultra-550b-a55b`; custom model IDs and the live catalog are also supported. These three IDs were confirmed in the authenticated NVIDIA catalog on October 17, 2026. Model access still depends on the key's current permissions and quota. All three use Chat Completions with `stream: false`, `temperature: 0.5` and `top_p: 1`. The decision output allowance is 1,400 tokens, slightly higher than the example's 1,024 so structured trading responses have room to finish. Truncated responses are rejected without placing orders.
- `ENABLE_OLLAMA=true`: enables a local Ollama server; default URL is `http://127.0.0.1:11434/v1`. Override with server-side `OLLAMA_BASE_URL` if needed. Ollama must be running with the selected model already available. A hosted worker's loopback does not refer to your desktop.

Enter the exact provider model ID in the creation form, or load the connected provider's `/models` catalog. Catalog entries are not a guarantee of text-generation compatibility; reasoning-only or multimodal-only configurations may require different parameters. An unavailable/invalid model fails visibly and submits no order. Provider keys never pass through the browser or the Git repository. Owner tokens remain in tab memory and must be re-entered after refresh.

Runs evaluate after five-minute candle boundaries, using the last 100 closed five-minute candles. Starting a run schedules its first evaluation at the next boundary. The per-run daily call allowance resets at UTC midnight. Requests, including failed attempts, consume this allowance; identical closed candles are not evaluated twice. Requests time out after 60 seconds, except NVIDIA NIM, which defaults to 120 seconds to accommodate observed hosted-model latency. Override `NVIDIA_NIM_TIMEOUT_MS` on the backend within 1,000–180,000 ms. A timeout places no model order. Usage counters report returned input/output tokens, not an invented dollar cost. Use provider-side spending limits as well: a request-count allowance is not a monetary budget, and the two-request concurrency limit is not a provider rate-limit policy.

No model call is made without a configured provider. Such a run remains **Awaiting model connection**. Local provider readiness means it was enabled in configuration, not that the model/server has been probed successfully.

For an opt-in NVIDIA integration check, run `pnpm smoke:nvidia`. This makes one inference request for each preset using public Binance market data, checks the structured decision response, and prints only the model ID, outcome and token counts. Pass an exact preset ID to test just one, e.g. `pnpm smoke:nvidia deepseek-ai/deepseek-v4.1-flash`. It does not create accounts or execute orders. It consumes provider credits/quota. Never paste real keys into source files or `.env.example`; keep them in the ignored `.env` or the hosted backend's secret settings.

Live verification on October 17, 2026: authenticated model discovery listed all three presets. GLM 5.3 and Nemotron 3 Ultra returned parseable decisions using the trading snapshot contract. DeepSeek V4.1 Flash inference timed out in both a 60-second check and a 120-second follow-up; its inference behavior is not yet verified. A listing alone does not establish that an inference request will succeed. No orders or persisted accounts were created by these checks. NVIDIA's hosted API follows its [Chat Completions interface](https://docs.api.nvidia.com/nim/reference/llm-apis).

## Model-facing environment

`server/models.mjs` explicitly selects the fields sent to the model. It uses neutral trading/account instructions and supplies no simulation flags, paper/fake labels, account display names or infrastructure events. It does not assert that real money is involved, and cannot guarantee a model's beliefs. The user interface and server always identify paper execution. Models cannot change this execution boundary, retrieve exchange credentials, bypass validation or call an exchange trading endpoint.

Models see prices, closed candles, instrument rules, available cash, holdings, open orders, limits, recent decisions and fills. They return one validated JSON decision: hold, buy, sell or cancel. Reasoning is displayed only as the model's brief decision rationale. The current journal provides recent-decision memory, not model-weight training, a backtesting engine, arbitrary tool execution or autonomous strategy-code editing.

## Execution and risk model

- Binance's curated twelve USDT spot markets are executable. Kraken XMR/USD and Coinbase ABT-USD remain research coverage, with no implied currency conversion.
- The worker polls top-20 public REST depth about every two seconds for active runs, holdings, open orders and recently viewed markets. Feeds are shared between runs. This is deliberately a lower-frequency first implementation, not a tick-level execution engine.
- Native instrument filters are loaded from `exchangeInfo`. Balances and monetary operations use `decimal.js` with 40-digit precision, not display floats.
- Market orders reserve cash/holdings, wait at least 500 ms, and consume the next observed opposite-side depth. A partially executable market order cancels its remainder. No order fills from its submission snapshot before the latency interval.
- Limits rest until opposite-side depth crosses their limit. They may fill partially, only at the limit or better. Candle highs/lows never trigger fills. Price/time priority against real exchange orders, market impact and hidden liquidity are not modeled.
- Each account maintains an independent liquidity budget. Within that account, the same exchange snapshot cannot be repeatedly consumed. Separate accounts do not compete for one simulated liquidity pool.
- The illustrative fee is 0.10% in USDT for both sides of each fill. It is not a personalized Binance fee schedule. Changing this assumption requires a versioned experiment.
- Open orders reserve funds/holdings. Cancelling releases only the unfilled reservation. Selling more than available holdings and borrowing/shorting are rejected.
- Stale, crossed or unavailable data prevents execution. After model latency, execution uses a fresh snapshot and rechecks account limits. A model proposal cannot override order-size or loss checks.
- The AI order ceiling is a percentage of initial capital, measured before fees. It is not a total portfolio exposure ceiling. A run's equity-loss stop disables new decisions and cancels open orders at the next fresh worker check; it does not liquidate holdings. Holdings and prices may move between checks, so the threshold is not a guaranteed maximum realized loss.
- Pause stops future AI decisions and aborts an in-flight response. It does not cancel existing orders or sell holdings. Order monitoring continues while the worker runs, regardless of browser/chart state.
- On restart, pending market orders are cancelled. Resting limit orders resume against fresh depth; fills during downtime are not reconstructed. Account state and audit rows commit in one database transaction.

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

| Option | Current allowance / limit | Fit |
| --- | --- | --- |
| Local worker + SQLite | No hosting bill; machine must stay awake and connected | Implemented development option. |
| Supabase Free | 500 MB database, authentication, 1 GB file storage; projects can pause after inactivity | Recommended first hosted account/identity database after adding a Postgres adapter. Not a continuously running worker by itself. |
| Neon Free | 1 GB Postgres storage and 100 CU-hours per project per month; scale-to-zero | Good database alternative. Continuously active queries can exceed the free compute allowance. |
| Vercel Daemons beta / Hobby | 10 active CPU-hours/month; no inbound HTTP and no persistent local storage | A possible future worker, paired with API functions/services and an external database. Current combined HTTP + SQLite worker cannot be deployed unchanged as a daemon. |

Model API usage is separate from hosting costs. Local models avoid per-token vendor fees but consume local hardware resources. No free tier is a promise of uninterrupted, unlimited 24/7 service.

Sources: [Supabase pricing](https://supabase.com/pricing), [Supabase pausing](https://supabase.com/docs/guides/platform/free-project-pausing), [Neon pricing](https://neon.com/pricing), [Vercel Daemon limits](https://vercel.com/docs/daemons/limits), [Binance market data](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints), [Binance filters](https://developers.binance.com/docs/binance-spot-api-docs/filters), [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [OpenRouter API](https://openrouter.ai/docs/api/reference/overview), [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility).

## Validation

`pnpm test` runs the market tests and Node backend tests; `pnpm test:trading` runs only backend tests. Tests cover decimal accounting, reservations, partial fills, snapshot reuse, risk ceilings, isolated accounts, provider payloads, malformed outputs, pause races, per-run call limits, SQLite audit retention and owner/origin boundaries. Unit tests use fixtures and stub providers. Actual model behavior requires a configured provider and is not certified by those stubs.
