/**
 * Stable re-export seam for the stub settlement path (mirrors `decision/stub.ts`).
 *
 * The settlement adapter's stub branch builds the Phase 1-3 fake-signed X-PAYMENT via
 * `buildStubXPayment`. Re-exporting it from here keeps the adapter's import path fixed
 * even if `x402/build.ts` moves, exactly like `decision/stub.ts` re-exports `decide`
 * so `forward.ts` never re-imports (D-12 fixed-seam contract). NOTE this is the SOURCE
 * of `buildStubXPayment` for the adapter ONLY; `forward.ts` still imports it directly
 * from `../x402/build.js` for the stub-mode manual replay (unchanged Phase 1-3 path).
 */
export { buildStubXPayment } from "../x402/build.js";
