import { randomUUID } from "node:crypto";

export class SupabaseStore {
  kind = "supabase";
  holder = randomUUID();
  revisions = new Map();
  failed = null;
  closing = false;

  static async open(env = process.env, request = fetch) {
    const store = new SupabaseStore(env, request);
    try {
      if (
        !(await store.rpc("trading_claim_worker", { p_holder: store.holder }))
      )
        throw new Error("Another trading worker holds the Supabase lease.");
      store.claimed = true;
      const rows = await store.call(
        "trading_accounts?select=id,state,revision&order=created_at.asc&limit=33",
      );
      if (rows.length > 32)
        throw new Error("Supabase account count exceeds this worker's limit.");
      store.accounts = rows.map((row) => {
        store.revisions.set(row.id, row.revision);
        return row.state;
      });
      store.timer = setInterval(() => {
        if (!store.renewing && !store.failed && !store.closing) {
          store.renewing = store
            .rpc("trading_claim_worker", { p_holder: store.holder })
            .then((ok) => {
              if (!ok) throw new Error("Trading worker lease lost.");
            })
            .catch(() => {
              store.failed = new Error(
                "Supabase worker lease could not be renewed. Restart the backend.",
              );
            })
            .finally(() => {
              store.renewing = null;
            });
        }
      }, 10000);
      store.timer.unref();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  constructor(env, request) {
    const url = new URL(env.SUPABASE_URL);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".supabase.co") ||
      url.username ||
      url.password
    )
      throw new Error(
        "SUPABASE_URL must be the project's HTTPS supabase.co URL.",
      );
    if (!env.SUPABASE_SECRET_KEY)
      throw new Error("SUPABASE_SECRET_KEY is required for cloud storage.");
    this.base = `${url.origin}/rest/v1/`;
    this.key = env.SUPABASE_SECRET_KEY;
    this.request = request;
  }
  async call(path, body) {
    const headers = { apikey: this.key, "Content-Type": "application/json" };
    // New sb_secret keys use apikey only; legacy service_role keys are JWTs.
    if (!this.key.startsWith("sb_secret_"))
      headers.Authorization = `Bearer ${this.key}`;
    const response = await this.request(this.base + path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error(
        `Supabase storage returned HTTP ${response.status}. Check migrations and server credentials.`,
      );
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  rpc(name, body) {
    return this.call(`rpc/${name}`, body);
  }
  assertHealthy() {
    if (this.failed) throw this.failed;
    if (this.closing) throw new Error("Supabase storage is closing.");
  }
  all() {
    return structuredClone(this.accounts);
  }
  async save(account) {
    this.assertHealthy();
    try {
      const revision = await this.rpc("trading_save_account", {
        p_holder: this.holder,
        p_account: account,
        p_revision: this.revisions.get(account.id) || 0,
      });
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new Error("Invalid revision response.");
      this.revisions.set(account.id, revision);
      const index = this.accounts.findIndex((row) => row.id === account.id);
      if (index < 0) this.accounts.push(structuredClone(account));
      else this.accounts[index] = structuredClone(account);
    } catch {
      // A timed-out transaction might have committed. Never retry with stale state.
      this.failed = new Error(
        "Supabase save was not confirmed. Trading is stopped; restart to reload durable state.",
      );
      throw this.failed;
    }
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await this.renewing;
    if (this.claimed) {
      await this.rpc("trading_release_worker", { p_holder: this.holder }).catch(
        () => {},
      );
      this.claimed = false;
    }
  }
}
