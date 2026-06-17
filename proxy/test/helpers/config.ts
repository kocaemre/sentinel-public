import { loadConfig, type Config } from "../../src/config.js";

/**
 * Build a full Config for e2e tests from the locked `loadConfig({})` defaults,
 * applying the given overrides. Keeps test fixtures from having to enumerate
 * every limit field (and from drifting as Plan 03 adds more), while still
 * exercising the real default-loading path. The mock upstream lives on loopback,
 * so `allowInternal` defaults true here.
 */
export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({});
  return {
    ...base,
    port: 0,
    logLevel: "silent",
    allowInternal: true,
    // Isolate each e2e from the shared on-disk wallet/ledger/dedup file by default
    // (Plan 03: configureDecision now opens those stores from dbPath at boot). A
    // single server instance keeps ONE :memory: connection per store for its
    // lifetime, so replay dedup + the ledger still work WITHIN a test; the file is
    // never touched. Override with a temp-file path when two handles must share.
    dbPath: ":memory:",
    ...overrides,
    // Keep companion Sets consistent if allowlist/denylist were overridden.
    allowSet: overrides.allowSet ?? new Set(overrides.allowlist ?? base.allowlist),
    denySet: overrides.denySet ?? new Set(overrides.denylist ?? base.denylist),
  };
}
