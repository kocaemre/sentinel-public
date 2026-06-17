/**
 * Pure deterministic controls (Plan 02 slice).
 *
 * Each control is a PURE, read-only function of the `DecisionContext` plus its
 * resolved limit(s). It returns a blocking `Verdict` (naming the SPECIFIC control
 * + the atomic amount it protected, D-06/D-10) or `null` (this control passes —
 * let the next one run). The block reason ALWAYS names the control (SC#3) — never
 * a generic "limit exceeded".
 *
 * CRITICAL (RESEARCH Pitfall 1): these controls perform NO state mutation. The
 * decision seam (`decide.ts`) runs the engine in BOTH the PRE and the POST pass,
 * so any control that mutated state would double-apply. Plan 03's stateful
 * controls (`budget`, `velocity`, `replay`, `denied`) must EVALUATE here but COMMIT
 * (ledger increment / dedup-mark on `(paymentId, resourceId)` / balance debit)
 * exactly once, OUTSIDE this read-only evaluation path.
 *
 * All comparisons are atomic-unit `BigInt` (RESEARCH Pattern 3 / Pitfall 4) — no
 * float ever touches money math.
 */

import type { DecisionContext, Verdict } from "@sentinel/shared";

/**
 * Per-call cap (POLICY-01, T-02-05). Blocks a single payment whose atomic amount
 * exceeds the global per-call cap. Exactly-at-the-cap PASSES — only strictly OVER
 * the cap blocks. This is the clean trip for the D-01 headline 50 USDC drain.
 */
export function perCallCap(ctx: DecisionContext, capAtomic: bigint): Verdict | null {
  if (ctx.amountAtomic <= capAtomic) return null;
  return {
    decision: "block",
    control: "per_call_cap",
    protectedAmountAtomic: ctx.amountAtomic.toString(),
    reasons: [
      `per_call_cap: payment of ${ctx.amountAtomic} atomic exceeds the per-call cap of ${capAtomic} atomic`,
    ],
  };
}

/**
 * Overpayment sanity (POLICY-07, T-02-11) — DISTINCT from the per-call cap (D-08).
 * Blocks a payment that exceeds `expectedAtomic × multiplier` for the resource,
 * where `expectedAtomic` comes from the config'd expected-price map (keyed on
 * `ctx.resource`). This trips even when the absolute amount is UNDER the global
 * cap (e.g. 0.5 USDC for a 0.001 USDC resource), and conversely the cap can trip
 * when overpayment would not (a 50 USDC payment for a 40 USDC resource is within
 * 2×, yet still over the 1 USDC cap).
 *
 * Ceiling math is integer-only: `(expected × round(mult × 100)) / 100`. At or
 * below the ceiling PASSES; strictly over blocks.
 */
export function overpayment(
  ctx: DecisionContext,
  expectedAtomic: bigint,
  mult: number,
): Verdict | null {
  // Integer ceiling = expected × mult, computed in BigInt via a ×100 scale so a
  // fractional multiplier (e.g. 1.5) never needs a float multiply on money.
  const scaledMult = BigInt(Math.round(mult * 100));
  const ceilingAtomic = (expectedAtomic * scaledMult) / 100n;
  if (ctx.amountAtomic <= ceilingAtomic) return null;
  return {
    decision: "block",
    control: "overpayment",
    protectedAmountAtomic: ctx.amountAtomic.toString(),
    reasons: [
      `overpayment: payment of ${ctx.amountAtomic} atomic exceeds ${mult}× the expected price ` +
        `(${expectedAtomic} atomic) for resource ${ctx.resource} — ceiling ${ceilingAtomic} atomic`,
    ],
  };
}
