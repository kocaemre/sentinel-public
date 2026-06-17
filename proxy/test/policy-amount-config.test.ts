import { test } from "node:test";
import assert from "node:assert/strict";
import { usdcToAtomic, reqAmountAtomic } from "../src/policy/amount.js";
import { canonicalPaymentId } from "../src/policy/identity.js";
import { loadConfig } from "../src/config.js";
import type { PaymentRequirements } from "@sentinel/shared";

// ── amount.ts: string-parse atomic math, NEVER float multiply ──────────────

test("usdcToAtomic: string-parse to 6-decimal atomic, no float drift", () => {
  assert.equal(usdcToAtomic("0.001"), 1000n, "0.001 USDC must be 1000 atomic, not 999n (float drift)");
  assert.equal(usdcToAtomic("1"), 1000000n);
  assert.equal(usdcToAtomic("50"), 50000000n);
  assert.equal(usdcToAtomic("20"), 20000000n);
  assert.equal(usdcToAtomic("100"), 100000000n);
  assert.equal(usdcToAtomic("5"), 5000000n);
  // number form also string-parsed
  assert.equal(usdcToAtomic(20), 20000000n);
  // full 6-decimal precision preserved, no over-pad
  assert.equal(usdcToAtomic("0.000001"), 1n);
  assert.equal(usdcToAtomic("1.5"), 1500000n);
});

test("reqAmountAtomic: the wire value is already atomic", () => {
  assert.equal(reqAmountAtomic("50000000"), 50000000n);
  assert.equal(reqAmountAtomic("1000"), 1000n);
});

// ── identity.ts: canonical replay paymentId over the stable upstream fields ──

function reqs(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "arc-testnet",
    maxAmountRequired: "1000",
    resource: "https://upstream/paid",
    description: "demo resource",
    mimeType: "application/json",
    payTo: "0xPayee",
    maxTimeoutSeconds: 60,
    asset: "0xUSDC",
    ...overrides,
  };
}

test("canonicalPaymentId: identical payment-defining fields collide (a logical retry)", () => {
  assert.equal(canonicalPaymentId(reqs()), canonicalPaymentId(reqs()));
});

test("canonicalPaymentId: changing ANY of the five stable fields produces a different id", () => {
  const base = canonicalPaymentId(reqs());
  assert.notEqual(base, canonicalPaymentId(reqs({ resource: "https://upstream/other" })));
  assert.notEqual(base, canonicalPaymentId(reqs({ payTo: "0xAttacker" })));
  assert.notEqual(base, canonicalPaymentId(reqs({ maxAmountRequired: "50000000" })));
  assert.notEqual(base, canonicalPaymentId(reqs({ asset: "0xOther" })));
  assert.notEqual(base, canonicalPaymentId(reqs({ network: "base" })));
});

test("canonicalPaymentId: cosmetic fields (description/mimeType) do NOT change the id", () => {
  const base = canonicalPaymentId(reqs());
  assert.equal(base, canonicalPaymentId(reqs({ description: "totally different" })));
  assert.equal(base, canonicalPaymentId(reqs({ mimeType: "text/plain" })));
});

test("canonicalPaymentId: delimiter-safe (length-prefixed, no boundary aliasing)", () => {
  // {resource:"a", payTo:"b"} must NEVER collide with {resource:"a|b", payTo:""}
  const a = canonicalPaymentId(reqs({ resource: "a", payTo: "b" }));
  const b = canonicalPaymentId(reqs({ resource: "a|b", payTo: "" }));
  assert.notEqual(a, b, "bare concatenation would alias these; encoding must be length-prefixed");
});

// ── config.ts: locked atomic defaults + fail-closed ─────────────────────────

test("loadConfig: returns the locked atomic demo defaults with no env", () => {
  const c = loadConfig({});
  assert.equal(c.perCallCapAtomic, 1000000n, "per-call cap 1 USDC");
  assert.equal(c.hourlyBudgetAtomic, 5000000n, "hourly 5 USDC");
  assert.equal(c.dailyBudgetAtomic, 20000000n, "daily 20 USDC");
  assert.equal(c.startingBalanceAtomic, 100000000n, "start 100 USDC");
  assert.equal(c.velocityLimit, 5);
  assert.equal(c.velocityWindowMs, 60000);
  assert.equal(c.overpaymentMultiplier, 2);
  assert.ok(c.denySet instanceof Set, "denySet materialized as a Set");
  assert.equal(typeof c.dbPath, "string");
  // legit /paid resource priced at 0.001 USDC (1000 atomic) in the price map
  assert.equal(c.expectedPriceMap["https://upstream/paid"], "1000");
});

test("loadConfig: fail-closed on a malformed cap (throws, never boots open)", () => {
  assert.throws(() => loadConfig({ SENTINEL_PER_CALL_CAP: "not-a-number" }));
});
