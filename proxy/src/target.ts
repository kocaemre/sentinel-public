/**
 * Path-prefix upstream-target decoding (D-02) and the SSRF allowlist guard (D-03).
 *
 * The agent points at Sentinel via a single base-URL swap:
 *   http://<sentinel>/https://api.foo.com/v1/pay?q=1  →  forwarded to api.foo.com
 *
 * The inner URL is reconstructed BYTE-EXACT from `request.raw.url` (not from a
 * Fastify route param, which is path-decoded and can mangle the query string —
 * RESEARCH Pitfall 2). `new URL()` validates the result; garbage throws and the
 * caller fail-closes (D-09).
 */

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Decode the upstream target from the raw request URL.
 *
 * @param rawUrl `request.raw.url`, e.g. "/https://api.foo.com/v1/pay?q=a%20b&x=1"
 * @returns the parsed upstream `URL` (query string + escapes preserved byte-exact)
 * @throws if the inner string is not a valid URL, has no host, or uses a non-http(s) scheme
 */
export function decodeTarget(rawUrl: string): URL {
  // Strip exactly the single leading slash Sentinel's route adds; keep the rest byte-exact.
  const inner = rawUrl.startsWith("/") ? rawUrl.slice(1) : rawUrl;
  if (inner.length === 0) {
    throw new Error("empty target");
  }

  // `new URL()` throws on garbage (no scheme, no host, etc.) → fail-closed (D-09).
  const target = new URL(inner);

  if (!ALLOWED_SCHEMES.has(target.protocol)) {
    throw new Error(`unsupported scheme: ${target.protocol}`);
  }
  if (target.hostname.length === 0) {
    throw new Error("target has no host");
  }
  return target;
}

/**
 * Reject hostnames that resolve to loopback / RFC1918 / link-local / metadata ranges.
 * This is an SSRF guard independent of the allowlist membership check: even an
 * allowlisted entry pointing at an internal address is refused.
 */
function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::") return true;
  // IPv4-mapped IPv6 loopback / link-local
  if (host.startsWith("::ffff:")) return isInternalHost(host.slice("::ffff:".length));
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;

  // IPv4 dotted-quad ranges
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata (169.254.169.254)
    if (a === 0) return true; // 0.0.0.0/8
  }
  return false;
}

/**
 * Throw unless `target.host` is on the allowlist AND the host is not an internal
 * (loopback/RFC1918/link-local/metadata) address. Enforced BEFORE any upstream
 * connection is opened (D-03, RESEARCH Pitfall 3).
 *
 * Note: the allowlist matches on `URL.host` (host + optional port); the SSRF
 * private-range check is performed on `URL.hostname` (no port).
 *
 * @param allowInternal when true, the loopback/RFC1918 guard is relaxed for local
 *   dev / e2e tests where the mock upstream lives on localhost. Defaults to false
 *   (secure posture): an internal host is rejected even if present in the allowlist.
 */
export function assertAllowed(
  target: URL,
  allowlist: Set<string>,
  allowInternal = false,
): void {
  if (!allowInternal && isInternalHost(target.hostname)) {
    throw new Error(`SSRF blocked: internal host ${target.hostname}`);
  }
  if (!allowlist.has(target.host)) {
    throw new Error(`host not allowlisted: ${target.host}`);
  }
}
