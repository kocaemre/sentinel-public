import { test } from "node:test";
import assert from "node:assert/strict";
import type { PayResult } from "@circle-fin/x402-batching/client";
import { makeSettlementAdapter } from "../src/settlement/adapter.js";
import {
  makeGatewayAdapter,
  SETTLE_FAILCLOSED,
  type GatewayClientLike,
  type CapLedger,
} from "../src/settlement/gateway.js";

/**
 * Network-free proof of the settlement seam (Plan 04-01, Task 2 — INTEG-01/02/03/04,
 * D-01/D-02). Mirrors `judge-adapter.test.ts`: the GatewayClient is injected as a fake
 * (via `deps.makeClient`) so the real↔stub selection, the empty-key fallback, the
 * fail-closed contract, the in-process cap backstop, and the key-never-logged posture
 * are ALL provable without touching the Arc testnet.
 *
 * Confirmed Task-1 field names wired here verbatim: chain "arcTestnet" (NEVER "arc"),
 * onBeforePaymentCreation reads ctx.selectedRequirements.amount, the settle signal is
 * the onPaymentResponse ctx.settleResponse.transaction (NOT pay() resolving).
 */

const CAPS = { perCallCapAtomic: 1_000_000n, hourlyBudgetAtomic: 5_000_000n };
const REAL_CFG = {
  settlementMode: "real" as const,
  walletPrivateKey: "0xabc123",
  arcChain: "arcTestnet",
  ...CAPS,
};
const TARGET = new URL("http://upstream.test/paid");

/** A scriptable fake GatewayClient: records the hooks, plays back a settle response. */
function fakeClient(opts: {
  settleResponse?: { success: boolean; transaction: string };
  payResult?: Partial<PayResult>;
  throwOnPay?: Error;
  /** The atomic amount the cap hook sees (string). Default under the 1 USDC per-call cap. */
  amount?: string;
}): { client: GatewayClientLike; capturedKey: string; sawAbort: () => boolean } {
  let before: ((ctx: { selectedRequirements: { amount: string } }) => Promise<unknown>) | undefined;
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
      // Run the cap hook exactly like the SDK does inside pay(): an abort throws.
      if (before) {
        const r = (await before({ selectedRequirements: { amount: opts.amount ?? "500000" } })) as
          | { abort: true; reason: string }
          | undefined;
        if (r && r.abort) {
          aborted = true;
          throw new Error(`Payment creation aborted: ${r.reason}`);
        }
      }
      if (opts.throwOnPay) throw opts.throwOnPay;
      if (onResp) await onResp({ settleResponse: opts.settleResponse });
      return {
        data: {},
        amount: 0n,
        formattedAmount: "0",
        transaction: opts.payResult?.transaction ?? "",
        status: 200,
        ...opts.payResult,
      } as PayResult;
    },
  };
  return { client, capturedKey: REAL_CFG.walletPrivateKey, sawAbort: () => aborted };
}

// ── adapter selection (D-01) ─────────────────────────────────────────────────

test("stub mode → stub outcome; never constructs a GatewayClient", async () => {
  let constructed = false;
  const adapter = makeSettlementAdapter(
    { ...REAL_CFG, settlementMode: "stub" },
    {
      makeClient() {
        constructed = true;
        return fakeClient({}).client;
      },
    },
  );
  const out = await adapter(TARGET);
  assert.equal(out.mode, "stub");
  assert.equal(out.settled, true, "a stub allow signals settled so the demo commit fires");
  assert.equal(out.txHash, undefined, "stub carries no real tx");
  assert.equal(constructed, false, "stub mode never builds a GatewayClient");
});

test("real mode with EMPTY key → falls back to stub, never throws, never fabricates a tx", async () => {
  let constructed = false;
  const adapter = makeSettlementAdapter(
    { ...REAL_CFG, walletPrivateKey: "" },
    {
      makeClient() {
        constructed = true;
        return fakeClient({}).client;
      },
    },
  );
  const out = await adapter(TARGET);
  assert.equal(out.mode, "stub", "empty real-mode key falls back to the stub path (D-01)");
  assert.equal(out.txHash, undefined);
  assert.equal(constructed, false, "no client built without a key");
});

test("real mode with a confirmed settle → settled:true with the onPaymentResponse txHash", async () => {
  const adapter = makeSettlementAdapter(REAL_CFG, {
    makeClient: () => fakeClient({ settleResponse: { success: true, transaction: "0xTXHASH" } }).client,
  });
  const out = await adapter(TARGET);
  assert.equal(out.mode, "real");
  assert.equal(out.settled, true);
  assert.equal(out.txHash, "0xTXHASH");
});

// ── fail-closed (INTEG-04 / T-04-04 / T-04-05) ───────────────────────────────

test("real mode where pay() throws → SETTLE_FAILCLOSED (settled:false, no tx)", async () => {
  const g = makeGatewayAdapter(REAL_CFG, {
    makeClient: () => fakeClient({ throwOnPay: new Error("network down") }).client,
  });
  const out = await g(TARGET);
  assert.deepEqual(out, SETTLE_FAILCLOSED);
  assert.equal(out.settled, false);
  assert.equal(out.txHash, undefined);
});

test("real mode where onPaymentResponse carries NO transaction → SETTLE_FAILCLOSED (never settled on pay() resolution alone)", async () => {
  // pay() resolves fine but the settle hook never fires a success+transaction.
  const g = makeGatewayAdapter(REAL_CFG, {
    makeClient: () => fakeClient({ settleResponse: undefined, payResult: { transaction: "0xLEAK" } }).client,
  });
  const out = await g(TARGET);
  assert.equal(out.settled, false, "pay() resolving is NOT a settle (RESEARCH Pitfall 2)");
  assert.equal(out.txHash, undefined, "never adopt PayResult.transaction without the hook signal");
});

