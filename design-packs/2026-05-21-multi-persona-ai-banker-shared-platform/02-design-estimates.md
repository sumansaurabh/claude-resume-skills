# 02 — Design Estimates: Multi-Persona AI Banker (Shared Platform)

## 1. Use case and problem statement

Retail customers, SME owner-operators, and CFO/treasury teams all interact with the same bank but with radically different mental models, risk appetites, and regulatory exposure. Today they get either three disjoint chatbots (each shallow), one generic copilot (which over-explains to a CFO and under-protects a retail user), or no AI at all. The cost of *not* solving this is real: (a) duplicated infra and on-call burden across three vertical agents, (b) inconsistent guardrails that leak to the regulator (RBI, DPDP, SOC-2 boundary violations between SME and CFO tenants), (c) missed cross-sell because the platform never sees the same user across personas (retail → small-business owner → CFO is a known lifecycle), and (d) hallucinated financial math that survives review because each vertical built its own thin numeric layer.

The thesis is to build **one shared agent platform** where persona is a *parameter* — driving permissions, context, tone, allowed tools, proactive cadence — rather than a *fork* of the codebase. This mirrors the prep guide framing: differences are in **what tools the agent can call, what data it sees, how it sounds, and when it nudges**; the orchestrator, memory tiers, deterministic calculation service, and audit plane are reused across all three personas.

## 2. Users and access patterns

| Persona | Population | Sync chat / user / day | Proactive nudges / user / day | Avg tool calls / chat | Notes |
|---|---|---|---|---|---|
| Retail | 7.0M MAU | 0.2 (1 chat / 5 days) | 0.5 | 2 | Spiky — payday, EMI dates, festivals |
| SME owner/operator | 2.5M MAU | 0.8 (multiple touchpoints) | 1.5 | 4 | GST cycle, payroll, vendor payments |
| CFO / treasury | 0.5M MAU | 1.5 (sessions, not single Q) | 2.0 | 6 | Long sessions, multi-leg reconciliation |
| Internal: notification orchestrator | — | — | drives all proactive QPS | — | Worker pool, not human |
| Internal: ingestion pipeline | — | — | continuous | — | OCR invoices, statement parse, rulebook updates |
| Internal: on-call / compliance | ~50 users | bursty | — | — | HITL approver UI, audit search |

**Assumption:** ~10M MAU total, 30-day month, peak-to-average ratio 4x for chat (lunchtime + post-market 15:30–17:00 IST), 2x for proactive (events bursty around 09:00 IST and 18:30 IST).

## 3. Existing options

| Option | What it gives | Specific gap |
|---|---|---|
| **Plaid AI + Personetics** | Personalized insights on top of aggregated accounts | Insight-only; no agentic action, no SME/CFO workflows, opaque math boundary, US-centric data model |
| **Kasisto (KAI)** | Conversational banking, pre-trained intents | Intent-classifier era; weak tool-calling loop, no shared memory across personas, vendor-controlled prompts |
| **Off-the-shelf LangChain agents** | Fast prototype | No deterministic financial boundary, no HITL, no tenant isolation, no audit retention, no proactive cooldown logic |
| **In-house chatbot (current)** | Some domain knowledge | One persona only (usually retail); rebuild cost for SME/CFO is full vertical, not incremental |
| **Copilot-on-banking-app** | UI-embedded help | Stateless per screen; can't reason across accounts, can't initiate proactive nudges, can't carry SME/CFO multi-step workflows |

None of these give the combination of **persona-aware shared orchestration + deterministic calc + integrated HITL + tenant-grade audit + proactive engine with fatigue prevention**, which is the wedge.

## 4. Why we are building it

- **Shared infra, persona as parameter.** One orchestrator, one memory mesh, one tool registry — three persona configs. The DAG workflow engine I built at BlackBox executed 10K+ agent runs/day across heterogeneous workloads on shared infra (resume.txt:51-54); the same pattern, scaled, fits here.
- **Deterministic financial math boundary.** The LLM proposes; a typed calc service decides. This is the only path to a defensible regulator answer when balance, interest, or tax is involved.
- **Multi-tenant + regulator posture by construction.** Tenant ID flows through every span; SOC-2-style isolation reused from the WASM sandbox plane (resume.txt:49-50) that ran 1M+ daily executions with hard tenant boundaries.
- **HITL + audit as first-class platform features**, not vertical bolt-ons — so adding a 4th persona later (wealth, NRI) is a config change.

