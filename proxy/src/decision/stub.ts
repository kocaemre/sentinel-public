import type { DecisionContext, Verdict } from "@sentinel/shared";

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE DECISION SEAM                                                         │
 * │                                                                           │
 * │  `decide(ctx: DecisionContext) => Verdict` is the SINGLE function the     │
 * │  later phases replace — its signature is the fixed contract that lets     │
 * │  the policy engine and the LLM judge slot in BETWEEN parse and build      │
 * │  with NO changes to `forward.ts`:                                         │
 * │                                                                           │
 * │    • Phase 2 — deterministic policy engine (per-call cap, hourly/daily    │
 * │      budget, velocity, counterparty allow/deny, replay/overpayment).      │
 * │    • Phase 3 — LLM payment judge (allow/block/step-up + injection         │
 * │      detection). The judge can only TIGHTEN; the deterministic code veto  │
 * │      stays independent of the LLM.                                        │
 * │                                                                           │
 * │  Phase 1 (this stub) returns a hardcoded `allow` for any input so the     │
 * │  full intercept→parse→decide→build→retry→return loop runs end-to-end      │
 * │  with a stubbed signature. DO NOT add policy logic here — replace this    │
 * │  module wholesale in Phase 2 while keeping the same export + signature.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
export function decide(_ctx: DecisionContext): Verdict {
  return { decision: "allow" };
}
