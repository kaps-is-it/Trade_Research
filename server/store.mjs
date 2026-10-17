import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export class AccountStore {
  constructor(
    path = resolve(process.env.TRADING_DB_PATH || "data/trading.sqlite"),
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS fills (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, state TEXT NOT NULL)",
    );
  }
  all() {
    return this.db
      .prepare("SELECT state FROM accounts ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(r.state));
  }
  save(account) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO accounts(id,state) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
        )
        .run(account.id, JSON.stringify(account));
      const fill = this.db.prepare(
        "INSERT OR IGNORE INTO fills(id,account_id,state) VALUES (?,?,?)",
      );
      const decision = this.db.prepare(
        "INSERT OR IGNORE INTO decisions(id,account_id,state) VALUES (?,?,?)",
      );
      const order = this.db.prepare(
        "INSERT INTO orders(id,account_id,state) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
      );
      for (const row of account.fills)
        fill.run(row.id, account.id, JSON.stringify(row));
      for (const row of account.journal)
        decision.run(row.id, account.id, JSON.stringify(row));
      for (const row of account.orders)
        order.run(row.id, account.id, JSON.stringify(row));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
