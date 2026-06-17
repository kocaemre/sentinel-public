import { test } from "node:test";
import assert from "node:assert/strict";
import type { DecisionContext } from "@sentinel/shared";
import { allowDeny, budget, velocity, replay } from "../src/policy/controls.js";
import { openLedger } from "../src/policy/ledger.js";
import { openDedup } from "../src/policy/dedup.js";

/**
 * Task 2 unit proof for the four stateful/list controls. Each is EVALUATE-only
 * (read-only against its ledger/dedup/denySet) and either returns a blocking
 * Verdict NAMING its control + `protectedAmountAtomic`, or `null`.
 */

function ctx(amountAtomic: bigint, opts: Partial<DecisionContext> = {}): DecisionContext {
  const resource = opts.resource ?? "https://upstream/paid";
  const payTo = opts.requirements?.payTo ?? "0xPayee";
  return {
    targetHost: "127.0.0.1:4021",
    requirements: {
      scheme: "exact",
      network: "arc-testnet",
      maxAmountRequired: amountAtomic.toString(),
      resource,
      description: "demo resource",
      mimeType: "application/json",
      payTo,
      maxTimeoutSeconds: 60,
      asset: "0xUSDC",
    },
    amountAtomic,
    paymentId: opts.paymentId ?? `pid:${resource}:${amountAtomic}`,
    resourceId: resource,
    resource,
    ...opts,
  };
}

// ── allowDeny (POLICY-04) ────────────────────────────────────────────────────

test("allowDeny: a payTo in the deny set blocks, naming denied (deny precedence)", () => {
  const v = allowDeny(ctx(1000n, { requirements: { payTo: "0xBadActor" } as never }), new Set(["0xBadActor"]));
  assert.ok(v, "must block");
  assert.equal(v!.decision, "block");
  assert.equal(v!.control, "denied");
  assert.equal(v!.protectedAmountAtomic, "1000");
  assert.ok(v!.reasons?.some((r) => r.includes("denied")));
});

test("allowDeny: a payTo NOT in the deny set passes (null)", () => {
  assert.equal(allowDeny(ctx(1000n), new Set(["0xSomeoneElse"])), null);
});

// ── budget (POLICY-02) ───────────────────────────────────────────────────────

test("budget: a payment that pushes the rolling-hour sum past the hourly cap blocks", () => {
  const ledger = openLedger(":memory:");
  // 4 USDC already spent this hour; hourly cap 5 USDC.
  ledger.recordSettlement(4_000_000n);
  // A 2 USDC payment → 4 + 2 = 6 > 5 → block.
  const v = budget(ctx(2_000_000n), ledger, 5_000_000n, 20_000_000n);
  assert.ok(v, "must block on the hourly cap");
  assert.equal(v!.control, "budget");
  assert.equal(v!.protectedAmountAtomic, "2000000");
});

test("budget: under both the hourly and daily cap passes (null)", () => {
  const ledger = openLedger(":memory:");
  ledger.recordSettlement(1_000_000n);
  // 1 + 1 = 2 <= 5 hourly and <= 20 daily.
  assert.equal(budget(ctx(1_000_000n), ledger, 5_000_000n, 20_000_000n), null);
});

test("budget: blocks on the DAILY cap even when within the hourly cap", () => {
  const ledger = openLedger(":memory:");
  // 19 USDC spent across the last 24h but none in the last hour (place it 2h ago).
  ledger.recordSettlement(19_000_000n, Date.now() - 2 * 3_600_000);
  // Incoming 2 USDC: hourly 0 + 2 <= 5 (ok), but daily 19 + 2 = 21 > 20 → block.
  const v = budget(ctx(2_000_000n), ledger, 5_000_000n, 20_000_000n);
  assert.ok(v, "must block on the daily cap");
  assert.equal(v!.control, "budget");
});

// ── velocity (POLICY-03) ─────────────────────────────────────────────────────

test("velocity: the Nth+1 payment inside the window blocks, naming velocity", () => {
  const ledger = openLedger(":memory:");
  for (let i = 0; i < 5; i++) ledger.recordSettlement(1000n); // limit 5 already reached
  const v = velocity(ctx(1000n), ledger, 5, 60_000);
  assert.ok(v, "the 6th in-window payment must block");
  assert.equal(v!.control, "velocity");
  assert.equal(v!.protectedAmountAtomic, "1000");
});

test("velocity: below the limit passes (null)", () => {
  const ledger = openLedger(":memory:");
  for (let i = 0; i < 4; i++) ledger.recordSettlement(1000n);
  assert.equal(velocity(ctx(1000n), ledger, 5, 60_000), null, "4 < 5 → allow");
});

// ── replay (POLICY-06) — read-only evaluate ──────────────────────────────────

test("replay: a previously-seen (paymentId, resourceId) blocks, naming replay", () => {
  const dedup = openDedup(":memory:");
  const c = ctx(1000n, { paymentId: "pidX", resource: "https://upstream/paid" });
  dedup.markFirstSeen("pidX", "https://upstream/paid"); // first-seen committed elsewhere
  const v = replay(c, dedup);
  assert.ok(v, "a seen payment must block");
  assert.equal(v!.control, "replay");
  assert.equal(v!.protectedAmountAtomic, "1000");
});

test("replay: a first-seen (paymentId, resourceId) passes (null) and does NOT mark it", () => {
  const dedup = openDedup(":memory:");
  const c = ctx(1000n, { paymentId: "pidY", resource: "https://upstream/paid" });
  assert.equal(replay(c, dedup), null, "first-seen → allow at evaluate");
  // The evaluate must NOT have marked it (commit happens once at decide()).
  assert.equal(dedup.wasSeen("pidY", "https://upstream/paid"), false, "replay() never inserts");
});
