import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PayResult } from "@circle-fin/x402-batching/client";
import {
  makeGatewayAdapter,
  SETTLE_FAILCLOSED,
  type GatewayClientLike,
  type CapLedger,
  type DecidedRequirements,
} from "../src/settlement/gateway.js";
import { openLedger } from "../src/policy/ledger.js";
import { openDedup } from "../src/policy/dedup.js";
import { openWallet } from "@sentinel/shared";
// Smoke-import the reference-agent real-drain entrypoint to prove it exists + typechecks
// across the workspace (the genuine testnet drain is run manually with a funded EOA).
import { payDirectReal } from "../../reference-agent/src/agent.js";

/**
 * SC#1 real-drain slice proof (Plan 04-01, Task 3) — the cap-bypass and INTEG-04 settle
 * gate behaviors, ALL network-free (no real testnet required, runs in stub/CI mode).
 *
 * The `--no-sentinel` REAL drain itself (reference-agent `payDirectReal`) genuinely
 * moves testnet USDC and is exercised manually end-of-phase with a funded EOA; here we
 * PROVE the deterministic backstop that makes the PROTECTED path safe:
 *
 *   1. A cap-EXCEEDING payment is rejected by the IN-PROCESS DETERMINISTIC cap layer
 *      (onBeforePaymentCreation), with a reason naming the in-process backstop —
 *      provably NOT the LLM and NOT an on-chain policy (D-02a, "survives a compromised
 *      proxy"). The bypass agent has NO cap hook at all; the cap lives in the proxy.
 *   2. An unconfirmed settle (settled:false / no tx) → fail-closed: NO ledger record,
 *      NO wallet debit, NO dedup mark, NO fabricated grant (INTEG-04).
 *   3. A confirmed settle (settled:true + txHash) → the commit-once stores fire EXACTLY
 *      once, and a replay of the SETTLED payment is still blocked (POLICY-06 preserved).
 */

const CAPS = { perCallCapAtomic: 1_000_000n, hourlyBudgetAtomic: 5_000_000n };
const REAL_CFG = { arcChain: "arcTestnet", walletPrivateKey: "0xkey", ...CAPS };
const TARGET = new URL("http://127.0.0.1/paid-overpriced");

/**
 * CR-01: the decided requirements threaded into the gateway. These cases predate the
 * decision-binding and only exercise the cap / settle-gate arms, so `decided` is set to
 * the SAME amount the fake 402 pays (binding is a no-op here — the cap/settle behavior is
 * unchanged). The amount is per-test so a higher-priced over-cap case still trips the CAP
 * arm (its intended cause), not the binding arm.
 */
const decidedFor = (amountAtomic: bigint): DecidedRequirements => ({ amountAtomic });

/** A scriptable fake GatewayClient (no network). */
function fakeClient(opts: {
  amount: string;
  settleResponse?: { success: boolean; transaction: string };
}): GatewayClientLike {
  let before: ((ctx: { selectedRequirements: { amount: string } }) => Promise<unknown>) | undefined;
  let onResp: ((ctx: { settleResponse?: { success: boolean; transaction: string } }) => Promise<unknown>) | undefined;
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
        const r = (await before({ selectedRequirements: { amount: opts.amount } })) as
          | { abort: true; reason: string }
          | undefined;
        if (r && r.abort) throw new Error(`Payment creation aborted: ${r.reason}`);
      }
      if (onResp) await onResp({ settleResponse: opts.settleResponse });
      return {
        data: {},
        amount: BigInt(opts.amount),
        formattedAmount: "0",
        transaction: opts.settleResponse?.transaction ?? "",
        status: 200,
      } as PayResult;
    },
  };
  return client;
}

test("payDirectReal is exported (the --no-sentinel real-drain entrypoint exists)", () => {
  assert.equal(typeof payDirectReal, "function");
});

// ── 1. cap-bypass rejection originates from the deterministic layer (D-02a) ──

