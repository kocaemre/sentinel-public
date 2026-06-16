import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTarget, assertAllowed } from "../src/target.js";
import { stripHopByHop, forwardableHeaders } from "../src/headers.js";

test("decodeTarget: happy path preserves host, path, query and escapes byte-exact", () => {
  const target = decodeTarget("/https://api.foo.com/v1/pay?q=a%20b&x=1");
  assert.equal(target.host, "api.foo.com");
  assert.equal(target.pathname, "/v1/pay");
  // query string + percent-escape preserved, not double-decoded
  assert.equal(target.search, "?q=a%20b&x=1");
  assert.equal(target.protocol, "https:");
});

test("decodeTarget: http scheme accepted", () => {
  const target = decodeTarget("/http://api.foo.com/x");
  assert.equal(target.protocol, "http:");
  assert.equal(target.host, "api.foo.com");
});

test("decodeTarget: rejects non-http(s) scheme (fail-closed)", () => {
  assert.throws(() => decodeTarget("/ftp://api.foo.com/x"), /unsupported scheme/);
});

test("decodeTarget: rejects garbage with no host (fail-closed)", () => {
  assert.throws(() => decodeTarget("/not-a-url"));
});

test("decodeTarget: rejects empty target", () => {
  assert.throws(() => decodeTarget("/"));
});

test("assertAllowed: no-op when host is on the allowlist", () => {
  const allow = new Set(["api.foo.com"]);
  assert.doesNotThrow(() => assertAllowed(new URL("https://api.foo.com/"), allow));
});

test("assertAllowed: throws when host is not on the allowlist", () => {
  const allow = new Set(["api.foo.com"]);
  assert.throws(() => assertAllowed(new URL("https://evil.com/"), allow), /not allowlisted/);
});

test("assertAllowed: SSRF guard rejects internal hosts even when allowlisted", () => {
  // each is added to the allowlist to prove the SSRF check is independent of membership
  const cases = [
    "https://localhost/",
    "https://127.0.0.1/",
    "https://169.254.169.254/", // cloud metadata endpoint
    "https://10.0.0.5/",
    "https://192.168.1.1/",
    "https://172.16.0.1/",
    "http://[::1]/",
  ];
  for (const url of cases) {
    const u = new URL(url);
    const allow = new Set([u.host]); // present in allowlist on purpose
    assert.throws(
      () => assertAllowed(u, allow),
      /SSRF blocked/,
      `expected SSRF rejection for ${url}`,
    );
  }
});

test("assertAllowed: allowInternal=true permits a localhost upstream for local dev", () => {
  const u = new URL("http://localhost:4021/");
  const allow = new Set([u.host]);
  assert.doesNotThrow(() => assertAllowed(u, allow, true));
});

test("assertAllowed: allowInternal=true still enforces allowlist membership", () => {
  const u = new URL("http://localhost:9999/");
  const allow = new Set(["localhost:4021"]);
  assert.throws(() => assertAllowed(u, allow, true), /not allowlisted/);
});

test("forwardableHeaders: removes host and all hop-by-hop headers", () => {
  const input = {
    host: "sentinel.local",
    connection: "keep-alive",
    "keep-alive": "timeout=5",
    "transfer-encoding": "chunked",
    upgrade: "websocket",
    "proxy-authenticate": "Basic",
    "proxy-authorization": "Basic abc",
    te: "trailers",
    trailer: "X-Foo",
    accept: "application/json",
    "x-payment": "abc",
  };
  const out = forwardableHeaders(input);
  for (const banned of [
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
  ]) {
    assert.equal(out[banned], undefined, `${banned} should be stripped`);
  }
  // benign headers pass through untouched
  assert.equal(out.accept, "application/json");
  assert.equal(out["x-payment"], "abc");
});

test("stripHopByHop: removes hop-by-hop but keeps host (response-side use)", () => {
  const out = stripHopByHop({ host: "x", connection: "close", "content-type": "text/plain" });
  assert.equal(out.connection, undefined);
  assert.equal(out.host, "x"); // stripHopByHop alone does NOT remove host
  assert.equal(out["content-type"], "text/plain");
});

test("stripHopByHop / forwardableHeaders: case-insensitive header matching", () => {
  const out = forwardableHeaders({ Connection: "keep-alive", Host: "h", "X-Keep": "1" });
  assert.equal(out.Connection, undefined);
  assert.equal(out.Host, undefined);
  assert.equal(out["X-Keep"], "1");
});
