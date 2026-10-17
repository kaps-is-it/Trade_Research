import test from "node:test";
import assert from "node:assert/strict";
import { newAccount } from "./ledger.mjs";
import {
  decisionInput,
  STRATEGY_INSTRUCTIONS,
  parseDecision,
  requestDecision,
  MODEL_PRESETS,
  modelTimeoutMs,
} from "./models.mjs";

const account = () =>
  newAccount({
    kind: "ai",
    capital: "300",
    model: "test-model",
    name: "Fake paper simulation",
  });
const snapshot = {
  asOf: 1000,
  bid: "99",
  ask: "100",
  candles: [{ time: 1, close: "99" }],
  rules: { step: ".001" },
  available: "300",
  orderCeiling: "75",
  minimumEquity: "270",
};
test("model contract omits simulation labels, names and account UI metadata", () => {
  const a = account();
  a.journal = [
    {
      action: "hold",
      rationale: "No entry",
      result: "No order submitted.",
      time: 1,
    },
    { result: "Paper account created." },
  ];
  const input = decisionInput(a, snapshot),
    text = STRATEGY_INSTRUCTIONS + JSON.stringify(input);
  assert.doesNotMatch(text, /fake|paper|simulat/i);
  assert.equal(input.account.cash, "300");
  assert.equal(input.market, "BTC/USDT");
  assert(!("name" in input.account));
  assert(!("kind" in input.account));
});
test("malformed and incomplete model outputs never become orders", () => {
  assert.throws(() => parseDecision("not JSON"));
  assert.throws(() =>
    parseDecision(JSON.stringify({ action: "withdraw", rationale: "x" })),
  );
  assert.throws(() =>
    parseDecision(
      JSON.stringify({
        action: "buy",
        type: "market",
        quantity: 2,
        rationale: "x",
      }),
    ),
  );
  assert.equal(
    parseDecision('{"action":"hold","rationale":"Wait"}').action,
    "hold",
  );
});
test("OpenAI requests use a server-side credential and parse Responses output", async () => {
  const a = account();
  let observed;
  const result = await requestDecision(a, snapshot, {
    env: { OPENAI_API_KEY: "test-only-key" },
    fetcher: async (url, options) => {
      observed = { url, options };
      return Response.json({
        output: [
          {
            content: [
              {
                type: "output_text",
                text: '{"action":"hold","rationale":"No signal"}',
              },
            ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 4 },
      });
    },
  });
  assert.equal(observed.url, "https://api.openai.com/v1/responses");
  assert.equal(JSON.parse(observed.options.body).store, false);
  assert.equal(result.inputTokens, 10);
  assert.equal(result.decision.action, "hold");
  assert.doesNotMatch(
    observed.options.body,
    /test-only-key|fake|paper|simulat/i,
  );
});
test("NVIDIA NIM requests use a server-side credential and chat completions", async () => {
  const a = account();
  a.provider = "nvidia";
  let observed;
  const result = await requestDecision(a, snapshot, {
    env: { NVIDIA_NIM_API_KEY: "nvapi-test-only" },
    fetcher: async (url, options) => {
      observed = { url, options };
      return Response.json({
        choices: [
          { message: { content: '{"action":"hold","rationale":"No signal"}' } },
        ],
        usage: { input_tokens: 10, output_tokens: 4 },
      });
    },
  });
  assert.equal(
    observed.url,
    "https://integrate.api.nvidia.com/v1/chat/completions",
  );
  assert.equal(JSON.parse(observed.options.body).model, "test-model");
  assert.equal(
    observed.options.headers.Authorization,
    "Bearer nvapi-test-only",
  );
  assert.equal(JSON.parse(observed.options.body).temperature, 0.5);
  assert.equal(JSON.parse(observed.options.body).top_p, 1);
  assert.equal(JSON.parse(observed.options.body).stream, false);
  assert.equal(result.inputTokens, 10);
  assert.equal(result.decision.action, "hold");
  assert.doesNotMatch(
    observed.options.body,
    /nvapi-test-only|fake|paper|simulat/i,
  );
});
test("unconfigured providers never make outbound requests", async () => {
  await assert.rejects(
    requestDecision(account(), snapshot, {
      env: {},
      fetcher: () => {
        throw new Error("Must not fetch");
      },
    }),
    /not configured/,
  );
});

test("each requested NVIDIA preset creates an independent run and keeps its exact ID", () => {
  assert.deepEqual(
    MODEL_PRESETS.nvidia.map((m) => m.id),
    [
      "z-ai/glm-5.3",
      "deepseek-ai/deepseek-v4.1-flash",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ],
  );
  const runs = MODEL_PRESETS.nvidia.map((m, i) =>
    newAccount({
      kind: "ai",
      provider: "nvidia",
      model: m.id,
      capital: i === 0 ? "1000" : "300",
    }),
  );
  assert.equal(new Set(runs.map((r) => r.id)).size, 3);
  assert.equal(runs[0].cash, "1000");
  assert.equal(runs[1].cash, "300");
});

test("truncated model decisions are rejected before parsing or execution", async () => {
  const a = account();
  a.provider = "nvidia";
  await assert.rejects(
    requestDecision(a, snapshot, {
      env: { NVIDIA_NIM_API_KEY: "test-only" },
      fetcher: async () =>
        Response.json({
          choices: [
            {
              finish_reason: "length",
              message: { content: '{"action":"buy"' },
            },
          ],
        }),
    }),
    /output-token limit/,
  );
});

test("NVIDIA gets a bounded provider-specific timeout without changing other providers", () => {
  assert.equal(modelTimeoutMs("nvidia", {}), 120000);
  assert.equal(
    modelTimeoutMs("nvidia", { NVIDIA_NIM_TIMEOUT_MS: "180000" }),
    180000,
  );
  assert.equal(
    modelTimeoutMs("nvidia", { NVIDIA_NIM_TIMEOUT_MS: "99999999" }),
    120000,
  );
  assert.equal(modelTimeoutMs("openai", {}), 60000);
});
