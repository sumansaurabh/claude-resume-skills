# 02 - Design Estimates: B2C AI Agent Orchestrator + Catalog

## 1. Use case and problem statement

Build a B2C web platform where any consumer can author, run, fork, and share a custom AI agent. An agent is the bundle of (persona, MCP/OAuth connectors, Claude-Skill-style scripts that execute in a sandbox, multi-tier memory, optional RAG corpora). The platform must operate the agent runtime, isolate user code in a sandbox plane, route LLM traffic across providers, expose a public catalog for discovery and forking, and split revenue with authors - at 1M registered users and ~5K peak concurrent runs while staying within Custom-GPT-grade latency targets (p50 first-token ~1.5s).

## 2. Users and access patterns

| Persona | Access pattern | Read/write mix | Peak concurrency | Notes |
|---|---|---|---|---|
| Agent creator (author) | Interactive web editor - persona prompt, connector OAuth, skill upload, test runs | 60/40 R/W | ~3K sessions | Heavy on connector handshake + sandbox cold-start |
| Agent consumer (end-user) | Chat-style run + tool calls | 95/5 R/W | ~5K runs in-flight | Drives most LLM tokens and memory writes |
| Catalog browser | Search, filter, preview, fork | 99/1 R/W | ~20K rps at viral spike | CDN-cachable; search is the heavy backend |
| Author for revenue (creator economy) | Analytics dashboards, payout, A/B variants | 80/20 R/W | ~500 | Reads cost/run metrics; daily payouts |
| Platform admin / trust & safety | Moderation queue, kill switch, audit log | 70/30 R/W | tens | Cross-tenant read; needs least-privilege guard |
| Automated CI / cron callers | Scheduled agent runs (cron, webhooks, API key) | 50/50 R/W | ~2K rps | Idempotency keys mandatory; separate quota class |

## 3. Existing options and gaps

| Option | What it does well | Gap we exploit |
|---|---|---|
| OpenAI Custom GPTs | Easy persona + file RAG + ChatGPT distribution | Locked to GPT models; no Claude Skill scripts; no real sandboxed code; weak connector breadth; no revenue share with creators |
| Anthropic Projects | Strong Claude + Skills + memory primitives | No public catalog / fork / discovery; no monetization; no MCP connector marketplace UI |
| Poe (Quora) | Multi-model bot directory; revenue share | Light on tool-calling, sandbox, persistent memory; no scriptable skills |
| character.ai | Persona depth + viral catalog | Entertainment-focused; no tools, no MCP, no enterprise-grade memory |
| Dust.tt | Connectors + assistants for work | B2B-priced; not consumer-friendly; no consumer catalog / forking economy |
| LangSmith Hub / LangChain hub | Prompt + chain sharing for devs | Dev-facing, no consumer surface, no runtime, no memory, no monetization |
| Coze (ByteDance) | Bot builder + plugins | Closed ecosystem; opaque pricing; weak Western connector coverage |
| Internal `/skills + Claude Skills` only | Power-user CLI flow | No public surface, no catalog, no isolation across users |

**Gap statement**: nothing today combines (a) open MCP + OAuth connector breadth, (b) scriptable Claude-Skill code in a hardened sandbox, (c) persistent multi-tier memory per agent-user pair, (d) consumer catalog with fork + revenue split, and (e) multi-model routing with cost passthrough.

## 4. Why we are building it

- **Connector breadth as a moat.** MCP is an open standard; first platform to ship 200+ MCP servers + OAuth (Gmail, Slack, Notion, GitHub, Drive) with one-click install wins distribution. Anchored on prior model-router work spanning Claude/GPT/Grok with capability-aware routing at 1B+ tokens/month (resume.txt:55-56).
- **Agent portability.** A user's agent is a portable bundle (persona + skill scripts + connector manifest + memory snapshot). Fork-on-catalog is cheap because state is decoupled from runtime.
- **Creator monetization.** Revenue share per token consumed by forks, plus per-run pricing - directly inspired by 200K+ users adopting Microsoft AutoML through SDK + UI (resume.txt:90-92), where developer-platform adoption was the moat.
- **Memory depth.** Four-tier memory (working / episodic / semantic / procedural) per agent-user pair, with checkpointing - anchored on durable resumable agents with memory persistence (resume.txt:53-54).
- **Skill scriptability + sandbox safety.** User-uploaded Skill scripts run in a Go-backed WASM sandbox, anchored on the WASM plane isolating 1M+ daily zero-shot executions and unblocking SOC-2 (resume.txt:49-50). This is the core differentiator vs Custom GPTs (no real code) and Poe (no scripts at all).

