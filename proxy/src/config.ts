import { z } from "zod";
import { usdcToAtomic } from "./policy/amount.js";

/**
 * Sentinel proxy configuration.
 *
 * Sourced from environment variables with sane local-dev defaults. Fail-closed:
 * an invalid config (e.g. a malformed allowlist entry or a non-numeric cap) throws
 * at load time so the proxy never boots into an open-proxy state (D-03, D-09).
 *
 * Money limits are stored as atomic-unit `bigint` (6-decimal USDC). Human USDC env
 * values are converted via `usdcToAtomic` string-parse — NEVER a float multiply
 * (RESEARCH Pitfall 4). The atomic defaults below are the locked demo values
 * (CONTEXT Claude's Discretion): start 100 / per-call 1 / hourly 5 / daily 20 USDC,
 * velocity 5/min, overpayment 2×, legit /paid price 0.001 USDC.
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

  // ── Deterministic policy limits (Plan 02 + seeded for Plan 03) ──────────────
  /** Per-call cap in atomic units (POLICY-01). Default 1 USDC. */
  perCallCapAtomic: z.bigint().nonnegative(),
  /** Hourly budget in atomic units (Plan 03). Default 5 USDC. */
  hourlyBudgetAtomic: z.bigint().nonnegative(),
  /** Daily budget in atomic units (Plan 03). Default 20 USDC. */
  dailyBudgetAtomic: z.bigint().nonnegative(),
  /** Simulated wallet starting balance in atomic units. Default 100 USDC. */
  startingBalanceAtomic: z.bigint().nonnegative(),
  /** Max payments per velocity window (Plan 03). Default 5. */
  velocityLimit: z.number().int().positive(),
  /** Velocity window in ms (Plan 03). Default 60000 (1 min). */
  velocityWindowMs: z.number().int().positive(),
  /** Overpayment ceiling multiplier vs the expected price (POLICY-07). Default 2. */
  overpaymentMultiplier: z.number().positive(),
  /** Expected price per resource (resource → atomic-string), keyed on `ctx.resource`. */
  expectedPriceMap: z.record(z.string(), z.string()),
  /** Counterparty deny list (payTo/resource) materialized to `denySet` (Plan 03). */
  denylist: z.array(z.string().min(1)),
  /** Shared simulated-wallet SQLite path (same file Plan 01's wallet uses). */
  dbPath: z.string().min(1),

  // ── LLM judge (Plan 03-02 OpenRouter adapter) ───────────────────────────────
  /**
   * OpenRouter model id the judge calls. CONFIG-SWAPPABLE (JUDGE-02): A/B or swap
   * to a sponsor credit by changing one env var. Defaults to a cheap, JSON/
   * structured-output-capable id verified live on openrouter.ai/models — NOT a
   * `:free` model (D-08: free tiers throttle/route to schema-ignoring providers).
   */
  judgeModel: z.string().min(1),
  /** OpenRouter OpenAI-compatible base URL. Default https://openrouter.ai/api/v1. */
  openRouterBaseUrl: z.string().url(),
  /**
   * OpenRouter API key (service secret — env ONLY, never logged). Allowed EMPTY at
   * config-load: the offline e2e path injects a stub judge and never calls OpenRouter.
   * The adapter fails closed to `block` at call time when this is empty, so a live
   * call without a key NEVER silently allows (RESEARCH Runtime State).
   */
  openRouterApiKey: z.string(),
  /**
   * Judge call timeout in ms. On expiry the adapter aborts and fails closed to
   * `block` (D-05). A snappy ceiling — the judge sits on every payment's hot path.
   */
  judgeTimeoutMs: z.number().int().positive(),
});

export type Config = z.infer<typeof ConfigSchema> & {
  /** Allowlist materialized as a Set for O(1) membership checks. */
  allowSet: Set<string>;
  /** Denylist materialized as a Set for O(1) membership checks (Plan 03). */
  denySet: Set<string>;
};

const DEFAULT_MOCK_PORT = 4021;
const DEFAULT_PROXY_PORT = 8787;

// Locked demo limits (human USDC → atomic via string-parse, never float).
const DEFAULT_PER_CALL_USDC = "1"; // 1 USDC
const DEFAULT_HOURLY_USDC = "5"; // 5 USDC
const DEFAULT_DAILY_USDC = "20"; // 20 USDC
const DEFAULT_START_USDC = "100"; // 100 USDC
const DEFAULT_VELOCITY_LIMIT = 5;
const DEFAULT_VELOCITY_WINDOW_MS = 60000;
const DEFAULT_OVERPAYMENT_MULT = 2;
const DEFAULT_DB_PATH = "sentinel-wallet.db"; // shared with Plan 01's wallet (gitignored)
// Cheap, JSON/structured-output-capable judge model verified live on
// openrouter.ai/models (2026-06-17). NOT a `:free` id (D-08). Swap via env.
const DEFAULT_JUDGE_MODEL = "google/gemini-2.5-flash";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_JUDGE_TIMEOUT_MS = 4000; // snappy hot-path ceiling; tune per model latency
// Legit /paid resource sells for 0.001 USDC (1000 atomic) — the overpayment baseline.
const DEFAULT_PRICE_MAP: Record<string, string> = {
  "https://upstream/paid": "1000",
};

