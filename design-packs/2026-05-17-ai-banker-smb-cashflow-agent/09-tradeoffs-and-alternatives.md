# 09 - Tradeoffs and Alternatives

Every decision below is annotated with what we picked, what we seriously considered, why we rejected the alternatives, and the specific signal that would make us reopen the call. Anchors cite the resume because the decisions inherit credibility (and scars) from prior systems.

---

## Group 1 - Orchestration & Runtime

### 1. Agent topology: Multi-agent supervisor over a single ReAct loop

| Field | Value |
|---|---|
| Picked | LangGraph supervisor with specialist sub-agents (Forecaster, Reconciler, Advisor, Action-Executor, Explainer) |
| Considered | Single big-model ReAct loop with a giant tool registry; hand-coded YAML workflow with no LLM planner |
| Rejected because | A single ReAct loop on 30+ tools degrades tool-selection accuracy past ~12 tools and balloons context cost at 1B+ tokens/month, a regime we already operated in `(resume.txt L55-56)`. Hand-coded workflows can't handle the open-ended "why is cash short next Tuesday?" class of question. |
| Reconsider when | A single frontier model with >256K context and reliable structured tool use makes the supervisor overhead net-negative - i.e., when median run latency drops below 2s on flat ReAct and tool-selection F1 stays >0.92 across our eval set. |

### 2. Orchestrator: LangGraph over Temporal / Step Functions / raw asyncio

| Field | Value |
|---|---|
| Picked | LangGraph with Postgres checkpointer for durable, resumable graph execution |
| Considered | Temporal (Go SDK), AWS Step Functions, raw asyncio + Celery |
| Rejected because | Temporal is the strongest contender but its DX is workflow-centric, not graph-centric - building branching reasoning loops on top of Temporal activities is fighting the framework. Step Functions adds vendor lock and 25K event-history limits that break long agent runs. Raw asyncio gives up the checkpointing semantics we proved at 10K+ runs/day `(resume.txt L51-54)`. LangGraph gives us native graph state, conditional edges, and a checkpointer interface we can back with Postgres. |
| Reconsider when | We hit a LangGraph determinism bug we can't patch upstream within 2 weeks, OR fleet exceeds 200K runs/day per region and Postgres checkpointer write amplification (currently ~6 writes/node) becomes the bottleneck. At that point, port hot paths to Temporal and keep LangGraph for prototyping. |

### 3. Runtime language: Python for agents, Go for the data/edge plane

| Field | Value |
|---|---|
| Picked | Python 3.12 (FastAPI + LangGraph) for agent runtime; Go for ingestion workers, webhook receivers, and the sandbox plane |
| Considered | Pure Go agent runtime; pure Rust runtime; Node.js/Bun |
| Rejected because | The LLM/agent ecosystem (LangGraph, LangChain, LangFuse, instructor, dspy) is Python-first; rewriting in Go costs 6 months of velocity for ~30% latency gain that's dwarfed by LLM call latency anyway. We already proved the Go split at BlackBox where WASM and high-throughput planes were Go and the agentic layer was Python `(resume.txt L49-54)`. |
| Reconsider when | LangGraph ships a stable Go port (unlikely <18 months), OR agent-loop CPU overhead (excluding LLM calls) exceeds 35% of per-request cost. |

### 4. State model: Stateless K8s pods + Postgres state over actor frameworks

| Field | Value |
|---|---|
| Picked | Stateless agent pods on EKS; all durable state in Postgres (checkpointer + run table); ephemeral working memory in pod-local Redis |
| Considered | Akka/Orleans virtual-actor model; Erlang/OTP; Ray Serve actor pool |
| Rejected because | Virtual actors give better in-memory locality but couple us to a stateful cluster that's painful to drain, version, and SOC-2 audit. Stateless pods + Postgres is the model that survived 15M+ jobs/month on Azure ML `(resume.txt L91-92)` and 1M+ daily sandbox executions at BlackBox `(resume.txt L49-50)`. SMB workflows are bursty and resumable, not low-latency tick-tick - pod locality buys us little. |
| Reconsider when | Per-run state grows past ~5MB hot working set and Postgres checkpoint write latency p99 > 80ms, OR we add real-time voice/chat sub-200ms requirements where pod-local state genuinely matters. |

### 5. Run dispatch: Postgres SKIP LOCKED over Redis queue / Kafka

