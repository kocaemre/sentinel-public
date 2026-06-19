import { pipeline } from "node:stream/promises";
import { request, type Dispatcher } from "undici";
import type { FastifyReply, FastifyRequest } from "fastify";
import { decodeXPaymentResponse } from "x402/shared";
import { forwardableHeaders, stripHopByHop } from "./headers.js";
import { parsePaymentRequired } from "./x402/parse.js";
import { buildStubXPayment } from "./x402/build.js";
import { decide, getCommitStores } from "./decision/stub.js";
import { canonicalPaymentId } from "./policy/identity.js";
import { reqAmountAtomic } from "./policy/amount.js";
import type { DecisionContext } from "@sentinel/shared";
import type { SettlementAdapter } from "./settlement/adapter.js";
import type { AuditRow } from "./policy/audit.js";

/**
 * The injected settlement adapter (real↔stub). The server wires it once at boot via
 * `configureSettlement`; the `allow` branch below routes through it (D-01). Until wired
 * (the unit/e2e paths that never boot the server), it is null and the allow branch uses
 * the EXACT Phase 1-3 stub path inline — preserving every legacy behavior.
 */
let settlementAdapter: SettlementAdapter | null = null;

/** Wire the settlement adapter into the hot path (mirrors `configureDecision`). */
export function configureSettlement(adapter: SettlementAdapter | null): void {
  settlementAdapter = adapter;
}

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
 * Read the external agent's identity off the request headers (Phase 5, D-06/D-07).
 *
 *  - `source`: the un-spoofable `CF-Connecting-IP` Cloudflare's edge SETS (overwrites)
 *    — the honest distinct-agent key. Null when absent (a direct/local hit).
 *  - `agent_label`: the OPTIONAL `X-Sentinel-Agent` self-label, clamped to 64 chars
 *    (stored-injection defence is the parameterized INSERT; the clamp bounds size).
 *    Never required for counting — the count is on `source`.
 */
function readAgentIdentity(req: FastifyRequest): { source: string | null; agent_label: string | null } {
  const source = (req.headers["cf-connecting-ip"] as string | undefined) ?? null;
  const agent_label = (req.headers["x-sentinel-agent"] as string | undefined)?.slice(0, 64) ?? null;
  return { source, agent_label };
}

/**
 * Append ONE row to the append-only audit log for a block/step-up decision (OBS-01).
 *
 * Defensive by design: the unit/e2e paths that never boot the server have no commit
 * stores (`getCommitStores()` null), so the write is skipped silently; and a write
 * failure is logged-and-swallowed — a block return must NEVER be turned into a pass
 * by an audit error (fail-closed posture, the 402 send below is unconditional).
 */