## Agentic Design Estimates Checklist (20 points)

1. **State persistence.** What survives crash: graph node outputs (Postgres + S3), tool-call results (idempotency-keyed in Redis + Postgres), agent memory writes (Postgres + vector store), checkpoint cursor (Postgres). What is recomputed: planner reasoning trace if not yet committed, in-flight LLM stream if first-token not yet flushed. Pattern reused from BlackBox checkpointing + retry semantics (resume.txt:53-54).
2. **Idempotency of tool calls.** All write-side connector calls (Gmail send, Slack post, Stripe charge) must carry a deterministic `idempotency_key = hash(run_id, node_id, attempt_input)`. Read-side MCP calls are safe to repeat. WASM skill executions are pure unless they call out - outbound HTTP from sandbox is recorded and replayed on retry.
3. **Cycle detection and loop prevention.** Per-run counter: max 25 graph hops, max 5 invocations of the same tool with the same arg hash, max 8 LLM calls per planner node. Exceeding any cap → planner forced into a `summarize_and_stop` terminal node.
4. **Parallel subgraph execution and join semantics.** Planner can fan out N=≤6 parallel tool calls via a `parallel` node; barrier waits with a timeout (45s) and `all_required | first_success | best_effort` policies. Joined output is a typed dict, not a freeform string.
5. **Conditional edge logic.** The planner LLM emits a structured `next_node` token under a constrained JSON grammar; the graph layer (not the LLM directly) resolves the edge from a static allowlist for that node. Prevents LLM jailbreak from rerouting itself.
6. **Human-in-the-loop interrupt and resume.** Nodes marked `requires_approval` (e.g. `send_email`, `transfer_money`, `delete_file`) emit an `interrupt` event, persist state, and return control to the UI. Resume re-hydrates state from Postgres + Redis and continues - same checkpoint primitive as BlackBox durable execution (resume.txt:53-54).
7. **Short-term / long-term / episodic memory separation.** Working memory = current run's scratchpad (Redis, TTL=2h). Episodic = per-session conversation summary (Postgres). Semantic = vector embeddings of user-supplied + agent-learned facts (Qdrant). Procedural = compiled skill code + tool-use patterns (S3 + Postgres). Each has its own retention + GDPR delete path.
8. **Tool routing.** Each node has a `tool_allowlist` enforced at the graph executor, not in the prompt. The planner can request a tool not in the allowlist, but the executor will refuse and feed an `observation: tool_not_permitted` back into the loop. Cross-tenant tool isolation enforced by signing tool descriptors with the tenant key.
9. **Tool failure handling.** Per-tool retry policy: exponential backoff 3 tries for 5xx/timeout; 0 retries for 4xx; fallback edge `on_tool_error` points to a recovery node that can ask the user, switch tool, or abort. Connector circuit breaker trips at 50% error rate over 60s.
10. **Agent-to-agent communication.** Single-process agents share state via the graph's typed channels (LangGraph-style). Cross-process / multi-agent flows use a durable scratchpad in Postgres + a topic on Kafka (one topic per `run_id`). No direct in-memory hand-off - keeps recovery clean.
11. **Concurrent run isolation at 1M users.** Tenant boundary = `(user_id, agent_id)` keyspace. WASM sandbox = one isolate per run, no shared heap. Postgres = row-level security on `tenant_id`. Vector store = per-tenant namespace. Reuses VNet + multi-tenant K8s isolation patterns from Microsoft (resume.txt:87-89).
12. **Latency budget per graph hop.** p99 per-hop budget = 400ms (graph executor) + LLM time. For an 8-hop run at p50 LLM 1.2s/hop → 9.6s total; at p99 LLM 3s/hop → 24s + ~3.2s graph overhead = ~27s p99 run. First-token target 1.5s p50 because we stream from the first planner node before the full graph completes.
13. **Checkpoint and resume mid-graph.** After each node, write `(run_id, node_id, output, version)` to Postgres + Redis. Resume = load latest cursor + replay deterministic nodes from cache; non-deterministic LLM nodes re-execute. Same pattern as BlackBox deterministic replay at 50M spans/day (resume.txt:58-59).
14. **Versioning of graph definitions during live traffic.** Each agent has `graph_def_version`; a run is pinned to the version that started it. Author publishes v2 → new runs start on v2, in-flight runs finish on v1. Catalog forks always pin to a frozen version.
15. **Multi-tenant isolation - preventing cross-tenant tool output / memory bleed.** Vector retrieval is namespace-scoped at query time, not filter time, so a buggy prompt cannot accidentally pull another tenant's docs. Tool outputs are tagged with `source_tenant`; the LLM-facing renderer strips foreign tenant tags. Reuses VNet + namespace + identity isolation from Azure ML (resume.txt:87-89).
16. **Prompt injection through tool outputs.** Tool outputs are wrapped in a fenced `<tool_output trusted="false">` block before being concatenated into the planner prompt. A small classifier checks outputs for obvious instruction-injection patterns ("ignore previous instructions", URL-encoded prompts). Skill scripts in WASM cannot read the system prompt directly - they receive a redacted task envelope.
17. **Token budget enforcement per run.** Each run carries `token_budget_remaining`. Model gateway decrements on every call and refuses when ≤0, raising `BudgetExceeded` into the graph (handled by `on_budget_exceeded` edge). Budget is set per agent tier (free: 50K tokens/run; pro: 500K). Aligns with cost-attribution patterns from 1B+ tokens/month model-router work (resume.txt:55-56).
18. **Partial execution failure and rollback.** Compensation actions registered per side-effecting tool (e.g. `send_email` → no rollback possible, mark run `partially_committed`; `create_calendar_event` → `delete_calendar_event` compensation). Graph emits a `saga_state` so the UI can show "3 of 5 steps committed, 1 needs manual cleanup".
19. **Observability: tracing a stuck or looping graph.** Every node emits an OTel span with `(run_id, node_id, attempt, tokens, latency_ms, tool_calls[])`. Stuck detector = no span in 60s for an active run. Loop detector = same `(node_id, input_hash)` ≥3 times triggers alert + auto-abort. Anchored on 50M spans/day telemetry mesh and 60% MTTR reduction (resume.txt:58-59).
20. **Scale model - peak concurrent runs, fan-out, coordinator bottleneck.** Target 5K peak concurrent runs × avg fan-out 1.5 parallel tool calls = 7.5K in-flight tool invocations. Coordinator (graph executor) is sharded by `hash(run_id) % N` across OrchestratorAPI pods so no single node owns all runs. Model gateway is the hottest service - sized separately below.

