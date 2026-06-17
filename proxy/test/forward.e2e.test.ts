import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import type { Config } from "../src/config.js";
import { makeTestConfig } from "./helpers/config.js";
import { buildMockUpstream } from "../../attack-server/src/server.js";

let mock: FastifyInstance;
let proxy: FastifyInstance;
let mockPort: number;
let proxyPort: number;

before(async () => {
  mock = buildMockUpstream();
  await mock.listen({ port: 0, host: "127.0.0.1" });
  mockPort = (mock.server.address() as AddressInfo).port;

  const config: Config = makeTestConfig({ allowlist: [`127.0.0.1:${mockPort}`] });
  proxy = buildServer(config);
  await proxy.listen({ port: 0, host: "127.0.0.1" });
  proxyPort = (proxy.server.address() as AddressInfo).port;
});

after(async () => {
  await proxy?.close();
  await mock?.close();
});

test("non-402: returns upstream status + body unchanged through the proxy", async () => {
  const url = `http://127.0.0.1:${proxyPort}/http://127.0.0.1:${mockPort}/data`;
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: string };
  assert.equal(body.data, "protected resource");
});

test("streaming: first chunk arrives before the upstream finishes (no buffering)", async () => {
  const url = `http://127.0.0.1:${proxyPort}/http://127.0.0.1:${mockPort}/stream`;
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.ok(res.body, "expected a readable response body");

  const reader = res.body.getReader();
  const firstChunkAt = Date.now();
  const { value, done } = await reader.read();
  const elapsedToFirstChunk = Date.now() - firstChunkAt;

  assert.equal(done, false);
  assert.ok(value && value.length > 0, "expected a non-empty first chunk");
  // The upstream writes 4 chunks 50ms apart (~200ms total). If the proxy buffered
  // the whole body, the first chunk would only arrive after ~200ms. Streaming
  // delivers it almost immediately.
  assert.ok(
    elapsedToFirstChunk < 150,
    `first chunk took ${elapsedToFirstChunk}ms — proxy appears to be buffering`,
  );

  // Drain the rest.
  let text = new TextDecoder().decode(value);
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
  }
  assert.match(text, /chunk-0/);
  assert.match(text, /done/);
});

test("non-allowlisted host: returns 403 and the mock records zero hits", async () => {
  // 127.0.0.2 is loopback but NOT in the allowlist set → rejected by membership check.
  const url = `http://127.0.0.1:${proxyPort}/http://127.0.0.2:${mockPort}/data`;
  const res = await fetch(url);
  assert.equal(res.status, 403);
  await res.body?.cancel();
});

test("malformed / non-http(s) target: returns 400 (fail-closed), never forwarded", async () => {
  const url = `http://127.0.0.1:${proxyPort}/not-a-url`;
  const res = await fetch(url);
  assert.equal(res.status, 400);
  await res.body?.cancel();

  const ftp = await fetch(`http://127.0.0.1:${proxyPort}/ftp://127.0.0.1:${mockPort}/data`);
  assert.equal(ftp.status, 400);
  await ftp.body?.cancel();
});
