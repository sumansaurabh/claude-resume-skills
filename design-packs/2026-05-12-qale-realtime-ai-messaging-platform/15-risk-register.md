# 15 — Risk Register

The risks I would brief the CEO on in week one, ranked, with what I would do about each. Anchors from `00-question-and-context.md`.

## 1. Format

Each risk has: **Category / Likelihood (L/M/H) / Impact (L/M/H) / Trigger / Mitigation / Contingency / Owner / Anchor lesson**.

I'm explicitly *not* hedging — these are the calls I'd make on day one.

---

## R-1 — AI cost runaway from a single workspace

- **Category:** Cost / abuse
- **Likelihood:** **High** (within 60 days of launch; near-certain with viral usage)
- **Impact:** **High** (a single tenant can burn $10K+ in a day if budget guard fails)
- **Trigger:** A power user automates AI calls; a prompt-injected agent loops; an integration spams the assistant.
- **Mitigation:** Token Budgeter is in the **synchronous path** of every AI call (Redis atomic INCR keyed `budget:{wsId}:{day}`); pre-charge then settle; per-workspace daily cap and per-user per-minute cap. Hard ceiling at the model router — no exceptions.
- **Contingency:** Per-workspace circuit breaker — if a workspace exceeds 3× its daily cap, automation routes to a `degraded` model (Haiku/4o-mini) and pages on-call. Customer notified in-app.
- **Owner:** AI plane lead.
- **Anchor lesson:** A-BB4 (model router with cost-aware routing); A-BB5 (LLM telemetry surfaces cost the moment it spikes, not at the next finance review).

## R-2 — Message-fanout hot partition collapses one workspace

- **Category:** Reliability / scale
- **Likelihood:** **Medium** (predictable as a few workspaces grow past 5K members)
- **Impact:** **High** (other tenants on the same Kafka partitions / Postgres shard suffer noisy-neighbor latency)
- **Trigger:** A workspace hits ~10K members and starts seeing 1K+ msg/s in a single thread.
- **Mitigation:** Kafka partition by `(workspaceId, threadId)`; Postgres shard by `workspaceId`; **per-workspace concurrency cap at the gateway**; backpressure into the producer (429 → client slowdown).
- **Contingency:** Move the hot tenant to a dedicated shard via dual-write + backfill + cutover (A-BB1 — done at BlackBox). Pre-built playbook; first migration completes in < 4h.
- **Owner:** Real-time pod lead.
- **Anchor lesson:** A-BB1 (tenant-aware sharding planned, not retrofitted).

## R-3 — Prompt injection exfiltrates cross-thread or cross-workspace data

- **Category:** Security / AI safety
- **Likelihood:** **High** (every AI-native product has been hit; assume it will be)
- **Impact:** **High** (data leak across tenant boundaries = SOC-2 incident, legal escalation, reputational damage)
- **Trigger:** A user pastes a malicious message that the assistant later reads as instruction; a third-party integration injects via webhook payload.
- **Mitigation:**
  - **Capability tokens, not ambient authority.** Every tool call from the AI gets a short-lived (60s) JWT bound to `(runId, userId, workspaceId, threadId, allowed_tools)`. Tools verify the binding.
  - System prompt always reasserts tenant scope; user-supplied content is wrapped and labeled.
  - LLM-generated tool args validated against allowlist before dispatch.
- **Contingency:** Kill switch per tool in `policy.changes`; revoke a tool fleet-wide in < 60s. Per-`(wsId, userId)` quarantine list.
- **Owner:** Security + AI plane co-owners.
- **Anchor lesson:** A-MS2 (VNet-attached compute trust — local enforcement of central policy with short-TTL artifacts); A-BB1 (tenant isolation invariant — same shape extended to AI tools).

## R-4 — Founder demands E2E encryption mid-flight

- **Category:** Product / architecture
- **Likelihood:** **Medium** (every modern messaging pitch faces "but Signal does E2E" once)
- **Impact:** **High** (E2E and server-side AI are largely incompatible — retrofitting is months of work and breaks search)
- **Trigger:** Enterprise prospect, regulator, or press cycle.
- **Mitigation:** Document the tradeoff *now* (TR-2 in `08-tradeoffs-and-alternatives.md`) and present three paths: (a) status quo, (b) optional opt-in per-thread E2E with no AI in those threads, (c) full pivot.
- **Contingency:** Have path (b) prototyped as a 2-engineer/4-week spike before public launch so we can ship it within a quarter if the market demands it.
- **Owner:** Head of Engineering (me).
- **Anchor lesson:** A-MS3 (control vs data plane) — making the AI-on/AI-off boundary a per-thread policy keeps the option reversible.

