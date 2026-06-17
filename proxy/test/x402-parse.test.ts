import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePaymentRequired } from "../src/x402/parse.js";
import { PaymentRequirementsSchema } from "@sentinel/shared";
import { decide } from "../src/decision/stub.js";
import type { DecisionContext } from "@sentinel/shared";

const ARC_REQS = {
  scheme: "exact" as const,
  network: "arc-testnet",
  maxAmountRequired: "1000",
  resource: "https://upstream/paid",
  description: "demo",
  mimeType: "application/json",
  payTo: "0xPayee",
  maxTimeoutSeconds: 60,
  asset: "0xUSDC",
};

test("schema: an Arc-network requirement parses successfully (Arc accepted — Pitfall 1 fix)", () => {
  const r = PaymentRequirementsSchema.safeParse(ARC_REQS);
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.data.network, "arc-testnet");
});

test("parsePaymentRequired: full {x402Version, accepts:[...]} envelope returns typed fields", () => {
  const raw = JSON.stringify({ x402Version: 1, accepts: [ARC_REQS] });
  const reqs = parsePaymentRequired(raw);
  assert.equal(reqs.network, "arc-testnet");
  assert.equal(reqs.maxAmountRequired, "1000");
  assert.equal(reqs.payTo, "0xPayee");
  assert.equal(reqs.maxTimeoutSeconds, 60);
});

test("parsePaymentRequired: tolerates a bare requirements object (no accepts wrapper)", () => {
  const reqs = parsePaymentRequired(JSON.stringify(ARC_REQS));
  assert.equal(reqs.network, "arc-testnet");
  assert.equal(reqs.asset, "0xUSDC");
});

test("parsePaymentRequired: non-JSON body throws (caller fail-closes — D-09)", () => {
  assert.throws(() => parsePaymentRequired("not json"));
});

test("parsePaymentRequired: missing required fields throws (Zod safeParse failure — D-09)", () => {
  assert.throws(() => parsePaymentRequired(JSON.stringify({ accepts: [{ scheme: "exact" }] })));
});

test("decide: a legit under-cap, correctly-priced payment is allowed (Phase 2 seam)", async () => {
  // 1000 atomic (0.001 USDC) for /paid (expected 1000) → under the per-call cap
  // and not an overpayment, so the deterministic gate allows it.
  const ctx: DecisionContext = {
    targetHost: "upstream",
    requirements: ARC_REQS,
    amountAtomic: 1000n,
    paymentId: "test-payment-id",
    resourceId: ARC_REQS.resource,
    resource: ARC_REQS.resource,
  };
  assert.deepEqual(await decide(ctx), { decision: "allow" });
});