## 5. Capacity and load estimates

### 5.1 Chat QPS

Daily chat events:
- Retail: 7,000,000 × 0.2 = **1,400,000 / day**
- SME: 2,500,000 × 0.8 = **2,000,000 / day**
- CFO: 500,000 × 1.5 = **750,000 / day**
- Total: **4,150,000 chats / day**

Average QPS = 4,150,000 / 86,400 ≈ **48 QPS**.
Peak QPS (4x) ≈ **192 QPS**. Round to **200 QPS peak** for sizing.

Anchor: at BlackBox the runtime sustained 10K+ agent runs/day (resume.txt:51-54). 4.15M/day is ~415x larger; the platform must scale horizontally, not optimize the per-run path.

### 5.2 Proactive event QPS

Daily proactive notifications:
- Retail: 7M × 0.5 = 3.5M
- SME: 2.5M × 1.5 = 3.75M
- CFO: 0.5M × 2.0 = 1.0M
- Total: **8.25M proactive events / day**

Average QPS = 8.25M / 86,400 ≈ **96 QPS**.
Peak QPS (2x, but burst-concentrated to two 1-hour windows) — effective peak inside a window: 8.25M × 0.35 / 3,600 ≈ **800 QPS** during 09:00 and 18:30 IST windows. Round to **1,000 QPS peak** for the proactive lane.

This is the ShareChat-style bursty pattern (resume.txt:109-114) — the platform has to absorb load shaped like an ad-decisioning spike, not a smooth web service.

### 5.3 Daily agent runs and token spend

Total agent runs ≈ chats + proactive nudges that invoke the agent (assume 30% of proactive events trigger a full agent run, the rest are templated):
- Agent runs / day = 4.15M + (8.25M × 0.30) ≈ **6.6M runs / day**

Tokens per run (assumption, mixed across personas, ~3 tool calls average, ~2 model hops with reflection):
- Retail simple: 4K tokens
- SME multi-step: 9K tokens
- CFO long-session: 18K tokens
- Weighted: (4.15M chats avg ~6K) + (2.5M proactive avg ~3K) ≈ 4.15M × 6K + 2.5M × 3K = 24.9B + 7.5B = **~32B tokens / day**
- Monthly: **~960B ≈ ~1T tokens / month**

This is the same order of magnitude as the BlackBox model router I built which handled 1B+ tokens/month across Claude/GPT/Grok (resume.txt:55-56) — but **1,000x larger**. The implication is that the capability-aware routing layer is non-negotiable: cheap-model fallback for templated proactive, premium-model only for CFO multi-step, exactly the routing pattern that worked at 1B scale (resume.txt:55-56) re-applied with stricter budget tiers.

### 5.4 Storage growth

