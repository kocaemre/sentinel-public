/**
 * Shared decision-seam types for Sentinel.
 *
 * The decision seam is the single function Phase 2 (deterministic policy) and
 * Phase 3 (LLM judge) replace. Its signature is `(ctx: DecisionContext) => Verdict`.
 * Phase 1 ships only a hardcoded `allow` stub, but the types are named now so the
 * later phases fill them in without renaming anything.
 */

import type { PaymentRequirements } from "./x402-schema.js";

/** The verdict the decision seam returns for a held 402. */
export interface Verdict {
  /** allow → proceed with X-PAYMENT; block → refuse; step-up → human-in-the-loop (Phase 2+). */
  decision: "allow" | "block" | "step-up";
  /** Optional human/audit-readable reasons backing the decision. */
  reasons?: string[];
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
}
