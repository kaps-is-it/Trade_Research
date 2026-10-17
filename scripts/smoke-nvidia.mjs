// Opt-in: performs one inference request per configured NVIDIA preset.
// Uses live public market data. Never creates accounts or submits orders.
import {
  MODEL_PRESETS,
  requestDecision,
  modelTimeoutMs,
} from "../server/models.mjs";
import { TradingMarket } from "../server/market.mjs";
import { newAccount, balances } from "../server/ledger.mjs";

if (!process.env.NVIDIA_NIM_API_KEY) {
  console.error("Set NVIDIA_NIM_API_KEY in the backend environment.");
  process.exit(1);
}
const market = new TradingMarket();
const selected = process.argv.slice(2).find((a) => a !== "--");
const presets = MODEL_PRESETS.nvidia.filter(
  (m) => !selected || m.id === selected,
);
if (!presets.length)
  throw new Error("Choose one of the configured NVIDIA model IDs.");
let failures = 0;
for (const preset of presets) {
  const book = await market.refresh("BTC"),
    candles = await market.history("BTC");
  const account = newAccount({
    kind: "ai",
    capital: "1000",
    provider: "nvidia",
    model: preset.id,
  });
  const snapshot = {
    asOf: book.received,
    bid: book.bids[0][0],
    ask: book.asks[0][0],
    candles,
    rules: market.rules.BTC,
    available: balances(account).available,
    orderCeiling: "250",
    minimumEquity: "900",
  };
  try {
    const result = await requestDecision(account, snapshot, {
      signal: AbortSignal.timeout(modelTimeoutMs("nvidia")),
    });
    console.log(
      JSON.stringify({
        model: preset.id,
        status: "ok",
        action: result.decision.action,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      }),
    );
  } catch (error) {
    failures++;
    console.error(
      JSON.stringify({
        model: preset.id,
        status: "failed",
        error: error.message,
      }),
    );
  }
}
process.exitCode = failures ? 1 : 0;
