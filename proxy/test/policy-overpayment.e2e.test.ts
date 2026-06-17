import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig, type Config } from "../src/config.js";
import { makeTestConfig } from "./helpers/config.js";
import { buildMockUpstream } from "../../attack-server/src/server.js";

/**
 * POLICY-07 headline e2e: overpayment is a control DISTINCT from the per-call cap
 * (D-08). This boots a config that ISOLATES overpayment — the per-call cap is set
 * generously HIGH (100 USDC) so it would NOT fire on the 50 USDC drain, while the
 * malicious `/paid-overpriced` resource is priced at its true 0.001 USDC in the
 * expected-price map. 50 USDC ≫ 2× 0.001 USDC, so ONLY the overpayment control
 * trips. The 402 block body NAMES `overpayment` (SC#3). The legit `/paid` still
 * passes. The malicious upstream is hit exactly once (no pay after a block).
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
  // Isolate overpayment from the cap (D-08): cap high enough that 50 USDC would
  // pass it, but the overpriced resource is priced at its true 0.001 USDC so the
  // 2× overpayment ceiling (0.002 USDC) is the clean trip.
  const config: Config = makeTestConfig({
    allowlist: [`127.0.0.1:${mockPort}`],
    dbPath: ":memory:",
    perCallCapAtomic: 100_000_000n, // 100 USDC — deliberately above the 50 USDC drain
    overpaymentMultiplier: 2,
    expectedPriceMap: {
      ...base.expectedPriceMap, // keeps the legit /paid baseline
      "https://upstream/paid-overpriced": "1000", // true price 0.001 USDC
    },
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

test("legit 0.001 USDC /paid still passes under the overpayment-isolating config", async () => {
  const res = await fetch(through("/paid"));
  assert.equal(res.status, 200);
  await res.body?.cancel();
  assert.equal(mock.hits?.["/paid"], 2);
});

test("50 USDC /paid-overpriced is blocked by OVERPAYMENT (not the cap), body names overpayment", async () => {
  const res = await fetch(through("/paid-overpriced"));

  assert.equal(res.status, 402, "blocked, not paid");
  assert.equal(res.headers.get("cache-control"), "no-store");

  const body = (await res.json()) as {
    decision: string;
    control: string;
    protectedAmountAtomic: string;
    reasons: string[];
  };
  assert.equal(body.decision, "block");
  assert.equal(
    body.control,
    "overpayment",
    "the cap was set above 50 USDC, so the OVERPAYMENT control is the trip (D-08)",
  );
  assert.equal(body.protectedAmountAtomic, "50000000");
  assert.ok(body.reasons.some((r) => r.includes("overpayment")), "reason names overpayment");

  assert.equal(mock.hits?.["/paid-overpriced"], 1, "no pay after a block (upstream hit once)");
});
