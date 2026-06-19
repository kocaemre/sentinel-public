import type { FastifyInstance } from "fastify";
import { getCommitStores } from "../decision/stub.js";

/**
 * Public JSON read endpoints (DIST-02, D-03) — the read contract the Vercel dashboard
 * fetches over the Cloudflare tunnel, mirroring `dashboard/lib/queries.ts` 1:1:
 *
 *   GET /api/metrics       → { screened, blocked, protectedAtomic, byType, distinctAgents }
 *   GET /api/feed?limit=N  → { feed: AuditRecord[] }   (limit clamped 1..200)
 *   GET /api/verdict/:id   → { verdict: AuditRecord } | 404 | 400
 *
 * MONEY IS ATOMIC-UNIT TEXT (threat T-05-09): `protectedAtomic` / `amount_atomic` /
 * `protected_atomic` flow through as STRINGS — never `Number()`-coerced — so the
 * dashboard formats human USDC at render with no float loss.
 *
 * CACHE (CLAUDE.md / threat T-05-05): every response sets `Cache-Control: no-store` —
 * the audit data is live; a stale snapshot would misreport traction.
 *
 * FAIL-SOFT (T-05-05): the unit/e2e paths and a not-yet-booted decision seam have no
 * commit stores; the routes reply 503 JSON instead of crashing the process.
 */

// Feed limit bounds — copied verbatim from dashboard/app/api/feed/route.ts.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The dev's own source to exclude from the honest distinct-agents count (D-07).
 * Wired once at boot by the server (mirrors `configureSettlement`). Empty by default
 * → excludes nothing.
 */
let devSource = "";

/** Wire the dev-exclusion source into the read endpoints (mirrors configureSettlement). */
export function configureReadEndpoints(source: string): void {
  devSource = source;
}

/**
 * Register the three JSON read endpoints on the Fastify instance. MUST be called
 * BEFORE the `app.all("/*")` proxy catch-all so the read routes are not swallowed by
 * it (server.ts registers in that order).
 */
export function registerReadEndpoints(app: FastifyInstance): void {
  app.get("/api/metrics", async (_req, reply) => {
    const stores = getCommitStores();
    if (!stores) {
      return reply
        .code(503)
        .header("Cache-Control", "no-store")
        .send({ error: "audit store not ready" });
    }
    const audit = stores.audit;
    // Money stays a STRING via metrics().protectedAtomic — never Number()-ed here.
    return reply.header("Cache-Control", "no-store").send({
      ...audit.metrics(),
      byType: audit.attacksByType(),
      distinctAgents: audit.distinctAgents(devSource),
    });
  });

  app.get("/api/feed", async (req, reply) => {
    const stores = getCommitStores();
    if (!stores) {
      return reply
        .code(503)
        .header("Cache-Control", "no-store")
        .send({ error: "audit store not ready" });
    }
    // Clamp `limit` to 1..200 (copy of the dashboard clamp) so a hostile query string
    // cannot ask for an unbounded scan.
    const raw = (req.query as Record<string, string | undefined>)?.limit;
    let limit = DEFAULT_LIMIT;
    if (raw !== undefined && raw !== null) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) limit = Math.min(Math.max(parsed, 1), MAX_LIMIT);
    }
    return reply
      .header("Cache-Control", "no-store")
      .send({ feed: stores.audit.recentFeed(limit) });
  });

  app.get("/api/verdict/:id", async (req, reply) => {
    const stores = getCommitStores();
    if (!stores) {
      return reply
        .code(503)
        .header("Cache-Control", "no-store")
        .send({ error: "audit store not ready" });
    }
    const { id } = req.params as { id: string };
    const numId = Number.parseInt(id, 10);
    if (!Number.isInteger(numId) || numId < 1) {
      return reply
        .code(400)
        .header("Cache-Control", "no-store")
        .send({ error: "invalid id" });
    }
    const verdict = stores.audit.byId(numId);
    if (!verdict) {
      return reply
        .code(404)
        .header("Cache-Control", "no-store")
        .send({ error: "verdict not found" });
    }
    return reply.header("Cache-Control", "no-store").send({ verdict });
  });
}