test("a settle hook with success:false (no transaction adoption) → fail-closed", async () => {
  const g = makeGatewayAdapter(REAL_CFG, {
    makeClient: () => fakeClient({ settleResponse: { success: false, transaction: "0xNOPE" } }).client,
  });
  const out = await g(TARGET);
  assert.equal(out.settled, false);
});

// ── cap backstop (D-02 / INTEG-03) ───────────────────────────────────────────

test("onBeforePaymentCreation aborts an over-cap payment; reason names the in-process backstop (NOT on-chain)", async () => {
  // amount 2_000_000 > perCallCapAtomic 1_000_000 → abort.
  const fc = fakeClient({ amount: "2000000" });
  const g = makeGatewayAdapter(REAL_CFG, { makeClient: () => fc.client });
  const out = await g(TARGET);
  assert.equal(out.settled, false, "an aborted cap → fail-closed, no grant");
  assert.equal(fc.sawAbort(), true, "the cap hook aborted before signing");
});

test("cap hook uses the rolling-hour ledger budget (BigInt, never float)", async () => {
  // amount 2_000_000 is UNDER the 1_000_000 per-call cap? No — raise the per-call cap so
  // only the rolling budget can trip, proving the budget arm is wired.
  const ledger: CapLedger = { spentSince: () => 4_000_000n };
  const cfg = { ...REAL_CFG, perCallCapAtomic: 10_000_000n, hourlyBudgetAtomic: 5_000_000n };
  const fc = fakeClient({ amount: "2000000", settleResponse: { success: true, transaction: "0xOK" } });
  const g = makeGatewayAdapter(cfg, { makeClient: () => fc.client, ledger });
  // spent 4_000_000 + amount 2_000_000 = 6_000_000 > 5_000_000 budget → abort.
  const out = await g(TARGET);
  assert.equal(out.settled, false, "rolling-budget arm of the cap hook trips → fail-closed");
  assert.equal(fc.sawAbort(), true);
});

test("under both caps with a ledger → settles cleanly", async () => {
  const ledger: CapLedger = { spentSince: () => 0n };
  const cfg = { ...REAL_CFG, perCallCapAtomic: 10_000_000n, hourlyBudgetAtomic: 10_000_000n };
  const g = makeGatewayAdapter(cfg, {
    makeClient: () => fakeClient({ settleResponse: { success: true, transaction: "0xUNDER" } }).client,
    ledger,
  });
  const out = await g(TARGET);
  assert.equal(out.settled, true);
  assert.equal(out.txHash, "0xUNDER");
});

// ── CR-02: guarded amount parse at the money boundary ─────────────────────────
// The cap hook must parse ctx.selectedRequirements.amount through reqAmountAtomic
// (the /^\d+$/ fail-closed guard), NEVER a bare BigInt(). A malformed/negative/hex/
// whitespace amount must ABORT (fail-closed) — never be honored, never throw
// uncontrolled out of the hook (which would let pay() proceed or crash the request).

for (const bad of ["-50000000", "0x10", " 5 ", "1e3", "", "NaN", "5.0"]) {
  test(`CR-02: a malformed amount ${JSON.stringify(bad)} aborts fail-closed (never honored, never throws out of the hook)`, async () => {
    // Use generous caps so ONLY the guard (not the cap arm) can trip the abort.
    const cfg = { ...REAL_CFG, perCallCapAtomic: 1_000_000_000n, hourlyBudgetAtomic: 1_000_000_000n };
    const fc = fakeClient({ amount: bad });
    const g = makeGatewayAdapter(cfg, { makeClient: () => fc.client });
    const out = await g(TARGET);
    assert.equal(out.settled, false, "a malformed amount must fail closed (no grant)");
    assert.equal(out.txHash, undefined, "no tx on the malformed-amount path");
    assert.equal(fc.sawAbort(), true, "the guard aborted the hook before signing");
  });
}

test("CR-02: a well-formed under-cap amount still settles (no regression to the guard)", async () => {
  const fc = fakeClient({ amount: "500000", settleResponse: { success: true, transaction: "0xGOOD" } });
  const g = makeGatewayAdapter(REAL_CFG, { makeClient: () => fc.client });
  const out = await g(TARGET);
  assert.equal(out.settled, true);
  assert.equal(out.txHash, "0xGOOD");
  assert.equal(fc.sawAbort(), false, "a well-formed amount must not be aborted by the guard");
});

// ── secret hygiene (T-04-01) ─────────────────────────────────────────────────

test("the wallet private key NEVER appears in a logged string on the fail-closed path", async () => {
  const logs: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const g = makeGatewayAdapter(REAL_CFG, {
      makeClient: () => fakeClient({ throwOnPay: new Error("boom") }).client,
    });
    await g(TARGET);
  } finally {
    console.warn = orig;
  }
  assert.ok(logs.length > 0, "the fail-closed path logged a warning");
  for (const line of logs) {
    assert.equal(line.includes(REAL_CFG.walletPrivateKey), false, "the private key must never be logged");
  }
});

test("SETTLE_FAILCLOSED is settled:false and carries no tx", () => {
  assert.equal(SETTLE_FAILCLOSED.settled, false);
  assert.equal(SETTLE_FAILCLOSED.txHash, undefined);
});
