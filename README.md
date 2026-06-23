# Sentinel

**A security proxy for autonomous paying AI agents.**

Sentinel is a transparent forward proxy that guards agents paying over the [x402](https://www.x402.org/) protocol against payment attacks. Your agent's HTTP traffic flows through Sentinel; when an endpoint returns `402 Payment Required`, Sentinel steps in **before the payment settles** and decides **allow / step-up / block** — so a prompt-injected or malicious payment request never reaches the chain.

> Built for the Lepton Agents Hackathon (Canteen × Circle, Arc blockchain).

- **Live endpoint:** `https://sentinel.0xemrek.dev`
- **Live dashboard:** `https://dashboard.0xemrek.dev`

---

## Why

Paying agents are a new attack surface. An attacker who can influence what an agent reads can smuggle a payment instruction into a tool result or a `402` body — and drain the agent's wallet one "legitimate-looking" nanopayment at a time. The core scenario Sentinel exists for:

> A paying agent's wallet is targeted by a prompt-injected payment request. Sentinel catches the attack **live and blocks it before the payment goes on-chain.**

## How it works

```
agent ──▶ Sentinel proxy ──▶ upstream
             │
             │  on 402 Payment Required:
             ├─ 1. HOLD the response (the agent never sees the raw 402)
             ├─ 2. LLM judge (injection-hardened) ── advisory only
             ├─ 3. deterministic policy gate ── the REAL enforcement
             └─ 4. allow → build X-PAYMENT, settle, replay ·· block → fail-closed
```

The **deterministic policy engine is the gate** — per-call cap, hourly/daily budget, velocity, overpayment, replay, and denied-counterparty checks run in-process and decide the outcome. The **LLM judge is advisory**: it adds an explanation and an injection signal, but `injection_detected` is *never* the thing that enforces a block. This is deliberate — LLM-judge guardrails are bypassable, so the trust boundary is the deterministic policy, not the model. Malformed or timed-out judge output **fails closed** (block).

## Adopt it — one line, no SDK, no config

Sentinel proxies via a path prefix. Put the Sentinel base URL in front of the full upstream URL your agent already calls:

```diff
- const res = await fetch("https://api.some-x402-service.com/v1/pay");
+ const res = await fetch("https://sentinel.0xemrek.dev/https://api.some-x402-service.com/v1/pay");
```

That's the entire integration. See [`deploy/README-adoption.md`](deploy/README-adoption.md) for details. Once your agent drives a payment through Sentinel it appears on the live dashboard's **distinct protected agents** counter (counted on the un-spoofable `CF-Connecting-IP` edge — the developer's own traffic is excluded so the number is honest).

> **Money safety:** the hosted endpoint runs in **stub settlement** — the public proxy screens and blocks but never moves real USDC on your behalf. Real on-chain settlement is used only for the controlled, recorded demo.

## Attack coverage

Every claimed attack maps to a runnable **attack-succeeds-then-blocked** test. Run the suite with:

```bash
pnpm -F sentinel-proxy test
```

| Attack / control | What Sentinel does | Test |
|---|---|---|
| **Prompt-injection payment** — a `402` body / resource carries an instruction to pay an attacker | LLM judge flags injection (advisory) **and** the deterministic gate blocks before settlement | [`proxy/test/judge-injection.e2e.test.ts`](proxy/test/judge-injection.e2e.test.ts) |
| **Replay** — the same `(paymentId, resource)` is settled twice | Blocked: a settled payment is never replayed (POLICY-06) | [`proxy/test/policy-replay.e2e.test.ts`](proxy/test/policy-replay.e2e.test.ts) |
| **Overpayment drain** — a re-fetched `402` demands far more than quoted | Blocked: the paid amount is bound to the decided amount | [`proxy/test/policy-overpayment.e2e.test.ts`](proxy/test/policy-overpayment.e2e.test.ts) |
| **Per-call cap** — a single payment exceeds the configured ceiling | Blocked at the per-call cap | [`proxy/test/policy-percall.e2e.test.ts`](proxy/test/policy-percall.e2e.test.ts) |
| **Budget exhaustion** — cumulative spend exceeds the hourly/daily budget | Blocked at the budget ledger | [`proxy/test/policy-budget.e2e.test.ts`](proxy/test/policy-budget.e2e.test.ts) |
| **Velocity** — too many payments in too short a window | Blocked at the velocity check | [`proxy/test/policy-velocity.e2e.test.ts`](proxy/test/policy-velocity.e2e.test.ts) |
| **Denied counterparty** — payment to a deny-listed `payTo` | Blocked at the counterparty check | [`proxy/test/policy-denied.e2e.test.ts`](proxy/test/policy-denied.e2e.test.ts) |
| **Compromised proxy / cap bypass** — a re-fetched `402` diverges from what was decided (higher-but-under-cap amount, redirected `payTo`, swapped asset/network) | Fail-closed: the on-chain payment is **check-to-use bound** to exactly what `decide()` approved — the static cap alone is not trusted (D-02a) | [`proxy/test/gateway-binding.test.ts`](proxy/test/gateway-binding.test.ts) |

**What Sentinel does not claim.** It does not perform fund-flow graph analysis or personal-data / privacy inspection — that work is out of scope for this milestone and is not implemented, so it is deliberately not claimed here.

**On enforcement honesty.** The cap layer above is the **in-process deterministic policy** — caps are enforced independently of the judge and survive a compromised proxy (see the `gateway-binding` test). On Arc **testnet** this layer is enforced in-process; it is *not* presented as an immutable on-chain guarantee. The Circle mainnet policy mirror is configured in code as the production backstop but is not relied on as the gate in this demo.

## Run it locally

```bash
pnpm install                 # on-box install (better-sqlite3 fetches a Node 22 prebuilt)
pnpm -F sentinel-proxy test  # the full attack-coverage suite

# record the killer-demo contrast (injection blocked vs legit allowed):
bash scripts/record-demo.sh          # stub settlement — the local-mock demo path
```

**On-chain integration.** Sentinel's Circle Gateway + Arc-testnet settlement path is real and verified end-to-end:
- A one-time Gateway **deposit** (`proxy/src/settlement/deposit.ts`) settles a real Arc-testnet transaction on-chain (the immediate on-chain anchor).
- A real **per-payment settlement** against a live x402 Gateway-batching seller is proven by `bash scripts/prove-real-settle.sh` — the funded buyer pays through Circle's testnet Gateway and the transfer is accepted (correct payer/recipient/amount on `eip155:5042002`). Circle Gateway is batched/gasless, so a payment returns a Circle transfer ID rather than an instant `0x` hash.
- The check-to-use binding that keeps a compromised proxy from redirecting a settlement is covered by [`gateway-binding`](proxy/test/gateway-binding.test.ts).

The local demo and the hosted endpoint both run in **stub settlement** by design — they screen and block, they don't move funds. A per-payment settle needs a real x402-compliant upstream (Circle's `GatewayClient` does its own x402 round-trip); the local mock stands in for the **decision path** only, so `--real` against it correctly fails closed rather than settling.

## Project layout

| Path | What |
|---|---|
| `proxy/` | the Fastify proxy + decision pipeline + SQLite audit/ledger (`sentinel-proxy`) |
| `dashboard/` | the Next.js live dashboard (payments screened / attacks blocked / USDC protected) |
| `attack-server/` | a mock x402 upstream that serves the attack scenarios |
| `reference-agent/` | a reference paying agent that drives traffic through Sentinel |
| `deploy/` | the hosting runbook (`DEPLOY.md`), systemd unit, tunnel config, and the one-line adoption doc |
| `scripts/` | the deterministic demo driver |

## Tech stack

Node 22 · TypeScript · Fastify · undici · better-sqlite3 · Zod · Next.js · OpenRouter (model-agnostic judge adapter) · Circle Agent Stack / Nanopayments Gateway + Arc testnet for settlement.
