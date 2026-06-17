/**
 * The decision seam — PRE → [judge slot] → POST with a monotonic-tightening gate.
 *
 * This REPLACES the Phase 1 `decide()` stub body while preserving its export and
 * signature `(ctx: DecisionContext) => Verdict`, so `forward.ts` is untouched
 * (it imports `decide` from `./decision/stub.js`, which now re-exports from here).
 *
 * Shape (D-12, POLICY-05):
 *   1. PRE  : runControls(ctx) — deterministic gate. Short-circuit on a block.
 *   2. JUDGE: the Phase 3 LLM payment judge slot. In Phase 2 it is an identity
 *             passthrough (returns the PRE verdict unchanged). A test may inject a
 *             judge via `configureDecision({ judge })` to PROVE it cannot loosen.
 *   3. POST : runControls(ctx) AGAIN — the trust anchor. `tighten()` lets the POST
 *             pass only equal-or-tighten the (possibly judge-mutated) verdict, so a
 *             later/injected `allow` can NEVER loosen a deterministic block
 *             (SC#5 / POLICY-05 / threat T-02-06).
 *
 * CRITICAL (RESEARCH Pitfall 1): the engine runs in BOTH PRE and POST, so every
 * control MUST be pure/read-only here. Plan 02's controls are. Plan 03's stateful
 * controls must EVALUATE in this path but COMMIT (ledger/balance/dedup-mark) exactly
 * once OUTSIDE it (see controls.ts / engine.ts).
 */

import type { DecisionContext, Verdict } from "@sentinel/shared";
import { loadConfig } from "../config.js";
import { runControls, type DecisionLimits } from "../policy/engine.js";

/** Severity ordering: a higher number is STRICTER. `tighten()` keeps the stricter. */
const SEVERITY = { allow: 0, "step-up": 1, block: 2 } as const;

/**
 * The Phase 3 judge slot: `(ctx, pre) => Verdict`. Phase 2 defaults to an identity
 * passthrough (the judge cannot exist yet). Injectable via `configureDecision` so a
 * test can prove an adversarial `allow` cannot loosen the POST gate.
 */
type Judge = (ctx: DecisionContext, pre: Verdict) => Verdict;

/** Limits the seam needs, plus the optional injectable judge. */
interface DecisionConfig extends DecisionLimits {
  judge?: Judge;
}

const identityJudge: Judge = (_ctx, pre) => pre;

/**
 * Module-level resolved config. Initialized lazily from `loadConfig()` defaults so
 * unit tests can call `decide()` without explicit wiring; the server calls
 * `configureDecision(config)` once at boot to inject the real limits.
 */
let active: DecisionConfig | null = null;

function resolved(): DecisionConfig {
  if (active) return active;
  const cfg = loadConfig();
  active = {
    perCallCapAtomic: cfg.perCallCapAtomic,
    overpaymentMultiplier: cfg.overpaymentMultiplier,
    expectedPriceMap: cfg.expectedPriceMap,
  };
  return active;
}

/**
 * Wire the resolved limits (and optionally a judge) into the decision seam. The
 * server calls this once at boot with its `Config` (a structural superset of
 * `DecisionConfig`); tests call it with the minimal subset.
 */
export function configureDecision(config: DecisionConfig): void {
  active = {
    perCallCapAtomic: config.perCallCapAtomic,
    overpaymentMultiplier: config.overpaymentMultiplier,
    expectedPriceMap: config.expectedPriceMap,
    judge: config.judge,
  };
}

/** Return the equal-or-STRICTER of two verdicts; preserve the stricter one's metadata. */
export function tighten(a: Verdict, b: Verdict): Verdict {
  return SEVERITY[b.decision] > SEVERITY[a.decision] ? b : a;
}

/**
 * The single decision the proxy makes per held 402. PRE → [judge] → POST, monotonic.
 */
export function decide(ctx: DecisionContext): Verdict {
  const cfg = resolved();

  // 1. PRE: deterministic gate. A block here short-circuits — no judge, no spend.
  const pre = runControls(ctx, cfg);
  if (pre.decision === "block") return pre;

  // 2. JUDGE slot (Phase 3). Phase 2: identity passthrough. The judge is advisory
  //    and can be adversarial — the POST pass below is what actually enforces.
  const judge = cfg.judge ?? identityJudge;
  const judged = judge(ctx, pre);

  // 3. POST: re-run the deterministic controls; tighten() lets the verdict only
  //    equal-or-tighten, so an injected `allow` can never loosen a real block.
  const post = runControls(ctx, cfg);
  return tighten(judged, post);
}
