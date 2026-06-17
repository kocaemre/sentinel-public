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

  // x402 paid resource (Plan 02). First hit → 402 + requirements; retry with
  // X-PAYMENT → 200 + X-PAYMENT-RESPONSE. The mock counts hits per path so the
  // e2e can assert exactly two upstream hits (402 then X-PAYMENT→200).
  app.get("/paid", (req, reply) => {
    bumpHit(app, "/paid");
    if (req.headers["x-payment"]) {
      const settle = Buffer.from(
        JSON.stringify({ success: true, transaction: "0xMOCKTX", network: "arc-testnet" }),
      ).toString("base64");
      return reply
        .header("X-PAYMENT-RESPONSE", settle)
        .send({ data: "protected resource (paid)" });
    }
    return reply.code(402).send(paymentRequired());
  });

  // Variant: returns a MALFORMED 402 body (not valid JSON requirements) so the
  // proxy's parse step fails closed (D-09). Used by the Plan 02 e2e.
  app.get("/paid-malformed", (req, reply) => {
    bumpHit(app, "/paid-malformed");
    if (req.headers["x-payment"]) {
      // Should never be reached: the proxy must fail closed before retrying.
      return reply.send({ data: "should not happen" });
    }
    reply.code(402).type("application/json").send("this is not valid json {");
  });

  // Variant: behaves like /paid but records the X-PAYMENT header it receives on
  // the retry on `app.lastXPayment`, so the e2e can decode + assert its fields.
  app.get("/paid-capture", (req, reply) => {
    bumpHit(app, "/paid-capture");
    const xp = req.headers["x-payment"];
    if (typeof xp === "string") {
      (app as WithHits).lastXPayment = xp;
      return reply.send({ data: "protected resource (paid)" });
    }
    return reply.code(402).send(paymentRequired("https://upstream/paid-capture"));
  });

  // MALICIOUS variant (D-01 headline overpayment drain): demands ~50 USDC
  // (maxAmountRequired "50000000" atomic) for a resource the legit /paid sells for
  // 0.001 USDC. Shaped IDENTICALLY to the legit 402 except the amount + resource,
  // so the overpayment/per-call-cap controls (Plan 02) are the clean trip — no
  // network/payTo/asset difference muddies the signal (RESEARCH A5). Settles (200)
  // on any x-payment header: this server is the attacker, it carries NO defense.
  app.get("/paid-overpriced", (req, reply) => {
    bumpHit(app, "/paid-overpriced");
    if (req.headers["x-payment"]) {
      const settle = Buffer.from(
        JSON.stringify({ success: true, transaction: "0xMOCKTX", network: "arc-testnet" }),
      ).toString("base64");
      return reply
        .header("X-PAYMENT-RESPONSE", settle)
        .send({ data: "protected resource (overpriced)" });
    }
    return reply
      .code(402)
      .send(paymentRequired("https://upstream/paid-overpriced", "50000000"));
  });

  // Variant: returns a normal 402 first, then 500 on the X-PAYMENT retry, so the
  // proxy's retry-error path fails closed and never fabricates a success (D-09).
  app.get("/paid-retry500", (req, reply) => {
    bumpHit(app, "/paid-retry500");
    if (req.headers["x-payment"]) {
      return reply.code(500).send({ error: "upstream blew up on retry" });
    }
    return reply.code(402).send(paymentRequired("https://upstream/paid-retry500"));
  });

  return app;
}

/**
 * The canonical Arc-network 402 requirements body (proves the Arc-permissive schema).
 *
 * `amount` defaults to the legit baseline "1000" (0.001 USDC). The malicious
 * /paid-overpriced route passes "50000000" (50 USDC) — ONLY the amount + resource
 * differ from the legit 402 so Plan 02's per-call-cap is the clean trip (RESEARCH A5).
 */
function paymentRequired(resource = "https://upstream/paid", amount = "1000") {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "arc-testnet", // Arc → proves the Arc-permissive schema in Plan 02
        maxAmountRequired: amount,
        resource,
        description: "demo resource",
        mimeType: "application/json",
        payTo: "0xPayee",
        maxTimeoutSeconds: 60,
        asset: "0xUSDC",
      },
    ],
  };
}

/**
 * Per-instance e2e introspection: a per-path hit counter (asserts the two
 * upstream hits — 402 then X-PAYMENT→200) and the last X-PAYMENT header received.
 */
type WithHits = FastifyInstance & {
  hits?: Record<string, number>;
  lastXPayment?: string;
};
function bumpHit(app: FastifyInstance, path: string): void {
  const a = app as WithHits;
  if (!a.hits) a.hits = {};
  a.hits[path] = (a.hits[path] ?? 0) + 1;
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
