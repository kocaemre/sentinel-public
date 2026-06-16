/**
 * Hop-by-hop header hygiene for forwarded requests/responses.
 *
 * Hop-by-hop headers are meaningful only on a single transport hop and MUST NOT
 * be forwarded across Sentinel's TLS-terminate-and-reopen boundary (D-04): doing
 * so enables request smuggling and connection-state confusion. The `Host` header
 * is additionally stripped from forwarded *requests* because Sentinel opens its
 * own upstream connection — forwarding the agent-facing `Host` verbatim breaks
 * upstream SNI / virtual-host routing (RESEARCH Anti-Patterns).
 */

type Headers = Record<string, string | string[] | undefined>;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

/** Return a copy of `headers` with all hop-by-hop headers removed (case-insensitive). */
export function stripHopByHop(headers: Headers): Headers {
  const out: Headers = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Headers safe to forward on a request to the upstream: hop-by-hop headers plus
 * `Host` removed (undici sets the correct upstream Host from the target URL).
 */
export function forwardableHeaders(headers: Headers): Headers {
  const out = stripHopByHop(headers);
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === "host") {
      delete out[key];
    }
  }
  return out;
}
