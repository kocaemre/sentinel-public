import { test } from "node:test";
import assert from "node:assert/strict";
import type { PayResult } from "@circle-fin/x402-batching/client";
import {
  makeGatewayAdapter,
  type GatewayClientLike,
  type DecidedRequirements,
} from "../src/settlement/gateway.js";
import { makeSettlementAdapter } from "../src/settlement/adapter.js";

/**
 * CR-01 — check-to-use binding (INTEG-04 / D-02a). `decide()` approves the FIRST 402
 * forward.ts fetched, but `GatewayClient.pay()` does its OWN independent 402→sign→settle
 * round-trip and could re-fetch a DIFFERENT 402 (higher-but-under-cap price, different
 * payTo, different asset/network). The cap hook alone only re-checks the STATIC per-call
 * cap — it does NOT bind the payment to what was decided. This suite proves the
 * onBeforePaymentCreation hook now ABORTS (fail-closed) whenever the paid requirements
 * diverge from the DECIDED requirements threaded in from forward.ts.
 *
 * Probed against node_modules/@circle-fin/x402-batching/dist/hooks-*.d.ts:
 *   HookPaymentRequirements = { scheme, network, asset, amount, payTo, maxTimeoutSeconds }
 * So selectedRequirements exposes amount + payTo + asset + network (bindable), but NOT
 * `resource` (resource lives on paymentRequired.resource.url, not selectedRequirements).
 */

const CAPS = { perCallCapAtomic: 1_000_000_000n, hourlyBudgetAtomic: 1_000_000_000n };
const REAL_CFG = {
  settlementMode: "real" as const,
  walletPrivateKey: "0xabc123",
  arcChain: "arcTestnet",
  ...CAPS,
};
const TARGET = new URL("http://upstream.test/paid");

/** The requirements decide() approved — what the on-chain payment must match. */
const DECIDED: DecidedRequirements = {
  amountAtomic: 50_000n,
  payTo: "0xRECIPIENT",
  asset: "0xUSDC",
  network: "arc-testnet",
};

/** What the SDK hook hands the cap hook (the 402 the GatewayClient actually re-fetched). */
interface PaidReq {
  amount: string;
  payTo: string;
  asset: string;
  network: string;
}
const MATCHING_PAID: PaidReq = {
  amount: "50000",
  payTo: "0xRECIPIENT",
  asset: "0xUSDC",
  network: "arc-testnet",
};

function fakeClient(opts: {
  paid: PaidReq;
  settleResponse?: { success: boolean; transaction: string };
}): { client: GatewayClientLike; sawAbort: () => boolean } {
  let before: ((ctx: { selectedRequirements: PaidReq }) => Promise<unknown>) | undefined;
  let onResp: ((ctx: { settleResponse?: { success: boolean; transaction: string } }) => Promise<unknown>) | undefined;
  let aborted = false;
  const client: GatewayClientLike = {
    onBeforePaymentCreation(hook) {
      before = hook as typeof before;
      return client;
    },
    onPaymentResponse(hook) {
      onResp = hook as typeof onResp;
      return client;
    },
    async pay(): Promise<PayResult> {
      if (before) {
        const r = (await before({ selectedRequirements: opts.paid })) as
          | { abort: true; reason: string }
          | undefined;
        if (r && r.abort) {
          aborted = true;
          throw new Error(`Payment creation aborted: ${r.reason}`);
        }
      }
      if (onResp) await onResp({ settleResponse: opts.settleResponse });
      return {
        data: {},
        amount: 0n,
        formattedAmount: "0",
        transaction: opts.settleResponse?.transaction ?? "",
        status: 200,
      } as PayResult;
    },
  };
  return { client, sawAbort: () => aborted };
}

// ── amount binding (the core CR-01 bypass) ───────────────────────────────────

test("CR-01: paid amount GREATER than decided → abort → fail-closed, no tx", async () => {
  // decided 50000, re-fetched 402 demands 5000000 (100x, but still under the static cap)
  const fc = fakeClient({
    paid: { ...MATCHING_PAID, amount: "5000000" },
    settleResponse: { success: true, transaction: "0xSHOULD_NOT_SETTLE" },
  });
  const g = makeGatewayAdapter(REAL_CFG, { makeClient: () => fc.client });
  const out = await g(TARGET, DECIDED);
  assert.equal(out.settled, false, "an over-decided amount must fail closed (no grant)");
  assert.equal(out.txHash, undefined);
  assert.equal(fc.sawAbort(), true, "the decision-binding assertion aborted before signing");
});

