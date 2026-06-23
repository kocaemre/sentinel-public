/**
 * HTTP read client for the dashboard (DIST-02, D-03).
 *
 * The dashboard no longer opens a shared SQLite file (the Phase 4 posture). It now reads
 * the proxy's live audit data over the Cloudflare tunnel — the three JSON read endpoints
 * Plan 01 shipped (`proxy/src/read/endpoints.ts`):
 *
 *   GET /api/metrics       → { screened, blocked, protectedAtomic, byType, distinctAgents }
 *   GET /api/feed?limit=N  → { feed: AuditRecord[] }   (limit clamped 1..200 by the proxy)
 *   GET /api/verdict/:id   → { verdict: AuditRecord } | 404 | 400
 *
 * BASE URL (threat T-05-08): `SENTINEL_API_BASE_URL` is a PLAIN server env var — NEVER
 * `NEXT_PUBLIC_`-prefixed (Pitfall 5). It is read at request time on the server (this
 * module is only reached through `db.ts`, which carries `import "server-only"`), so the
 * tunnel URL never ships in the client bundle.
 *
 * MONEY IS ATOMIC-UNIT STRING (threat T-05-09): `protectedAtomic` / `amount_atomic` /
 * `protected_atomic` flow through as STRINGS, untouched — never `Number()`-coerced here.
 * The page formats human USDC via its `formatUsdc` BigInt helper at render only, so a
 * value past 2^53 survives the HTTP boundary with no float loss.
 *
 * CACHE (CLAUDE.md / threat T-05-05): every fetch uses `{ cache: "no-store" }` — the
 * audit data is live; a cached snapshot would misreport traction.
 *
 * FAIL-LOUD: a non-OK response throws a clear `Error` so the route handlers / the page's
 * poll loop surface the error state rather than rendering malformed data.
 */
import type {
  AuditRecord,
  DashboardMetrics,
  AttackBucket,
} from "./queries";

export type { AuditRecord, DashboardMetrics, AttackBucket } from "./queries";

/** The tunnel base URL — a PLAIN server env var (NOT `NEXT_PUBLIC_`). */
function baseUrl(): string {
  const base = process.env.SENTINEL_API_BASE_URL;
  if (!base) {
    throw new Error(
      "SENTINEL_API_BASE_URL is not set — point it at the proxy tunnel URL " +
        "(e.g. https://sentinel.<dev-domain>), a PLAIN server env var (NOT NEXT_PUBLIC_).",
    );
  }
  return base;
}

/**
 * Fetch + parse one JSON read endpoint over the tunnel. `no-store` (live data); a non-OK
 * response throws so callers surface the error state rather than rendering bad data.
 */
async function readJson<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`sentinel read ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Three headline numbers + by-type buckets + the honest distinct-agents count.
 * `protectedAtomic` is returned as the EXACT atomic-unit STRING the proxy sent — never
 * coerced to a Number (Pitfall 4).
 */
export async function getMetrics(): Promise<DashboardMetrics> {
  const m = await readJson<DashboardMetrics>("/api/metrics");
  return m;
}

/** Most-recent decisions first, capped at `limit` — the live verdict feed (OBS-02). */
export async function getFeed(limit: number): Promise<AuditRecord[]> {
  const body = await readJson<{ feed: AuditRecord[] }>(
    `/api/feed?limit=${encodeURIComponent(limit)}`,
  );
  return body.feed ?? [];
}

/**
 * A single decision by id — the per-verdict drill-down (OBS-03), or undefined when the
 * proxy replies 404 (mirrors the Phase 4 `getVerdict` contract: a missing id is not an
 * error, it is `undefined`).
 */
export async function getVerdict(id: number): Promise<AuditRecord | undefined> {
  const res = await fetch(`${baseUrl()}/api/verdict/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`sentinel read /api/verdict/${id} -> ${res.status}`);
  }
  const body = (await res.json()) as { verdict: AuditRecord };
  return body.verdict;
}

/**
 * Attacks-blocked-by-type buckets. The proxy carries them on the `/api/metrics` `byType`
 * field (matching the Plan-01 shape), so this reads that endpoint and returns the buckets.
 */
export async function getAttacksByType(): Promise<AttackBucket[]> {
  const m = await readJson<DashboardMetrics & { byType?: AttackBucket[] }>(
    "/api/metrics",
  );
  return m.byType ?? [];
}
