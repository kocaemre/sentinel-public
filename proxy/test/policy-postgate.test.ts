import { test } from "node:test";
import assert from "node:assert/strict";
import type { DecisionContext, Verdict } from "@sentinel/shared";
import { perCallCap, overpayment } from "../src/policy/controls.js";
import { runControls } from "../src/policy/engine.js";
import { decide, configureDecision, tighten } from "../src/decision/decide.js";

// A minimal DecisionContext factory for the pure-control unit tests. Only the
// fields the Plan 02 controls read are load-bearing (amountAtomic + resource);
// the rest satisfy the type.
function ctx(amountAtomic: bigint, resource = "https://upstream/paid"): DecisionContext {
  return {
    targetHost: "127.0.0.1:4021",
    requirements: {
      scheme: "exact",
      network: "arc-testnet",
      maxAmountRequired: amountAtomic.toString(),
      resource,
      description: "demo resource",
      mimeType: "application/json",
      payTo: "0xPayee",
      maxTimeoutSeconds: 60,
      asset: "0xUSDC",
    },
    amountAtomic,
    paymentId: `pid:${resource}:${amountAtomic}`,
    resourceId: resource,
    resource,
  };
}

// ── perCallCap (POLICY-01) ──────────────────────────────────────────────────

test("perCallCap: 50 USDC over a 1 USDC cap blocks, naming per_call_cap", () => {
  const v = perCallCap(ctx(50_000_000n), 1_000_000n);
  assert.ok(v, "must block");
  assert.equal(v!.decision, "block");
  assert.equal(v!.control, "per_call_cap");
  assert.equal(v!.protectedAmountAtomic, "50000000");
  assert.ok(
    v!.reasons?.some((r) => r.includes("per_call_cap")),
    "reason must NAME the control, never a generic 'limit exceeded'",
  );
});

test("perCallCap: a sub-cap amount passes (null)", () => {
  assert.equal(perCallCap(ctx(1000n), 1_000_000n), null);
});

test("perCallCap: exactly at the cap passes (only OVER the cap blocks)", () => {
  assert.equal(perCallCap(ctx(1_000_000n), 1_000_000n), null);
});

// ── overpayment (POLICY-07) — distinct from the cap (D-08) ───────────────────

test("overpayment: 50 USDC vs a 1000-atomic expected price at 2x blocks, naming overpayment", () => {
  const v = overpayment(ctx(50_000_000n), 1000n, 2);
  assert.ok(v, "must block");
  assert.equal(v!.decision, "block");
  assert.equal(v!.control, "overpayment");
  assert.equal(v!.protectedAmountAtomic, "50000000");
  assert.ok(v!.reasons?.some((r) => r.includes("overpayment")));
});

test("overpayment: at-or-below the ceiling passes", () => {
  assert.equal(overpayment(ctx(1000n), 1000n, 2), null, "exactly expected passes");
  assert.equal(overpayment(ctx(2000n), 1000n, 2), null, "exactly 2x ceiling passes");
});

test("overpayment: just over the 2x ceiling blocks", () => {
  assert.ok(overpayment(ctx(2001n), 1000n, 2), "2001 > 2*1000 must block");
});

test("overpayment is DISTINCT from the per-call cap (D-08)", () => {
  // Case A: the cap would NOT fire (amount under a generous cap) but overpayment DOES,
  // because the resource's expected price is tiny.
  const amount = 500_000n; // 0.5 USDC
  assert.equal(perCallCap(ctx(amount), 1_000_000n), null, "0.5 USDC is under the 1 USDC cap");
  assert.ok(overpayment(ctx(amount), 1000n, 2), "but 0.5 USDC is >> 2x the 0.001 USDC price");

  // Case B: overpayment would NOT fire (amount within 2x of a high expected price) but
  // the cap DOES, because the absolute amount exceeds the global cap.
  const big = 50_000_000n; // 50 USDC
  assert.equal(overpayment(ctx(big), 40_000_000n, 2), null, "50 within 2x of a 40 USDC price");
  assert.ok(perCallCap(ctx(big), 1_000_000n), "but 50 USDC exceeds the 1 USDC cap");
});

// ── runControls: first blocking verdict, named ──────────────────────────────

const limits = {
  perCallCapAtomic: 1_000_000n,
  overpaymentMultiplier: 2,
  expectedPriceMap: { "https://upstream/paid": "1000" },
};

test("runControls: legit 0.001 USDC allows", () => {
  assert.equal(runControls(ctx(1000n), limits).decision, "allow");
});

test("runControls: 50 USDC blocks naming a control", () => {
  const v = runControls(ctx(50_000_000n), limits);
  assert.equal(v.decision, "block");
  assert.ok(v.control, "the block names a specific control");
});

// ── tighten() monotonic invariant (POLICY-05 / SC#5) ────────────────────────

test("tighten: an injected allow can NEVER loosen a block", () => {
  const block: Verdict = { decision: "block", control: "per_call_cap", reasons: ["per_call_cap exceeded"] };
  const allow: Verdict = { decision: "allow" };
  assert.equal(tighten(block, allow).decision, "block", "allow must not loosen the block");
  assert.equal(tighten(allow, block).decision, "block", "a later block tightens an allow");
  assert.equal(tighten(block, { decision: "step-up" }).decision, "block", "block stays stricter than step-up");
});

// ── decide(): PRE → [judge slot] → POST, judge can't loosen ─────────────────

test("decide: legit 0.001 USDC allows; 50 USDC blocks naming a control", () => {
  configureDecision({
    perCallCapAtomic: 1_000_000n,
    overpaymentMultiplier: 2,
    expectedPriceMap: { "https://upstream/paid": "1000" },
  });
  assert.equal(decide(ctx(1000n)).decision, "allow");
  const v = decide(ctx(50_000_000n));
  assert.equal(v.decision, "block");
  assert.ok(v.control, "named control");
});

test("decide: an injected judge `allow` over a deterministic block stays blocked (POLICY-05)", () => {
  configureDecision({
    perCallCapAtomic: 1_000_000n,
    overpaymentMultiplier: 2,
    expectedPriceMap: { "https://upstream/paid": "1000" },
    // Inject a judge that always returns allow — the POST-check must override it.
    judge: () => ({ decision: "allow" }),
  });
  const v = decide(ctx(50_000_000n));
  assert.equal(v.decision, "block", "the POST-check re-runs the controls; the injected allow cannot loosen it");
  assert.ok(v.control, "the block still names the deterministic control");
});