## 5. Capacity and load estimates

### 5.1 User and run volume

- Registered users: **1,000,000**
- Weekly active (10% of registered): **100,000**
- Daily active (DAU = 40% of WAU): **40,000**
- Agents created (1% of registered author): **10,000**
- Avg runs/DAU/day: **6** → **240,000 runs/day**
- Peak hour share (5× avg): 240K / 24 × 5 = **50,000 runs/peak hour** = **~14 runs/sec**
- Avg run duration (8 hops × 1.5s LLM + 0.4s graph overhead): ~15s
- Peak concurrent runs = peak rps × avg run duration = 14 × 15 ≈ **~210 sustained**; bursty design target = **5,000 concurrent** (catalog viral spike, scheduled cron storms) - anchored on BlackBox 10K+ agent runs/day baseline (resume.txt:51-52), scaled ~24× for B2C concurrency.

### 5.2 LLM tokens and model gateway QPS

- Hops per run: **8 avg**
- Tokens per hop (input+output): **2,000**
- Tokens per run: 8 × 2,000 = **16,000**
- Tokens/day: 240,000 × 16,000 = **3.84B tokens/day** → **~115B tokens/month**
- Anchored on BlackBox 1B+ tokens/month at 10K runs/day (resume.txt:55-56); B2C scale-up to 240K runs/day → ~24×, projecting ~24B/month is conservative; viral catalog drives toward 115B/month upper bound. Plan for **20–50B tokens/month steady state, 115B peak**.
- Peak QPS to model gateway: 5,000 concurrent runs × 1 in-flight LLM call/run avg = **5,000 LLM rps** at peak; sustained = ~14 runs/sec × 8 hops / 15s ≈ **~7.5 LLM rps**. Gateway must support **5K rps peak**, **500 rps p99 steady**.

### 5.3 Storage growth

