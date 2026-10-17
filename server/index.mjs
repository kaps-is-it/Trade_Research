import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { AccountStore } from "./store.mjs";
import { TradingMarket } from "./market.mjs";
import { TradingService } from "./service.mjs";

export function createTradingServer(service, env = process.env) {
  const host = env.TRADING_HOST || "127.0.0.1",
    token = env.TRADING_ADMIN_TOKEN || "";
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && token.length < 24)
    throw new Error(
      "A hosted backend requires TRADING_ADMIN_TOKEN of at least 24 characters.",
    );
  const origins = new Set(
    (
      env.TRADING_ALLOWED_ORIGINS ||
      "http://127.0.0.1:5173,http://localhost:5173"
    )
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
  const equal = (a, b) => {
    const aa = Buffer.from(a),
      bb = Buffer.from(b);
    return aa.length === bb.length && timingSafeEqual(aa, bb);
  };
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin,
      allowedOrigin = !origin || origins.has(origin);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "application/json");
    if (origin && origins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    const send = (code, data) => {
      res.writeHead(code);
      res.end(JSON.stringify(data));
    };
    if (!allowedOrigin) return send(403, { error: "Origin is not allowed." });
    if (req.method === "OPTIONS") return send(204, null);
    const bearer = String(req.headers.authorization || "").replace(
      /^Bearer /,
      "",
    );
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress,
    );
    // A loopback-only development server needs no credential. Hosted mode always does.
    const canWrite = token
      ? equal(bearer, token)
      : local && ["127.0.0.1", "localhost", "::1"].includes(host);
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/api/trading") {
        service.watch(url.searchParams.get("base"));
        return send(200, service.snapshot(canWrite));
      }
      if (req.method === "GET" && url.pathname === "/api/trading/models") {
        if (!canWrite)
          return send(401, {
            error: "Owner access required to load model catalogs.",
          });
        return send(200, {
          models: await service.catalog(url.searchParams.get("provider")),
        });
      }
      if (req.method !== "POST") return send(404, { error: "Not found." });
      if (!canWrite) return send(401, { error: "Owner access is required." });
      if (
        !String(req.headers["content-type"] || "").startsWith(
          "application/json",
        )
      )
        return send(415, { error: "Send application/json." });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 16384)
          return send(413, { error: "Request is too large." });
      }
      const input = JSON.parse(raw);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Invalid request.");
      if (url.pathname === "/api/trading/accounts") {
        const account = service.create(input);
        return send(201, { id: account.id });
      }
      const route = url.pathname.match(
        /^\/api\/trading\/accounts\/([\w-]+)\/(orders|control|cancel)$/,
      );
      if (!route) return send(404, { error: "Not found." });
      if (route[2] === "orders") {
        const order = await service.order(route[1], input);
        return send(201, { id: order.id });
      }
      if (route[2] === "control") service.control(route[1], input.action);
      if (route[2] === "cancel") service.cancel(route[1], input.orderId);
      return send(200, { ok: true });
    } catch (error) {
      return send(400, { error: error.message || "Request failed." });
    }
  });
  server.requestTimeout = 15000;
  return server;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const store = new AccountStore(),
    service = new TradingService(store, new TradingMarket());
  const server = createTradingServer(service),
    port = Number(process.env.TRADING_PORT || 8787),
    host = process.env.TRADING_HOST || "127.0.0.1";
  server.listen(port, host, () => {
    console.log(
      `Trading backend: http://${host}:${port} (paper execution only)`,
    );
    service.start();
  });
  const shutdown = async () => {
    server.close();
    await service.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
