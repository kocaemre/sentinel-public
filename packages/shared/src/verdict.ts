/**
 * Shared decision-seam types for Sentinel.
 *
 * The decision seam is the single function Phase 2 (deterministic policy) and
 * Phase 3 (LLM judge) replace. Its signature is `(ctx: DecisionContext) => Verdict`.
 * Phase 1 ships only a hardcoded `allow` stub, but the types are named now so the
 * later phases fill them in without renaming anything.
 */

/** The verdict the decision seam returns for a held 402. */
export interface Verdict {
  /** allow → proceed with X-PAYMENT; block → refuse; step-up → human-in-the-loop (Phase 2+). */
  decision: "allow" | "block" | "step-up";
  /** Optional human/audit-readable reasons backing the decision. */
  reasons?: string[];
}

/**
 * The typed input the decision seam receives in Plan 02.
 *
 * Kept intentionally minimal for Plan 01: the parsed x402 PaymentRequirements
 * slot is `unknown` here (Plan 02 Task 1 introduces the Arc-permissive schema in
 * `packages/shared/src/x402-schema.ts` and tightens this type) and the upstream
 * target host is captured so policy/velocity logic in Phase 2 can key on it.
 */
export interface DecisionContext {
  /** The decoded upstream host (e.g. `api.foo.com`) the agent is paying. */
  targetHost: string;
  /**
   * The parsed x402 PaymentRequirements. Forward-declared as `unknown` in Plan 01;
   * Plan 02 replaces this with the typed `PaymentRequirements` from the shared schema.
   */
  requirements: unknown;
}
