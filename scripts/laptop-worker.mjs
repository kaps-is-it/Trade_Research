import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = resolve(root, "data"),
  configPath = resolve(data, "laptop-config.json");
mkdirSync(data, { recursive: true });
if (!existsSync(configPath))
  throw new Error(
    "Run laptop setup first; data/laptop-config.json is missing.",
  );
const config = JSON.parse(readFileSync(configPath, "utf8"));
const statusPath = resolve(data, "laptop-status.json"),
  stopPath = resolve(data, "laptop-stop");
if (process.argv.includes("--stop")) {
  writeFileSync(stopPath, "stop");
  console.log("Laptop backend stop requested. Autostart remains configured.");
  process.exit(0);
}
if (existsSync(statusPath)) {
  const old = JSON.parse(readFileSync(statusPath, "utf8"));
  if (old.supervisorPid) {
    try {
      process.kill(old.supervisorPid, 0);
      console.log("Laptop backend is already running.");
      process.exit(0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
rmSync(stopPath, { force: true });
let stopping = false,
  backend,
  tunnel,
  awake;
const logPath = resolve(data, "laptop-worker.log");
function log(text) {
  appendFileSync(logPath, `${new Date().toISOString()} ${text}\n`);
}
function status(extra = {}) {
  writeFileSync(
    statusPath,
    JSON.stringify(
      {
        supervisorPid: process.pid,
        backendPid: backend?.pid,
        tunnelPid: tunnel?.pid,
        updatedAt: Date.now(),
        ...extra,
      },
      null,
      2,
    ),
  );
}
async function stopChildren() {
  if (backend && backend.exitCode === null && backend.signalCode === null) {
    if (backend.connected) backend.send({ action: "shutdown" });
    for (
      let i = 0;
      i < 150 && backend.exitCode === null && backend.signalCode === null;
      i++
    )
      await delay(100);
    if (backend.exitCode === null && backend.signalCode === null)
      backend.kill();
  }
  if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null)
    tunnel.kill();
  backend = tunnel = null;
}
function shutdown() {
  stopping = true;
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
const stopWatcher = setInterval(() => {
  if (existsSync(stopPath)) stopping = true;
}, 1000);
// A process-scoped power request; it does not change the Windows power plan.
if (process.platform === "win32") {
  awake = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -Namespace RunThisPR -Name Power -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'; [RunThisPR.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null; while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 }`,
    ],
    { windowsHide: true, stdio: "ignore" },
  );
}
try {
  status({ state: "starting" });
  while (!stopping) {
    if (
      existsSync(logPath) &&
      (await import("node:fs")).statSync(logPath).size > 5_000_000
    )
      renameSync(logPath, logPath + ".previous");
    try {
      tunnel = spawn(
        config.cloudflared,
        [
          "tunnel",
          "--no-autoupdate",
          "--url",
          "http://127.0.0.1:8787",
          "--protocol",
          "http2",
        ],
        { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let discovered, tunnelError;
      tunnel.on("error", (error) => {
        tunnelError = error;
      });
      let buffer = "";
      const receive = (chunk) => {
        const text = chunk.toString();
        log(text.trim());
        buffer = (buffer + text).slice(-16000);
        discovered ||= [
          ...buffer.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/g),
        ].find((match) => match[1] !== "api")?.[0];
      };
      tunnel.stdout.on("data", receive);
      tunnel.stderr.on("data", receive);
      const deadline = Date.now() + 90000;
      while (
        !discovered &&
        !stopping &&
        tunnel.exitCode === null &&
        tunnel.signalCode === null &&
        !tunnelError &&
        Date.now() < deadline
      )
        await delay(250);
      if (stopping) break;
      if (!discovered)
        throw tunnelError || new Error("HTTPS tunnel did not become ready.");
      backend = spawn(
        process.execPath,
        ["--env-file-if-exists=.env", "server/index.mjs"],
        {
          cwd: root,
          windowsHide: true,
          env: {
            ...process.env,
            TRADING_HOST: "127.0.0.1",
            TRADING_PORT: "8787",
            TRADING_PUBLIC_MODE: "true",
            TRADING_PUBLIC_URL: discovered,
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      let backendError;
      backend.on("error", (error) => {
        backendError = error;
      });
      backend.stdout.on("data", (chunk) => log(chunk.toString().trim()));
      backend.stderr.on("data", (chunk) => log(chunk.toString().trim()));
      log(`Laptop backend started: ${discovered}`);
      while (
        !stopping &&
        backend.exitCode === null &&
        backend.signalCode === null &&
        tunnel.exitCode === null &&
        tunnel.signalCode === null &&
        !backendError &&
        !tunnelError
      ) {
        status({ state: "running", publicUrl: discovered });
        await delay(1000);
      }
      if (backendError || tunnelError) throw backendError || tunnelError;
    } catch (error) {
      log(error.message);
    } finally {
      await stopChildren();
    }
    if (!stopping) {
      status({ state: "reconnecting" });
      // Let a failed worker's database lease expire before restarting.
      for (let i = 0; i < 60 && !stopping; i++) await delay(1000);
    }
  }
} finally {
  await stopChildren();
  awake?.kill();
  clearInterval(stopWatcher);
  rmSync(stopPath, { force: true });
  status({ state: "stopped", supervisorPid: null });
  log("Laptop backend stopped.");
}
