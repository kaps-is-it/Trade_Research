import test from "node:test";
import assert from "node:assert/strict";
import { newAccount } from "./ledger.mjs";
import {
  decisionInput,
  STRATEGY_INSTRUCTIONS,
  parseDecision,
  requestDecision,
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