| Field | Value |
|---|---|
| Picked | Postgres `FOR UPDATE SKIP LOCKED` on a `runs` table for run claim and lease renewal |
| Considered | Redis Streams with consumer groups; Kafka with partitioned consumer; SQS FIFO |
| Rejected because | At our claim rate (peak ~2K claims/sec at 1M tenants) Postgres SKIP LOCKED is well within published limits and gives us one transactional system of record - no dual-write between queue and state. Kafka adds operational weight (we maintained Kafka and SKIP LOCKED in parallel at Microsoft and SKIP LOCKED won the agentic workloads on simplicity). Redis Streams loses durability guarantees we need for SOC-2 audit trails. |
| Reconsider when | Claim rate sustains >10K/sec or claim p99 latency exceeds 50ms after partitioning the runs table. At that point, move the dispatch hot path to Kafka and keep Postgres as the system of record. |

---

## Group 2 - Memory & Retrieval

### 6. Vector store: pgvector over Pinecone / Qdrant / Weaviate

| Field | Value |
|---|---|
| Picked | pgvector (Postgres extension) with HNSW indexes, partitioned by tenant_id |
| Considered | Pinecone (managed), Qdrant (self-hosted), Weaviate, Vespa |
| Rejected because | Three reasons. (a) Per-tenant row-level security in Postgres extends naturally to vectors; replicating that in Pinecone needs per-tenant indexes that blow up cost past 50K tenants. (b) We need joins between vector hits and transactional data (invoices, balances) - pgvector keeps that in one query. (c) I shipped Qdrant in production at Microsoft `(resume.txt L101)`; it's excellent but adds a second stateful system to back up, replicate, and audit. |
| Reconsider when | Paid-tier MRR exceeds $500K AND working-set vectors per tenant exceed 5M (where pgvector HNSW recall starts degrading without aggressive `ef_search`), OR p99 retrieval latency exceeds 120ms after read-replica scaling. Migrate hot tenants to Qdrant first, not Pinecone - we don't need managed at that scale. |

### 7. Memory model: Three-tier (working/long-term/episodic) over single store with importance scores

| Field | Value |
|---|---|
| Picked | Working memory (Redis, TTL minutes), long-term semantic memory (pgvector, tenant-scoped), episodic memory (Postgres `agent_episodes` table with structured outcomes) |
| Considered | Single unified store with an LLM-scored `importance` field (MemGPT-style); pure context-window stuffing |
| Rejected because | A single store forces every retrieval to re-score importance and conflates "what the user said 30s ago" with "what we learned about this business 6 months ago." Separation lets us tune TTL, embedding model, and access controls per tier independently - the same separation that worked for our LLMOps telemetry mesh at BlackBox `(resume.txt L58-59)`. |
| Reconsider when | Eval shows the supervisor agent retrieves from the wrong tier >15% of the time, OR maintenance cost of three stores exceeds the eval-quality delta. Most likely the unified store wins only after a frontier model can do retrieval routing reliably itself. |

### 8. ANN index: HNSW over IVF-Flat / flat brute force

| Field | Value |
|---|---|
| Picked | HNSW (`m=16`, `ef_construction=64`, `ef_search=40`) |
| Considered | IVF-Flat with nprobes tuning; flat brute force; ScaNN |
| Rejected because | HNSW gives us >0.95 recall at 10x query speed of flat for the corpus sizes we expect (median tenant ~50K vectors). IVF-Flat needs retraining on insert and we have continuous ingestion - that's an operational sharp edge I already paid for `(resume.txt L60-61)`. Flat brute force is fine for the smallest tenants and we'll use it as the sub-1K vector default. |
| Reconsider when | Per-tenant vector count exceeds 10M (HNSW memory becomes painful) - switch that tenant to IVF-PQ with on-disk storage. |

---

## Group 3 - Forecasting

### 9. Forecast core: Deterministic waterfall + Monte Carlo + LLM explainer over LLM-end-to-end or pure classical

| Field | Value |
|---|---|
| Picked | Rule-based cashflow waterfall (AR aging + AP schedule + recurring) → Monte Carlo (10K paths over collection/payment distributions) → LLM only for natural-language explanation |
| Considered | LLM-end-to-end forecast (give the model the transactions and ask); classical Prophet/ARIMA; Bayesian structural time-series |
| Rejected because | LLMs are not calibrated probabilistic forecasters - they hallucinate confidence intervals and can't be audited to a SOC-2 auditor's satisfaction. Prophet/ARIMA assume stationarity that SMB cashflow brutally violates (one delayed customer invoice swings the week). The waterfall + MC split keeps the numbers defensible and lets the LLM do what it's actually good at: explain the drivers. |
| Reconsider when | A frontier model demonstrates calibrated 80%/95% PI coverage on our held-out SMB cashflow eval set across at least 2 quarters. Until then, the LLM stays as a narrator, not a forecaster. |