function writeAudit(req: FastifyRequest, row: AuditRow): void {
  const stores = getCommitStores();
  if (!stores) return;
  try {
    stores.audit.insert(row);
  } catch (err) {
    req.log.warn({ err: (err as Error).message }, "audit write failed (block decision unaffected)");
  }
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

    // (2) Parse into typed PaymentRequirements AND build the decision context —
    // fail-closed on malformed input or an invalid atomic amount (D-09 / CR-01).
    //
    // `reqAmountAtomic` re-asserts the non-negative-integer invariant and THROWS on a
    // hostile amount ("-50000000", "0x10", "1e3"). It is inside THIS try so a throw
    // fails closed with the controlled 502 shape instead of escaping to Fastify's
    // default handler (the bare BigInt() previously ran outside any try/catch).
    //
    // Open Q2 (RESOLVED): compute the canonical HTTP-layer replay identity from
    // the ALREADY-PARSED upstream 402 BEFORE the decision. `paymentId` is
    // canonicalPaymentId(requirements) over the STABLE upstream fields; `resourceId`
    // is requirements.resource. The per-call X-PAYMENT nonce STAYS minted inside
    // buildStubXPayment AFTER the decision — it is NOT the replay key (D-11,
    // POLICY-06, threat T-02-17), so no nonce-before-decide restructure is needed.
    let ctx: DecisionContext;
    try {
      const requirements = parsePaymentRequired(raw);
      ctx = {
        requirements,
        targetHost: target.host,
        amountAtomic: reqAmountAtomic(requirements.maxAmountRequired),
        paymentId: canonicalPaymentId(requirements),
        resourceId: requirements.resource,
        resource: requirements.resource,
        // D-02: route the attacker-influenced 402 description through the judge's
        // screened-context channel in PRODUCTION (not just the prompt.ts fallback),
        // so the injection-in-description catch path is live and regression-guarded.
        context: requirements.description,
      };
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "unparseable 402 — fail-closed");
      return failClosed(reply, "unparseable 402");
    }
    const requirements = ctx.requirements;

    // (Phase 5, D-06/D-07) The external agent's un-spoofable edge IP (+ optional
    // self-label) for honest distinct-agent attribution — read once, stamped on BOTH
    // audit branches below. Attacker-influenced values are bound as DATA via the
    // parameterized INSERT (audit.ts); the label is length-clamped (T-05-03).
    const { source, agent_label } = readAgentIdentity(req);

    // (3) Decision seam (Phase 2 deterministic gate: PRE → [judge slot] → POST).
    const verdict = await decide(ctx);
    if (verdict.decision !== "allow") {
      req.log.info(
        { decision: verdict.decision, reasons: verdict.reasons, control: verdict.control },
        "payment blocked by decision seam",
      );
      // (OBS-01) Persist the block to the append-only audit log BEFORE the 402 send —
      // exactly one row per decision (this write is OUTSIDE runControls, so the PRE/POST
      // double-evaluate never double-writes). settlement_tx is NULL: nothing settled.
      // ADDITIVE to the pino log + the no-store discipline; a write failure must NEVER
      // turn a block into a pass (the block return below is unconditional).
      writeAudit(req, {
        decided_at: Date.now(),
        decision: verdict.decision,
        control: verdict.control ?? null,
        matched_attack: verdict.matched_attack ?? null,
        injection_detected: verdict.injection_detected ? 1 : 0,
        reasons: JSON.stringify(verdict.reasons ?? []),
        amount_atomic: ctx.amountAtomic.toString(),
        protected_atomic: verdict.protectedAmountAtomic ?? null,
        target_host: ctx.targetHost,
        resource: ctx.resource,
        settlement_tx: null,
        source,
        agent_label,
      });
      // Block response carries the NAMED control + the protected atomic amount
      // (D-09/D-10), with Cache-Control: no-store (CLAUDE.md, never cache a block).
      reply
        .code(402)
        .header("Cache-Control", "no-store")
        .send({
          error: "payment blocked",
          decision: verdict.decision,
          reasons: verdict.reasons,
          control: verdict.control,
          protectedAmountAtomic: verdict.protectedAmountAtomic,
          matched_attack: verdict.matched_attack,
          injection_detected: verdict.injection_detected,
        });
      return;
    }

    // (4) SETTLE the allowed payment via the injected adapter (Plan 04-01). Two paths:
    //   • REAL: the GatewayClient does its OWN 402→sign→settle round-trip — no manual
    //     X-PAYMENT replay here. The `settled`/`txHash` it returns ARE the confirmed
    //     on-chain signal (INTEG-04). The in-process cap backstop fires inside it (D-02).
    //   • STUB (default, OR real-but-keyless fallback D-01): preserve the EXACT Phase 1-3
    //     buildStubXPayment + manual replay below, gated on the upstream-200.
    // No adapter wired (unit/e2e that never boot the server) → legacy stub path.
    // CR-01 / D-02a: thread the DECIDED requirements so the REAL path binds the on-chain
    // payment to the 402 decide() approved (a GatewayClient round-trip that re-fetches a
    // DIFFERENT 402 — higher amount, redirected payTo, swapped asset/network — fails closed).
    const outcome = settlementAdapter
      ? await settlementAdapter(target, {
          amountAtomic: ctx.amountAtomic,
          payTo: requirements.payTo,
          asset: requirements.asset,
          network: requirements.network,
        })
      : null;

    // The settle gate inputs the commit-once block is keyed on (INTEG-04): a CONFIRMED
    // settle AND a transaction reference. Computed per path below.
    let settled = false;
    let settlementTx: string | undefined;
    // For the stub/legacy path we still stream the upstream 200 body back; the real path
    // returns the GatewayClient's already-fetched data, so there is no undici retry body.
    let retry: Dispatcher.ResponseData | null = null;

    if (outcome && outcome.mode === "real") {
      // REAL: gate strictly on the adapter's confirmed settle signal. An unconfirmed
      // settle (settled:false / no tx) fails closed with NO grant (INTEG-04 / D-01a) —
      // never a fabricated 200, never a manual stub replay on the real path.
      settled = outcome.settled;
      settlementTx = outcome.txHash;
      if (!settled || !settlementTx) {
        req.log.warn({ host: target.host }, "real settlement not confirmed — fail-closed");
        return failClosed(reply, "settlement not confirmed");
      }
    } else {
      // STUB / legacy: the exact Phase 1-3 path. If the adapter ran in stub mode it has
      // already signalled `settled:true`; if no adapter is wired we behave exactly as
      // before. Either way the upstream-200 of the manual replay is the stub settle.

      // (4a) Build the fake-signed X-PAYMENT — fail-closed on throw (D-09).
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

      // The upstream 200 is the stub settle. Mint a stub tx ref from the X-PAYMENT so
      // the commit gate `settled && txHash` is UNIFORM across stub and real (the stub
      // ref is clearly non-on-chain; the audit/dashboard treat it as the stub marker).
      settled = true;
      settlementTx = `stub:${ctx.paymentId}`;
    }

    // ── POST-SETTLEMENT COMMIT (RESEARCH Pitfall 2, CR-02, INTEG-04) ─────────
    // Gate the commit-once block on the CONFIRMED settle signal — never on pay()
    // resolution alone (real) and never on the block/fail-closed branches (those
    // returned early). All three commits reflect only CONFIRMED settlements:
    //   • dedup.markFirstSeen — the replay request-identity mark. Bound to SETTLEMENT
    //     (here), NOT to the allow decision (CR-02): a payment allowed-but-failed
    //     before settlement must NOT block the agent's legitimate retry. The read-only
    //     `wasSeen` check in runControls still blocks a duplicate of a SETTLED payment
    //     (SC#4). markFirstSeen's INSERT ... ON CONFLICT is the atomic claim.
    //   • ledger.recordSettlement — feeds the rolling-window budget/velocity ledger.
    //   • wallet.settle — debits the simulated balance (the displayed wallet number).
    if (settled && settlementTx) {
      const stores = getCommitStores();
      if (stores) {
        stores.dedup.markFirstSeen(ctx.paymentId, ctx.resourceId);
        stores.ledger.recordSettlement(ctx.amountAtomic);
        stores.wallet.settle(ctx.amountAtomic);
        // (OBS-01) Persist the allow to the append-only audit log INSIDE the settle
        // gate, carrying the real settlement_tx — a stub-mode allow's `stub:<id>` ref
        // is recorded as NULL (no on-chain tx). Exactly one row per decision; the audit
        // write is wrapped so a write failure can NEVER undo or block a settled grant.
        const settlementTxForAudit = settlementTx.startsWith("stub:") ? null : settlementTx;
        try {
          stores.audit.insert({
            decided_at: Date.now(),
            decision: "allow",
            control: null,
            matched_attack: verdict.matched_attack ?? null,
            injection_detected: verdict.injection_detected ? 1 : 0,
            reasons: JSON.stringify(verdict.reasons ?? []),
            amount_atomic: ctx.amountAtomic.toString(),
            protected_atomic: null,
            target_host: ctx.targetHost,
            resource: ctx.resource,
            settlement_tx: settlementTxForAudit,
            source,
            agent_label,
          });
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, "audit write failed (settled grant unaffected)");
        }
      }
    } else {
      // Defensive: any path reaching here without a confirmed settle fails closed.
      return failClosed(reply, "settlement not confirmed");
    }

    // ── RETURN to the agent ───────────────────────────────────────────────────
    if (retry) {
      // STUB / legacy: stream the upstream 200 body back with Cache-Control: no-store.
      const settleHeader = retry.headers["x-payment-response"];
      if (typeof settleHeader === "string") {
        try {
          req.log.info({ settle: decodeXPaymentResponse(settleHeader) }, "x402 settle response");
        } catch {
          // Non-fatal: a malformed/foreign settle header is logged-and-ignored.
        }
      }
      reply.hijack();
      reply.raw.writeHead(retry.statusCode, {
        ...(stripHopByHop(retry.headers) as Record<string, string | string[]>),
        "Cache-Control": "no-store",
      });
      await pipeline(retry.body, reply.raw);
      return;
    }

    // REAL: the GatewayClient already fetched the resource. Return a controlled 200
    // with the confirmed tx ref, Cache-Control: no-store (CLAUDE.md, never cache a paid
    // response). The full resource body flows in Plan 02's audit; the agent gets the
    // settle confirmation here.
    reply
      .code(200)
      .header("Cache-Control", "no-store")
      .send({ settled: true, transaction: settlementTx });
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
