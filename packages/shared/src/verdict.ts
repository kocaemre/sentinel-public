/**
 * Shared decision-seam types for Sentinel.
 *
 * The decision seam is the single function Phase 2 (deterministic policy) and
 * Phase 3 (LLM judge) replace. Its signature is `(ctx: DecisionContext) => Verdict`.
 * Phase 1 ships only a hardcoded `allow` stub, but the types are named now so the
 * later phases fill them in without renaming anything.
 */

import { z } from "zod";
import type { PaymentRequirements } from "./x402-schema.js";

/**
 * The named attack class the LLM judge claims to have matched (JUDGE-06).
 *
 * A CLOSED string-literal union, aligned in spirit with `ControlName`: a fixed
 * taxonomy the dashboard/audit can render, never an open free-text channel.
 * `prompt_injection_payment` is the D-01 headline (the killer-demo attack);
 * `none` is a clean allow / no attack matched.
 *
 * NOTE: keep these members BYTE-IDENTICAL with the `matched_attack` z.enum in
 * `VerdictSchema` below — the type and the schema must not drift.
 */
export type MatchedAttack =
  | "prompt_injection_payment"
  | "overpayment_drain"
  | "replay"
  | "none";

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
  /**
   * ADVISORY ONLY (CLAUDE.md "What NOT to Use"): the LLM judge's self-reported
   * confidence in `[0,1]`. A display/audit field — NEVER the enforcement gate.
   */
  confidence?: number;
  /**
   * ADVISORY ONLY (CLAUDE.md "What NOT to Use"): the LLM judge's claim that it
   * detected a prompt-injection in the screened context. A display/audit field
   * surfaced to the dashboard — NEVER trusted as the gate (the deterministic
   * PRE/POST controls + tighten() are the real enforcement).
   */
  injection_detected?: boolean;
  /**
   * ADVISORY ONLY (CLAUDE.md "What NOT to Use"): the named attack class the judge
   * matched (JUDGE-06). A display/audit field for the verdict drill-down — NEVER
   * the enforcement gate.
   */
  matched_attack?: MatchedAttack;
}

/**
 * Zod schema used to RE-VALIDATE the LLM judge's JSON output (JUDGE-05 / D-05).
 *
 * This is the FAIL-CLOSED gate (consumed by Plan 02's OpenRouter adapter): a cheap
 * model that omits a field or returns a bad enum produces `safeParse().success ===
 * false`, which the adapter maps to a `block`. So for the LLM-output contract ALL
 * FIVE fields are REQUIRED — unlike the optional advisory fields on `Verdict`, a
 * missing field here MUST fail the parse rather than silently default.
 *
 * Mirrors the `import { z } from "zod"` + `z.object({...})` style from
 * `x402-schema.ts`. The `matched_attack` enum members are byte-identical to the
 * `MatchedAttack` type above so the two cannot drift.
 */
export const VerdictSchema = z.object({
  decision: z.enum(["allow", "block", "step-up"]),
  reasons: z.array(z.string()),
  confidence: z.number(),
  injection_detected: z.boolean(),
  matched_attack: z.enum(["prompt_injection_payment", "overpayment_drain", "replay", "none"]),
});

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
  /**
   * The general attacker-influenced text channel the LLM judge SCREENS (D-02).
   *
   * In Phase 3 this carries the 402 `description`; later phases route other
   * fetched-resource content through this SAME field without re-architecting the
   * seam. Do NOT hardcode it to the description — it is a general-purpose channel.
   * Treated as untrusted DATA by the judge (framed with delimiters, never as
   * operator instructions).
   */
  context?: string;
}
