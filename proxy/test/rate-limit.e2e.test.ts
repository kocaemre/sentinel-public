import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import type { Config } from "../src/config.js";
import { makeTestConfig } from "./helpers/config.js";
import { buildMockUpstream } from "../../attack-server/src/server.js";

/**
 * Phase-5 Plan 01 Task 2 e2e proof: the per-source-IP rate limit (DIST-02, D-05).
 *
 *  - Over `rateLimitMax` requests from the SAME `CF-Connecting-IP` → HTTP 429
 *    (fail-closed, never a pass-through).
 *  - Two DIFFERENT `CF-Connecting-IP` values are keyed INDEPENDENTLY (one IP's
 *    spend does not throttle another's) — proves the keyGenerator reads the edge IP.
 *  - The SSRF allowlist + allowInternal posture is UNCHANGED: a non-allowlisted host
 *    still 403s (the allowlist guard runs; the rate-limit never relaxes it).
 *
 * A low `rateLimitMax` is injected via the test config so the limit trips fast.
 */

const LIMIT = 3; // tiny threshold so the test trips deterministically

let mock: FastifyInstance;
let proxy: FastifyInstance;
let mockPort: number;
let proxyPort: number;

before(async () => {
  mock = buildMockUpstream();
  await mock.listen({ port: 0, host: "127.0.0.1" });
  mockPort = (mock.server.address() as AddressInfo).port;

  const config: Config = makeTestConfig({
    allowlist: [`127.0.0.1:${mockPort}`],
    rateLimitMax: LIMIT,
    rateLimitWindowMs: 60_000,
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

const base = () => `http://127.0.0.1:${proxyPort}`;
// /api/metrics is a registered route guarded by the global rate-limit; it does not
// touch upstream, so we exercise the limiter cleanly.
const hit = (ip: string) =>
  fetch(`${base()}/api/metrics`, { headers: { "CF-Connecting-IP": ip } });

test("rate-limit: over the threshold from the SAME cf-connecting-ip returns 429 (fail-closed)", async () => {
  const ip = "203.0.113.50";
  const statuses: number[] = [];
  // LIMIT allowed + a couple over → at least one 429 in the tail.
  for (let i = 0; i < LIMIT + 3; i++) {
    const res = await hit(ip);
    statuses.push(res.status);
    await res.body?.cancel();
  }
  const allowed = statuses.filter((s) => s === 200).length;
  const throttled = statuses.filter((s) => s === 429).length;
  assert.ok(allowed <= LIMIT, `no more than ${LIMIT} allowed before throttling (saw ${allowed})`);
  assert.ok(throttled >= 1, `at least one 429 over the threshold (saw statuses ${statuses.join(",")})`);
});

test("rate-limit: two DIFFERENT cf-connecting-ip values are keyed independently", async () => {
  // A fresh IP must get its OWN budget even after another IP was throttled above.
  const fresh = "198.51.100.77";
  const res = await hit(fresh);
  assert.equal(res.status, 200, "a previously-unseen IP is not throttled by another IP's spend");
  await res.body?.cancel();
});

test("rate-limit: the SSRF allowlist still 403s a non-allowlisted host (limiter never relaxes it)", async () => {
  // 127.0.0.2 is loopback but NOT in the allowlist → must 403 (not 429-then-pass), and
  // must NOT be forwarded. Use a fresh IP so the limiter is not the cause of a non-200.
  const url = `${base()}/http://127.0.0.2:${mockPort}/data`;
  const res = await fetch(url, { headers: { "CF-Connecting-IP": "198.51.100.200" } });
  assert.equal(res.status, 403, "non-allowlisted host is rejected by the SSRF allowlist, unchanged");
  await res.body?.cancel();
});
