# Cheat Sheet — Live Interview Reference

One-page whiteboard reference. Read this on the way into the room. If the interview shifts to a different system, the structure of this sheet still works as a template.

---

## 30-Second Pitch

"A B2C platform where any user can author an AI agent — persona, MCP and OAuth connectors, RAG corpora, Claude-skills-syntax scripts, four-tier memory — and publish it to a public catalog where other users fork and run it. Underneath, it's a LangGraph durable runtime with WASM-sandboxed skills, a ConnectorBroker that is the only egress path, a MemoryService facade over Redis/Postgres/Pgvector/S3, and GuardrailService at every input/output boundary. This is the B2C extension of the LangGraph runtime, WASM sandbox, model router, and telemetry mesh I built at BlackBox."

---

## Top-Level Boxes

**Edge Plane**
- **CDN** — CloudFront for static + cached catalog pages.
- **Gateway** — Envoy; AuthN/Z, rate limit, WebSocket upgrade, JWT verify.

**Control Plane**
- **OrchestratorAPI** — REST + WebSocket for run lifecycle (create/stream/cancel).
- **CatalogAPI** — Publish, browse, search, fork, rate agents.
- **AuthService** — OAuth (Google/GitHub/Apple), session, refresh tokens.

**Runtime Plane**
- **AgentRuntime** — LangGraph durable executor; Planner → Router → ToolCaller → Critic loop with checkpoints in Postgres.
- **SkillExecutor** — Wasmtime sandbox; runs user scripts under capability tokens, 30s wall clock, no network.
- **ConnectorBroker** — Sole egress to Gmail/Slack/MCP/any third-party; holds OAuth tokens in Vault.

**Intelligence Plane**
- **MemoryService** — Facade over WorkingMemory (Redis), EpisodicMemory (Postgres+S3), SemanticMemory (Pgvector+BM25), ProceduralMemory (Postgres).
- **RAGService** — Hybrid vector + BM25 retrieval with cross-encoder rerank.
- **IngestionPipeline** — Parse → chunk → dedup → embed via EmbedderTextV3 (1024-dim) → dual-write Pgvector + BM25.
- **ModelGateway** — Capability-aware router across Claude / GPT-4o / Gemini; prompt cache; retry; fallback.
- **GuardrailService** — Prompt injection, PII, output classifier, manifest signing, scope validation.
- **TelemetryMesh** — OpenTelemetry → Kafka → Clickhouse; 50M spans/day; deterministic replay.

**Data Plane**
- **Postgres** — Metadata, AgentCheckpoint, EpisodicMemory hot.
- **Redis** — WorkingMemory, rate-limit counters, queues.
- **Pgvector** — SemanticMemory + RAG corpora; HNSW index.
- **S3** — Raw corpora, Episodic cold tier, run artifacts.
- **Clickhouse** — Telemetry, billing spans, replay store.
- **Kafka** — Event backbone (run events, ingest jobs, audit).

---

## Hot Numbers

| Metric | Target | Notes |
|---|---|---|
| Registered users | 1M | Plan target |
| WAU | 100K | 10% of registered |
| Agents created | 10K | ~1% author rate |
| Runs / day | 500K | 100K WAU × 5 runs/day |
| Concurrent runs peak | 5K | Drives runtime fleet sizing |
| Runtime pods | ~250 | 20 concurrent runs / pod, 2x headroom |
| Sandbox pods | ~100 | Wasmtime, ~50 concurrent skills / pod |
| Tokens / day | 750M | Drives ModelGateway QPS |
| Telemetry spans / day | 50M | Matches BlackBox figure |
| Vector index size | ~2 TB | 10K agents × 200 MB |
| Memory per user | ~50 MB | Working+Episodic+Semantic+Procedural |
| Cost / run (p50) | $0.05 | $0.03 model + $0.01 infra + $0.01 storage |
| TTFT (p50) | 1.8s | Gateway 50ms + Planner 600ms + Model 1.1s |
| Full run latency (p95) | 12s | With 1 RAG + 2 connector hops |
| Gateway QPS | ~2K | 500K runs/day × ~3.5 requests/run / 86400 × 3x peak |
| Pgvector recall@10 | ≥ 0.92 | HNSW M=32, efSearch=128 |
| RAG retrieval p95 | < 400ms | Hybrid + rerank top-50→top-5 |
| Sandbox cold start | < 200ms | Wasmtime pre-warmed pool |
| Checkpoint write p95 | < 50ms | Postgres + WAL |

