import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig, type Config } from "./config.js";
import { decodeTarget, assertAllowed } from "./target.js";
import { forwardAndStream } from "./forward.js";

/**
 * Build the Sentinel proxy as a Fastify instance.
 *
 * Flow (the Walking Skeleton):
 *   1. Single catch-all route `'*'` for every method/path.
 *   2. decodeTarget(request.raw.url) — byte-exact path-prefix decode; throw → 400 fail-closed (D-09).
 *   3. assertAllowed(target, allowlist) — SSRF + allowlist guard BEFORE any upstream connection; throw → 403 (D-03).
 *   4. forwardAndStream — undici round-trip, non-402 streamed straight back (D-04/D-10, PROXY-02).
 * Each request is logged with the decoded target host and an elapsed-ms timing.
 */
export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel } });

  // Passthrough content-type parser: do NOT parse request bodies, just buffer them
  // for forwarding (request bodies are small in Phase 1 — only the response fast
  // path is latency-critical, D-10 / RESEARCH A3).
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.all("/*", async (request, reply) => {
    const start = process.hrtime.bigint();

    let target: URL;
    try {
      target = decodeTarget(request.raw.url ?? "");
    } catch (err) {
      // Malformed / non-http(s) target → fail-closed, never forward (D-09).
      request.log.warn({ err: (err as Error).message, rawUrl: request.raw.url }, "target decode failed");
      reply.code(400).send({ error: "invalid upstream target" });
      return;
    }

    try {
      assertAllowed(target, config.allowSet, config.allowInternal);
    } catch (err) {
      request.log.warn({ err: (err as Error).message, host: target.host }, "target rejected");
      reply.code(403).send({ error: "upstream host not permitted" });
      return;
    }

    try {
      await forwardAndStream(target, request, reply);
    } finally {
      // Honest audit trail: log the ACTUAL response status, not an unconditional
      // "forwarded". On a hijacked success the status is on reply.raw; on a
      // fail-closed / decision-block it is reply.statusCode (T-01-07 audit gap).
      const statusCode = reply.raw.headersSent ? reply.raw.statusCode : reply.statusCode;
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      request.log.info(
        { targetHost: target.host, method: request.method, statusCode, elapsedMs: Number(elapsedMs.toFixed(2)) },
        "request complete",
      );
    }
  });

  return app;
}

/** Boot the proxy on the configured port and log the listening address. */
export async function start(): Promise<FastifyInstance> {
  const config = loadConfig();
  const app = buildServer(config);
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info({ port: config.port, allowlist: config.allowlist }, "Sentinel proxy listening");
  return app;
}

// Run directly (tsx src/server.ts) but not when imported by tests.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  start().catch((err) => {
    console.error("failed to start Sentinel proxy:", err);
    process.exit(1);
  });
}
