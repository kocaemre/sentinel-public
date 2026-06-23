import type { NextConfig } from "next";

/**
 * Sentinel live dashboard — Next.js 15 App Router config.
 *
 * The dashboard now reads the proxy over HTTP (`lib/api-client.ts`) and no longer
 * depends on the native better-sqlite3 addon (Plan 05-02 dropped it). The previous
 * `serverExternalPackages: ["better-sqlite3"]` carve-out was REMOVED: listing a
 * package that is not a dashboard dependency makes the server runtime fail to resolve
 * it on Vercel (FUNCTION_INVOCATION_FAILED on every route). No carve-out is needed —
 * `lib/db.ts` stays `import "server-only"` and the read routes stay `runtime = "nodejs"`.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
