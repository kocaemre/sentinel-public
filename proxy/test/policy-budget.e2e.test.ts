import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { type Config } from "../src/config.js";
import { makeTestConfig } from "./helpers/config.js";
import { buildMockUpstream } from "../../attack-server/src/server.js";

/**
 * POLICY-02 attack-succeeds-then-blocked e2e (SC#3, D-02): the rolling-HOUR budget.
 *
 * Each `/paid-n/:n` is a DISTINCT resource priced at 1 USDC, so each settles
 * independently (no replay-dedup collision) and accrues to the rolling-window
 * settlements ledger via the post-200 commit (RESEARCH Pitfall 2). The hourly cap
 * is 5 USDC; velocity is set HIGH (100) so BUDGET — not velocity — is the clean trip
 * (D-08 isolation). Five 1 USDC payments settle (5 USDC, exactly at the cap, allowed
 * since the budget blocks only when the sum WOULD EXCEED). The sixth 1 USDC payment
 * (5 + 1 = 6 > 5) is blocked with the body NAMING `budget`. The upstream is hit only
 * once for the blocked payment (the 402 — no X-PAYMENT retry after a block).
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
    perCallCapAtomic: 100_000_000n, // 100 USDC — high, so the per-call cap never trips on 1 USDC
    hourlyBudgetAtomic: 5_000_000n, // 5 USDC rolling-hour budget — the control under test
    dailyBudgetAtomic: 1_000_000_000n, // 1000 USDC — high, isolate the HOURLY trip
    velocityLimit: 100, // high, so VELOCITY never trips (D-08 isolation)
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

test("five 1 USDC payments settle (at the 5 USDC hourly cap), the SIXTH is blocked naming budget", async () => {
  // Drive five distinct 1 USDC settled payments → rolling-hour sum reaches 5 USDC.
  for (let i = 0; i < 5; i++) {
    const res = await fetch(through(`/paid-n/${i}?amount=1000000`));
    assert.equal(res.status, 200, `payment ${i} (1 USDC) must settle under the budget`);
    await res.body?.cancel();
  }

  // The sixth 1 USDC payment (5 + 1 = 6 > 5 USDC) trips the rolling-hour budget.
  const res = await fetch(through(`/paid-n/5?amount=1000000`));
  assert.equal(res.status, 402, "the over-budget payment is blocked, not paid");
  assert.equal(res.headers.get("cache-control"), "no-store");

  const body = (await res.json()) as {
    decision: string;
    control: string;
    protectedAmountAtomic: string;
    reasons: string[];
  };
  assert.equal(body.decision, "block");
  assert.equal(body.control, "budget", "the rolling-hour budget is the trip (not velocity), SC#3");
  assert.equal(body.protectedAmountAtomic, "1000000");
  assert.ok(body.reasons.some((r) => r.includes("budget")), "reason names budget");

  // No pay after a block: the over-budget upstream resource was hit only once (402).
  assert.equal(mock.hits?.["/paid-n/5"], 1, "no X-PAYMENT retry after a budget block");
});
