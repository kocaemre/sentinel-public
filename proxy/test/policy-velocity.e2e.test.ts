import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { type Config } from "../src/config.js";
import { makeTestConfig } from "./helpers/config.js";
import { buildMockUpstream } from "../../attack-server/src/server.js";

/**
 * POLICY-03 attack-succeeds-then-blocked e2e (SC#3, D-02): rolling-window velocity.
 *
 * Each `/paid-n/:n` is a DISTINCT tiny (0.001 USDC) resource, so each settles
 * independently (no replay collision) and accrues one tick to the rolling-window
 * settlements ledger. The velocity limit is 5 in a 60s window; the budget is set
 * HIGH so VELOCITY — not budget — is the clean trip (D-08 isolation). Five payments
 * settle inside the window; the SIXTH (count already 5 >= limit 5) is blocked with
 * the body NAMING `velocity`. The upstream is hit only once for the blocked payment.
 */

let mock: FastifyInstance & { hits?: Record<string, number> };
let proxy: FastifyInstance;
let mockPort: number;
let proxyPort: number;

before(async () => {
  mock = buildMockUpstream();
  await mock.listen({ port: 0, host: "127.0.0.1" });
  mockPort = (mock.server.address() as AddressInfo).port;

  const config: Config = makeTestConfig({
    allowlist: [`127.0.0.1:${mockPort}`],
    dbPath: ":memory:",
    perCallCapAtomic: 100_000_000n, // high — never the trip
    hourlyBudgetAtomic: 1_000_000_000n, // 1000 USDC — high, isolate VELOCITY (D-08)
    dailyBudgetAtomic: 1_000_000_000n,
    velocityLimit: 5, // 5 payments / window — the control under test
    velocityWindowMs: 60_000,
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

test("five in-window payments settle, the SIXTH is blocked naming velocity", async () => {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(through(`/paid-n/${i}`));
    assert.equal(res.status, 200, `payment ${i} must settle below the velocity limit`);
    await res.body?.cancel();
  }

  const res = await fetch(through(`/paid-n/5`));
  assert.equal(res.status, 402, "the 6th in-window payment is blocked, not paid");
  assert.equal(res.headers.get("cache-control"), "no-store");

  const body = (await res.json()) as {
    decision: string;
    control: string;
    reasons: string[];
  };
  assert.equal(body.decision, "block");
  assert.equal(body.control, "velocity", "velocity is the trip (not budget), SC#3");
  assert.ok(body.reasons.some((r) => r.includes("velocity")), "reason names velocity");

  assert.equal(mock.hits?.["/paid-n/5"], 1, "no X-PAYMENT retry after a velocity block");
});
