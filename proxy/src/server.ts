import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { loadConfig, type Config } from "./config.js";
import { decodeTarget, assertAllowed } from "./target.js";
import { forwardAndStream, configureSettlement } from "./forward.js";
import { configureDecision, getCommitStores } from "./decision/stub.js";
import { makeOpenRouterJudge } from "./judge/adapter.js";
import { makeSettlementAdapter } from "./settlement/adapter.js";
import { registerReadEndpoints, configureReadEndpoints } from "./read/endpoints.js";

/**
 * Build the Sentinel proxy as a Fastify instance.
 *
 * Flow (the Walking Skeleton):
 *   1. Single catch-all route `'*'` for every method/path.
 *   2. decodeTarget(request.raw.url) — byte-exact path-prefix decode; throw → 400 fail-closed (D-09).
 *   3. assertAllowed(target, allowlist) — SSRF + allowlist guard BEFORE any upstream connection; throw → 403 (D-03).
 *   4. forwardAndStream — undici round-trip, non-402 streamed straight back (D-04/D-10, PROXY-02).
 * Each request is logged with the decoded target host and an elapsed-ms timing.
 *
 * Phase 5 (DIST-02): a per-source-IP rate limit (`@fastify/rate-limit` keyed on the
 * un-spoofable `CF-Connecting-IP`, D-05) and the three JSON read endpoints
 * (`/api/metrics|feed|verdict/:id`, D-03).
 *
 * REGISTRATION ORDER (load-bearing): `@fastify/rate-limit` installs an `onRoute` hook
 * that only sees routes registered AFTER the plugin has loaded. So ALL routes (the read
 * endpoints, the content-type parser, and the proxy catch-all) are registered inside a
 * child plugin that Fastify loads AFTER the rate-limit plugin — guaranteeing the global
 * limiter applies to every route. Fastify resolves the whole plugin tree in registration
 * order at `ready()`/`listen()`, so `buildServer` stays synchronous (every existing test
 * call site that builds-then-listens still works) and no `await` is needed here.
 */
export function buildServer(config: Config): FastifyInstance {
  // Wire this server's resolved limits into the decision seam (PRE/POST gate) so
  // the per-call cap + overpayment controls evaluate against THIS config's
  // values/price-map (e2e tests inject an isolating config here — Plan 02). Plan 03
  // injects the real hardened OpenRouter judge into the seam's judge slot ONLY when an
  // OPENROUTER_API_KEY is configured (the live CLI demo). The judge is advisory — the
  // deterministic POST tighten() remains the hard backstop. With NO key (the offline
  // e2e / unit path) we inject NO judge, so the seam's identity passthrough runs and
  // legitimate allows are not fail-closed-blocked by a keyless judge. (At runtime the
  // judge still fails closed to `block` on any error once a key IS present.)
  const judge = config.openRouterApiKey ? makeOpenRouterJudge(config) : undefined;
  configureDecision({ ...config, judge });

  // Wire the settlement adapter (Plan 04-01). Stub-default (D-01): the demo always
  // runs. In real mode the GatewayClient settles USDC on Arc testnet and the in-process
  // cap backstop reads the SAME ledger the decision seam opened (configureDecision ran
  // first, so getCommitStores() exposes it). Stub mode never constructs a GatewayClient.
  const ledger = getCommitStores()?.ledger;
  configureSettlement(makeSettlementAdapter(config, { ledger }));

  // Wire the honest-N dev-exclusion source into the read endpoints (D-07).
  configureReadEndpoints(config.devSource);

  const app = Fastify({ logger: { level: config.logLevel } });

  // (1) Per-source-IP rate limit (D-05): keyed on the un-spoofable edge `CF-Connecting-IP`
  // (Cloudflare overwrites it — NOT client-spoofable), falling back to the socket peer
  // for a direct/local hit. Fail-closed 429 over `rateLimitMax`. Registered FIRST so its
  // onRoute hook is installed before any route is added below.
  void app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    keyGenerator: (req) =>
      (req.headers["cf-connecting-ip"] as string | undefined) ?? req.ip,
  });

  // (2) ALL routes live in a child plugin loaded AFTER rate-limit so the global limiter
  // applies to every one of them (the read endpoints AND the proxy catch-all).
  void app.register(async (instance) => {
    // JSON read endpoints (D-03) — registered BEFORE the `instance.all("/*")` proxy
    // catch-all so the dashboard read routes are not consumed by the proxy path-prefix
    // decoder.
    registerReadEndpoints(instance);

    // Passthrough content-type parser: do NOT parse request bodies, just buffer them
    // for forwarding (request bodies are small in Phase 1 — only the response fast
    // path is latency-critical, D-10 / RESEARCH A3).
    instance.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    instance.all("/*", async (request, reply) => {
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
