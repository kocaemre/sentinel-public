import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMockUpstream } from "../../attack-server/src/server.js";
import { openWallet } from "@sentinel/shared";
import { payDirect } from "../../reference-agent/src/agent.js";

/**
 * DEMO-02 drain proof (Plan 02-01, Task 3) — the exploit BEFORE any defense.
 *
 * In --no-sentinel mode the agent is its OWN x402 client: it self-builds and sends
 * the X-PAYMENT against the malicious /paid-overpriced (50 USDC) 402 and decrements
 * the SHARED simulated wallet. The proxy is provably out of the loop — this test
 * NEVER imports or starts `buildServer`. Two settlements drain a 100 USDC wallet to
 * exactly 0n, the third drives it negative (drain past zero, D-04). This is the
 * unprotected baseline Plan 02's deterministic gate will later preserve (SC#2, D-05).
 */

let mock: FastifyInstance & { hits?: Record<string, number> };
let mockPort: number;
let tmpDir: string;
let dbPath: string;

before(async () => {
  // Boot ONLY the attack-server — no proxy is ever constructed (proxy out of loop).
  mock = buildMockUpstream();
  await mock.listen({ port: 0, host: "127.0.0.1" });
  mockPort = (mock.server.address() as AddressInfo).port;

  // A temp-file shared wallet so it behaves like the two-process shared store.
  tmpDir = mkdtempSync(join(tmpdir(), "sentinel-drain-"));
  dbPath = join(tmpDir, "wallet.db");
});

after(async () => {
  await mock?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("--no-sentinel bypass drains the shared wallet to <= 0 with the proxy out of the loop (DEMO-02)", async () => {
  const wallet = openWallet(dbPath);
  wallet.resetBalance(100_000_000n); // 100 USDC atomic — the demo starting point
  assert.equal(wallet.getBalanceAtomic(), 100_000_000n);

  const overpriced = `http://127.0.0.1:${mockPort}/paid-overpriced`;

  // First malicious 50 USDC settlement → 100 - 50 = 50 USDC.
  const paid1 = await payDirect(overpriced, wallet);
  assert.equal(paid1, 50_000_000n, "the malicious 402 demanded 50 USDC atomic");
  assert.equal(wallet.getBalanceAtomic(), 50_000_000n);

  // Second malicious 50 USDC settlement → exactly 0n (BigInt, no float drift).
  await payDirect(overpriced, wallet);
  assert.equal(wallet.getBalanceAtomic(), 0n, "two 50 USDC drains land exactly on 0n");

  // DRAINED: balance <= 0 per D-04.
  assert.ok(wallet.getBalanceAtomic() <= 0n, "the wallet is drained (balance <= 0)");

  // The attack-server was hit for each bypass payment: 402 then X-PAYMENT→200 ×2 = 4 hits.
  assert.equal(
    mock.hits?.["/paid-overpriced"],
    4,
    "attack-server hit 4× (402 + X-PAYMENT→200, twice) — the agent self-paid it directly",
  );
});

test("a third bypass settlement drives the drained wallet negative (drain past zero, D-04)", async () => {
  const overpriced = `http://127.0.0.1:${mockPort}/paid-overpriced`;
  // Continues from the previous test's 0n balance on the same shared db file.
  const wallet = openWallet(dbPath);
  assert.equal(wallet.getBalanceAtomic(), 0n);
  await payDirect(overpriced, wallet);
  assert.equal(wallet.getBalanceAtomic(), -50_000_000n, "balance goes negative past zero");
});
