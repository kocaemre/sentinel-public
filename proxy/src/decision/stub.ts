/**
 * Decision-seam entrypoint (the import path `forward.ts` depends on).
 *
 * Phase 1 shipped a hardcoded `allow` stub here. Phase 2 replaces the decision
 * logic wholesale in `./decide.ts` (the PRE → [judge slot] → POST deterministic
 * gate) and this module now simply RE-EXPORTS it, so `forward.ts`'s
 * `import { decide } from "./decision/stub.js"` keeps resolving unchanged (the
 * fixed seam contract — D-12, POLICY-05). `configureDecision` is re-exported so the
 * server can wire the resolved limits at boot.
 */
export { decide, configureDecision, tighten, getCommitStores } from "./decide.js";
