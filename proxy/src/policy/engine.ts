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
import { perCallCap, overpayment, allowDeny, budget, velocity, replay } from "./controls.js";
import type { Ledger } from "./ledger.js";
import type { Dedup } from "./dedup.js";

/**
 * The subset of config the engine needs to evaluate the controls. A full `Config`
 * is a structural superset of this, so the server can pass its `Config` straight
 * through. Plan 02 wired the cap/overpayment fields; Plan 03 adds the budget/
 * velocity/deny limits and the (optional) ledger/dedup store handles.
 *
 * The Plan 03 store handles + their limits are OPTIONAL: when a store is absent the
 * corresponding control is simply skipped. This keeps the pure unit tests (which
 * call `runControls` with cap/overpayment only) working unchanged, while the server
 * (which opens the stores at boot) gets the full six-control set.
 */
export interface DecisionLimits {
  /** Per-call cap in atomic units (POLICY-01). */
  perCallCapAtomic: bigint;
  /** Overpayment ceiling multiplier vs the expected price (POLICY-07). */
  overpaymentMultiplier: number;
  /** Expected price per resource (resource → atomic-string), keyed on `ctx.resource`. */
  expectedPriceMap: Record<string, string>;
  /** Denied counterparties as a Set for O(1) lookup (POLICY-04). */
  denySet?: Set<string>;
  /** Hourly budget cap in atomic units (POLICY-02). */
  hourlyBudgetAtomic?: bigint;
  /** Daily budget cap in atomic units (POLICY-02). */
  dailyBudgetAtomic?: bigint;
  /** Max payments per velocity window (POLICY-03). */
  velocityLimit?: number;
  /** Velocity window in ms (POLICY-03). */
  velocityWindowMs?: number;
  /** Rolling-window settlements ledger (POLICY-02/03) — opened once at boot. */
  ledger?: Ledger;
  /** Replay-dedup store (POLICY-06) — opened once at boot. */
  dedup?: Dedup;
}

const ALLOW: Verdict = { decision: "allow" };

/**
 * Run the registered controls in order; return the first blocking verdict or allow.
 *
 * Registration order — cheapest/most-decisive first, stateful reads last:
 *   1. denied       (POLICY-04)   — pure deny-set lookup, fail-closed precedence
 *   2. perCallCap   (POLICY-01)   — pure amount compare
 *   3. overpayment  (POLICY-07)   — pure amount compare (only if the resource is priced)
 *   4. replay       (POLICY-06)   — read-only dedup `wasSeen`
 *   5. velocity     (POLICY-03)   — read-only ledger count
 *   6. budget       (POLICY-02)   — read-only ledger sum
 *
 * The engine is EVALUATE-only: NO control mutates state here (no `markFirstSeen`,
 * no `recordSettlement`). `decide()` runs this in BOTH the PRE and POST pass, so a
 * mutating control would double-apply (RESEARCH Pitfall 1). The single COMMIT for
 * each stateful control happens OUTSIDE: the replay dedup-mark once at decide()'s
 * allow point, the ledger/balance write once post-settlement in forward.ts.
 *
 * Each stateful/list control is skipped when its config (denySet / ledger / dedup
 * + the matching limit) is absent — so the pure unit tests run unwired.
 */
export function runControls(ctx: DecisionContext, limits: DecisionLimits): Verdict {
  // 1. Denied counterparty — deny precedence, fail-closed (cheapest decisive check).
  if (limits.denySet) {
    const deniedVerdict = allowDeny(ctx, limits.denySet);
    if (deniedVerdict) return deniedVerdict;
  }

  // 2. Per-call cap.
  const capVerdict = perCallCap(ctx, limits.perCallCapAtomic);
  if (capVerdict) return capVerdict;

  // 3. Overpayment — only when the resource has a configured expected price.
  const expectedStr = limits.expectedPriceMap[ctx.resource];
  if (expectedStr !== undefined) {
    const overVerdict = overpayment(ctx, BigInt(expectedStr), limits.overpaymentMultiplier);
    if (overVerdict) return overVerdict;
  }

  // 4. Replay — read-only dedup evaluate (the commit is in decide()).
  if (limits.dedup) {
    const replayVerdict = replay(ctx, limits.dedup);
    if (replayVerdict) return replayVerdict;
  }

  // 5. Velocity — read-only rolling-window count.
  if (limits.ledger && limits.velocityLimit !== undefined && limits.velocityWindowMs !== undefined) {
    const velocityVerdict = velocity(ctx, limits.ledger, limits.velocityLimit, limits.velocityWindowMs);
    if (velocityVerdict) return velocityVerdict;
  }

  // 6. Budget — read-only rolling-window sum.
  if (
    limits.ledger &&
    limits.hourlyBudgetAtomic !== undefined &&
    limits.dailyBudgetAtomic !== undefined
  ) {
    const budgetVerdict = budget(ctx, limits.ledger, limits.hourlyBudgetAtomic, limits.dailyBudgetAtomic);
    if (budgetVerdict) return budgetVerdict;
  }

  return ALLOW;
}
