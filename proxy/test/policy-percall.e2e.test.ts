import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import type { Config } from "../src/config.js";
import { makeTestConfig } from "./helpers/config.js";
import { buildMockUpstream } from "../../attack-server/src/server.js";

/**
 * POLICY-01 headline e2e: the SAME malicious 50 USDC drain that succeeded in
 * Plan 01's `--no-sentinel` mode is now BLOCKED live by the per-call cap, with the
 * 402 block body NAMING `per_call_cap` (SC#3). The legit 0.001 USDC `/paid` still
 * passes (allow → 200) — the deterministic gate does not false-positive the legit
 * baseline. The malicious upstream is hit exactly ONCE (no pay after a block).
 */

let mock: FastifyInstance & { hits?: Record<string, number> };
let proxy: FastifyInstance;
let mockPort: number;
let proxyPort: number;

before(async () => {
  mock = buildMockUpstream();
  await mock.listen({ port: 0, host: "127.0.0.1" });
  mockPort = (mock.server.address() as AddressInfo).port;

  // Locked demo defaults: per-call cap 1 USDC, /paid expected price 0.001 USDC.
  // In-memory db path keeps the test isolated from the shared wallet file.
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

const through = (path: string) =>
  `http://127.0.0.1:${proxyPort}/http://127.0.0.1:${mockPort}${path}`;

test("legit 0.001 USDC /paid passes (allow → 200), the cap does NOT false-positive", async () => {
  const res = await fetch(through("/paid"));
  assert.equal(res.status, 200, "the legit baseline must still pay through");
  const body = (await res.json()) as { data: string };
  assert.equal(body.data, "protected resource (paid)");
  assert.equal(mock.hits?.["/paid"], 2, "legit pays: 402 then X-PAYMENT→200");
});

test("malicious 50 USDC /paid-overpriced is BLOCKED, body names per_call_cap, no-store, upstream hit once", async () => {
  const res = await fetch(through("/paid-overpriced"));

  assert.equal(res.status, 402, "the agent receives a Sentinel block, not a paid 200");
  assert.equal(res.headers.get("cache-control"), "no-store", "never cache a block (D-09)");

  const body = (await res.json()) as {
    error: string;
    decision: string;
    control: string;
    protectedAmountAtomic: string;
    reasons: string[];
  };
  assert.equal(body.decision, "block");
  assert.equal(body.control, "per_call_cap", "the block NAMES the specific control (SC#3), never generic");
  assert.equal(body.protectedAmountAtomic, "50000000", "the 50 USDC drain was protected (D-06)");
  assert.ok(body.reasons.some((r) => r.includes("per_call_cap")), "reason names the control");

  // The proxy must NOT replay/pay after a block: the malicious upstream is hit
  // exactly once (the initial 402 only — no X-PAYMENT retry).
  assert.equal(mock.hits?.["/paid-overpriced"], 1, "no pay after a block (upstream hit once)");
});
