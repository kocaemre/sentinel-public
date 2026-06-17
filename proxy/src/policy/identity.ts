/**
 * Canonical HTTP-layer replay identity — the `paymentId` Plan 03's dedup keys on.
 *
 * WHY NOT the per-call X-PAYMENT nonce: Sentinel IS the x402 client (D-05). Its
 * `buildStubXPayment` (proxy/src/x402/build.ts) mints a FRESH 32-byte nonce per
 * proxied call. If the dedup key were that nonce, two identical agent requests
 * through the proxy would mint two distinct nonces and BOTH would be granted —
 * the replay control would be a no-op on the proxied path (threat T-02-17). So
 * the HTTP-layer replay key is derived instead from the STABLE, upstream-controlled
 * payment-defining fields that are present on `PaymentRequirements` and identical
 * across a logical retry: `resource`, `payTo`, `maxAmountRequired`, `asset`,
 * `network`. (POLICY-06's "nonce/expiry reuse" wording still holds for the future
 * real-facilitator path where an agent/facilitator-supplied nonce exists; the
 * HTTP-layer dedup SC#4 tests keys on `(paymentId, resourceId)` exactly — D-11.)
 *
 * EXCLUDED deliberately:
 *  - `description` / `mimeType` / `outputSchema` / `extra` — cosmetic/optional; an
 *    attacker varying them must NOT defeat dedup.
 *  - the X-PAYMENT `nonce` / computed `validBefore` — they do NOT exist on
 *    `PaymentRequirements` (they live in the per-call X-PAYMENT payload built in
 *    build.ts), so they are not eligible as a stable HTTP-layer key.
 *
 * Delimiter safety (RESEARCH Pitfall 3): a bare `join("|")` aliases field
 * boundaries — `{resource:"a", payTo:"b"}` would collide with
 * `{resource:"a|b", payTo:""}`. We length-prefix each field (`len:value`) so the
 * boundaries are unambiguous and no two distinct field tuples can ever alias.
 */

import type { PaymentRequirements } from "@sentinel/shared";

/** The five stable, upstream-controlled, payment-defining fields, in fixed order. */
function paymentDefiningFields(reqs: PaymentRequirements): string[] {
  return [reqs.resource, reqs.payTo, reqs.maxAmountRequired, reqs.asset, reqs.network];
}

/**
 * Canonical, delimiter-safe encoding of the upstream-402 payment-defining fields.
 * Two PaymentRequirements identical on those five fields produce the SAME string
 * (a logical retry collides); changing any one produces a different string.
 */
export function canonicalPaymentId(requirements: PaymentRequirements): string {
  // Length-prefixed join: each field emitted as `<byteLength>:<value>` so distinct
  // field boundaries can never alias regardless of the value's own characters.
  return paymentDefiningFields(requirements)
    .map((f) => `${Buffer.byteLength(f, "utf8")}:${f}`)
    .join("|");
}