## R-5 — One LLM provider goes down or rate-limits us

- **Category:** Reliability / vendor
- **Likelihood:** **High** (Anthropic, OpenAI, and xAI have all had multi-hour incidents in the last 12 months)
- **Impact:** **Medium** (chat keeps working; AI features degrade)
- **Trigger:** Provider 5xx storm, rate-limit cap hit, or outright outage.
- **Mitigation:** Model router has a **fallback ladder per capability** (anchor A-BB4): Claude → GPT → Grok for general; intent-classified routing means we don't put everything on one provider.
- **Contingency:** Auto-degrade to cached templates for common intents (summarize, draft reply); show "AI unavailable" banner only as last resort. Recover automatically.
- **Owner:** AI plane lead.
- **Anchor lesson:** A-BB4 — we already operate a multi-provider router; this is a known shape.

## R-6 — WebSocket gateway can't handle concurrency at launch peak

- **Category:** Reliability / scale
- **Likelihood:** **Medium**
- **Impact:** **High** (chat down = product down)
- **Trigger:** Public launch traffic spike; HN/PH front page; viral moment.
- **Mitigation:** Sized for **150K concurrent at 1M users** with 30% headroom; sticky-by-userId routing; per-pod cap with overflow re-balanced via `gateway:{userId}` Redis hint; HPA on connection count, not CPU.
- **Contingency:** Pre-warmed standby fleet (50% extra capacity, 5-min spin-up). Connection draining + reconnect storm controls (jittered backoff client-side, anchor: ran 30+ arch reviews, A-MS5).
- **Owner:** Real-time pod lead.
- **Anchor lesson:** A-MS5 (architecture reviews) — gateway capacity is the most-rehearsed scenario in any real-time launch.

## R-7 — Hyderabad team can't be hired fast enough

- **Category:** People / execution
- **Likelihood:** **High** (the bar I want — senior+, real-time experience — is a thin market)
- **Impact:** **High** (delayed launch, burned founder runway)
- **Trigger:** Three months in, fewer than 4 of the 8 hires made.
- **Mitigation:**
  - Lower-funnel early: outbound directly to BlackBox/Microsoft alumni network (anchor A-MS5 — relationships from running 30+ arch reviews).
  - Two senior recruiters, one in Hyderabad, one global remote.
  - Structured loop: phone screen → take-home → systems design → coding → bar-raiser. No skipping.
  - Honest level-mapping; pay above market for principal candidates.
- **Contingency:** Hire 2–3 senior contractors from a known agency for 6 months while pipeline matures; budgeted in `14-leadership-and-business-framing.md`.
- **Owner:** Head of Engineering (me) + Head of Talent.
- **Anchor lesson:** A-MS5.

## R-8 — Real-time spec drift between web and mobile clients

- **Category:** Product / engineering quality
- **Likelihood:** **Medium**
- **Impact:** **Medium** (subtle bugs: missed messages, ghost typing, unread counters wrong)
- **Trigger:** Web ships a protocol change; mobile is on an older version; reconnect logic diverges.
- **Mitigation:** Single OpenAPI + AsyncAPI source of truth; codegen for client SDKs; protocol version field on every WS frame; **server is canonical** for unread/delivery state — clients never disagree without losing.
- **Contingency:** Client kill switch via `policy.changes` to force minimum protocol version; server can refuse old clients with an upgrade prompt.
- **Owner:** Frontend pod lead + Real-time pod lead.
- **Anchor lesson:** A-MS3 (control vs data plane) — protocol version is a control-plane concern enforced at data-plane edges.

## R-9 — Postgres write amplification from read receipts

- **Category:** Reliability / data
- **Likelihood:** **Medium**
- **Impact:** **Medium** (DB CPU saturation; cascading latency)
- **Trigger:** A 5K-member channel where everyone reads every message — 5K writes per message.
- **Mitigation:** Read receipts batched through Redis (1s coalesce window); flushed to Postgres in bulk. Cuts write amp ~10×. Documented in `13-data-model-and-storage.md` §2.5.
- **Contingency:** If still hot, demote read-receipt durability for very-large channels: keep last-read in Redis only, accept 60s of lag and rebuild on demand.
- **Owner:** Data plane lead.
- **Anchor lesson:** A-BB1 — patterns like this are *the* reason we own the storage decisions instead of leaning on a generic ORM.

