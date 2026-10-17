// Constrain generated decisions before local validation. Order IDs are scoped to
// this request's live orders; historical IDs and invented abbreviations cannot pass.
export function decisionSchema(account) {
  const text = (maxLength) => ({ type: "string", minLength: 1, maxLength });
  const nullableDecimal = { type: ["string", "null"], maxLength: 80 };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "action",
      "type",
      "quantity",
      "price",
      "orderId",
      "rationale",
      "strategy",
    ],
    properties: {
      action: {
        type: "string",
        enum: ["hold", "buy", "sell", "cancel", "replace"],
      },
      type: { enum: ["market", "limit", null] },
      quantity: nullableDecimal,
      price: nullableDecimal,
      orderId: {
        enum: [
          null,
          ...account.orders
            .filter((o) => ["open", "partial"].includes(o.status))
            .map((o) => o.id),
        ],
      },
      rationale: text(1000),
      strategy: {
        type: "object",
        additionalProperties: false,
        required: [
          "thesis",
          "entryConditions",
          "holdConditions",
          "exitConditions",
          "invalidation",
          "memory",
          "entryReadiness",
          "exitUrgency",
        ],
        properties: {
          ...Object.fromEntries(
            [
              "thesis",
              "entryConditions",
              "holdConditions",
              "exitConditions",
              "invalidation",
            ].map((f) => [f, text(800)]),
          ),
          memory: text(2000),
          entryReadiness: { type: "number", minimum: 0, maximum: 100 },
          exitUrgency: { type: "number", minimum: 0, maximum: 100 },
        },
      },
    },
  };
}
