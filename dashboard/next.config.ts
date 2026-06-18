import type { NextConfig } from "next";

/**
 * Sentinel live dashboard — Next.js 15 App Router config.
 *
 * `serverExternalPackages: ["better-sqlite3"]` keeps the native Node addon OUT of
 * the bundler (RESEARCH Pitfall 4): better-sqlite3 is a compiled `.node` binary with
 * no edge support, so it must stay a runtime `require`, never be webpack-bundled.
 * Combined with `import "server-only"` in `lib/db.ts` and `export const runtime =
 * "nodejs"` on every db-touching route handler, the native module never reaches the
 * client bundle or an edge runtime.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
