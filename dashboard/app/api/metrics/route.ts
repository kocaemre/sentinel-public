/**
 * GET /api/metrics — the 3 headline numbers + attacks-by-type, in one poll (OBS-02/03).
 *
 * `runtime = "nodejs"` (RESEARCH Pitfall 4): better-sqlite3 is a native addon with no
 * edge support, so this handler must run on the Node runtime. It READS only (the proxy
 * is the sole writer — no audit-tampering surface). `protectedAtomic` is returned as an
 * atomic-unit STRING (BigInt-summed in the db layer); the client formats it to human
 * USDC for display only — float money math never re-enters the data layer.
 *
 * `Cache-Control: no-store` (CLAUDE.md no-cache discipline): the dashboard data is live;
 * never serve a stale audit snapshot.
 */
import { getMetrics, getAttacksByType } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [metrics, byType] = await Promise.all([getMetrics(), getAttacksByType()]);
  return Response.json(
    { ...metrics, byType },
    { headers: { "Cache-Control": "no-store" } },
  );
}