test("a cap-EXCEEDING payment is rejected by the in-process deterministic cap layer (NOT the LLM, NOT on-chain)", async () => {
  // The malicious 50 USDC (50_000_000) >> the 1 USDC per-call cap.
  const ledger: CapLedger = { spentSince: () => 0n };
  const g = makeGatewayAdapter(REAL_CFG, {
    makeClient: () => fakeClient({ amount: "50000000" }),
    ledger,
  });
  const logs: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  let out;
  try {
    // decided amount == paid amount → the CAP arm (not the binding arm) is the trip cause.
    out = await g(TARGET, decidedFor(50_000_000n));
  } finally {
    console.warn = orig;
  }
  const reason = logs.join("\n");
  assert.deepEqual(out, SETTLE_FAILCLOSED, "over-cap → fail-closed, no grant");
  // The rejection reason names the IN-PROCESS BACKSTOP — not the LLM, not Circle/on-chain.
  assert.ok(reason.includes("exceeds Sentinel cap (in-process backstop)"), "reason names the in-process cap layer");
  assert.equal(/llm|judge|model/i.test(reason), false, "rejection is NOT from the LLM");
  assert.equal(/on-chain|onchain|immutable/i.test(reason), false, "rejection is NOT labeled on-chain");
});

// ── 2. unconfirmed settle → fail-closed, no commit (INTEG-04) ────────────────

test("settled:false (unconfirmed settle) commits NOTHING — no ledger, no wallet debit, no dedup mark", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "drain-real-"));
  const dbPath = join(tmp, "w.db");
  try {
    const ledger = openLedger(dbPath);
    const dedup = openDedup(dbPath);
    const wallet = openWallet(dbPath);
    wallet.resetBalance(100_000_000n);

    // No settleResponse → the adapter returns settled:false.
    const g = makeGatewayAdapter(REAL_CFG, {
      makeClient: () => fakeClient({ amount: "500000", settleResponse: undefined }),
      ledger: { spentSince: () => 0n },
    });
    const out = await g(TARGET, decidedFor(500_000n));
    assert.equal(out.settled, false, "unconfirmed settle → fail-closed");

    // Simulate forward.ts's gate: commit ONLY when settled && txHash. It must NOT fire.
    if (out.settled && out.txHash) {
      dedup.markFirstSeen("pid", "rid");
      ledger.recordSettlement(500_000n);
      wallet.settle(500_000n);
    }
    assert.equal(ledger.spentSince(3_600_000), 0n, "no ledger record on unconfirmed settle");
    assert.equal(wallet.getBalanceAtomic(), 100_000_000n, "no wallet debit on unconfirmed settle");
    assert.equal(dedup.wasSeen("pid", "rid"), false, "no dedup mark on unconfirmed settle");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 3. confirmed settle → commit once; replay still blocked (POLICY-06) ──────

test("settled:true + txHash commits exactly once; a replay of the settled payment is still blocked", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "drain-real-ok-"));
  const dbPath = join(tmp, "w.db");
  try {
    const ledger = openLedger(dbPath);
    const dedup = openDedup(dbPath);
    const wallet = openWallet(dbPath);
    wallet.resetBalance(100_000_000n);

    const g = makeGatewayAdapter(REAL_CFG, {
      makeClient: () =>
        fakeClient({ amount: "500000", settleResponse: { success: true, transaction: "0xCONFIRMED" } }),
      ledger: { spentSince: () => 0n },
    });
    const out = await g(TARGET, decidedFor(500_000n));
    assert.equal(out.settled, true);
    assert.equal(out.txHash, "0xCONFIRMED");

    // forward.ts commit gate fires once.
    assert.equal(out.settled && Boolean(out.txHash), true);
    const firstSeen = dedup.markFirstSeen("pid", "rid");
    ledger.recordSettlement(500_000n);
    wallet.settle(500_000n);
    assert.equal(firstSeen, true, "first settlement marks first-seen");
    assert.equal(ledger.spentSince(3_600_000), 500_000n, "ledger recorded exactly the settled amount");
    assert.equal(wallet.getBalanceAtomic(), 99_500_000n, "wallet debited exactly once");

    // A replay of the SAME settled payment is still blocked (POLICY-06): markFirstSeen
    // returns false the second time, so the commit must not double-fire.
    const replaySeen = dedup.markFirstSeen("pid", "rid");
    assert.equal(replaySeen, false, "a replay of the settled payment is blocked");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