/**
 * Load and validate config from the environment. Throws (fail-closed) on invalid input.
 *
 * Env vars:
 *  - SENTINEL_ALLOWLIST     : comma-separated upstream hosts (default: the local mock upstream)
 *  - SENTINEL_PORT          : listen port (default 8787)
 *  - SENTINEL_LOG_LEVEL     : pino level (default "info")
 *  - SENTINEL_ALLOW_INTERNAL: permit loopback/RFC1918 upstreams (default false)
 *  - SENTINEL_PER_CALL_CAP  : per-call cap in HUMAN USDC (default "1")
 *  - SENTINEL_HOURLY_BUDGET : hourly budget in HUMAN USDC (default "5")
 *  - SENTINEL_DAILY_BUDGET  : daily budget in HUMAN USDC (default "20")
 *  - SENTINEL_START_BALANCE : wallet start in HUMAN USDC (default "100")
 *  - SENTINEL_VELOCITY_LIMIT: max payments per window (default 5)
 *  - SENTINEL_OVERPAYMENT_MULT: overpayment ceiling multiplier (default 2)
 *  - SENTINEL_PRICE_MAP     : JSON {resource: atomic-string} (default the legit /paid baseline)
 *  - SENTINEL_DENYLIST      : comma-separated denied counterparties (default empty)
 *  - SENTINEL_DB_PATH       : shared wallet SQLite path (default sentinel-wallet.db)
 *  - SENTINEL_JUDGE_MODEL   : OpenRouter judge model id (default google/gemini-2.5-flash; config-swappable)
 *  - SENTINEL_OPENROUTER_BASE_URL: OpenRouter base URL (default https://openrouter.ai/api/v1)
 *  - OPENROUTER_API_KEY     : OpenRouter API key (SECRET, never logged; default "" → adapter fails closed)
 *  - SENTINEL_JUDGE_TIMEOUT_MS: judge call timeout in ms (default 4000)
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawAllow = (env.SENTINEL_ALLOWLIST ?? `localhost:${DEFAULT_MOCK_PORT}`)
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  const rawDeny = (env.SENTINEL_DENYLIST ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  const priceMap = env.SENTINEL_PRICE_MAP
    ? (JSON.parse(env.SENTINEL_PRICE_MAP) as Record<string, string>)
    : DEFAULT_PRICE_MAP;

  const candidate = {
    allowlist: rawAllow,
    port: env.SENTINEL_PORT ? Number(env.SENTINEL_PORT) : DEFAULT_PROXY_PORT,
    logLevel: (env.SENTINEL_LOG_LEVEL ?? "info") as z.infer<typeof ConfigSchema>["logLevel"],
    allowInternal: env.SENTINEL_ALLOW_INTERNAL === "true",
    // Human USDC → atomic via string-parse (never float). usdcToAtomic throws on a
    // malformed value, which propagates as a fail-closed config error.
    perCallCapAtomic: usdcToAtomic(env.SENTINEL_PER_CALL_CAP ?? DEFAULT_PER_CALL_USDC),
    hourlyBudgetAtomic: usdcToAtomic(env.SENTINEL_HOURLY_BUDGET ?? DEFAULT_HOURLY_USDC),
    dailyBudgetAtomic: usdcToAtomic(env.SENTINEL_DAILY_BUDGET ?? DEFAULT_DAILY_USDC),
    startingBalanceAtomic: usdcToAtomic(env.SENTINEL_START_BALANCE ?? DEFAULT_START_USDC),
    velocityLimit: env.SENTINEL_VELOCITY_LIMIT ? Number(env.SENTINEL_VELOCITY_LIMIT) : DEFAULT_VELOCITY_LIMIT,
    velocityWindowMs: DEFAULT_VELOCITY_WINDOW_MS,
    overpaymentMultiplier: env.SENTINEL_OVERPAYMENT_MULT
      ? Number(env.SENTINEL_OVERPAYMENT_MULT)
      : DEFAULT_OVERPAYMENT_MULT,
    expectedPriceMap: priceMap,
    denylist: rawDeny,
    dbPath: env.SENTINEL_DB_PATH ?? DEFAULT_DB_PATH,
    // LLM judge (Plan 03-02). The API key is read straight from env and NEVER logged.
    judgeModel: env.SENTINEL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
    openRouterBaseUrl: env.SENTINEL_OPENROUTER_BASE_URL ?? DEFAULT_OPENROUTER_BASE_URL,
    openRouterApiKey: env.OPENROUTER_API_KEY ?? "",
    judgeTimeoutMs: env.SENTINEL_JUDGE_TIMEOUT_MS
      ? Number(env.SENTINEL_JUDGE_TIMEOUT_MS)
      : DEFAULT_JUDGE_TIMEOUT_MS,
  };

  const parsed = ConfigSchema.parse(candidate); // throws ZodError on malformed config → fail-closed
  return {
    ...parsed,
    allowSet: new Set(parsed.allowlist),
    denySet: new Set(parsed.denylist),
  };
}
