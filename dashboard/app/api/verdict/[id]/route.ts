/**
 * GET /api/verdict/[id] — the per-verdict drill-down (OBS-03).
 *
 * Returns the full audit row backing one decision: rationale (`reasons`),
 * `matched_attack`, `injection_detected`, `protected_atomic`, and the real
 * `settlement_tx` (NULL on a block/step-up or a stub allow). 404 JSON if the id is
 * absent or malformed. `runtime = "nodejs"` (native better-sqlite3 — RESEARCH Pitfall 4).
 * READS only. `Cache-Control: no-store` — the drill-down is live.
 *
 * Next.js 15: route `params` is a Promise and must be awaited.
 */
import { getVerdict } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const numId = Number.parseInt(id, 10);
  if (!Number.isInteger(numId) || numId < 1) {
    return Response.json(
      { error: "invalid id" },
      { status: 400, headers: NO_STORE },
    );
  }

  const verdict = await getVerdict(numId);
  if (!verdict) {
    return Response.json(
      { error: "verdict not found" },
      { status: 404, headers: NO_STORE },
    );
  }

  return Response.json({ verdict }, { headers: NO_STORE });
}