| Bucket | Assumption | Per-unit | Population | Total | Notes |
|---|---|---|---|---|---|
| Memory (working+episodic+semantic) | 50 MB/user (assumption - avg over WAU; cold users near zero) | 50 MB | 1M registered (but 100K WAU dominate) | **~50 TB worst case, ~5 TB realistic** | Tiered: hot in Postgres+Qdrant, cold in S3 |
| RAG indexes | 30% of 10K agents have RAG; 100 MB avg corpus | 100 MB | 3,000 corpora | **300 GB raw + ~600 GB embeddings (3× blow-up)** | HNSW + bm25 hybrid, per-tenant namespace |
| Skill scripts (procedural memory) | 50 KB avg / agent | 50 KB | 10K agents | **500 MB** | Negligible; in S3 + Postgres metadata |
| Run traces / OTel spans | 8 hops × ~5 spans/hop = 40 spans/run; 1 KB/span | 40 KB | 240K runs/day | **~9.6 GB/day, ~290 GB/month, ~3.5 TB/year** | ClickHouse + S3 cold; pattern from 50M spans/day, 2.5TB/month at BlackBox (resume.txt:58-59) |
| Checkpoints | 8 hops × 10 KB output snapshot | 80 KB | 240K runs/day | **~19 GB/day, ~580 GB/month** | Postgres + S3 after 7d |
| Catalog metadata | persona+skills+manifest, ~20 KB/agent | 20 KB | 10K agents | **200 MB** | Negligible |

### 5.4 Bandwidth

- Egress to LLM providers: ~115B tokens/month × 4 bytes/token ≈ **460 GB/month** (request side) + ~similar response.
- Catalog browse traffic (CDN-cached): 20K rps peak × 50 KB/page = **1 GB/s peak** - served from CDN, ~95% cache hit, origin sees ~50 MB/s.
- Tool/connector egress: hard to bound precisely (depends on connector); assumption: 10 KB avg per tool call × 7.5K tool calls peak = **75 MB/s peak**.

### 5.5 Vector store retrieval QPS

- 60% of LLM hops trigger a vector retrieval = 0.6 × 8 hops × 14 rps = **~67 retrievals/sec sustained**, **~24,000 retrievals/sec at 5K concurrent burst** (5K × 0.6 × ~8 calls/15s).
- Sized at **30K peak QPS** to vector store cluster.

### 5.6 Instance sizing on m8g family

Anchor pricing: `m8g.4xlarge` ≈ $0.196/hr On-Demand (16 vCPU / 64 GB) → ~$143/month. Scale linearly by size. ARM Graviton4 is the default; deviations called out below.

| Service tier | Instance (deviation note) | Count | Total vCPU | Total RAM | Monthly $ (On-Demand) | Sizing rationale |
|---|---|---|---|---|---|---|
| Gateway (TLS + auth + rate-limit) | m8g.2xlarge (8vCPU/32GB) | 6 | 48 | 192 GB | ~$430 | Mostly I/O bound, ARM is fine. Sized for 20K rps catalog + 5K rps API peak with 3× headroom. |
| OrchestratorAPI (graph executor) | m8g.4xlarge | 8 | 128 | 512 GB | ~$1,150 | Holds in-memory graph state for 5K concurrent runs; shard by run_id. Each pod ~625 runs. |
| AgentRuntime (planner loop + tool dispatch) | **r8g.4xlarge** (16vCPU/128GB) - deviation: prefer r8g over m8g because each in-flight run holds 100–500KB of working memory + context window cache; at 5K concurrent, RAM is the binding constraint, not vCPU. | 10 | 160 | 1,280 GB | ~$1,800 | 500 runs/pod, headroom for context spikes. |
| SkillExecutor (Go WASM sandbox plane) | m8g.8xlarge (32vCPU/128GB) | 12 | 384 | 1,536 GB | ~$3,460 | Anchored on BlackBox WASM plane at 1M+ daily executions (resume.txt:49-50). Each pod runs ~80 concurrent WASM isolates; CPU-bound, not RAM-bound, so m8g is correct. |
| ConnectorBroker (MCP + OAuth token vault) | m8g.2xlarge | 6 | 48 | 192 GB | ~$430 | Token refresh + OAuth handshakes; I/O bound; KMS-backed secret cache. |
| MemoryService (Postgres-fronting tier + summarizer) | r8g.4xlarge - deviation: memory-heavy because it caches per-user episodic summaries hot. | 6 | 96 | 768 GB | ~$1,080 | Reads dominate; cache hit rate target 80%. |
| RAGService (HNSW + bm25 hybrid query layer) | **i4i.4xlarge** (16vCPU/128GB + NVMe) - deviation: HNSW recall is NVMe-IOPS sensitive when index spills past RAM; m8g doesn't have local NVMe. | 8 | 128 | 1,024 GB | ~$3,100 | Sized for 30K peak QPS; per-tenant namespace fan-out. |
| IngestionPipeline (embedding + chunking workers) | **i4i.2xlarge** - deviation: embedding throughput is bottlenecked on local-disk staging of source docs; NVMe matters. Embedding itself runs on a separate small GPU pool (g6.xlarge × 4). | 6 (+ 4 GPU) | 48 + 16 GPU vCPU | 384 + 128 GB | ~$1,160 + ~$1,200 GPU = **~$2,360** | RAG ingest for 3K corpora at ~100 MB; one-time + incremental updates. |
| ModelGateway (LLM provider fan-out + caching + budget enforcement) | m8g.4xlarge | 10 | 160 | 640 GB | ~$1,430 | 5K rps peak; mostly I/O wait on provider HTTP; ARM is great. Anchored on model-router work at 1B+ tokens/month (resume.txt:55-56). |
| **Compute subtotal** | | | **1,200 vCPU** | **6.1 TB RAM** | **~$15,240/month** | Excludes Postgres, Qdrant, ClickHouse, Kafka, Redis, S3, CDN, NAT, LLM provider spend. |

