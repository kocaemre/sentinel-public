/**
 * Shared decision-seam types for Sentinel.
 *
 * The decision seam is the single function Phase 2 (deterministic policy) and
 * Phase 3 (LLM judge) replace. Its signature is `(ctx: DecisionContext) => Verdict`.
 * Phase 1 ships only a hardcoded `allow` stub, but the types are named now so the
 * later phases fill them in without renaming anything.
 */

import type { PaymentRequirements } from "./x402-schema.js";

/**
 * The named deterministic control that produced a block (D-10).
 *
 * All six values are defined now even though Plan 02 only wires `per_call_cap`
 * and `overpayment`; Plan 03 wires `budget`, `velocity`, `denied`, `replay` into
 * the same engine. The block reason NAMES the specific control (SC#3) — never a
 * generic "limit exceeded".
 */
export type ControlName =
  | "per_call_cap"
  | "budget"
  | "velocity"
  | "denied"
  | "replay"
  | "overpayment";

/** The verdict the decision seam returns for a held 402. */
export interface Verdict {
  /** allow → proceed with X-PAYMENT; block → refuse; step-up → human-in-the-loop (Phase 2+). */
  decision: "allow" | "block" | "step-up";
  /** Optional human/audit-readable reasons backing the decision. */
  reasons?: string[];
  /** The specific deterministic control that produced a block (D-10) — named, never generic. */
  control?: ControlName;
  /** The atomic-unit amount Sentinel protected by blocking this payment (D-06), as a string. */
  protectedAmountAtomic?: string;
}

/**
 * The typed input the decision seam receives.
 *
 * Carries the parsed, Arc-permissive `PaymentRequirements` (Plan 02 filled in the
 * `unknown` slot from Plan 01 now that the shared schema exists) and the upstream
 * target host so policy/velocity logic in Phase 2 can key on it.
 */
export interface DecisionContext {
  /** The decoded upstream host (e.g. `api.foo.com`) the agent is paying. */
  targetHost: string;
  /** The parsed, Arc-permissive x402 payment requirements held from the 402. */
  requirements: PaymentRequirements;
  /** The payment amount in atomic units (BigInt), from `requirements.maxAmountRequired`. */
  amountAtomic: bigint;
  /**
   * The canonical HTTP-layer replay `paymentId` — a delimiter-safe encoding of the
   * STABLE upstream-402 payment-defining fields (resource+payTo+maxAmountRequired+
   * asset+network). This is canonical-over-the-upstream-402, NOT Sentinel's per-call
   * X-PAYMENT nonce (which is minted per proxied call in build.ts and would defeat
   * dedup — D-11, POLICY-06). Plan 03 dedups on `(paymentId, resourceId)`.
   */
  paymentId: string;
  /** The replay `resourceId` (== `requirements.resource`); also the price-map key. */
  resourceId: string;
  /** Convenience alias of `resourceId` for human reasons + the expected-price lookup. */
  resource: string;
}
