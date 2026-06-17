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
import type { Ledger } from "./ledger.js";
import type { Dedup } from "./dedup.js";

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

// ── Plan 03 controls: stateful/list, EVALUATE-only (commit-once lives outside) ──

/**
 * Allow/deny counterparty (POLICY-04, T-02-13). Blocks if the upstream-declared
 * `payTo` is on the deny set. Deny precedence + fail-closed: a denied payee blocks
 * even when the amount is well under every cap. EVALUATE-only — a pure set lookup.
 */
export function allowDeny(ctx: DecisionContext, denySet: Set<string>): Verdict | null {
  const payTo = ctx.requirements.payTo;
  if (!denySet.has(payTo)) return null;
  return {
    decision: "block",
    control: "denied",
    protectedAmountAtomic: ctx.amountAtomic.toString(),
    reasons: [`denied: counterparty ${payTo} is on the deny list (deny precedence, fail-closed)`],
  };
}

/**
 * Rolling-window budget (POLICY-02, T-02-12). Blocks if the incoming payment would
 * push the rolling-HOUR settled sum over `hourlyAtomic` OR the rolling-24h sum over
 * `dailyAtomic`. EVALUATE-only: it READS `ledger.spentSince` and never writes (the
 * settlement is recorded once post-200 in forward.ts — RESEARCH Pitfall 2). All
 * sums are atomic-unit BigInt.
 */
export function budget(
  ctx: DecisionContext,
  ledger: Ledger,
  hourlyAtomic: bigint,
  dailyAtomic: bigint,
): Verdict | null {
  const hourSpent = ledger.spentSince(3_600_000);
  const daySpent = ledger.spentSince(24 * 3_600_000);
  const wouldHour = hourSpent + ctx.amountAtomic;
  const wouldDay = daySpent + ctx.amountAtomic;
  if (wouldHour <= hourlyAtomic && wouldDay <= dailyAtomic) return null;
  const which =
    wouldHour > hourlyAtomic
      ? `hourly (${wouldHour} > ${hourlyAtomic} atomic in the last 1h)`
      : `daily (${wouldDay} > ${dailyAtomic} atomic in the last 24h)`;
  return {
    decision: "block",
    control: "budget",
    protectedAmountAtomic: ctx.amountAtomic.toString(),
    reasons: [`budget: payment of ${ctx.amountAtomic} atomic would exceed the ${which} budget`],
  };
}

/**
 * Rolling-window velocity (POLICY-03, T-02-12). Blocks the Nth+1 payment inside the
 * window: if `velocityCount(windowMs) >= limit` the incoming payment would be over
 * the limit. EVALUATE-only — READS `ledger.velocityCount`, never writes.
 */
export function velocity(
  ctx: DecisionContext,
  ledger: Ledger,
  limit: number,
  windowMs: number,
): Verdict | null {
  const count = ledger.velocityCount(windowMs);
  if (count < limit) return null;
  return {
    decision: "block",
    control: "velocity",
    protectedAmountAtomic: ctx.amountAtomic.toString(),
    reasons: [
      `velocity: ${count} payments already settled in the last ${windowMs}ms (limit ${limit})`,
    ],
  };
}

/**
 * Replay (POLICY-06, T-02-10). Blocks if the canonical `(paymentId, resourceId)`
 * pair was already seen. EVALUATE-only via the read-only `dedup.wasSeen` — it NEVER
 * inserts (so PRE and POST can both call it without double-marking, Pitfall 1). The
 * single COMMIT (`markFirstSeen`) happens once at the allow decision in decide.ts.
 * The key is the canonical paymentId from the upstream 402, NOT Sentinel's per-call
 * X-PAYMENT nonce (which differs per proxied call — threat T-02-17).
 */
export function replay(ctx: DecisionContext, dedup: Dedup): Verdict | null {
  if (!dedup.wasSeen(ctx.paymentId, ctx.resourceId)) return null;
  return {
    decision: "block",
    control: "replay",
    protectedAmountAtomic: ctx.amountAtomic.toString(),
    reasons: [
      `replay: the canonical (paymentId, resourceId) for resource ${ctx.resourceId} was already settled — ` +
        `duplicate payment blocked at the HTTP layer`,
    ],
  };
}
