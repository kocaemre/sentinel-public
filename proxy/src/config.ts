import { z } from "zod";

/**
 * Sentinel proxy configuration.
 *
 * Sourced from environment variables with sane local-dev defaults. Fail-closed:
 * an invalid config (e.g. a malformed allowlist entry) throws at load time so the
 * proxy never boots into an open-proxy state (D-03, D-09).
 */
export const ConfigSchema = z.object({
  /** Upstream hosts Sentinel is permitted to forward to. Matched against `URL.host` (includes port). */
  allowlist: z.array(z.string().min(1)),
  /** Listen port for the proxy. */
  port: z.number().int().positive(),
  /** pino log level. */
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
  /**
   * Permit allowlisted upstreams that resolve to loopback/RFC1918 ranges.
   * Defaults to false (the secure, fail-closed posture). Enabled ONLY for local
   * development / e2e tests where the mock upstream lives on localhost. In a
   * hosted deployment this stays false so the SSRF guard rejects internal hosts
   * even if mistakenly allowlisted (RESEARCH Pitfall 3).
   */
  allowInternal: z.boolean(),
});

export type Config = z.infer<typeof ConfigSchema> & {
  /** Allowlist materialized as a Set for O(1) membership checks. */
  allowSet: Set<string>;
};

const DEFAULT_MOCK_PORT = 4021;
const DEFAULT_PROXY_PORT = 8787;

/**
 * Load and validate config from the environment. Throws (fail-closed) on invalid input.
 *
 * Env vars:
 *  - SENTINEL_ALLOWLIST : comma-separated upstream hosts (default: the local mock upstream)
 *  - SENTINEL_PORT      : listen port (default 8787)
 *  - SENTINEL_LOG_LEVEL : pino level (default "info")
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawAllow = (env.SENTINEL_ALLOWLIST ?? `localhost:${DEFAULT_MOCK_PORT}`)
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  const candidate = {
    allowlist: rawAllow,
    port: env.SENTINEL_PORT ? Number(env.SENTINEL_PORT) : DEFAULT_PROXY_PORT,
    logLevel: (env.SENTINEL_LOG_LEVEL ?? "info") as z.infer<typeof ConfigSchema>["logLevel"],
    allowInternal: env.SENTINEL_ALLOW_INTERNAL === "true",
  };

  const parsed = ConfigSchema.parse(candidate); // throws ZodError on malformed config → fail-closed
  return { ...parsed, allowSet: new Set(parsed.allowlist) };
}