**Notes on deviations**:
- `AgentRuntime` → `r8g` because RAM/concurrent-run is the tight axis. At 500 runs × ~256 KB working state × 2 for context cache, a 4xlarge m8g would push 70% RAM utilization before considering headroom.
- `RAGService` and `IngestionPipeline` → `i4i` for local NVMe; HNSW index page faults are catastrophic on EBS-only nodes at 30K QPS.
- `SkillExecutor` stays on `m8g` because WASM is CPU-bound; Graviton4 has excellent per-vCPU throughput.

LLM provider spend dominates infra cost: at 20B tokens/month and a blended $1.50/M tokens (mix of cheap + premium routing), **~$30K/month in LLM spend** - 2× the compute spend. At 115B peak, **~$170K/month**. This makes the model-router cache hit rate and prompt-caching strategy load-bearing (anchor: 1B+ tokens/month router experience, resume.txt:55-56).

## 6. Functional and non-functional requirements

### Functional

- **Persona authoring**: editor with prompt, voice settings, model preference, safety filter selection; live preview.
- **Connector management**: install MCP servers from a registry; OAuth handshake for Gmail/Slack/Drive/GitHub/Notion; scoped token vault; per-agent connector allowlist.
- **Skill authoring**: upload Claude-Skill markdown + scripts; lint + dry-run in sandbox; version per-skill.
- **Agent run**: streamed chat, tool-call visualization, mid-run pause/resume, HITL approval gates.
- **Catalog browse**: search (semantic + keyword), filter by category/connectors-needed/rating, preview, fork-with-memory or fork-without-memory.
- **Fork**: deep-copy persona+skills+connectors-manifest; optional memory carryover (user choice + GDPR-clean).
- **Memory inspect/export**: user can see their per-agent memory, edit/delete entries, export as JSON (GDPR Article 20).
- **Author analytics + payout**: per-agent runs, tokens, revenue, churn.
- **Trust & safety**: kill switch per agent, moderation queue for catalog submissions.

### Non-functional

- **Latency**: p50 first-token **1.5s**, p99 first-token **4s**, p99 full-run **30s** for an 8-hop graph. *(Assumption: aligned with Custom-GPT-class expectations; not directly anchored on a resume number.)*
- **Availability**: **99.9%** monthly (43.8 min/month error budget) for orchestrator + gateway; **99.5%** for catalog (degraded read-only mode acceptable).
- **Durability**: **99.999999999%** (11 nines) for memory + skill artifacts (S3 + cross-region replication).
- **RTO**: **30 min** for orchestrator failover (multi-AZ); **2h** for full-region failover.
- **RPO**: **5 min** for memory + checkpoints (Postgres WAL ship + S3 PITR).
- **Compliance**: GDPR (data export, right-to-delete, EU region option) within 6 months; **SOC-2 Type II within 12 months**, anchored on prior SOC-2 work via WASM sandbox isolation (resume.txt:49-50).
- **Multi-tenant isolation**: row-level security in Postgres, per-tenant vector namespace, per-run WASM isolate; reusing patterns from multi-tenant K8s + VNet isolation at Microsoft (resume.txt:87-89).
- **Observability**: every run is traceable end-to-end via OTel; deterministic replay supported on a sampled basis. Anchored on 50M spans/day mesh and 60% MTTR reduction (resume.txt:58-59).
- **Cost guardrails**: per-user soft cap (free 50K tokens/day, pro 500K/day), platform-wide hard cap to avoid runaway LLM spend, automatic fallback to cheap-model on cap breach.
