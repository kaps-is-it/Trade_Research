import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32")
  throw new Error("This setup script targets Windows.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = resolve(root, "data"),
  bin = resolve(data, "bin");
mkdirSync(bin, { recursive: true });
const exe = resolve(bin, "cloudflared.exe");
// Pin the official release and verify the publisher's release asset digest.
const download =
  "https://github.com/cloudflare/cloudflared/releases/download/2026.10.1/cloudflared-windows-amd64.exe";
const checksum =
  "4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6";
if (!existsSync(exe)) {
  const response = await fetch(download);
  if (!response.ok)
    throw new Error(`Tunnel download returned HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== checksum)
    throw new Error("Tunnel download checksum mismatch.");
  writeFileSync(exe, bytes);
}
if (createHash("sha256").update(readFileSync(exe)).digest("hex") !== checksum)
  throw new Error("Installed tunnel checksum mismatch.");
const envPath = resolve(root, ".env");
let env = readFileSync(envPath, "utf8");
if (!/^SUPABASE_URL=.+$/m.test(env) || !/^SUPABASE_SECRET_KEY=.+$/m.test(env))
  throw new Error("Configure Supabase in .env first.");
const tokenMatch = env.match(/^TRADING_ADMIN_TOKEN=(.+)$/m);
if (tokenMatch && tokenMatch[1].trim().length < 24)
  throw new Error(
    "Existing owner token is too short; replace it before publishing.",
  );
if (!tokenMatch)
  env += `\nTRADING_ADMIN_TOKEN=${randomBytes(32).toString("base64url")}\n`;
const originLine = env.match(/^TRADING_ALLOWED_ORIGINS=(.*)$/m);
const origins = new Set(
  (originLine?.[1] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
for (const origin of [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "https://www.runthispr.com",
  "https://runthispr.com",
])
  origins.add(origin);
env = env.replace(/^TRADING_ALLOWED_ORIGINS=.*\r?\n?/m, "");
env += `\nTRADING_ALLOWED_ORIGINS=${[...origins].join(",")}\n`;
writeFileSync(envPath, env);
writeFileSync(
  resolve(data, "laptop-config.json"),
  JSON.stringify({ cloudflared: exe }, null, 2),
);
const startup = resolve(
  process.env.APPDATA,
  "Microsoft/Windows/Start Menu/Programs/Startup",
);
mkdirSync(startup, { recursive: true });
const quoteVB = (value) => value.replaceAll('"', '""');
const command = `"${process.execPath}" "${resolve(root, "scripts/laptop-worker.mjs")}"`;
writeFileSync(
  resolve(startup, "RunThisPR Backend.vbs"),
  `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "${quoteVB(command)}", 0, False\r\n`,
);
console.log(
  "Installed laptop backend launcher and current-user sign-in autostart.",
);
console.log(
  "Owner token is saved only in .env. It is not printed or published.",
);
console.log("Start: pnpm laptop | Stop: pnpm laptop:stop");
if (process.argv.includes("--start")) {
  const child = spawn(
    process.execPath,
    [resolve(root, "scripts/laptop-worker.mjs")],
    { cwd: root, detached: true, windowsHide: true, stdio: "ignore" },
  );
  child.unref();
  console.log(
    "Background launcher started. Check data/laptop-status.json and data/laptop-worker.log.",
  );
}