### 10. Forecast granularity: Daily over hourly / weekly

| Field | Value |
|---|---|
| Picked | Daily buckets for 90 days; weekly buckets for 90-365 days |
| Considered | Hourly granularity (matches payment processor settlement); weekly only |
| Rejected because | SMB owners think in days ("will I make payroll Friday?"). Hourly adds noise without decision value - payment timing is dominated by counterparty behavior, not intra-day timing. Weekly-only loses the payroll-day signal that's the #1 query class. |
| Reconsider when | We add treasury/sweep automation for >$5M ARR customers where intra-day cash matters; introduce hourly as a separate forecast track, don't promote daily. |

---

## Group 4 - Model Strategy

### 11. Provider strategy: Multi-provider router over single-vendor

| Field | Value |
|---|---|
| Picked | Capability-aware router across Claude (planning/explanation), GPT (structured extraction), Grok/Gemini (long-context ingest), self-hosted Llama (PII-sensitive ops) |
| Considered | Single-vendor (Anthropic-only or OpenAI-only); two-provider failover only |
| Rejected because | I lived through 3 provider outages in the BlackBox 1B+ token/month regime `(resume.txt L55-56)`; single-vendor SLAs aren't sufficient for a system SMB owners trust with payroll decisions. Capability routing also unlocks 30-40% cost savings by sending cheap intent classification to Haiku/4-mini class models. |
| Reconsider when | One provider ships a model that strictly dominates on quality AND cost AND latency for our top 5 task classes for 2 consecutive quarters. Even then, keep one fallback for outage resilience - never go true single-vendor. |

### 12. Inference hosting: Hosted LLMs over self-hosted (with one self-hosted PII model)

| Field | Value |
|---|---|
| Picked | Hosted (Anthropic, OpenAI, xAI, Google) for the supervisor and reasoning agents; self-hosted Llama-3-70B on Azure/GCP GPUs for PII-redaction and transaction classification |
| Considered | Full self-hosted (Llama/Mistral on owned GPU fleet); full hosted |
| Rejected because | Full self-hosted only makes sense when token volume × hosted markup > GPU fleet TCO including vLLM ops, eval drift, and on-call. We're not there for the reasoning layer. We *are* there for the high-volume narrow tasks (classification, redaction) - that's where I shipped vLLM in production `(resume.txt L101)` and the unit economics work. |
| Reconsider when | Token spend on a single hosted model class exceeds $1.5M/year AND we have 2 SREs who can own a vLLM fleet, OR a regulated customer demands no-cloud-LLM contractually. |

---

## Group 5 - Data & Integration

### 13. Ingestion: Pull-based APIs + webhooks over aggregator-only or OCR-first

| Field | Value |
|---|---|
| Picked | Direct integrations with QuickBooks, Xero, Stripe, Plaid (banking), Gusto (payroll) via OAuth + webhooks; OCR for email-attached invoices as a fallback |
| Considered | Aggregator-only (Plaid/Finicity for everything); OCR-first from email/Drive scraping |
| Rejected because | Aggregators give breadth but lose the structured invoice/PO/customer data we need for reconciliation - they're a bank-statement lens, not an accounting lens. OCR-first is a quality and cost trap for a forecasting product. Webhook-first ingestion is also the only way to keep the agent's view fresh enough to answer "what changed this morning?" |
| Reconsider when | A vertical (e.g., trucking, restaurants) doesn't use QuickBooks/Xero and we'd need 5+ niche ERPs - there, lean on aggregators and OCR for that vertical only. |

### 14. Storage split: Postgres (OLTP) + ClickHouse (analytics + traces) over unified warehouse

| Field | Value |
|---|---|
| Picked | Postgres for transactions, agent state, memory; ClickHouse for transaction-level analytics, agent traces, and forecast backtest store |
| Considered | Unified Snowflake/BigQuery for everything analytical; unified Postgres with TimescaleDB |
| Rejected because | Snowflake/BigQuery latency for interactive agent queries (need <500ms for "show me last quarter's biggest expense category") is too slow without aggressive caching, and per-query cost is unpredictable when an agent might fan out 20 queries. ClickHouse is what I used for 2.5TB/month of trace data at BlackBox `(resume.txt L58-61)` and it handled both interactive and batch cleanly. |
| Reconsider when | We add a data-team-owned BI layer and want one source of truth for finance dashboards (probably year 2-3); then mirror ClickHouse → BigQuery for BI, but keep CH as the operational store. |

