import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { type Config } from "../src/config.js";
import { makeTestConfig } from "./helpers/config.js";
import { buildMockUpstream } from "../../attack-server/src/server.js";

/**
 * CR-02 regression: the replay first-seen mark must bind to SETTLEMENT (the
 * upstream 200), NOT to the allow decision.
 *
 * `/paid-retry500` is ALLOWED by the deterministic gate (legit 0.001 USDC price),
 * but its X-PAYMENT retry returns 500 — so the proxy fails closed and NO settlement
 * ever occurs. With the old code the dedup row was marked at the allow point, so the
 * agent's legitimate retry of the SAME logical request was permanently blocked as
 * `control:"replay"` even though the payment never settled.
 *
 * After the fix, a never-settled attempt does NOT mark first-seen, so the identical
 * retry is permitted to try again (it fails closed again because the route always
 * 500s on retry — but as an upstream-retry failure, NOT a replay block).
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

test("a payment that is allowed but fails BEFORE settlement does NOT block the identical retry as replay", async () => {
  // First attempt: allowed → X-PAYMENT retry → upstream 500 → fail-closed, NO settle.
  const first = await fetch(through("/paid-retry500"));
  assert.equal(first.status, 502, "the first attempt fails closed on the upstream 500");
  const firstBody = (await first.json()) as { error: string; reason: string };
  assert.equal(firstBody.error, "payment blocked (fail-closed)");
  assert.match(firstBody.reason, /retry/, "the failure is an upstream-retry failure, not a replay");

  // Second IDENTICAL attempt (the agent's legitimate retry). Because the first never
  // SETTLED, it must NOT be marked first-seen — so this is NOT blocked as replay. It
  // reaches the X-PAYMENT retry again (the route still 500s, so it fails closed the
  // SAME way). The key assertion: status 502 (not 402) and reason is NOT replay.
  const second = await fetch(through("/paid-retry500"));
  assert.equal(
    second.status,
    502,
    "the identical retry is NOT permanently blocked — it reaches the upstream again (CR-02)",
  );
  const secondBody = (await second.json()) as { error: string; reason: string };
  assert.equal(secondBody.error, "payment blocked (fail-closed)");
  assert.match(
    secondBody.reason,
    /retry/,
    "the retry fails closed as an upstream-retry failure, never as control:replay",
  );
  assert.doesNotMatch(secondBody.reason, /replay/, "a never-settled attempt must not become a replay block");

  // Each attempt hit the upstream twice (402 + X-PAYMENT retry→500). Two attempts = 4
  // hits. If the second had been wrongly blocked as replay it would have hit only the
  // 402 (3 total) and returned 402, not 502.
  assert.equal(
    mock.hits?.["/paid-retry500"],
    4,
    "both attempts reached the X-PAYMENT retry (no replay short-circuit on the second)",
  );
});
