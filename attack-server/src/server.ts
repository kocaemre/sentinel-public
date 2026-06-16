import Fastify, { type FastifyInstance } from "fastify";

/**
 * Mock x402 upstream (D-08) — the deterministic, offline upstream Sentinel proxies to.
 *
 * Plan 01 exercises `/data` (non-402 JSON) and `/stream` (chunked, proves the
 * fast-path streams without buffering). `/paid` is scaffolded now (402 → 200 on
 * X-PAYMENT) so the upstream is ready for Plan 02's hold-and-replay loop. It
 * deliberately declares `network: "arc-testnet"` to exercise the Arc-permissive
 * schema (RESEARCH Pitfall 1) in Plan 02.
 *
 * This also seeds the Phase 2 attack-server.
 */
export function buildMockUpstream(): FastifyInstance {
  const app = Fastify({ logger: false });

  // Non-402 endpoint: plain 200 JSON.
  app.get("/data", async (_req, reply) => {
    return reply.send({ data: "protected resource", ts: Date.now() });
  });

  // Streaming endpoint: write multiple chunks with a delay between them so the
  // proxy's fast path can be observed delivering the first chunk before the
  // upstream finishes (no full-body buffering).
  app.get("/stream", (_req, reply) => {
    reply.raw.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    let n = 0;
    const total = 4;
    const tick = () => {
      if (n < total) {
        reply.raw.write(`chunk-${n}\n`);
        n += 1;
        setTimeout(tick, 50);
      } else {
        reply.raw.end("done\n");
      }
    };
    tick();
  });

  // x402 paid resource (Plan 02 plug point). First hit → 402 + requirements;
  // retry with X-PAYMENT → 200 + X-PAYMENT-RESPONSE.
  app.get("/paid", (req, reply) => {
    if (req.headers["x-payment"]) {
      const settle = Buffer.from(
        JSON.stringify({ success: true, transaction: "0xMOCKTX", network: "arc-testnet" }),
      ).toString("base64");
      return reply
        .header("X-PAYMENT-RESPONSE", settle)
        .send({ data: "protected resource (paid)" });
    }
    return reply.code(402).send({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "arc-testnet", // Arc → proves the Arc-permissive schema in Plan 02
          maxAmountRequired: "1000",
          resource: "https://upstream/paid",
          description: "demo resource",
          mimeType: "application/json",
          payTo: "0xPayee",
          maxTimeoutSeconds: 60,
          asset: "0xUSDC",
        },
      ],
    });
  });

  return app;
}

const MOCK_PORT = Number(process.env.MOCK_PORT ?? 4021);

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = buildMockUpstream();
  app
    .listen({ port: MOCK_PORT, host: "0.0.0.0" })
    .then(() => console.log(`mock x402 upstream listening on :${MOCK_PORT}`))
    .catch((err) => {
      console.error("failed to start mock upstream:", err);
      process.exit(1);
    });
}