---

## Group 6 - Safety & UX

### 15. Action safety: HITL approval for writes above thresholds over full auto / zero auto

| Field | Value |
|---|---|
| Picked | Tiered: read-only and advisory always auto; reversible writes (drafting invoices, categorizing) auto with undo; irreversible writes (sending payment, emailing customer) require explicit owner approval above $-tier thresholds |
| Considered | Full auto with rollback; zero automation (advisory only); per-customer-configured policy |
| Rejected because | Full auto with rollback doesn't work for outbound payments and customer-facing emails - you can't unsend. Zero automation kills the product's reason to exist. The threshold model maps cleanly onto SOC-2 controls I designed at BlackBox `(resume.txt L49-50)` and Microsoft `(resume.txt L88-94)`. |
| Reconsider when | We have 6 months of approval-trail data showing >98% approval rate for a specific action class - promote that class to auto-with-undo. Use real evidence, not vibes. |

### 16. Conversation transport: Streaming SSE over polling / WebSocket

| Field | Value |
|---|---|
| Picked | SSE for agent-to-client streaming; HTTP POST for client-to-agent; WebSocket reserved for future voice mode |
| Considered | Polling (request/response); full WebSocket bidirectional; gRPC streaming |
| Rejected because | SSE is one-way (what we need - most data flows server→client), works through every proxy/CDN we'd put in front of it, and doesn't need the connection-state machinery WebSocket forces on us. WebSocket's only win is bidirectional, which we don't need until voice. |
| Reconsider when | We add real-time voice or collaborative multi-user agent sessions where the client needs to interrupt mid-response with low-latency signals. |

### 17. Data residency: Per-tenant region pinning over single-region with logical isolation

| Field | Value |
|---|---|
| Picked | Single-region (us-east) at launch with tenant_id-scoped row-level security; EU region added at first enterprise EU contract; per-tenant region pinning controlled by a residency field on the tenant record |
| Considered | Single-region forever with logical isolation only; multi-region from day one |
| Rejected because | Multi-region from day one triples ops cost before we have product-market fit and the cross-region data sync for the memory/vector stores is genuinely hard. Single-region forever loses every EU and finance-regulated enterprise deal past Series A. The middle path matches how we evolved multi-tenant ML infra at Microsoft `(resume.txt L88-89)`. |
| Reconsider when | First enterprise EU or APAC deal closes - then activate the second region within 90 days, with the residency field already in the schema. |

### 18. Guardrails: Layered (input filter + tool-policy + output check) over single LLM-judge

| Field | Value |
|---|---|
| Picked | Three layers: input prompt-injection classifier, tool-call policy engine (OPA-style rules), output PII + hallucination check via cheaper LLM |
| Considered | Single LLM-as-judge over the whole turn; no guardrails (rely on model behavior); regex-only |
| Rejected because | One LLM judge is a single point of failure and adds 1-2s latency per turn. Regex-only misses semantic attacks. Layered defense is what survived enterprise SOC-2 review at BlackBox `(resume.txt L49-50)`. |
| Reconsider when | A frontier model ships a built-in safety classifier that beats our stack on our red-team eval set with lower latency - fold our layers into it. |

---

## Decisions I'm Least Confident In

Three decisions where the evidence is thinnest and how we'd de-risk in the first 90 days:

1. **#6 pgvector over a dedicated vector DB.** The bet is that join-with-OLTP + per-tenant RLS wins over raw vector performance. De-risk: build a parallel Qdrant shadow index for the top 100 tenants by query volume in month 2; measure recall and p99 latency side-by-side. If pgvector slips >25% on either metric, we have a pre-validated migration path.

2. **#9 deterministic waterfall + Monte Carlo over an LLM-end-to-end forecast.** The bet is that calibration matters more than narrative quality and that frontier models can't yet do calibrated probabilistic reasoning over SMB cashflow. De-risk: in month 1, run an end-to-end LLM forecast in shadow mode against the waterfall, score both on prediction interval coverage and MAPE on a 200-business held-out set. Revisit at month 3 with real numbers.

3. **#12 hosted LLMs over self-hosting the reasoning layer.** The bet is that hosted-API economics beat owned-GPU TCO at our token volume for the first 18 months. De-risk: stand up a single self-hosted Llama-3-70B node for the transaction-classification path in month 2 (we need it anyway for PII), measure real $/1M-tokens including GPU idle time, on-call cost, and eval drift. Use that number to project the crossover for the reasoning layer honestly - most teams underestimate ops cost by 3x.
