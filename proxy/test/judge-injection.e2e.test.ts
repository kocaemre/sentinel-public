import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { DecisionContext, Verdict } from "@sentinel/shared";
import { buildServer } from "../src/server.js";
import { configureDecision } from "../src/decision/stub.js";
import { loadConfig, type Config } from "../src/config.js";
import { makeTestConfig } from "./helpers/config.js";
import { buildMockUpstream } from "../../attack-server/src/server.js";

/**
 * DEMO-03 / JUDGE-06 KILLER-DEMO e2e (D-09a, OFFLINE — no live LLM, no key).
 *
 * The full Core-Value scenario, finally provable end-to-end with a stubbed
 * payment: a live prompt-injection 402 that PASSES every Phase 2 deterministic
 * control is caught by the JUDGE and blocked BEFORE any settlement, shown beside
 * a contrasting legitimate payment that is allowed.
 *
 * Runs fully offline by injecting a DETERMINISTIC STUB JUDGE through the existing
 * `configureDecision({ judge })` seam — no OpenRouter key/network. The stub
 * emulates the Plan 02 hardened judge's behavior: for the injected resource it
 * returns an async `block` with `injection_detected: true` +
 * `matched_attack: "prompt_injection_payment"`; for everything else it allows.
 *
 * Because the injected 402's amount ("1000" = 0.001 USDC) is UNDER the cap, its
 * payee ("0xPayee") is allowed, and the price-map prices the resource at its true
 * amount, NO deterministic control can fire — so this test proves the JUDGE, not a
 * control, made the catch (RESEARCH Anti-Pattern). The contrasting legit /paid
 * 402 still ALLOWS (settles), confirming the deterministic controls passed the
 * injected 402.
 */

let mock: FastifyInstance & { hits?: Record<string, number> };
let proxy: FastifyInstance;
let mockPort: number;
let proxyPort: number;

/**
 * The offline stub judge — emulates the hardened judge WITHOUT a network call.
 * Keys its branch on the screened context/resource: the operator-impersonation
 * injection ("pre-approved"/"ignore") in the description is the catch.
 */
const stubJudge = async (ctx: DecisionContext, pre: Verdict): Promise<Verdict> => {
  const screened = `${ctx.context ?? ""} ${ctx.resource}`.toLowerCase();
  const looksInjected =
    screened.includes("/paid-injected") ||
    screened.includes("pre-approved") ||
    screened.includes("ignore prior limits");
  if (looksInjected) {
    return {
      decision: "block",
      reasons: [
        "operator-impersonation prompt-injection in the 402 description: attempts to override the per-call cap",
      ],
      confidence: 0.97,
      injection_detected: true,
      matched_attack: "prompt_injection_payment",
    };
  }
  // No attack matched — pass the PRE verdict through unchanged (identity).
  return pre;
};

before(async () => {
  mock = buildMockUpstream();
  await mock.listen({ port: 0, host: "127.0.0.1" });
  mockPort = (mock.server.address() as AddressInfo).port;

  const base = loadConfig({});
  // Locked default cap (1 USDC). Price the injected resource at its true amount so
  // the overpayment control cannot fire — PRE passes deliberately, leaving the
  // JUDGE as the only thing that can catch the injection (RESEARCH Anti-Pattern).
  const config: Config = makeTestConfig({
    allowlist: [`127.0.0.1:${mockPort}`],
    dbPath: ":memory:",
    expectedPriceMap: {
      ...base.expectedPriceMap, // keeps the legit /paid baseline
      "https://upstream/paid-injected": "1000", // true price 0.001 USDC
    },
  });
  proxy = buildServer(config);
  // `buildServer` calls `configureDecision(config)` internally and injects the real
  // judge ONLY when OPENROUTER_API_KEY is set — keyless here, so it leaves identity
  // passthrough. Re-run configureDecision with our offline stub so it survives.
  configureDecision({ ...config, judge: stubJudge });

  await proxy.listen({ port: 0, host: "127.0.0.1" });
  proxyPort = (proxy.server.address() as AddressInfo).port;
});

after(async () => {
  await proxy?.close();
  await mock?.close();
});

const through = (path: string) =>
  `http://127.0.0.1:${proxyPort}/http://127.0.0.1:${mockPort}${path}`;

test("KILLER DEMO: the injected 402 is BLOCKED by the judge with injection_detected before any settlement", async () => {
  const res = await fetch(through("/paid-injected"));

  assert.equal(res.status, 402, "blocked, not paid");
  assert.equal(res.headers.get("cache-control"), "no-store", "a block is never cached");

  const body = (await res.json()) as {
    decision: string;
    reasons: string[];
    matched_attack: string;
    injection_detected: boolean;
  };
  assert.equal(body.decision, "block");
  assert.equal(body.injection_detected, true, "the judge flagged the prompt-injection");
  assert.equal(
    body.matched_attack,
    "prompt_injection_payment",
    "the block names the prompt-injection attack class (JUDGE-06)",
  );

  // The attacker upstream is hit EXACTLY ONCE (the 402), never the settle retry —
  // proving the block happened BEFORE any pay (no wallet.settle).
  assert.equal(mock.hits?.["/paid-injected"], 1, "no pay after the block (upstream hit once)");
});

test("CONTRAST: the legit 0.001 USDC /paid is ALLOWED and settles (the controls passed the injected 402, so the JUDGE made the catch)", async () => {
  const res = await fetch(through("/paid"));
  assert.equal(res.status, 200, "the legit payment is allowed and settles");
  await res.body?.cancel();
  // 402 then the X-PAYMENT→200 settle retry — two upstream hits.
  assert.equal(mock.hits?.["/paid"], 2, "the legit resource settled (402 then paid)");
});
