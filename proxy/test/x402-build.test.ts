import { test } from "node:test";
import assert from "node:assert/strict";
import { safeBase64Decode } from "x402/shared";
import { buildStubXPayment } from "../src/x402/build.js";
import type { PaymentRequirements } from "@sentinel/shared";

// x402@1.2.0's decodePayment rejects any network not in its closed enum (Arc is
// not in it — the codec-side Pitfall 1). We decode with the package's own
// safeBase64Decode (the exact base64 step decodePayment runs) + JSON.parse so the
// round-trip is verified byte-for-byte against the same primitive, without the
// network gate. See proxy/src/x402/build.ts for the matching encode-side note.
type DecodedPayload = {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: { from: string; to: string; value: string; validBefore: string; nonce: string };
  };
};
function decodePaymentArcSafe(header: string): DecodedPayload {
  return JSON.parse(safeBase64Decode(header)) as DecodedPayload;
}

const ARC_REQS: PaymentRequirements = {
  scheme: "exact",
  network: "arc-testnet",
  maxAmountRequired: "1000",
  resource: "https://upstream/paid",
  description: "demo",
  mimeType: "application/json",
  payTo: "0xPayee",
  maxTimeoutSeconds: 60,
  asset: "0xUSDC",
};

const STUB_SIG = "0x" + "00".repeat(65);

test("buildStubXPayment: returns a non-empty base64 string", () => {
  const header = buildStubXPayment(ARC_REQS);
  assert.equal(typeof header, "string");
  assert.ok(header.length > 0);
  assert.match(header, /^[A-Za-z0-9+/=]+$/);
});

test("buildStubXPayment: round-trips via the x402 base64 codec with the right field mapping (Arc verbatim)", () => {
  const decoded = decodePaymentArcSafe(buildStubXPayment(ARC_REQS));
  assert.equal(decoded.network, "arc-testnet"); // Arc passes through verbatim
  assert.equal(decoded.payload.authorization.to, ARC_REQS.payTo);
  assert.equal(decoded.payload.authorization.value, ARC_REQS.maxAmountRequired);
  assert.equal(decoded.payload.signature, STUB_SIG); // 65-byte zero stub
  // nonce is a 0x-prefixed 32-byte hex string (64 hex chars)
  assert.match(decoded.payload.authorization.nonce, /^0x[0-9a-f]{64}$/);
});

test("buildStubXPayment: validBefore ~= now + maxTimeoutSeconds", () => {
  const before = Math.floor(Date.now() / 1000);
  const decoded = decodePaymentArcSafe(buildStubXPayment(ARC_REQS));
  const after = Math.floor(Date.now() / 1000);
  const validBefore = Number(decoded.payload.authorization.validBefore);
  assert.ok(validBefore >= before + ARC_REQS.maxTimeoutSeconds);
  assert.ok(validBefore <= after + ARC_REQS.maxTimeoutSeconds + 2);
});

test("buildStubXPayment: two successive calls produce distinct nonces (fresh per-payment replay key)", () => {
  const read = (h: string) => decodePaymentArcSafe(h).payload.authorization.nonce;
  const a = read(buildStubXPayment(ARC_REQS));
  const b = read(buildStubXPayment(ARC_REQS));
  assert.notEqual(a, b);
});