---

## Hot Tradeoffs

1. **LangGraph durable runtime over hand-rolled state machine.** Get checkpoint, replay, HITL pause/resume for free. Cost: framework lock-in. Acceptable because we already operate it at 10K runs/day at BlackBox (`resume.txt:51-52`).

2. **Pgvector over a dedicated vector DB (Pinecone / Weaviate).** One fewer system to operate, transactional consistency with metadata, $0 SaaS fee. Cost: HNSW build is single-node and slower at extreme scale. Acceptable up to ~10M vectors / shard; we shard by agent_id beyond that.

3. **WASM sandbox over container-per-script or V8 isolate.** Wasmtime gives us 200ms cold start vs 2s for containers, capability-based syscalls, deterministic resource limits. Cost: limits the language surface (Python via Pyodide, JS, Rust). Acceptable because Claude skills are mostly Python/JS.

4. **Single ConnectorBroker over per-agent direct egress.** Centralizes secret storage, audit, rate limit, scope enforcement. Cost: SPOF if it falls over (mitigated by stateless horizontal scale + Vault HA). Acceptable because per-agent egress would mean 1M users × N tokens with no central enforcement — a security disaster.

5. **GuardrailService at 5 boundaries over a single output filter.** Defense in depth; injection caught at input, PII caught at retrieval, harmful output caught at egress. Cost: ~150ms added latency total. Acceptable because a single point of guardrail failure on a B2C platform = headline risk.

---

## Risk Hot Spots — Top 5 Things That Break First

1. **ConnectorBroker rate limits with third-party APIs.** Gmail / Slack throttle aggressively. At 5K concurrent runs each touching Gmail, we exhaust shared quotas fast. Mitigation: per-user-per-connector token buckets, exponential backoff, batch-where-possible, surface 429s to the user as "Gmail is rate limited, retry in 60s."

2. **Pgvector index rebuild during ingestion spikes.** A user uploads a 500MB PDF; HNSW rebuild blocks the shard. Mitigation: append-only writes, async index refresh, per-agent shard, sharded write queue.

3. **Skill execution storms.** A skill that loops calling another skill recursively. Mitigation: per-run skill call count cap (50), wall-clock cap (30s), recursive-call detection, circuit-break the user's agent for 5min on detected loop.

4. **Memory write contention during long agent runs.** A 20-turn conversation writes to EpisodicMemory 20 times; concurrent runs of the same agent collide. Mitigation: MemoryService write queue per (user, agent), idempotency keys keyed on (run_id, turn_id).

5. **Catalog hotspot — viral agent.** One agent goes viral; 50K users fork and run it simultaneously. Mitigation: catalog read served entirely from CDN; fork creates a new agent record (no shared write path); per-agent fork-rate-limit; pre-warm RAG cache for trending agents.

---

## Resume Anchors — Say These Out Loud

- "At BlackBox I ran the **LangGraph + LangChain ReAct runtime at 10K+ runs/day** (`resume.txt:51-52`). This design is the B2C extension of that pattern — durable graph, checkpointing, HITL — scaled out and exposed via a catalog."

- "I built the **WASM sandbox plane that isolates 1M+ daily zero-shot code executions** under SOC-2 (`resume.txt:49-50`). That is exactly what SkillExecutor is here. Same Wasmtime substrate, same capability-token syscalls."

- "I shipped the **graph workflow engine with DAG execution, checkpointing, retry semantics, memory persistence** (`resume.txt:53-54`). The AgentRuntime checkpoint contract in this pack is the same shape."

- "I run a **model router across Claude/GPT/Grok at 1B+ tokens/month** (`resume.txt:55-56`). ModelGateway here is the same router with capability-aware routing and prompt caching."

