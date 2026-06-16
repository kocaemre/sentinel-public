import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { safeBase64Decode } from "x402/shared";
import { buildServer } from "../src/server.js";
import type { Config } from "../src/config.js";
import { buildMockUpstream } from "../../attack-server/src/server.js";

let mock: FastifyInstance & { hits?: Record<string, number>; lastXPayment?: string };
let proxy: FastifyInstance;
let mockPort: number;
let proxyPort: number;

before(async () => {
  mock = buildMockUpstream();
  await mock.listen({ port: 0, host: "127.0.0.1" });
  mockPort = (mock.server.address() as AddressInfo).port;

  const config: Config = {
    allowlist: [`127.0.0.1:${mockPort}`],
    allowSet: new Set([`127.0.0.1:${mockPort}`]),
    port: 0,
    logLevel: "silent",
    allowInternal: true, // local e2e: the mock lives on loopback
  };
  proxy = buildServer(config);
  await proxy.listen({ port: 0, host: "127.0.0.1" });
  proxyPort = (proxy.server.address() as AddressInfo).port;
});

after(async () => {
  await proxy?.close();
  await mock?.close();
});

const through = (path: string) => `http://127.0.0.1:${proxyPort}/http://127.0.0.1:${mockPort}${path}`;

test("paid: agent receives 200 + protected body, never sees the 402, mock hit exactly twice", async () => {
  const res = await fetch(through("/paid"));

  assert.equal(res.status, 200, "agent must receive 200, never the upstream 402");
  const body = (await res.json()) as { data: string };
  assert.equal(body.data, "protected resource (paid)");

  // Two upstream hits: the initial 402, then the X-PAYMENT retry → 200.
  assert.equal(mock.hits?.["/paid"], 2, "upstream must be hit exactly twice (402 then X-PAYMENT→200)");
});

test("paid: the retry's X-PAYMENT decodes to payTo/value/network matching the parsed 402", async () => {
  const res = await fetch(through("/paid-capture"));
  assert.equal(res.status, 200);
  await res.body?.cancel();

  const received = mock.lastXPayment;
  assert.ok(received, "mock must have received an X-PAYMENT header on the retry");
  const decoded = JSON.parse(safeBase64Decode(received!)) as {
    network: string;
    payload: { authorization: { to: string; value: string } };
  };
  assert.equal(decoded.network, "arc-testnet");
  assert.equal(decoded.payload.authorization.to, "0xPayee");
  assert.equal(decoded.payload.authorization.value, "1000");
});

test("paid: the final 200 carries Cache-Control: no-store (Pitfall 5)", async () => {
  const res = await fetch(through("/paid"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  await res.body?.cancel();
});

test("malformed 402: fails closed (non-200, non-402), never returns the raw 402 (D-09)", async () => {
  const res = await fetch(through("/paid-malformed"));
  assert.notEqual(res.status, 200, "a malformed 402 must NOT yield a paid 200");
  assert.notEqual(res.status, 402, "the agent must never observe the upstream 402");
  assert.equal(res.status, 502, "fail-closed");
  await res.body?.cancel();
  // The mock was hit once (the initial 402); the proxy must NOT have retried.
  assert.equal(mock.hits?.["/paid-malformed"], 1, "no retry after an unparseable 402");
});

test("upstream retry 500: fails closed, never fabricates a success (D-09)", async () => {
  const res = await fetch(through("/paid-retry500"));
  assert.notEqual(res.status, 200, "a failed retry must NOT be turned into a fabricated 200");
  assert.equal(res.status, 502, "fail-closed");
  await res.body?.cancel();
  // Hit twice: the initial 402 and the retry that 500s.
  assert.equal(mock.hits?.["/paid-retry500"], 2);
});

test("unreachable upstream: transport error fails closed with a controlled 502, not an uncaught throw (T-01-07/CR-02)", async () => {
  // Reserve a port, then close it so connections are refused (ECONNREFUSED).
  const { createServer } = await import("node:net");
  const deadPort = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

  const config: Config = {
    allowlist: [`127.0.0.1:${deadPort}`],
    allowSet: new Set([`127.0.0.1:${deadPort}`]),
    port: 0,
    logLevel: "silent",
    allowInternal: true,
  };
  const deadProxy = buildServer(config);
  await deadProxy.listen({ port: 0, host: "127.0.0.1" });
  const deadProxyPort = (deadProxy.server.address() as AddressInfo).port;

  try {
    const res = await fetch(
      `http://127.0.0.1:${deadProxyPort}/http://127.0.0.1:${deadPort}/anything`,
    );
    assert.equal(res.status, 502, "unreachable upstream must fail closed with the controlled 502 shape");
    const body = (await res.json()) as { error: string; reason: string };
    assert.equal(body.error, "payment blocked (fail-closed)");
    assert.match(body.reason, /upstream unreachable/);
  } finally {
    await deadProxy.close();
  }
});
