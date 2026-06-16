/**
 * Proxy-side entry point for parsing a held 402 body into typed, Arc-permissive
 * `PaymentRequirements`.
 *
 * The actual Zod schema + parse logic lives in `@sentinel/shared`
 * (`packages/shared/src/x402-schema.ts`) so Phases 2-4 reuse the exact same
 * Arc-permissive schema. This module is the thin entry point `forward.ts`
 * imports — keeping `forward.ts` decoupled from the shared package's internal
 * layout and giving the proxy a single named import site for the x402 parse.
 *
 * Fails CLOSED: `parsePaymentRequired` throws on malformed input (JSON or Zod
 * failure); the caller (`forward.ts`) catches and returns a fail-closed error,
 * never the raw 402 (D-05, D-09).
 */
export { parsePaymentRequired, type PaymentRequirements } from "@sentinel/shared";
