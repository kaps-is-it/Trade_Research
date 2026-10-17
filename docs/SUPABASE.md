# Supabase storage and deployment

The `Trade_Research` project (`hnwncscrmotfbzvrlklj`, Canada Central) is linked to `kaps-is-it/Trade_Research`. Its GitHub integration deploys migrations from `main`, with working directory `.`. Schema changes live in `supabase/migrations`. Preview branching stays disabled. Repository defaults do not replace production Auth/API settings. See the [Supabase integration documentation](https://supabase.com/docs/guides/deployment/branching/github-integration).

## Server configuration

Set both variables in the ignored `.env` or the worker host's secret settings:

```dotenv
SUPABASE_URL=https://hnwncscrmotfbzvrlklj.supabase.co
SUPABASE_SECRET_KEY=<existing-secret-or-service-role-key>
```

Run `pnpm backend` with Node 24+. Neither variable set means local SQLite; incomplete configuration or a failed Supabase connection stops startup. It never silently switches to a different account workspace. Existing SQLite accounts are not imported automatically. Stop the old worker and migrate records deliberately before changing stores for a populated workspace.

Five tables store accounts, orders, fills, decision journals and a worker lease. RLS is enabled, with no table or RPC access for browser roles. The privileged server key stays out of the frontend and Git. See [Supabase API key guidance](https://supabase.com/docs/guides/getting-started/api-keys). The existing HTTP API remains public-read/owner-write. Supabase Auth sign-in is not implemented by this storage change.

## Durability and worker coordination

Balances, orders and audit rows commit in one Postgres transaction through an RPC. The backend serializes mutations and publishes them only after the save is confirmed. Audit tables retain records after recent page histories are trimmed. A database lease permits one worker at a time; account revisions reject stale updates.

Lease renewal failure or an unconfirmed save stops mutations and future model requests. The UI marks the account view as potentially out of date. Restart the backend to reload committed state. Saves are not automatically replayed because a lost response might have committed. A dead worker's lease expires after 45 seconds.

Pending market orders are cancelled on restart; resting limits resume against fresh depth. Fills during downtime are not reconstructed. Supabase stores trading records, not a continuous archive of market ticks or order-book history.

## Hosting boundary

Supabase does not run this Node trading loop continuously. A persistent online worker still needs Node 24+, market/model network access, and an HTTPS API URL. With Supabase it does not need a persistent SQLite disk. Set `TRADING_HOST=0.0.0.0`, a random `TRADING_ADMIN_TOKEN` of at least 24 characters and the allowed frontend origins on that host. Set `VITE_TRADING_API_URL` to its HTTPS URL in the Vercel frontend build. Never put a Supabase secret or model key in a `VITE_` variable.

This adapter fences duplicate workers; it does not distribute simulations between them or turn the worker into a serverless request handler. A frontend or migration deployment does not start the worker.

## Validation

`pnpm test` covers SQLite behavior plus mocked cloud persistence, commit-before-publication, concurrent mutations, durable reload, occupied leases, failed-save handling, credential headers and secret-free snapshots. Run `pnpm smoke:supabase` for a live lease/read/release check. It creates no accounts, invokes no LLMs and places no orders. Do not run it while a production worker owns the lease.
