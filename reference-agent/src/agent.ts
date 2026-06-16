/**
 * Reference paying-agent — x402-unaware, plain HTTP client (D-05).
 *
 * Demonstrates Success Criterion #1: routing through Sentinel is a single base-URL
 * swap. The agent's effective base URL becomes the proxy host followed by the full
 * upstream URL as a path prefix:
 *
 *   normal:   http://localhost:4021/data
 *   sentinel: http://localhost:8787/http://localhost:4021/data
 *
 * No SDK, no custom header — just the literal base-URL change.
 */

const PROXY = process.env.SENTINEL_BASE ?? "http://localhost:8787";
const UPSTREAM = process.env.UPSTREAM_BASE ?? "http://localhost:4021";

async function main(): Promise<void> {
  // The one-line swap: prepend the proxy origin to the full upstream URL.
  const url = `${PROXY}/${UPSTREAM}/data`;
  console.log(`[reference-agent] GET ${url}`);

  const res = await fetch(url);
  const body = await res.text();
  console.log(`[reference-agent] status=${res.status}`);
  console.log(`[reference-agent] body=${body}`);
}

main().catch((err) => {
  console.error("[reference-agent] request failed:", err);
  process.exit(1);
});
