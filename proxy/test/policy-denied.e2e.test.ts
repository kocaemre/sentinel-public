import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig, type Config } from "../src/config.js";
import { makeTestConfig } from "./helpers/config.js";
import { buildMockUpstream } from "../../attack-server/src/server.js";

/**
 * POLICY-04 headline e2e (SC#3): paying a DENIED counterparty is blocked live, with
 * the 402 block body NAMING `denied`. The mock's `/paid` 402 declares `payTo:
 * "0xPayee"`; this test puts that payee on the deny list. Deny precedence: even
 * though the legit 0.001 USDC amount is far under every cap, the deny-list blocks
 * it (fail-closed). A control test with the deny list EMPTY proves the same legit
 * payment otherwise passes — so the block is attributable to `denied` alone.
 */

let mock: FastifyInstance & { hits?: Record<string, number> };
let proxy: FastifyInstance;
let mockPort: number;
let proxyPort: number;

before(async () => {
  mock = buildMockUpstream();
  await mock.listen({ port: 0, host: "127.0.0.1" });
  mockPort = (mock.server.address() as AddressInfo).port;

  const base = loadConfig({});
  // Deny the legit payee. Everything else is the locked default (so the ONLY reason
  // a /paid payment is blocked is the deny list — not a cap).
  const config: Config = makeTestConfig({
    allowlist: [`127.0.0.1:${mockPort}`],
    dbPath: ":memory:",
    denylist: ["0xPayee"],
    denySet: new Set(["0xPayee"]),
    expectedPriceMap: base.expectedPriceMap,
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

test("a denied counterparty (0xPayee) is BLOCKED, body names denied, deny precedence over a sub-cap amount", async () => {
  const res = await fetch(through("/paid"));

  assert.equal(res.status, 402, "blocked, not paid");
  assert.equal(res.headers.get("cache-control"), "no-store");

  const body = (await res.json()) as {
    decision: string;
    control: string;
    protectedAmountAtomic: string;
    reasons: string[];
  };
  assert.equal(body.decision, "block");
  assert.equal(body.control, "denied", "the deny-list block NAMES denied (SC#3)");
  assert.ok(body.reasons.some((r) => r.includes("denied")), "reason names the control");

  // No pay after a block: the upstream is hit exactly once (the initial 402 only).
  assert.equal(mock.hits?.["/paid"], 1, "no X-PAYMENT retry after a deny block");
});

test("control: with the deny list EMPTY the same legit /paid passes (so the block above is attributable to denied)", async () => {
  // Boot a second proxy with NO deny list against the same mock.
  const cleanConfig: Config = makeTestConfig({
    allowlist: [`127.0.0.1:${mockPort}`],
    dbPath: ":memory:",
  });
  const cleanProxy = buildServer(cleanConfig);
  await cleanProxy.listen({ port: 0, host: "127.0.0.1" });
  const cleanPort = (cleanProxy.server.address() as AddressInfo).port;
  try {
    const res = await fetch(
      `http://127.0.0.1:${cleanPort}/http://127.0.0.1:${mockPort}/paid`,
    );
    assert.equal(res.status, 200, "with no deny list the legit payment pays through");
    await res.body?.cancel();
  } finally {
    await cleanProxy.close();
  }
});
