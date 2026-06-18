import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { getCommitStores } from "../src/decision/stub.js";
import type { Config } from "../src/config.js";
import { makeTestConfig } from "./helpers/config.js";
import { buildMockUpstream } from "../../attack-server/src/server.js";
import type { AuditRecord } from "../src/policy/audit.js";

/**
 * Task 2 e2e proof: forward.ts writes exactly ONE append-only audit row on EVERY
 * decision (OBS-01).
 *
 *  - BLOCK branch: a row with the named control, the protected atomic amount, and
 *    `settlement_tx` NULL — written BEFORE the 402 is sent.
 *  - ALLOW (stub-mode settle) branch: a row with `decision: "allow"` and
 *    `settlement_tx` NULL (stub allows carry no on-chain tx) inside the settle gate.
 *  - Exactly one row per decision (the write is in forward.ts, OUTSIDE runControls,
 *    so the PRE/POST double-evaluate never double-writes).
 *
 * The server holds the audit store as a module singleton (`getCommitStores().audit`,
 * opened by configureDecision from the test config's dbPath), so the test reads back
 * exactly what the hot path persisted. A temp-file dbPath isolates this suite's rows
 * from the default `:memory:` shared by other e2e files.
 */

let mock: FastifyInstance & { hits?: Record<string, number> };
let proxy: FastifyInstance;
let mockPort: number;
let proxyPort: number;

before(async () => {
  mock = buildMockUpstream();
  await mock.listen({ port: 0, host: "127.0.0.1" });
  mockPort = (mock.server.address() as AddressInfo).port;

  // Dedicated in-memory db for this server instance: configureDecision opens the
  // audit store here, and getCommitStores() exposes the SAME live handle the hot
  // path writes to (a single :memory: connection lives for the server's lifetime).
  const config: Config = makeTestConfig({
    allowlist: [`127.0.0.1:${mockPort}`],
    dbPath: ":memory:",
  });
  proxy = buildServer(config);
  await proxy.listen({ port: 0, host: "127.0.0.1" });
  proxyPort = (proxy.server.address() as AddressInfo).port;
});

after(async () => {
  await proxy?.close();
  await mock?.close();
});

const through = (path: string) => `http://127.0.0.1:${proxyPort}/http://127.0.0.1:${mockPort}${path}`;

function auditFeed(): AuditRecord[] {
  const stores = getCommitStores();
  assert.ok(stores, "configureDecision opened the commit stores (incl. audit)");
  return stores!.audit.recentFeed(50);
}

test("forward audit: a BLOCK writes one row — named control, protected_atomic set, settlement_tx NULL", async () => {
  const before = auditFeed().length;

  // /paid-overpriced is a 50 USDC (50000000 atomic) 402 → over the 1 USDC per-call cap → block.
  const res = await fetch(through("/paid-overpriced"));
  assert.equal(res.status, 402, "the agent receives the controlled 402 block (never the upstream 402)");
  assert.equal(res.headers.get("cache-control"), "no-store", "block 402 carries Cache-Control: no-store");
  await res.body?.cancel();

  const feed = auditFeed();
  assert.equal(feed.length, before + 1, "exactly one audit row written for the block (no PRE/POST double-write)");

  const row = feed[0];
  assert.notEqual(row.decision, "allow", "the block row's decision is a non-allow verdict");
  assert.equal(row.control, "per_call_cap", "the named deterministic control is persisted");
  assert.ok(row.protected_atomic, "protected_atomic is set on a block");
  assert.equal(row.protected_atomic, "50000000", "the protected atomic amount is the exact TEXT");
  assert.equal(row.settlement_tx, null, "a block carries settlement_tx NULL");
  assert.equal(row.target_host, `127.0.0.1:${mockPort}`, "the target host is recorded");
});

test("forward audit: a stub-mode ALLOW writes one row — decision 'allow', settlement_tx NULL", async () => {
  const before = auditFeed().length;

  // /paid-stable is a 0.001 USDC (1000 atomic) 402 → under the cap → allow → stub settle → 200.
  const res = await fetch(through("/paid-stable"));
  assert.equal(res.status, 200, "the allowed payment settles (stub) and returns 200");
  assert.equal(res.headers.get("cache-control"), "no-store", "the paid 200 carries Cache-Control: no-store");
  await res.body?.cancel();

  const feed = auditFeed();
  assert.equal(feed.length, before + 1, "exactly one audit row written for the allow (single settle-gated write)");

  const row = feed[0];
  assert.equal(row.decision, "allow", "the allow row's decision is 'allow'");
  assert.equal(row.settlement_tx, null, "a stub-mode allow carries settlement_tx NULL (no on-chain tx)");
  assert.equal(row.amount_atomic, "1000", "the allowed atomic amount is the exact TEXT");
});

test("forward audit: every decision is persisted — screened/blocked metrics reflect the writes", () => {
  const stores = getCommitStores();
  assert.ok(stores);
  const m = stores!.audit.metrics();
  // At least the two decisions above (a block + an allow) are screened; the block counts.
  assert.ok(m.screened >= 2, "every decision was screened into the audit table");
  assert.ok(m.blocked >= 1, "the block was counted (decision != 'allow')");
  assert.equal(m.protectedAtomic, "50000000", "the block's protected_atomic is summed in BigInt");
});