test("CR-01: paid amount EQUAL to decided settles (≤ decided is allowed)", async () => {
  const fc = fakeClient({ paid: MATCHING_PAID, settleResponse: { success: true, transaction: "0xOK" } });
  const g = makeGatewayAdapter(REAL_CFG, { makeClient: () => fc.client });
  const out = await g(TARGET, DECIDED);
  assert.equal(out.settled, true);
  assert.equal(out.txHash, "0xOK");
  assert.equal(fc.sawAbort(), false);
});

test("CR-01: paid amount LESS than decided settles (a cheaper 402 is not an attack)", async () => {
  const fc = fakeClient({
    paid: { ...MATCHING_PAID, amount: "10000" },
    settleResponse: { success: true, transaction: "0xCHEAP" },
  });
  const g = makeGatewayAdapter(REAL_CFG, { makeClient: () => fc.client });
  const out = await g(TARGET, DECIDED);
  assert.equal(out.settled, true);
  assert.equal(out.txHash, "0xCHEAP");
});

// ── payTo / asset / network binding (where the SDK ctx exposes them) ──────────

test("CR-01: paid payTo DIFFERENT from decided → abort → fail-closed (drain-to-attacker)", async () => {
  const fc = fakeClient({
    paid: { ...MATCHING_PAID, payTo: "0xATTACKER" },
    settleResponse: { success: true, transaction: "0xDRAIN" },
  });
  const g = makeGatewayAdapter(REAL_CFG, { makeClient: () => fc.client });
  const out = await g(TARGET, DECIDED);
  assert.equal(out.settled, false, "a redirected payTo must fail closed");
  assert.equal(fc.sawAbort(), true);
});

test("CR-01: paid asset DIFFERENT from decided → abort → fail-closed", async () => {
  const fc = fakeClient({
    paid: { ...MATCHING_PAID, asset: "0xRUGTOKEN" },
    settleResponse: { success: true, transaction: "0xRUG" },
  });
  const g = makeGatewayAdapter(REAL_CFG, { makeClient: () => fc.client });
  const out = await g(TARGET, DECIDED);
  assert.equal(out.settled, false);
  assert.equal(fc.sawAbort(), true);
});

test("CR-01: paid network DIFFERENT from decided → abort → fail-closed", async () => {
  const fc = fakeClient({
    paid: { ...MATCHING_PAID, network: "ethereum" },
    settleResponse: { success: true, transaction: "0xWRONGNET" },
  });
  const g = makeGatewayAdapter(REAL_CFG, { makeClient: () => fc.client });
  const out = await g(TARGET, DECIDED);
  assert.equal(out.settled, false);
  assert.equal(fc.sawAbort(), true);
});

test("CR-01: a fully MATCHING paid 402 settles normally (no false-positive abort)", async () => {
  const fc = fakeClient({ paid: MATCHING_PAID, settleResponse: { success: true, transaction: "0xMATCH" } });
  const g = makeGatewayAdapter(REAL_CFG, { makeClient: () => fc.client });
  const out = await g(TARGET, DECIDED);
  assert.equal(out.settled, true);
  assert.equal(out.txHash, "0xMATCH");
  assert.equal(fc.sawAbort(), false);
});

// ── seam: the adapter forwards `decided` to the gateway ──────────────────────

test("CR-01: makeSettlementAdapter forwards decided to the gateway; mismatch fails closed end-to-end", async () => {
  const fc = fakeClient({
    paid: { ...MATCHING_PAID, payTo: "0xATTACKER" },
    settleResponse: { success: true, transaction: "0xNOPE" },
  });
  const adapter = makeSettlementAdapter(REAL_CFG, { makeClient: () => fc.client });
  const out = await adapter(TARGET, DECIDED);
  assert.equal(out.mode, "real");
  assert.equal(out.settled, false, "the binding mismatch propagated through the adapter seam");
  assert.equal(out.txHash, undefined);
});

test("CR-01: stub mode ignores decided and preserves its exact current behavior", async () => {
  const adapter = makeSettlementAdapter({ ...REAL_CFG, settlementMode: "stub" }, {});
  const out = await adapter(TARGET, DECIDED);
  assert.equal(out.mode, "stub");
  assert.equal(out.settled, true, "stub allow still signals settled (D-01 unchanged)");
  assert.equal(out.txHash, undefined);
});
