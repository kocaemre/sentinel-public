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
import { payDirect } from "../../reference-agent/src/agent.js";

/**
 * POLICY-06 / SC#4 headline e2e: replay is provably stopped at the HTTP layer across
 * a REAL proxied duplicate.
 *
 * WITH Sentinel: the agent issues the SAME logical request TWICE against the stable
 * `/paid-stable` route (whose 402 body is identical on both calls, so
 * `canonicalPaymentId(requirements)` matches). Sentinel mints a DIFFERENT per-call
 * X-PAYMENT nonce each time, yet the dedup keys on the canonical `(paymentId,
 * resourceId)` — so the FIRST yields a grant (200, upstream settle hit twice:
 * 402 + X-PAYMENT→200) and the SECOND is blocked `control:"replay"`. The proxy must
 * read the upstream 402 to obtain the canonical paymentId, so the second request
 * touches the upstream ONCE (the 402) but is then blocked BEFORE the X-PAYMENT pay —
 * so the resource is SETTLED exactly once (only ONE X-PAYMENT retry ever reaches it:
 * 2 + 1 = 3 total hits, never a second settle). This is NOT a hand-replayed captured
 * nonce — it is two real proxied requests.
 *
 * WITHOUT Sentinel (--no-sentinel bypass, Plan 01's `drain.e2e.test.ts` recipe):
 * `payDirect` against the SAME direct upstream twice yields TWO grants (two upstream
 * settles, balance decremented twice) — the proxy is out of the loop, nothing
 * dedups. Proving SC#4's full statement (two grants bypass, exactly one with Sentinel)
 * in one file.
 */

let mock: FastifyInstance & { hits?: Record<string, number> };
let proxy: FastifyInstance;
let mockPort: number;
let proxyPort: number;
let tmpDir: string;

before(async () => {
  mock = buildMockUpstream();
  await mock.listen({ port: 0, host: "127.0.0.1" });
  mockPort = (mock.server.address() as AddressInfo).port;

  const config: Config = makeTestConfig({
    allowlist: [`127.0.0.1:${mockPort}`],
    dbPath: ":memory:",
  });
  proxy = buildServer(config);
  await proxy.listen({ port: 0, host: "127.0.0.1" });
  proxyPort = (proxy.server.address() as AddressInfo).port;

  tmpDir = mkdtempSync(join(tmpdir(), "sentinel-replay-"));
});

after(async () => {
  await proxy?.close();
  await mock?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const through = (path: string) =>
  `http://127.0.0.1:${proxyPort}/http://127.0.0.1:${mockPort}${path}`;

test("WITH Sentinel: the SAME logical request twice → exactly ONE grant, the second blocked control:replay", async () => {
  // First proxied request: a fresh first-seen → grant (402 + X-PAYMENT→200 = 2 hits).
  const first = await fetch(through("/paid-stable"));
  assert.equal(first.status, 200, "the first logical request is granted");
  await first.body?.cancel();
  assert.equal(mock.hits?.["/paid-stable"], 2, "first grant settles upstream (402 + retry)");

  // Second proxied request — SAME logical request (same canonical paymentId, even
  // though Sentinel mints a different per-call nonce). The proxy reads the upstream
  // 402 (to derive the canonical paymentId), then the replay control blocks it
  // BEFORE the X-PAYMENT pay.
  const second = await fetch(through("/paid-stable"));
  assert.equal(second.status, 402, "the duplicate is blocked, not paid");
  assert.equal(second.headers.get("cache-control"), "no-store");
  const body = (await second.json()) as { decision: string; control: string; reasons: string[] };
  assert.equal(body.decision, "block");
  assert.equal(body.control, "replay", "the HTTP-layer dedup NAMES replay (SC#4)");
  assert.ok(body.reasons.some((r) => r.includes("replay")), "reason names replay");

  // The resource is SETTLED exactly once: the first grant's 402 + X-PAYMENT retry
  // (2 hits) plus the second request's 402-only (1 hit, NO X-PAYMENT retry after the
  // replay block) = 3 total. There is never a SECOND X-PAYMENT pay — exactly ONE
  // grant with Sentinel (vs two without, the bypass test below).
  assert.equal(
    mock.hits?.["/paid-stable"],
    3,
    "the replay never reaches the X-PAYMENT pay — settled exactly ONCE with Sentinel",
  );
});

test("WITHOUT Sentinel (--no-sentinel bypass): the SAME two requests yield TWO grants (Plan 01 contrast, SC#4)", async () => {
  // The bypass drives payDirect DIRECTLY against the upstream — the proxy is out of
  // the loop, so nothing dedups (cf. drain.e2e.test.ts). Use a distinct route so
  // this assertion is independent of the WITH-Sentinel hit counter above.
  const directUrl = `http://127.0.0.1:${mockPort}/paid-n/bypass`;
  const wallet = openWallet(join(tmpDir, "bypass-wallet.db"));
  wallet.resetBalance(100_000_000n);

  const amt1 = await payDirect(directUrl, wallet);
  const amt2 = await payDirect(directUrl, wallet); // SAME logical request → STILL grants

  assert.equal(amt1, 1000n, "first bypass grant settles 0.001 USDC");
  assert.equal(amt2, 1000n, "second IDENTICAL bypass request ALSO grants (no dedup without Sentinel)");
  assert.equal(wallet.getBalanceAtomic(), 100_000_000n - 2000n, "balance decremented TWICE");

  // Two grants = the upstream settled twice: 402 + X-PAYMENT→200, twice = 4 hits.
  assert.equal(
    mock.hits?.["/paid-n/bypass"],
    4,
    "bypass yields TWO grants for the same two requests (vs exactly ONE with Sentinel)",
  );
});
