/**
 * The deterministic policy engine — orchestrates the pure controls in order and
 * returns the FIRST blocking `Verdict` (naming its control) or `{ decision: "allow" }`.
 *
 * Plan 02 wires two controls: `perCallCap` (POLICY-01) then `overpayment`
 * (POLICY-07). The order list below is the single registration point: Plan 03
 * inserts `denied` / `budget` / `velocity` / `replay` into this same sequence
 * WITHOUT restructuring `decide.ts` or `forward.ts`. The engine stays PURE
 * (read-only) — stateful Plan-03 controls must commit OUTSIDE this evaluation
 * (RESEARCH Pitfall 1; see controls.ts).
 */

import type { DecisionContext, Verdict } from "@sentinel/shared";
import { perCallCap, overpayment } from "./controls.js";

/**
 * The subset of config the engine needs to evaluate the Plan 02 controls. A full
 * `Config` is a structural superset of this, so the server can pass its `Config`
 * straight through. (Plan 03 widens this with the budget/velocity/deny fields.)
 */
export interface DecisionLimits {
  /** Per-call cap in atomic units (POLICY-01). */
  perCallCapAtomic: bigint;
  /** Overpayment ceiling multiplier vs the expected price (POLICY-07). */
  overpaymentMultiplier: number;
  /** Expected price per resource (resource → atomic-string), keyed on `ctx.resource`. */
  expectedPriceMap: Record<string, string>;
}

const ALLOW: Verdict = { decision: "allow" };

/**
 * Run the registered controls in order; return the first blocking verdict or allow.
 *
 * Registration order (Plan 03 inserts its controls into this list):
 *   1. perCallCap   (POLICY-01)   — Plan 02
 *   2. overpayment  (POLICY-07)   — Plan 02   (only if the resource has an expected price)
 *   [3. denied      (POLICY-03)   — Plan 03]
 *   [4. budget      (POLICY-02)   — Plan 03]
 *   [5. velocity    (POLICY-04)   — Plan 03]
 *   [6. replay      (POLICY-06)   — Plan 03]
 */
export function runControls(ctx: DecisionContext, limits: DecisionLimits): Verdict {
  // 1. Per-call cap.
  const capVerdict = perCallCap(ctx, limits.perCallCapAtomic);
  if (capVerdict) return capVerdict;

  // 2. Overpayment — only when the resource has a configured expected price.
  const expectedStr = limits.expectedPriceMap[ctx.resource];
  if (expectedStr !== undefined) {
    const overVerdict = overpayment(ctx, BigInt(expectedStr), limits.overpaymentMultiplier);
    if (overVerdict) return overVerdict;
  }

  return ALLOW;
}
