/**
 * Config-swappable settlement selector (D-01, INTEG-01/02) — the `makeOpenRouterJudge`
 * pattern applied to payment settlement. A factory takes a `Pick<Config, ...>`, closes
 * over a lazily-constructed gateway adapter, returns an async function, and selects
 * real↔stub by `settlementMode` exactly as the judge selects models by `judgeModel`.
 *
 * The settlement seam is "blockchain-last": the PRE→[judge]→POST decision seam is
 * UNTOUCHED. On the `allow` branch forward.ts calls this adapter instead of inlining
 * steps 4-6. Selection:
 *   - settlementMode === "stub"                       → STUB: signal forward.ts to run
 *     OR (settlementMode === "real" && empty key)       the exact Phase 1-3
 *                                                        buildStubXPayment + manual
 *                                                        replay (D-01 fallback). Never
 *                                                        constructs a GatewayClient.
 *   - settlementMode === "real" && key present        → REAL: delegate to the
 *                                                        GatewayClient adapter, which
 *                                                        does its OWN 402→sign→settle
 *                                                        and gates on the settle signal.
 *
 * Fail-closed everywhere: a real-mode throw / unconfirmed settle → `SETTLE_FAILCLOSED`
 * (`{ settled: false }`), NEVER a fabricated tx. The private key is NEVER logged.
 */

import type { Config } from "../config.js";
import {
  makeGatewayAdapter,
  SETTLE_FAILCLOSED,
  type GatewayDeps,
  type SettlementResult,
} from "./gateway.js";

export { SETTLE_FAILCLOSED, type SettlementResult } from "./gateway.js";

/**
 * The settlement outcome handed back to forward.ts. The `mode` discriminates which
 * replay path forward.ts runs:
 *   - "stub": forward.ts performs the EXACT Phase 1-3 buildStubXPayment + manual
 *     X-PAYMENT replay (preserving Cache-Control: no-store, single-use body, every
 *     fail-closed branch). `settled` rides true on a stub allow so the commit-once
 *     block fires for the demo's simulated wallet/ledger.
 *   - "real": the GatewayClient already did the full round-trip. `settled`/`txHash`
 *     ARE the confirmed on-chain signal — forward.ts SKIPS the manual replay and gates
 *     the commit on `settled && txHash`.
 */
export interface SettlementOutcome extends SettlementResult {
  mode: "stub" | "real";
}

/** Dependencies the adapter forwards to the gateway adapter (the budget ledger). */
export type SettlementDeps = GatewayDeps;

/**
 * The settlement adapter signature forward.ts injects. `target` is the upstream URL the
 * payment settles against. `_ctx` is reserved for future per-decision routing (the stub
 * path needs no ctx today — forward.ts already holds the parsed requirements).
 */
export type SettlementAdapter = (target: URL) => Promise<SettlementOutcome>;

/** A stub settle never carries a real tx; the txHash is minted by buildStubXPayment in forward.ts. */
const STUB_OUTCOME: SettlementOutcome = { mode: "stub", settled: true };

/**
 * Construct the settlement adapter from resolved config. Mirrors `makeOpenRouterJudge`:
 * lazy gateway adapter, config-flag selection, fail-closed.
 */
export function makeSettlementAdapter(
  config: Pick<
    Config,
    "settlementMode" | "walletPrivateKey" | "arcChain" | "perCallCapAtomic" | "hourlyBudgetAtomic"
  >,
  deps: SettlementDeps = {},
): SettlementAdapter {
  // Lazily build the real adapter only when first needed AND a key is present.
  let gateway: ReturnType<typeof makeGatewayAdapter> | null = null;

  // Stub when explicitly stub OR real-but-keyless (D-01 fallback: faucet/SDK flake still
  // records the demo via the Phase 1-3 path; never fabricate a real tx).
  const useStub = config.settlementMode === "stub" || !config.walletPrivateKey;

  return async (target: URL): Promise<SettlementOutcome> => {
    if (useStub) return STUB_OUTCOME;

    if (!gateway) gateway = makeGatewayAdapter(config, deps);
    const result = await gateway(target);
    return { mode: "real", settled: result.settled, txHash: result.txHash };
  };
}
