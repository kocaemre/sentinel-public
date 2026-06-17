import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.js";
import { type Config } from "../src/config.js";
import { makeTestConfig } from "./helpers/config.js";
import { buildMockUpstream } from "../../attack-server/src/server.js";
import { openWallet } from "@sentinel/shared";

/**
 * CR-01 regression: a hostile upstream 402 carries an attacker-controlled
 * `maxAmountRequired`. A NEGATIVE ("-50000000") or NON-DECIMAL ("0x10") atomic
 * amount must be rejected at the parse boundary (fail-closed) so it NEVER passes
 * the per-call cap / overpayment / budget controls and NEVER reaches
 * wallet.settle() (where a negative amount would CREDIT the simulated balance).
 *
 * The 402 build path already fail-closes a parse failure with a controlled 502
 * shape, so the agent sees a fail-closed error, the wallet balance is unchanged,
 * and the upstream is hit exactly once (the 402 only — no X-PAYMENT pay).
 */

let mock: FastifyInstance & { hits?: Record<string, number> };
let proxy: FastifyInstance;
let mockPort: number;
let proxyPort: number;
let tmpDir: string;
let walletPath: string;
const START_BALANCE = 100_000_000n; // 100 USDC

before(async () => {
  mock = buildMockUpstream();
  await mock.listen({ port: 0, host: "127.0.0.1" });
  mockPort = (mock.server.address() as AddressInfo).port;

  tmpDir = mkdtempSync(join(tmpdir(), "sentinel-amount-bypass-"));
  walletPath = join(tmpDir, "wallet.db");

  const config: Config = makeTestConfig({
    allowlist: [`127.0.0.1:${mockPort}`],
    dbPath: walletPath, // a real file so we can re-open the wallet row and assert it
    startingBalanceAtomic: START_BALANCE,
  });
  proxy = buildServer(config);
  await proxy.listen({ port: 0, host: "127.0.0.1" });
  proxyPort = (proxy.server.address() as AddressInfo).port;
});

after(async () => {
  await proxy?.close();
  await mock?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const through = (path: string) =>
  `http://127.0.0.1:${proxyPort}/http://127.0.0.1:${mockPort}${path}`;

test("hostile 402 with a NEGATIVE maxAmountRequired is rejected fail-closed (no credit, no settle)", async () => {
  const res = await fetch(through("/paid-negative"));

  // Fail-closed: the proxy returns the controlled 502 shape, never the raw 402 and
  // never a fabricated paid 200.
  assert.equal(res.status, 502, "a negative atomic amount must fail closed, not pay");
  const body = (await res.json()) as { error: string; reason: string };
  assert.equal(body.error, "payment blocked (fail-closed)");

  // No X-PAYMENT retry: the upstream saw the 402 ONCE and was never re-hit to settle.
  assert.equal(mock.hits?.["/paid-negative"], 1, "no X-PAYMENT pay after a fail-closed parse");

  // The wallet balance is UNCHANGED — a negative settle would have CREDITED it.
  const wallet = openWallet(walletPath);
  assert.equal(
    wallet.getBalanceAtomic(),
    START_BALANCE,
    "the wallet must NOT be credited by a hostile negative amount (CR-01)",
  );
});

test("hostile 402 with a NON-DECIMAL maxAmountRequired ('0x10') is rejected fail-closed", async () => {
  const res = await fetch(through("/paid-hexamount"));

  assert.equal(res.status, 502, "a hex atomic amount must fail closed, not pay");
  const body = (await res.json()) as { error: string; reason: string };
  assert.equal(body.error, "payment blocked (fail-closed)");

  assert.equal(mock.hits?.["/paid-hexamount"], 1, "no X-PAYMENT pay after a fail-closed parse");

  const wallet = openWallet(walletPath);
  assert.equal(
    wallet.getBalanceAtomic(),
    START_BALANCE,
    "the wallet must NOT be affected by a hostile non-decimal amount (CR-01)",
  );
});