## R-10 — SOC-2 readiness slips and blocks an enterprise deal

- **Category:** Compliance / business
- **Likelihood:** **Medium** (timeline-dependent)
- **Impact:** **High** (a single 6-figure enterprise deal can require it as a gate)
- **Trigger:** First enterprise prospect requests SOC-2 Type II during sales cycle.
- **Mitigation:** Day-one controls (audit log immutable in S3 Object Lock; KMS per workspace; access reviews quarterly; least-privilege IRSA). Vanta/Drata for evidence collection. Targeted SOC-2 Type I within 6 months, Type II within 12 months of launch.
- **Contingency:** Bridge with a security questionnaire + customer-specific BAA / DPA + customer audit access; close the deal with a contractual SOC-2 timeline commitment.
- **Owner:** Head of Engineering (me) + first Security hire (R-11 funding).
- **Anchor lesson:** A-MS1 (Microsoft compliance posture — the work is daily, not a sprint at the end).

## R-11 — Single-point-of-knowledge in the early team

- **Category:** People / continuity
- **Likelihood:** **High** (early teams always concentrate knowledge)
- **Impact:** **High** (one person leaving = months of recovery)
- **Trigger:** A founding engineer is the only one who understands the AI runtime / the gateway / the migration story.
- **Mitigation:**
  - Mandatory pairing on critical-path features (AI orchestrator, gateway, sharding).
  - Decision logs in the repo (`/docs/decisions/`); ADRs for every load-bearing call.
  - Oncall rotation includes shadowing — no one is a permanent SME.
- **Contingency:** Documented bus-factor list, reviewed monthly; hiring backfill triggered when bus factor for any subsystem hits 1.
- **Owner:** Head of Engineering (me).
- **Anchor lesson:** A-MS5 (30+ arch reviews — the reviews themselves were a knowledge-distribution mechanism).

## R-12 — Privacy / regulatory pivot (EU, India DPDP) forces data-residency rework

- **Category:** Compliance / architecture
- **Likelihood:** **Medium** (within 18 months as we go international)
- **Impact:** **High** (re-architecting storage for multi-region residency is months of work if not designed in)
- **Trigger:** First EU enterprise prospect; DPDP enforcement; a customer demands India-only data plane.
- **Mitigation:** **Region is a first-class field on workspace creation** (`workspaces.region`); routing fabric per region; KMS keys per region; audit log per region. Cross-region replication is opt-in, not default.
- **Contingency:** Stand up a new region (us-east + eu-west + ap-south) with the same Helm chart; takes ~2 weeks for the first new region after us-east, ~1 week each thereafter.
- **Owner:** Infra lead + Head of Engineering.
- **Anchor lesson:** A-MS2 (VNet-attached compute) — region isolation is the same shape as VNet isolation: enforce locally, govern centrally.

---

## 2. Risk dashboard (ranked by Likelihood × Impact)

| ID | Risk | L | I | Score | Trend |
| --- | --- | --- | --- | --- | --- |
| R-1 | AI cost runaway from one workspace | H | H | **9** | Decreasing as Token Budgeter hardens |
| R-3 | Prompt injection / data leak | H | H | **9** | Steady — eternal vigilance |
| R-7 | Hiring pace in Hyderabad | H | H | **9** | Decreasing as pipeline matures |
| R-2 | Hot-partition collapse | M | H | **6** | Steady |
| R-4 | E2E demand mid-flight | M | H | **6** | Could spike on a single press cycle |
| R-6 | Gateway concurrency at launch | M | H | **6** | Decreasing after first load test |
| R-10 | SOC-2 slip blocks enterprise deal | M | H | **6** | Decreasing if started day one |
| R-11 | Bus factor on critical paths | H | H | **9** | Decreasing as team scales |
| R-12 | Data residency rework | M | H | **6** | Steady |
| R-5 | LLM provider outage | H | M | **6** | Steady — known shape |
| R-8 | Web/mobile spec drift | M | M | **4** | Steady |
| R-9 | Read-receipt write amplification | M | M | **4** | Decreasing once batching ships |

## 3. Cadence

- **Weekly:** I review R-1, R-3, R-6, R-7 with the relevant pod leads. These move week to week.
- **Monthly:** full register reviewed in the eng leadership 1:1; trend column updated.
- **Quarterly:** the founder/CEO sees the dashboard and the top three risks. No surprises.

This is the same cadence I used for architecture reviews at Microsoft (anchor A-MS5) — the value isn't the document, it's the standing meeting that forces a decision.
