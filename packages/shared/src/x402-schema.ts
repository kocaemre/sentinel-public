import { z } from "zod";

/**
 * Arc-permissive x402 `PaymentRequirements` schema (RESEARCH Pitfall 1 fix).
 *
 * This is a deliberate, hand-rolled mirror of the x402 package's
 * `PaymentRequirements` shape — with ONE intentional deviation: `network` is
 * `z.string()` instead of the SDK's closed `NetworkSchema` enum. The SDK enum
 * has NO `arc` / `arc-testnet` member, so validating an Arc 402 body with it
 * returns `success: false` and would fail-close a *legitimate* Arc payment
 * (the very chain this project targets).
 *
 * Do NOT import or validate with `PaymentRequirementsSchema` / `NetworkSchema`
 * from the `x402` package anywhere on the validate path. The x402 package is
 * used ONLY for its runtime base64 codec (`encodePayment`/`decodePayment`),
 * which is byte-compatible with real facilitators in Phase 4.
 *
 * Field shape mirrors RESEARCH §"x402 Protocol Surface" exactly so the wire
 * format stays x402-compatible. The per-payment `nonce` and `signature` live in
 * the payment *payload* (see `proxy/src/x402/build.ts`), not here.
 */
export const PaymentRequirementsSchema = z.object({
  scheme: z.literal("exact"),
  network: z.string(), // PERMISSIVE — accepts 'arc-testnet', unlike the SDK's closed enum (Pitfall 1)
  // FAIL-CLOSED (CR-01): the 402 body is attacker-controlled, so `maxAmountRequired`
  // must be a NON-NEGATIVE atomic-unit integer (decimal digits only). A bare
  // `z.string()` lets a hostile upstream send "-50000000" (negative — passes every
  // amount cap and CREDITS the wallet on settle) or "0x10" (valid hex BigInt literal).
  // Constraining to /^\d+$/ rejects both at the parse boundary; the caller fail-closes.
  maxAmountRequired: z
    .string()
    .regex(/^\d+$/, "maxAmountRequired must be a non-negative atomic integer (decimal digits only)"),
  resource: z.string(),
  description: z.string(),
  mimeType: z.string(),
  outputSchema: z.record(z.string(), z.any()).optional(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number(),
  asset: z.string(),
  extra: z.record(z.string(), z.any()).optional(),
});

/** The typed, Arc-permissive x402 payment requirements parsed from a 402 body. */
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

/**
 * Parse a held 402 body into typed `PaymentRequirements`, failing CLOSED on any
 * malformed input (D-09).
 *
 * - `JSON.parse` throws on non-JSON → the caller (`forward.ts`) fail-closes.
 * - The body may be the full `{ x402Version, accepts: [...] }` envelope or a
 *   bare requirements object; we tolerate both (`body.accepts ?? [body]`).
 * - Zod `safeParse` of the first requirement throws on a missing/invalid field
 *   → the caller fail-closes. The raw 402 is NEVER returned to the agent.
 */
export function parsePaymentRequired(rawBody: string): PaymentRequirements {
  const body = JSON.parse(rawBody) as { accepts?: unknown[] } & Record<string, unknown>;
  const accepts = Array.isArray(body.accepts) ? body.accepts : [body];
  const result = PaymentRequirementsSchema.safeParse(accepts[0]);
  if (!result.success) {
    throw new Error("malformed 402: " + result.error.message);
  }
  return result.data;
}
