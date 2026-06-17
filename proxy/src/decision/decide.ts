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
import { openWallet, type Wallet } from "@sentinel/shared";
import { loadConfig } from "../config.js";
import { runControls, type DecisionLimits } from "../policy/engine.js";
import { openLedger, type Ledger } from "../policy/ledger.js";
import { openDedup, type Dedup } from "../policy/dedup.js";

/** Severity ordering: a higher number is STRICTER. `tighten()` keeps the stricter. */
const SEVERITY = { allow: 0, "step-up": 1, block: 2 } as const;

/**
 * The Phase 3 judge slot: `(ctx, pre) => Verdict`. Phase 2 defaults to an identity
 * passthrough (the judge cannot exist yet). Injectable via `configureDecision` so a
 * test can prove an adversarial `allow` cannot loosen the POST gate.
 */
type Judge = (ctx: DecisionContext, pre: Verdict) => Verdict;

/**
 * Limits the seam needs, plus the optional injectable judge and the SQLite db path.
 * The server passes its full `Config` (a structural superset); `configureDecision`
 * opens the ledger/dedup/wallet stores once from `dbPath`. `dbPath` is optional so
 * the pure unit tests (limits-only) still configure without touching SQLite.
 */
interface DecisionConfig extends DecisionLimits {
  judge?: Judge;
  /** Shared SQLite path for the ledger/dedup/wallet stores (Plan 03). */
  dbPath?: string;
  /** Wallet starting balance in atomic units, reset once at boot (Plan 01/03). */
  startingBalanceAtomic?: bigint;
}

const identityJudge: Judge = (_ctx, pre) => pre;

/**
 * The post-settlement commit handles forward.ts needs (RESEARCH Pitfall 2): the
 * ledger (record the confirmed settlement) and the wallet (debit the balance). Both
 * are opened once at boot in `configureDecision`. Absent until configured with a
 * `dbPath` (the unit tests don't go through forward.ts).
 */
interface CommitStores {
  ledger: Ledger;
  wallet: Wallet;
}
let commitStores: CommitStores | null = null;

/** Forward.ts reads this to commit the settlement ONCE after the upstream 200. */
export function getCommitStores(): CommitStores | null {
  return commitStores;
}

/**
 * Module-level resolved config. Initialized lazily from `loadConfig()` defaults so
 * unit tests can call `decide()` without explicit wiring; the server calls
 * `configureDecision(config)` once at boot to inject the real limits.
 */
let active: DecisionConfig | null = null;

function resolved(): DecisionConfig {
  if (active) return active;
  // Lazily configure from env defaults so unit tests run unwired. This path opens
  // NO stores (cap/overpayment only) — the stateful controls stay skipped until the
  // server calls configureDecision() with a dbPath.
  const cfg = loadConfig();
  active = {
    perCallCapAtomic: cfg.perCallCapAtomic,
    overpaymentMultiplier: cfg.overpaymentMultiplier,
    expectedPriceMap: cfg.expectedPriceMap,
  };
  return active;
}

/**
 * Wire the resolved limits (and optionally a judge) into the decision seam, opening
 * the ledger/dedup/wallet stores ONCE from `config.dbPath`. The server calls this
 * once at boot with its full `Config` (a structural superset of `DecisionConfig`);
 * the pure unit tests call it with the limits-only subset (no `dbPath` → no stores,
 * so the stateful controls are skipped and the seam stays pure).
 */
export function configureDecision(config: DecisionConfig): void {
  let ledger: Ledger | undefined;
  let dedup: Dedup | undefined;
  if (config.dbPath) {
    ledger = openLedger(config.dbPath);
    dedup = openDedup(config.dbPath);
    const wallet = openWallet(config.dbPath);
    // Reset the simulated balance to the demo starting point once at boot so the
    // protected-balance contrast is deterministic across runs (Plan 01 invariant).
    if (config.startingBalanceAtomic !== undefined) {
      wallet.resetBalance(config.startingBalanceAtomic);
    }
    commitStores = { ledger, wallet };
  } else {
    commitStores = null;
  }

  active = {
    perCallCapAtomic: config.perCallCapAtomic,
    overpaymentMultiplier: config.overpaymentMultiplier,
    expectedPriceMap: config.expectedPriceMap,
    denySet: config.denySet,
    hourlyBudgetAtomic: config.hourlyBudgetAtomic,
    dailyBudgetAtomic: config.dailyBudgetAtomic,
    velocityLimit: config.velocityLimit,
    velocityWindowMs: config.velocityWindowMs,
    ledger,
    dedup,
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
  const verdict = tighten(judged, post);

  // 4. COMMIT-once for replay (RESEARCH Pitfall 1): only on the ALLOW path, exactly
  //    once, do we mark the canonical (paymentId, resourceId) first-seen. The PRE/POST
  //    evaluate above used the read-only `wasSeen`. If `markFirstSeen` returns false a
  //    concurrent request won the first-seen race between our POST and this insert —
  //    block as a replay (belt-and-suspenders for the TOCTOU window, threat T-02-14).
  if (verdict.decision === "allow" && cfg.dedup) {
    const firstSeen = cfg.dedup.markFirstSeen(ctx.paymentId, ctx.resourceId);
    if (!firstSeen) {
      return {
        decision: "block",
        control: "replay",
        protectedAmountAtomic: ctx.amountAtomic.toString(),
        reasons: [
          "replay: a concurrent request already claimed first-seen for this canonical " +
            `(paymentId, resourceId) for resource ${ctx.resourceId} — duplicate blocked`,
        ],
      };
    }
  }

  return verdict;
}
