/**
 * OpenRouter LLM payment judge adapter (JUDGE-01/02/03/05, RESEARCH Patterns 1-2).
 *
 * One model-agnostic OpenAI-SDK client pointed at OpenRouter. The judge:
 *   - frames the held 402 via the spotlighting prompt (operator rules system-role
 *     only; attacker context as randomized-delimiter DATA — see prompt.ts);
 *   - forces a strict `json_schema` verdict and pins routing to providers that honor
 *     `response_format` (`provider.require_parameters` — Pitfall 5 / T-03-09);
 *   - is timeout-bounded by `AbortSignal.timeout` (Pitfall 4 / T-03-06);
 *   - RE-VALIDATES the model's JSON with `VerdictSchema` and FAILS CLOSED to `block`
 *     on every failure path — empty / malformed / schema-incomplete / timeout /
 *     network / SDK error (JUDGE-05 / D-05). It NEVER returns `allow`/`step-up` on a
 *     failure, and the API key is NEVER logged (T-03-08).
 *
 * `injection_detected` and `confidence` ride through as ADVISORY display/audit fields
 * from the validated verdict — they are NEVER consulted to change the decision. The
 * operative decision is the model's `decision` field, still subject to the seam's POST
 * `tighten()` backstop (CLAUDE.md "What NOT to Use").
 */

import OpenAI from "openai";
import { VerdictSchema, type DecisionContext, type Verdict } from "@sentinel/shared";
import type { Config } from "../config.js";
import { buildSpotlightMessages } from "./prompt.js";

/**
 * The canonical fail-closed verdict. Returned on ANY judge failure. `decision` is
 * `block` (never `allow`/`step-up`); the advisory fields are inert.
 */
export const BLOCK_FAILCLOSED: Verdict = {
  decision: "block",
  reasons: ["judge failed closed (timeout/malformed/empty/error)"],
  matched_attack: "none",
  injection_detected: false,
  confidence: 0,
};

/**
 * OpenRouter strict-JSON response format. `strict:true` + `additionalProperties:false`
 * + all five fields required forces the provider to emit exactly the verdict shape;
 * `VerdictSchema.safeParse` is the backstop if a provider leaks past it (T-03-09).
 */
export const verdictResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "sentinel_verdict",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "reasons", "confidence", "injection_detected", "matched_attack"],
      properties: {
        decision: { type: "string", enum: ["allow", "block", "step-up"] },
        reasons: { type: "array", items: { type: "string" } },
        confidence: { type: "number" },
        injection_detected: { type: "boolean" },
        matched_attack: {
          type: "string",
          enum: ["prompt_injection_payment", "overpayment_drain", "replay", "none"],
        },
      },
    },
  },
} as const;

/**
 * Fail-closed mapper: turn the model's raw output string into a `Verdict`.
 *
 * empty/undefined → block; `JSON.parse` throw → block; `VerdictSchema.safeParse`
 * failure (missing field / bad enum / wrong type) → block; success → the validated
 * verdict unchanged. NEVER uses `VerdictSchema.parse` — a throw mid-judge must be
 * caught to a block here, not escape (JUDGE-05 / D-05).
 */
export function toVerdict(raw: string | undefined): Verdict {
  if (!raw) return BLOCK_FAILCLOSED;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return BLOCK_FAILCLOSED;
  }

  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) return BLOCK_FAILCLOSED;
  return result.data;
}

/**
 * Construct the hardened judge from resolved config. Closes over ONE OpenAI client
 * pointed at OpenRouter and returns the async `Judge` `(ctx, pre) => Promise<Verdict>`
 * the seam injects via `configureDecision({ judge })`.
 */
export function makeOpenRouterJudge(
  config: Pick<Config, "judgeModel" | "openRouterBaseUrl" | "openRouterApiKey" | "judgeTimeoutMs">,
): (ctx: DecisionContext, pre: Verdict) => Promise<Verdict> {
  // Construct ONE client lazily on first use. The OpenAI SDK constructor THROWS on an
  // empty apiKey, so we never build it when the key is missing — the empty-key path
  // below short-circuits to block first (never call the network, never silently allow).
  let client: OpenAI | null = null;

  return async (ctx: DecisionContext, _pre: Verdict): Promise<Verdict> => {
    // No key → never call the network, never silently allow (RESEARCH Runtime State).
    if (!config.openRouterApiKey) return BLOCK_FAILCLOSED;

    if (!client) {
      client = new OpenAI({
        baseURL: config.openRouterBaseUrl,
        apiKey: config.openRouterApiKey,
      });
    }

    const messages = buildSpotlightMessages(ctx);

    try {
      // Non-streaming body. `stream: false` keeps the SDK return type narrowed to a
      // ChatCompletion (not the streaming union). `provider` is an OpenRouter-only
      // body field (routes only to providers honoring response_format — Pitfall 5 /
      // T-03-09); cast through `as` since it is not on the vanilla OpenAI params type.
      const body = {
        model: config.judgeModel,
        messages,
        response_format: verdictResponseFormat,
        stream: false as const,
        provider: { require_parameters: true },
      };
      const completion = await client.chat.completions.create(
        body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        { signal: AbortSignal.timeout(config.judgeTimeoutMs) },
      );

      const raw = completion.choices?.[0]?.message?.content ?? undefined;
      return toVerdict(typeof raw === "string" ? raw : undefined);
    } catch (err) {
      // ANY throw — timeout/abort/network/SDK — fails closed to block. Log the error
      // message ONLY; NEVER the API key (T-03-08).
      console.warn(
        JSON.stringify({ msg: "judge call failed — fail-closed block", err: (err as Error).message }),
      );
      return BLOCK_FAILCLOSED;
    }
  };
}
