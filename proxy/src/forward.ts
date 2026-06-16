import { pipeline } from "node:stream/promises";
import { request, type Dispatcher } from "undici";
import type { FastifyReply, FastifyRequest } from "fastify";
import { decodeXPaymentResponse } from "x402/shared";
import { forwardableHeaders, stripHopByHop } from "./headers.js";
import { parsePaymentRequired } from "./x402/parse.js";
import { buildStubXPayment } from "./x402/build.js";
import { decide } from "./decision/stub.js";
import type { DecisionContext } from "@sentinel/shared";

/**
 * Max bytes Sentinel will buffer from a held 402 body before failing closed.
 * The 402 challenge is tiny JSON; an oversized/streamed 402 is an abuse signal,
 * not a legitimate payment requirement (RESEARCH Assumption A4 / Pitfall 6, DoS).
 */
const MAX_402_BODY_BYTES = 64 * 1024;

/** Fail-closed: never return the raw 402, never fabricate a paid success (D-09). */
function failClosed(reply: FastifyReply, reason: string): void {
  reply.code(502).send({ error: "payment blocked (fail-closed)", reason });
}

/**
 * Forward the agent's request to the decoded upstream target.
 *
 * Two paths, branched on the upstream status BEFORE the body is consumed (undici
 * `request()` resolves on headers):
 *
 *  • NON-402 (FAST PATH, D-10): stream the body straight back, zero buffering.
 *
 *  • 402 (SLOW PATH — the x402 hold-and-replay loop, D-05/D-07/D-09): the agent
 *    NEVER sees the 402 (Sentinel is the x402 client). Sentinel buffers ONLY the
 *    402 body, Zod-parses it into typed PaymentRequirements (fail-closed on
 *    malformed), runs the decision seam, builds a fake-signed X-PAYMENT, replays
 *    the request, and returns the upstream 200 with `Cache-Control: no-store`.
 *    Every parse/build/retry error fails closed — never a fabricated pay.
 *
 * undici bodies are single-use: each must be consumed (`pipeline`/`text`) or
 * `dump()`-ed exactly once on every path, including early/fail-closed returns
 * (RESEARCH Pitfall 6).
 */
export async function forwardAndStream(
  target: URL,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const method = req.method as Dispatcher.HttpMethod;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const reqBody = hasBody ? (req.body as Buffer | undefined) : undefined;

  // undici request() REJECTS on transport-level failure (DNS, ECONNREFUSED, TLS,
  // reset, timeout). Wrap it so an unreachable upstream fails closed with the
  // controlled 502 shape + an audit log, instead of escaping into Fastify's
  // default error handler (T-01-07 / CR-02).
  let upstream: Dispatcher.ResponseData;
  try {
    upstream = await request(target.href, {
      method,
      headers: forwardableHeaders(req.headers) as Record<string, string | string[]>,
      body: reqBody,
    });
  } catch (err) {
    req.log.warn({ err: (err as Error).message, host: target.host }, "upstream unreachable — fail-closed");
    return failClosed(reply, "upstream unreachable");
  }

  // ── SLOW PATH (402): x402 hold → parse → decide → build → replay → return ──
  if (upstream.statusCode === 402) {
    // (1) Buffer ONLY the 402 body (D-10), with a size cap (Assumption A4).
    let raw: string;
    try {
      raw = await readCapped(upstream.body, MAX_402_BODY_BYTES);
    } catch (err) {
      // dump() is unnecessary here: readCapped fully consumed or destroyed the body.
      req.log.warn({ err: (err as Error).message }, "402 body read failed");
      return failClosed(reply, "402 body too large or unreadable");
    }

    // (2) Parse into typed PaymentRequirements — fail-closed on malformed (D-09).
    let requirements;
    try {
      requirements = parsePaymentRequired(raw);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "unparseable 402 — fail-closed");
      return failClosed(reply, "unparseable 402");
    }

    // (3) Decision seam (Phase 1 stub → always allow; Phase 2/3 replace it).
    const ctx: DecisionContext = { requirements, targetHost: target.host };
    const verdict = decide(ctx);
    if (verdict.decision !== "allow") {
      req.log.info({ decision: verdict.decision, reasons: verdict.reasons }, "payment blocked by decision seam");
      reply.code(402).send({ error: "payment blocked", decision: verdict.decision, reasons: verdict.reasons });
      return;
    }

    // (4) Build the fake-signed X-PAYMENT — fail-closed on throw (D-09).
    let xPayment: string;
    try {
      xPayment = buildStubXPayment(requirements);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "cannot build X-PAYMENT — fail-closed");
      return failClosed(reply, "cannot build X-PAYMENT");
    }

    // (5) Replay the request to upstream WITH the X-PAYMENT header. A transport
    // failure on the replay must fail closed too — never fabricate a paid 200
    // and never leak an uncontrolled error (T-01-07 / CR-02).
    let retry: Dispatcher.ResponseData;
    try {
      retry = await request(target.href, {
        method,
        headers: {
          ...(forwardableHeaders(req.headers) as Record<string, string | string[]>),
          "X-PAYMENT": xPayment,
        },
        body: reqBody,
      });
    } catch (err) {
      req.log.warn({ err: (err as Error).message, host: target.host }, "X-PAYMENT replay unreachable — fail-closed");
      return failClosed(reply, "upstream unreachable on payment replay");
    }

    // (6) Any retry error fails closed — never fabricate a 200 (D-09).
    if (retry.statusCode >= 400) {
      await retry.body.dump(); // consume the single-use body
      req.log.warn({ status: retry.statusCode }, "upstream retry failed — fail-closed");
      return failClosed(reply, `upstream retry ${retry.statusCode}`);
    }

    // Audit seed: if the upstream returned a settle header, decode + log it and
    // pass it through unchanged (RESEARCH Open Question 2; no behavior depends on it).
    const settleHeader = retry.headers["x-payment-response"];
    if (typeof settleHeader === "string") {
      try {
        req.log.info({ settle: decodeXPaymentResponse(settleHeader) }, "x402 settle response");
      } catch {
        // Non-fatal: a malformed/foreign settle header is logged-and-ignored, passed through verbatim.
      }
    }

    // (7) Return the final 200 to the agent with Cache-Control: no-store (Pitfall 5).
    reply.hijack();
    reply.raw.writeHead(retry.statusCode, {
      ...(stripHopByHop(retry.headers) as Record<string, string | string[]>),
      "Cache-Control": "no-store",
    });
    await pipeline(retry.body, reply.raw);
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

/**
 * Read a undici body to a UTF-8 string, failing if it exceeds `maxBytes`.
 * Consumes the body exactly once; on overflow the body is destroyed (Pitfall 6).
 */
async function readCapped(
  body: Dispatcher.ResponseData["body"],
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      body.destroy();
      throw new Error(`402 body exceeded ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
