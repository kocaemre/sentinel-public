/**
 * KILLER-DEMO CLI driver (D-09b, DEMO-03 / JUDGE-06 — the <3-minute video path).
 *
 * Drives BOTH payments through Sentinel via the one-line base-URL-swap idiom and
 * prints them SIDE-BY-SIDE for the video:
 *
 *   LEGIT    → ${PROXY}/${UPSTREAM}/paid           → ALLOWED (200, settles)
 *   INJECTED → ${PROXY}/${UPSTREAM}/paid-injected  → BLOCKED (402, judge catch)
 *
 * The injected 402 is legit-looking on every deterministic axis (under-cap amount,
 * allowed payee) — so a BLOCK here means the JUDGE caught the operator-impersonation
 * injection in the description, not a deterministic control.
 *
 * This LIVE path uses the REAL OpenRouter judge (Plan 02), so it requires
 * OPENROUTER_API_KEY + network (RESEARCH Environment Availability). This script is a
 * PURE client driver — it adds NO logic to the proxy. If the proxy returns a
 * fail-closed block (missing key / timeout) it prints a clear hint so the operator
 * knows it is NOT a genuine judge catch.
 */

const PROXY = process.env.SENTINEL_BASE ?? "http://localhost:8787";
const UPSTREAM = process.env.UPSTREAM_BASE ?? "http://localhost:4021";

/** The 402 block body shape the proxy returns (forward.ts), incl. the advisory fields. */
interface BlockBody {
  error?: string;
  decision?: string;
  reasons?: string[];
  control?: string;
  matched_attack?: string;
  injection_detected?: boolean;
}

/** Drive one payment through the proxy and narrate the outcome. */
async function drive(label: string, path: string): Promise<void> {
  const url = `${PROXY}/${UPSTREAM}${path}`;
  console.log(`\n[${label}] GET ${url}`);
  const res = await fetch(url);

  if (res.status === 200) {
    await res.body?.cancel();
    console.log(`[${label}] ✅ ALLOWED → ${res.status} (payment settled)`);
    return;
  }

  // A 402 from the proxy = Sentinel BLOCKED this payment before settlement.
  const body = (await res.json().catch(() => ({}))) as BlockBody;
  const injected = body.injection_detected === true;
  const matched = body.matched_attack ?? "none";

  console.log(`[${label}] 🛑 BLOCKED → ${res.status}`);
  console.log(`[${label}]   decision:           ${body.decision}`);
  console.log(`[${label}]   matched_attack:     ${matched}`);
  console.log(`[${label}]   injection_detected: ${injected}`);
  if (body.reasons?.length) {
    console.log(`[${label}]   reasons:            ${body.reasons.join("; ")}`);
  }

  // Distinguish a GENUINE judge catch from a fail-closed block (missing key / timeout
  // / model error). A genuine catch carries injection_detected + the named attack; a
  // fail-closed block has neither (T-03-11) — hint so the operator sets the key.
  if (path.includes("/paid-injected") && !(injected && matched === "prompt_injection_payment")) {
    console.log(
      `[${label}]   ⚠️  NOT a genuine judge catch — looks fail-closed (missing OPENROUTER_API_KEY,`,
    );
    console.log(
      `[${label}]       timeout, or model error). Set OPENROUTER_API_KEY (and SENTINEL_JUDGE_MODEL)`,
    );
    console.log(`[${label}]       and confirm the model supports structured outputs, then re-run.`);
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("Sentinel killer demo — legit-allowed vs injected-blocked, side by side");
  console.log("=".repeat(72));

  // LEGIT: a 0.001 USDC payment that passes every control AND the judge → ALLOWED.
  await drive("LEGIT   ", "/paid");

  // INJECTED: a legit-looking 402 carrying an operator-impersonation injection in its
  // description → the JUDGE catches it and Sentinel BLOCKS before any settlement.
  await drive("INJECTED", "/paid-injected");

  console.log("\n" + "=".repeat(72));
  console.log("LEGIT → ALLOWED   |   INJECTED → BLOCKED (injection_detected, prompt_injection_payment)");
  console.log("=".repeat(72));
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("[demo] failed:", err);
    process.exit(1);
  });
}
