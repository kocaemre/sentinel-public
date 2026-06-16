<!-- GSD:project-start source:PROJECT.md -->

## Project

**Sentinel**

Sentinel, otonom ödeme yapan AI ajanlarını (paying agents) x402 nanopayment akışındaki saldırılara ve israfa karşı koruyan, kendisi de LLM ile karar veren bir **güvenlik proxy'sidir**. Ajanın HTTP istekleri Sentinel üzerinden geçer; bir endpoint `402 Payment Required` döndürdüğünde Sentinel ödemeden *önce* devreye girer ve "onayla / blokla / step-up" kararı verir. Lepton Agents Hackathon (Canteen × Circle, Arc blockchain) için, ödeme-yapan ajan ekosisteminin güvenlik altyapısı olarak konumlanır.

**Core Value:** Bir paying-agent'ın cüzdanı, prompt-injection ile manipüle edilmiş bir ödeme isteği yüzünden boşaltılmaya çalışıldığında, Sentinel bu saldırıyı ödeme on-chain'e gitmeden **canlı olarak yakalayıp bloklamalıdır.** Her şey başarısız olsa bile bu tek senaryo çalışmalı — çünkü hem killer demo hem de ürünün varlık sebebi budur.

### Constraints

- **Timeline**: 13 gün (15–29 Haziran 2026) — solo, yoğun (6+ saat/gün). Scope sıkı tutulmalı, MVP + tek killer demo öncelikli.
- **Tech stack**: Zorunlu — Arc blockchain, USDC, Circle CLI, Arc CLI, x402 protokolü, Circle Agent Stack, Nanopayments Gateway. Uygulama: TS/Next.js + Node (proxy + dashboard), gerekirse Python/FastAPI. Geliştiricinin mevcut stack'iyle uyumlu.
- **Budget**: LLM için sıfır bütçe hedefi — OpenRouter üzerinden hızlı/ucuz (gerekirse `:free`) model. Model-agnostik adapter arkasında; sponsor kredisi gelirse veya demo için kalite yükseltilebilir. Provider chat aboneliği app trafiğine kullanılamaz (ayrı faturalama).
- **Performance**: Sentinel her ödemenin hot-path'inde — düşük latency kritik. Tiered yaklaşım (ucuz model hızlı tarama → gerekirse daha güçlü model derin yargı) + prompt caching.
- **Security**: Yargıç saldırgan-kontrollü içeriği işliyor → kendisi prompt-injection'a karşı sertleştirilmeli (içerik veri olarak çerçevelenir, net delimiter, operatör talimatları sistem rolünde).
- **Submission**: Public GitHub repo (zorunlu), <3dk video demo (zorunlu), canlı link (tercihen). Çoklu submission serbest.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | 22 LTS | Runtime for the proxy + decision pipeline | Required by Circle/Arc sample repos (sibling PITFALLS: sample repo needs Node 22 + Supabase + Docker); current LTS; native fetch/undici |
| TypeScript | 5.x | Whole codebase | Type-safe `PaymentRequirements`/`DecisionContext`/`Verdict`; matches dev's stack (recon-deck) |
| Fastify | 5.x | HTTP proxy/gateway server | Low-overhead, stream-friendly, plugin ecosystem; ARCHITECTURE.md already commits to it. Fast-path non-402 pass-through, hold only 402 for the decision pipeline |
| undici | 6.x (bundled in Node 22) | Upstream HTTP client for forwarding | Native, fast, streaming; forward requests + re-issue with signed `X-PAYMENT` header after an allow |
| Next.js | 15.x (App Router) | Live dashboard (the demo surface) | SSE/stream-friendly, dev knows it; renders scanned/blocked/USDC-protected metrics + per-verdict drill-down |
| SQLite (better-sqlite3) | better-sqlite3 11.x | Budget/velocity ledger + audit store | Single-file, zero-ops, atomic increments for the velocity ledger; correct for a hackathon single-process deployment (do NOT add a DB server / queue) |
| Zod | 3.x | Verdict schema + 402 body validation | Schema-locked LLM output `{decision, reasons[], confidence, injection_detected}`; fail-closed on malformed output (Pitfall #7) |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **x402 SDK** (`x402` / `@coinbase/x402` / `x402-foundation`) | LOW-confidence — verify | Parse `402` `PaymentRequirements` (scheme, network, maxAmountRequired, payTo, asset, resource, description) + build the `X-PAYMENT` header | x402 Handler. Reuse the published TS types instead of hand-rolling the schema. coinbase/x402 + x402-foundation/x402 are the reference implementations |
| **Circle Agent Stack SDK** (`@circle-fin/*`) | LOW-confidence — verify exact package | Circle Wallets (programmable spending policy), Nanopayments Gateway (batched gas-free USDC) | Circle/Arc integration, on the `allow` branch only. Set time-bound USDC limits + address allow/deny on the wallet (the immutable backstop) |
| **Circle CLI** (`@circle-fin/cli`) | LOW-confidence — verify | Wallet/agent setup, x402-compatible payments, crosschain USDC | Setup/scaffolding; `npm install -g @circle-fin/cli` per hackathon docs |
| **OpenAI SDK** (`openai`) pointed at OpenRouter | 4.x | Calling OpenRouter (OpenAI-compatible API) for the LLM judge | LLM judge adapter. `baseURL: https://openrouter.ai/api/v1`, JSON / structured-output mode. Wrap behind a model-agnostic `adapter.ts` so the model is config-swappable |
| **viem** (optional) | 2.x | Low-level EVM/USDC interaction if Circle SDK gaps appear | Only if the Circle SDK can't do something needed (e.g. reading USDC balance / building a raw Arc tx). Arc is an EVM-compatible L1 |
| pino | 9.x | Structured logging | Proxy + audit; pairs with Fastify |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| Arc CLI (`the-canteen-dev/ARC-cli`) | Arc testnet RPC access, docs, repos | `uv tool install git+https://github.com/the-canteen-dev/ARC-cli` (Python-based installer per hackathon docs) |
| Docker | Local Circle/Arc sample-repo deps | Sibling PITFALLS: sample repo needs Docker; keep Sentinel itself a single Node process |
| pnpm | Monorepo package manager | Matches the `proxy/` + `dashboard/` + `attack-server/` + `reference-agent/` layout in ARCHITECTURE.md |
| tsx / tsup | Run/build TS without a heavy bundler | Fast dev loop for a 13-day sprint |

## Installation

# Hackathon-required CLIs (global)

# Proxy service (Node/TS)

# Dashboard (Next.js) — separate workspace

## LLM Judge — model selection (OpenRouter, zero-budget)

| Tier | Candidate models (verify live on openrouter.ai/models) | Why |
|------|--------------------------------------------------------|-----|
| Hot-path (every 402) | Gemini Flash class, DeepSeek (chat), or a stable `:free` model | Fast, cheap/free, good-enough JSON + reasoning; latency-critical |
| Escalation (suspicious/high-value) | A stronger instruct model (larger Qwen/Llama/DeepSeek, or Claude/Gemini if budget appears) | Deeper reasoning only when risk flags fire |

- **JSON reliability:** prefer models with JSON/structured-output mode; validate with Zod and **fail-closed** on malformed output (cheap/free models produce unreliable JSON — Pitfall #7).
- **Prompt caching is provider-dependent on OpenRouter** (Anthropic explicit `cache_control`; DeepSeek/Moonshot/Z.ai/Groq automatic) → the adapter must be provider-aware to cache the stable system prefix.
- **Model-agnostic adapter** (`judge/adapter.ts`): model id from config so you can A/B and swap when a sponsor credit appears.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Fastify + undici | Express + http-proxy-middleware | If a turnkey reverse-proxy plugin saves time over manual 402 sniffing; Fastify preferred for stream control + speed |
| OpenRouter (OpenAI-compat) | Direct Anthropic/Google SDK | If a sponsor credit lands → swap behind the adapter for native caching/structured-output; keeps the agnostic interface |
| SQLite (better-sqlite3) | Supabase/Postgres | Only when onboarding real concurrent users (velocity-ledger lost-writes under concurrency) — defer past the demo |
| viem | ethers.js | Either works for EVM/Arc; viem is lighter/typed. Use only if Circle SDK has gaps |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Running your own x402 facilitator | Unnecessary complexity; Canteen hosts a testnet facilitator | Hosted testnet facilitator (Arc CLI / Circle docs) |
| A message queue / DB server for the demo | Over-engineering for 1–few agents; burns sprint time | Single Node process + SQLite + in-memory ledger |
| Trusting the LLM's `injection_detected`/`confidence` as the gate | LLM-judge guardrails are bypassable up to 100% (Pitfall: arXiv 2504.11168) | Deterministic PRE/POST policy + Circle Wallets caps as the real gate; LLM is advisory + explanation |
| Free-text prompt to the judge ("does this look like injection?") | Hands the instruction channel to the attacker (the judge meta-attack) | Structured fields + randomized delimiter (spotlighting), operator rules in system role only |
| Multichain / on-chain co-signer / ML reputation | Out of scope for 13-day solo | Arc testnet only; proxy + Circle wallet policy |
| Caching `Cache-Control` defaults on paid responses | nginx/proxy cache leakage measured at 100% (Pitfall) | `Cache-Control: no-store` on paid/402 responses |

## Stack Patterns by Variant

- Single Node/Fastify process + SQLite + in-memory velocity ledger + Next.js dashboard
- Because it's the correct scale; adding infra wastes sprint time and adds failure surface
- Move velocity ledger to SQLite/Postgres with atomic increments before onboarding
- Because the in-memory ledger loses writes under concurrency (second bottleneck after the LLM call)
- Swap the hot-path/escalation model id in config; switch the adapter to native provider for caching/structured output
- Because the agnostic adapter makes this a one-line change

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| Node 22 | better-sqlite3 11.x, Fastify 5.x, undici 6.x | Node 22 required by Circle/Arc sample repos |
| Circle Agent Stack SDK | Arc testnet | VERIFY at integration phase — package names/versions LOW confidence (Oct 2025 launch, fast-moving) |
| x402 SDK | Circle/Arc facilitator | Confirm the TS package handles Arc network + USDC asset, not just Base/Solana |

## Sources

- `.planning/research/ARCHITECTURE.md` — component→tech mapping (Fastify, undici, SQLite, Zod, OpenRouter adapter, Next.js+SSE), HIGH confidence on flow
- `.planning/research/PITFALLS.md` — tooling traps (Node 22 + Supabase + Docker, USDC-as-gas, hosted facilitator, faucet limits, cache leakage), MEDIUM on Circle/Arc tooling
- [coinbase/x402](https://github.com/coinbase/x402) — x402 reference implementation
- [x402.org](https://www.x402.org/) — protocol spec (402 → X-PAYMENT → facilitator settle)
- [Circle Agent Wallets](https://developers.circle.com/agent-stack/agent-wallets) — programmable spending policy, allow/deny lists — LOW confidence on exact SDK surface
- [Circle — Autonomous Payments with Wallets, USDC & x402](https://www.circle.com/blog/autonomous-payments-using-circle-wallets-usdc-and-x402)
- [circlefin/arc-nanopayments](https://github.com/circlefin/arc-nanopayments) — reference repo
- [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching) — provider-dependent caching
- Hackathon docs — Circle CLI (`npm i -g @circle-fin/cli`), Arc CLI (`uv tool install git+...ARC-cli`)

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