- "I operate the **LLMOps telemetry mesh ingesting 50M spans/day with deterministic replay and 60% MTTR reduction** (`resume.txt:58-59`). TelemetryMesh in this pack is the same OpenTelemetry → Kafka → Clickhouse pipeline."

- "At Microsoft I built **secure multi-tenant ML infra on Kubernetes + Azure with VNet isolation and identity boundaries** (`resume.txt:87-89`). The per-tenant network policies, identity boundaries, and runtime isolation in `07-security-and-isolation.md` come from that work."

Drop two anchors per major claim. Never claim "I built it before" without naming the file and line number.

---

## Likely First Follow-Up Questions — Pre-Canned Answers

1. **"Walk me through what happens when a user clicks Run."**
   → Gateway authn → OrchestratorAPI creates `Run` row + WebSocket → enqueue to AgentRuntime → Planner loads (persona + RecentEpisodic + RelevantSemantic + Procedural) → ModelGateway → tool call → either RAGService / ConnectorBroker / SkillExecutor → MemoryWriter persists → Critic → stream tokens to client. Every step writes a span to TelemetryMesh. Full walk: `05-low-level-design.md`.

2. **"How do you stop a malicious skill from exfiltrating data?"**
   → WASM sandbox has no network, no filesystem. Outbound calls must go through ConnectorBroker which enforces user-scoped OAuth. Memory access requires a capability token issued by AgentRuntime, scoped to (user_id, agent_id, run_id). GuardrailService inspects skill manifest signature before SkillExecutor accepts it. Detail: `07-security-and-isolation.md` + `15-guardrails.md`.

3. **"What's the consistency model for memory?"**
   → WorkingMemory: strong, single-writer per run, Redis transactional. EpisodicMemory: read-your-writes within a run, eventual across runs. SemanticMemory: eventual (async embed). ProceduralMemory: strong, version-controlled in Postgres. The MemoryService facade hides this; agent code sees a single API. Detail: `13-memory-layer-design.md` point 7.

4. **"How do you handle a viral agent — 50K concurrent forks?"**
   → Catalog page is CDN-cached; fork is a metadata copy, not a data copy (corpora are content-addressed). Per-agent fork rate limit. Pgvector reads use the original agent's index (forks share until divergence). AgentRuntime scales horizontally; Postgres checkpoint write is the only shared resource and that's sharded by run_id. Detail: `06-scaling-and-capacity.md`.

5. **"Why LangGraph instead of building it yourself?"**
   → Already battle-tested at 10K runs/day at BlackBox (`resume.txt:51-52`). Building durability, replay, HITL pause/resume from scratch is a 6-month project. Lock-in is real but the abstractions (graph + node + edge + checkpoint) are the right primitives; if we ever need to migrate, the contract surface is small. Detail: `09-tradeoffs-and-alternatives.md`.

Other likely follows: "what breaks first at 10x scale?" (`06`), "how do you cost-optimize the model bill?" (`09`), "what if Pgvector falls over?" (`08`), "show me the API for fork" (`04`), "how do you do per-tenant isolation in a B2C product?" (`07`).

---

## Whiteboard Order (If Asked to Draw)

1. Draw three columns: **User**, **Platform**, **External**.
2. In **Platform**, stack five rows top-to-bottom: Edge, Control, Runtime, Intelligence, Data.
3. Drop the 12 named boxes into their rows.
4. Draw three arrows out of Platform: Models (right), Connectors (right), CDN (left).
5. Annotate the **one critical loop**: AgentRuntime → ModelGateway → ToolCaller → (RAG | Connector | Skill) → MemoryWriter → AgentRuntime.
6. Call out the **three keystones** with a star: ConnectorBroker (only egress), GuardrailService (every boundary), MemoryService (facade over 4 stores).
7. If time remains, draw the planner/router/critic LangGraph as an inset.

Total budget: 8 minutes. If the interviewer keeps interrupting with questions, that's a good sign — keep the diagram half-drawn and answer in place.