| Store | Per-event size | Daily volume | Monthly | Retention | Steady state |
|---|---|---|---|---|---|
| Session memory (Redis) | 2 KB / turn | 4.15M chats × 5 turns × 2 KB = 41 GB/day | — | 24h sliding | ~40 GB hot |
| Long-term user memory (Postgres + pgvector) | 1 KB profile + 4 KB embeddings | 10M users × 5 KB ≈ 50 GB | — | indefinite | 50 GB + growth |
| Financial historical (TimescaleDB) | 200 B / txn | 10M users × 50 txn/day × 200 B = 100 GB/day | 3 TB | 7 years (regulator) | ~250 TB at steady state |
| Org / KB (rulebook + OCR'd invoices + contracts) | 100 KB / doc | 50K new docs/day × 100 KB = 5 GB/day | 150 GB | 10 years | ~20 TB |
| Audit log (immutable, append-only) | 4 KB / event | (6.6M runs + 8.25M nudges) × 4 KB ≈ 60 GB/day | 1.8 TB | 7 years | ~150 TB |
| Observability spans | derived (§5.5) | 5 TB/day | 150 TB | 30 days hot, 1 year cold | ~150 TB hot |

### 5.5 Observability span rate

Spans per agent run (assumption: gateway, auth, identity, context fetch, policy, tool router, 3 tool calls, calc, model hop, response, audit emit = ~12 spans) + proactive lane (~6 spans):
- Sync: 4.15M × 12 = 50M spans/day
- Proactive: 8.25M × 6 = 50M spans/day
- Background ingestion / HITL: 20M spans/day
- **Total: ~120M spans/day, ~6 TB/day at ~50 KB/span (with payloads)**

At BlackBox the telemetry mesh ran 50M spans/day, 2.5 TB/month, with deterministic replay cutting MTTR 60% (resume.txt:58-59). This system is ~2.4x that span rate and ~80x the monthly volume, so the same architecture (Kafka → durable lake → indexed hot tier) holds; the *retention* tier expands and the *index* stays narrow.

### 5.6 Instance sizing on m8g

Pricing anchor: m8g.4xlarge ≈ $0.196/hr On-Demand → $143/mo. Linear scale by vCPU: ~$8.94 per vCPU-month.

Headroom: 1.4 for stateless tiers (gateway, orchestrator, tool router, calc), 1.8 for stateful (memory, notification).

**API gateway + auth + identity resolution.** Per-instance: m8g.2xlarge handles ~250 QPS chat + 600 QPS internal at p99 < 50ms.
- Peak load = 200 (chat) + 1,000 (proactive) + 500 (internal) = 1,700 QPS.
- Per instance: ~800 QPS combined.
- ceil(1,700 / 800 × 1.4) = ceil(2.98) = **3 m8g.2xlarge** → 24 vCPU, 96 GiB. **$214/mo**.

**Agent orchestrator (LangGraph runtime).** Stateful-ish (in-memory checkpoint cache), but state persists to Postgres, so treat as stateless with 1.5 headroom.
- Per-instance: m8g.4xlarge sustains ~80 concurrent agent runs (each ~250ms wall, ~1.5s with tool calls).
- Concurrent runs at peak = 6.6M / 86,400 × peak_factor(4) × avg_wall(2s) ≈ 612 concurrent.
- ceil(612 / 80 × 1.5) = **12 m8g.4xlarge** → 192 vCPU, 768 GiB. **$1,716/mo**.

**Tool router.** Stateless, simple dispatch + RBAC check. m8g.xlarge handles ~1,500 QPS.
- Tool calls / sec at peak: 200 chats × 3 tools + 1,000 proactive × 1 tool = 1,600 QPS.
- ceil(1,600 / 1,500 × 1.4) = **2 m8g.xlarge** → 8 vCPU, 32 GiB. **$72/mo**.

**Deterministic calculation service.** CPU-bound, no LLM. m8g.2xlarge does ~3,000 calc ops/sec.
- Calc ops at peak: 200 chats × 0.7 (70% of chats hit calc) + 1,000 proactive × 0.3 = 440 ops/s.
- ceil(440 / 3,000 × 1.4) = **1 m8g.2xlarge**, run **2 for HA** → 16 vCPU, 64 GiB. **$143/mo**.

**Memory tier (Redis session + Postgres long-term + pgvector).** Stateful, 1.8 headroom.
- Redis session: peak 1,700 QPS reads + 600 QPS writes. m8g.2xlarge handles 30K ops/s easily; **2 nodes** (primary + replica). **$143/mo**.
- Postgres long-term + pgvector: 50 GB hot, peak ~800 QPS. m8g.4xlarge primary + 2 read replicas → **3 m8g.4xlarge** → 48 vCPU, 192 GiB. **$429/mo**.
- TimescaleDB (financial historical, 250 TB steady state): 6 nodes m8g.8xlarge → 192 vCPU, 768 GiB. **$1,716/mo**.

**Notification orchestrator.** Stateful queue workers, 1.8 headroom.
- Peak 1,000 QPS during burst windows; m8g.2xlarge does ~400 QPS per worker (channel fan-out: push, SMS, email).
- ceil(1,000 / 400 × 1.8) = **5 m8g.2xlarge** → 40 vCPU, 160 GiB. **$358/mo**.

**Total compute (excluding KB, audit, observability storage):** ~**$4,791/mo** for compute alone. Storage and managed services (Kafka, S3, OpenSearch) add roughly 2-3x; full BoE ~$15-18K/mo. This is for a 10M MAU footprint — the model router on premium models will dwarf this (1T tokens/month is the dominant cost line, not compute).

## 6. Functional and non-functional requirements

### Functional

- **FR-1 Shared orchestration.** One LangGraph DAG with persona-parameterized nodes: identity → policy → context → planner → tool loop → calc → response → audit emit. Same DAG executes Retail/SME/CFO, differing only in the policy and context nodes — same checkpointing and retry semantics the BlackBox graph engine used (resume.txt:52-54).
- **FR-2 Persona-aware context.** Context manager loads {session, long-term-user, financial-historical, organizational} memory based on persona scope. Retail never sees org memory; CFO always does.
- **FR-3 Deterministic calc service.** All numeric outputs (balance, interest, tax, FX, EMI, runway) must flow through the typed calc service; the LLM may *describe* but not *compute*. Hard boundary, enforced by the tool router.
- **FR-4 Tool registry with RBAC.** Tools are typed, versioned, and gated by `(persona, scope, risk_tier)`. Risk tiers: read-only / low / medium / high. Medium and high require HITL.
- **FR-5 Layered memory.** Session (Redis, 24h), long-term user (Postgres + pgvector, indefinite), financial historical (Timescale, 7y), organizational (S3 + vector index, 10y).
- **FR-6 Proactive engine.** Event-driven (Kafka). Per-user cooldown (min 4h same-topic, min 24h same-channel). Fatigue prevention: rolling 7-day cap of 5 nudges/user, decayed by engagement.
- **FR-7 HITL workflows.** Medium-risk = bank ops approver (SLA 30 min); high-risk = customer + ops dual approval (SLA 4h). State machine analogous to the AutoML state machines at 15M+ jobs/month (resume.txt:91-92), here for approval rather than training.
- **FR-8 Audit.** Every agent decision, tool call, and HITL transition emits an append-only audit event with tenant + persona + user + request hash + model + tool args + result hash. 7-year retention. Tamper-evident (hash chain).
- **FR-9 Observability.** Span-per-step, deterministic replay of any run from the audit + span store, same pattern that cut MTTR 60% at BlackBox (resume.txt:58-59).

### Non-functional

- **NFR-1 Latency.** Sync chat: p50 ≤ 1.2s, p99 ≤ 3.5s end-to-end. Proactive: p99 ≤ 60s from event to delivery. HITL poll: p99 ≤ 200ms.
- **NFR-2 Availability.** Chat path 99.9%, notification path 99.95% (it must never drop a regulator-mandated alert), calc service 99.99%.
- **NFR-3 Durability.** Audit log: 11 nines (S3 + Glacier with object-lock). Financial historical: 11 nines. Session memory: 3 nines tolerated (re-derivable from audit).
- **NFR-4 RTO/RPO.** RTO ≤ 30 min for chat, ≤ 10 min for notification path. RPO ≤ 5 min for memory tiers, ≤ 0 for audit (synchronous replication).
- **NFR-5 Security & compliance.** SOC-2 Type II, DPDP (India), RBI guidelines for chatbot disclosures, PCI for any card-data touch. Tenant isolation enforced at gateway and tool router. Encryption in transit (mTLS, anchored to the TunDRA QUIC-in-Rust posture I built across 1M+ instances, resume.txt:97-98) and at rest (KMS per tenant for SME/CFO).
- **NFR-6 Scalability.** Event-driven, horizontally scalable, no in-process state outside the LangGraph checkpoint cache.
- **NFR-7 Out of scope.** Voice channel (deferred), agentic *trading* on customer behalf (regulatory blocker), cross-bank account aggregation (separate Plaid-style platform), generative document creation beyond templated summaries.

**Assumption:** the rollout starts with Retail-only behind a 5% canary, then 25%, then 100%; SME adds at month 4, CFO at month 7. This staged path is what the capacity model above is sized for at steady state.

---

Resume anchors used: LangGraph DAG runtime and checkpointing at 10K+ runs/day (resume.txt:51-54), model router at 1B+ tokens/month (resume.txt:55-56), telemetry mesh at 50M spans/day with deterministic replay (resume.txt:58-59), WASM sandbox tenant isolation at 1M+ daily executions (resume.txt:49-50), AutoML state machines at 15M+ jobs/month (resume.txt:91-92), TunDRA QUIC-in-Rust on 1M+ instances (resume.txt:97-98), ShareChat ad-decisioning at 40M DAU (resume.txt:109-114).
