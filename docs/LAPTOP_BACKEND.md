# Laptop backend for research

The laptop runs the Node market loop, paper execution, model scheduling and HTTP API. NVIDIA runs model inference on its hosted service; this setup does not run NVIDIA's large models on the laptop's GPU. Accounts and audit records remain in Supabase.

## Continuous AI

There is no daily request allowance. Each enabled run evaluates fresh market/account snapshots, then becomes eligible again one second after its response finishes. The worker checks eligibility about every second. It may reuse the last 100 closed five-minute candles while live prices, balances and orders change. No unfinished candle is presented as closed history. A hold decision is valid; an evaluation need not produce a trade.

Up to six evaluations can be in flight, with one at a time per account. Due runs take turns. Each provider connection has a shared maximum of 30 request starts in a rolling minute; NVIDIA's three model presets and catalog calls use the same NVIDIA gate. Starts are spaced by at least 2.05 seconds. This is a ceiling, not a target: latency, outages, waiting runs, cancellations and risk stops can reduce throughput. Requests made outside this worker with the same key are outside its counter.

The gate persists recent starts in ignored `data/provider-rate-history.json`, so restarting does not reset the rolling budget. HTTP 429 activates a shared cooldown and honors a longer Retry-After. Other model failures back off per run. Existing daily-cap fields are ignored and removed on load. Today's evaluation count remains an informational counter with no daily stop.

## Start and stop

On this Windows machine, setup is:

```sh
pnpm laptop:setup --start
```

Setup downloads the pinned official cloudflared Windows binary, verifies its published SHA-256 digest, saves a random owner token in ignored `.env` if none exists, and installs `RunThisPR Backend.vbs` in the current user's Startup folder. It launches hidden at the next Windows sign-in. It does not run before sign-in.

```sh
pnpm laptop         # foreground, if it is not already running
pnpm laptop:stop    # stop the supervisor, API, tunnel and sleep request
```

Stop any older `pnpm backend` process before starting laptop mode. The database lease rejects duplicate workers. Status is in `data/laptop-status.json`; bounded worker logs are in `data/laptop-worker.log`. The supervisor restarts failed processes after a lease-expiry delay. Internet reconnection within a live tunnel generally keeps its URL; a newly created tunnel gets a new one. Failed storage stops the worker so the supervisor can reload durable state.

Remove the named VBS file from `%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup` to disable sign-in autostart. This leaves trading records and keys intact. No Windows administrator service is installed.

## Public connection and owner access

The API binds to `127.0.0.1:8787`; an outbound Cloudflare Quick Tunnel supplies HTTPS access. No router port forwarding is needed. Public mode requires a long owner token even on loopback, because tunnel requests originate locally. Visitors can read the shared paper accounts; account creation, orders, run controls and model catalogs require the owner token. CORS permits the configured RunThisPR and local development origins.

Supabase exposes one narrow public discovery function containing only a fresh tunnel URL and heartbeat. Its writer verifies the worker's database lease. Account tables and the server key remain private. The public frontend discovers a replacement URL automatically, without redeploying whenever the tunnel changes. The checked-in discovery key is a publishable key, not a server secret. The metadata expires if the worker stops or loses its lease.

Use **Owner sign in** in the app with `TRADING_ADMIN_TOKEN` from the local `.env` file. Do not post that token or the NVIDIA/Supabase keys in chat, screenshots or the repository. The browser keeps the owner token in tab memory only.

## Operating conditions

Keep the laptop plugged in, connected to the internet and signed in, with its lid open. A process-scoped Windows power request prevents idle sleep while the supervisor is running; it does not override closing the lid, manual sleep, shutdown, Windows updates or a lost connection. Stopping the launcher releases the request and restores normal idle-sleep behavior. The display can turn off normally.

This is a research hosting setup. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) have temporary hostnames, no uptime guarantee and a 200-in-flight-request limit. A named tunnel or hosted worker is the later upgrade for dependable public traffic. Watch Supabase storage/egress as audit history grows; NVIDIA request access does not make other free tiers unlimited.
