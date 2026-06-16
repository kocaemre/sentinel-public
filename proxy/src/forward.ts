import { pipeline } from "node:stream/promises";
import { request, type Dispatcher } from "undici";
import type { FastifyReply, FastifyRequest } from "fastify";
import { forwardableHeaders, stripHopByHop } from "./headers.js";

/**
 * Forward the agent's request to the decoded upstream target and, for any non-402
 * response, stream the body straight back with zero buffering (D-10, PROXY-02).
 *
 * undici `request()` resolves as soon as the response *headers* arrive, exposing
 * `{ statusCode, headers, body }` BEFORE the body is consumed — so we can branch on
 * status without buffering. The body is single-use: it must be consumed (via
 * `pipeline`) or `dump()`-ed exactly once on every path, including early returns
 * (RESEARCH Pitfall 6).
 *
 * The `statusCode === 402` branch is the Plan 02 plug point: it currently
 * fail-closes (D-09). Plan 02 replaces it with the hold → parse → decide → build
 * X-PAYMENT → replay loop.
 */
export async function forwardAndStream(
  target: URL,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const upstream = await request(target.href, {
    // Fastify's req.method is a string; undici expects its Dispatcher.HttpMethod union.
    method: req.method as Dispatcher.HttpMethod,
    headers: forwardableHeaders(req.headers) as Record<string, string | string[]>,
    // Request body buffered by the passthrough content-type parser (parseAs:'buffer').
    // GET/HEAD have no body; undici rejects a body on those, so omit it.
    body: hasBody ? (req.body as Buffer | undefined) : undefined,
  });

  if (upstream.statusCode === 402) {
    // ── Plan 02 plug point ──────────────────────────────────────────────────
    // Plan 02 replaces this branch with: buffer the 402 → parse PaymentRequirements
    // (Arc-permissive Zod) → decision seam → build fake-signed X-PAYMENT → replay →
    // return the final 200. For Plan 01 we fail-closed (D-09) and never silently pay.
    await upstream.body.dump(); // consume the single-use body exactly once
    reply.code(502).send({ error: "402 handling not yet implemented (Plan 02)" });
    return;
  }

  // ── FAST PATH (non-402): stream upstream → agent, zero buffering, SSE/chunked-safe ──
  reply.hijack(); // Sentinel owns the socket; Fastify must not also send a response
  reply.raw.writeHead(
    upstream.statusCode,
    stripHopByHop(upstream.headers) as Record<string, string | string[]>,
  );
  await pipeline(upstream.body, reply.raw);
}
