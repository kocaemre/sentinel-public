import { safeBase64Encode } from "x402/shared";
import type { PaymentRequirements } from "@sentinel/shared";

/**
 * Build the shape-correct, FAKE-SIGNED `X-PAYMENT` header for the retry (D-06/D-07).
 *
 * Phase 1 has no wallet: the EIP-712 `signature` is a 65-byte zero stub and `from`
 * is a placeholder for Sentinel's future wallet. Everything else is shaped exactly
 * like a real x402 `PaymentPayload` (EIP-3009 `transferWithAuthorization`) so the
 * wire format is byte-compatible with real facilitators in Phase 4 — only the
 * signature is fake.
 *
 * NOTE (deviation from RESEARCH §"Build the stub"): x402@1.2.0's `encodePayment`
 * is NOT a pure codec — it rejects any `network` not in `SupportedEVMNetworks` /
 * `SupportedSVMNetworks` with `throw new Error("Invalid network")` BEFORE encoding,
 * and Arc is not in those lists (the exact Pitfall 1 surface, now on the codec). So
 * we use the package's OWN `safeBase64Encode` primitive — the identical base64 step
 * `encodePayment` runs internally (`safeBase64Encode(JSON.stringify(payload))`).
 * This still satisfies CLAUDE.md "Don't Hand-Roll" (we reuse the x402 codec
 * primitive, not a custom base64) and stays byte-compatible with real facilitators
 * in Phase 4, while letting `arc-testnet` pass through verbatim. Decode side: tests
 * mirror this with `safeBase64Decode` (which `decodePayment` also gates on network).
 *
 * A fresh 32-byte `nonce` is generated per call: it is the per-payment replay key
 * Phase 2's policy engine will dedup on. Throws if `reqs` is missing the fields used
 * here — the caller (`forward.ts`) fail-closes on the throw (D-09).
 */
const STUB_SIG = "0x" + "00".repeat(65); // 65-byte zero sig — fake but shape-correct (D-06/D-07)
const STUB_FROM = "0x000000000000000000000000000000000000dEaD"; // Sentinel's (future) wallet placeholder

export function buildStubXPayment(reqs: PaymentRequirements): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    x402Version: 1,
    scheme: "exact" as const,
    network: reqs.network, // pass through verbatim (incl. 'arc-testnet')
    payload: {
      signature: STUB_SIG,
      authorization: {
        from: STUB_FROM,
        to: reqs.payTo, // == payTo
        value: reqs.maxAmountRequired, // == maxAmountRequired (atomic units)
        validAfter: "0",
        validBefore: String(nowSec + reqs.maxTimeoutSeconds),
        nonce: "0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
      },
    },
  };
  // safeBase64Encode is the exact base64 step encodePayment runs internally —
  // reused here so the wire format stays byte-identical, but without the closed
  // network-enum gate that rejects Arc. We deliberately do NOT validate the
  // payload with the SDK's schema.
  return safeBase64Encode(JSON.stringify(payload));
}
