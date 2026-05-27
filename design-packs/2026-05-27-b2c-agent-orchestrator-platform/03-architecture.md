# 03 - Architecture: B2C AI Agent Orchestrator + Catalog

## 1. Top-level Mermaid Diagram

```mermaid
graph TB
  subgraph Edge["Edge Layer"]
    CDN[CloudFront CDN]
    GW[Gateway<br/>Envoy + AuthN/Z + rate limit]
  end

  subgraph Control["Control Plane"]
    ORCH[OrchestratorAPI<br/>run lifecycle]
    CAT[CatalogAPI<br/>publish/browse/fork]
    AUTH[AuthService<br/>OAuth + sessions]
  end

  subgraph Runtime["Agent Runtime Plane"]
    RT[AgentRuntime<br/>LangGraph durable]
    SKILL[SkillExecutor<br/>WASM sandbox]
    CONN[ConnectorBroker<br/>sole egress]
  end

  subgraph Intelligence["Intelligence Plane"]
    MEM[MemoryService<br/>facade: 4 stores]
    RAG[RAGService<br/>vector + BM25 + rerank]
    ING[IngestionPipeline<br/>chunk/embed/dedup]
    MG[ModelGateway<br/>router + cache]
    GUARD[GuardrailService<br/>5 boundaries]
  end

  subgraph Stores["Data Plane"]
    PG[(Postgres<br/>metadata + checkpoints)]
    REDIS[(Redis<br/>WorkingMemory + queues)]
    PGV[(Pgvector<br/>SemanticMemory + RAG)]
    S3[(S3<br/>corpora + Episodic cold)]
    CH[(Clickhouse<br/>TelemetryMesh)]
    KAFKA[(Kafka<br/>events + ingest)]
  end

  subgraph Models["External Models"]
    CLAUDE[Claude]
    GPT[GPT-4o]
    GEM[Gemini]
  end

  subgraph Third["Third-Party"]
    GMAIL[Gmail / Slack / MCP servers]
  end

  User((User)) --> CDN --> GW
  GW --> AUTH
  GW --> ORCH
  GW --> CAT

  ORCH --> RT
  CAT --> PG

  RT --> SKILL
  RT --> CONN
  RT --> MEM
  RT --> RAG
  RT --> MG
  RT --> GUARD

  ING --> RAG
  ING --> S3

  MEM --> PG
  MEM --> REDIS
  MEM --> PGV
  MEM --> S3

  RAG --> PGV

  CONN --> GMAIL
  MG --> CLAUDE
  MG --> GPT
  MG --> GEM

  RT --> CH
  GUARD --> CH
  CONN --> CH

  RT --> KAFKA
  ING --> KAFKA
  AUTH --> PG

  classDef edge fill:#e3f2fd,stroke:#1976d2
  classDef ctrl fill:#f3e5f5,stroke:#7b1fa2
  classDef rt fill:#fff3e0,stroke:#f57c00
  classDef intel fill:#e8f5e9,stroke:#388e3c
  classDef store fill:#fce4ec,stroke:#c2185b
  classDef ext fill:#eceff1,stroke:#455a64

  class CDN,GW edge
  class ORCH,CAT,AUTH ctrl
  class RT,SKILL,CONN rt
  class MEM,RAG,ING,MG,GUARD intel
  class PG,REDIS,PGV,S3,CH,KAFKA store
  class CLAUDE,GPT,GEM,GMAIL ext
```

---

## 3. Control Plane vs Data Plane


| Component | Plane | Why it lives there | Scale concern |
|---|---|---|---|
| `Gateway` | Edge | TLS termination, WAF, rate limit, auth cookie → JWT exchange. Single ingress for both planes. | Connection storms during catalog launches; needs HPA on conn-count. |
| `OrchestratorAPI` | Control | Agent CRUD, persona edits, connector OAuth callbacks, skill upload, corpus registration. Low QPS, transactional. | Burst on signup; bounded by Postgres write IOPS. |
| `CatalogAPI` | Control | Browse, search, fork, install. Read-heavy; cache aggressively in Redis. | Hot agents (viral fork) - needs per-agent Redis caching with stampede protection. |
| `AgentRuntime` | Data | Executes the LangGraph DAG per run. Pulls from `RunQueue`, runs Planner → ... → Aggregator. | 10K+ runs/day target initially; horizontal scale via pod count, durable checkpoints in Postgres. |
| `SkillExecutor` | Data | Sandbox for user skill scripts. SOC-2-isolatable execution surface. | 1M+ executions/day envelope from sandbox plane (resume.txt:49, blackbox-experience.md points 3-5). |
| `ConnectorBroker` | Data | Proxies MCP and OAuth calls so tokens never enter `AgentRuntime` process. | Per-tenant token decryption hot path; needs token cache with KMS-bounded TTL. |
| `MemoryService` | Data | Read/write working, episodic, semantic, procedural memory. Critical-path latency. | Read p99 must stay < 80ms; `WorkingMemory` Redis hot key risk per session. |
| `RAGService` | Data | kNN retrieval against `Qdrant`. | HNSW index pressure on writes; resume mentions HNSW + bm25 hybrid (resume.txt:60-61). |
| `IngestionPipeline` | Data (async) | Chunk → embed → index user-uploaded docs. Decoupled from query path. | Embedding throughput; `EmbedderTextV3` batch size + provider rate limits. |
| `ModelGateway` | Data | Multi-provider LLM gateway, capability-aware routing - direct port of the BlackBox model router across Claude/GPT/Grok (resume.txt:55-56, blackbox-experience.md points 16-19). | 1B+ tokens/month envelope; provider rate-limit shaping. |
| `GuardrailService` | Data | Input/output/tool-call policy enforcement. | In-line latency budget; needs sub-30ms p99 for shadow checks. |
| `TelemetryMesh` | Data (out-of-band) | OTel collector + span buffering before Clickhouse. | - |

---

## 4. End-to-end Request Flows

### Flow A - User creates an agent

1. User opens `/builder` in browser → `Gateway` → `OrchestratorAPI POST /agents`.
2. `OrchestratorAPI` writes a row in `Postgres.agents` with `tenant_id = user_id`, persona JSON, default model id.
3. User adds Gmail connector → `OrchestratorAPI` returns OAuth URL → user consents → callback hits `OrchestratorAPI` → encrypted token stored in `ConnectorBroker` vault keyed by `(tenant_id, agent_id, connector_id)`.
4. User uploads a PDF as RAG corpus → `OrchestratorAPI` writes raw to `S3`, enqueues an `IngestionPipeline` job → pipeline chunks, calls `EmbedderTextV3`, writes vectors into `Qdrant` partition `tenant_<id>`.
5. User uploads a skill script (Claude-skills-syntax `script.ts`) → `OrchestratorAPI` validates schema, writes script blob to `S3`, registers it in `Postgres.skills`.
6. User clicks "save" → `OrchestratorAPI` returns the full agent manifest (versioned).

```mermaid
sequenceDiagram
    autonumber
    participant U as User Browser
    participant GW as Gateway
    participant O as OrchestratorAPI
    participant CB as ConnectorBroker
    participant IP as IngestionPipeline
    participant E as EmbedderTextV3
    participant PG as Postgres
    participant S3 as S3
    participant PV as Pgvector

    U->>GW: POST /agents (persona)
    GW->>O: forward
    O->>PG: INSERT agents (tenant_id, persona)
    O-->>U: agent_id

    U->>GW: connect Gmail (OAuth start)
    GW->>O: oauth-start
    O-->>U: provider URL
    U->>O: oauth-callback(code)
    O->>CB: store encrypted token
    CB->>PG: token row

    U->>GW: upload corpus.pdf
    GW->>O: signed S3 URL
    U->>S3: PUT corpus.pdf
    O->>IP: enqueue ingest(tenant, agent)
    IP->>S3: GET corpus.pdf
    IP->>E: embed(chunks)
    E-->>IP: vectors
    IP->>PV: UPSERT vectors (tenant partition)

    U->>GW: upload skill.ts
    GW->>O: forward
    O->>S3: PUT skill.ts
    O->>PG: INSERT skills
    O-->>U: saved
```

### Flow B - User runs the agent

1. User clicks "run" in the builder → `Gateway POST /runs` with `agent_id` + user prompt.
2. `Gateway` enqueues a run envelope into the `Run Queue` (SQS | Kafka ).
3. An `AgentRuntime` worker pod picks up the run, materializes the DAG from the agent manifest, persists `run_id` checkpoint row in `Postgres`.
4. `AgentRuntime` enters the Planner node → asks `ModelGateway` for a plan → `ModelGateway` routes to Claude (capability-aware) and returns the plan.
5. `Planner` output passes through `GuardrailService` (output check) before being committed to `WorkingMemory`.
6. `Router` decides: tool call vs RAG retrieve vs respond.
7. If RAG: `RAGService` runs HNSW + bm25 hybrid over the tenant's `Qdrant` partition (resume.txt:60-61), returns top-k chunks.
8. If tool: `ToolCaller` invokes either `ConnectorBroker` (Gmail/Slack/MCP) or `SkillExecutor` (Sandbox) with idempotency key. `ConnectorBroker` injects the token; `SkillExecutor` runs the script in the sandbox.
9. Tool result → `Critic` node validates → `Aggregator` merges parallel branch results → write turn to `EpisodicMemory` (Postgres) and important facts to `SemanticMemory` (Qdrant`).
10. If policy requires human approval → `HITL` node pauses run; checkpoint in `Postgres`; surfaces approval UI via websocket; user resumes → durable-execution restart of the DAG.
11. Final response → `GuardrailService` (output check) → streamed to user via SSE through `Gateway`.
12. Every node emits OTel spans to `TelemetryMesh` → `Clickhouse`.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant GW as Gateway
    participant Q as RunQueue
    participant AR as AgentRuntime
    participant GR as GuardrailService
    participant MG as ModelGateway
    participant MS as MemoryService
    participant RS as RAGService
    participant CB as ConnectorBroker
    participant SE as SkillExecutor
    participant TM as TelemetryMesh

    U->>GW: POST /runs (agent_id, prompt)
    GW->>Q: enqueue run
    Q->>AR: dispatch
    AR->>MS: read WorkingMemory + ProceduralMemory
    AR->>GR: input check (prompt)
    GR-->>AR: allow

    AR->>MG: plan(prompt + context)
    MG-->>AR: plan
    AR->>GR: output check (plan)
    GR-->>AR: allow

    par tool branch
        AR->>CB: invoke Gmail.list_messages
        CB-->>AR: messages
    and rag branch
        AR->>RS: retrieve(query)
        RS-->>AR: chunks
    and skill branch
        AR->>SE: exec(skill.ts, args)
        SE-->>AR: result
    end

    AR->>MG: synthesize(final answer)
    MG-->>AR: answer
    AR->>GR: output check (answer)
    GR-->>AR: allow

    AR->>MS: write EpisodicMemory + SemanticMemory
    AR-->>GW: SSE stream answer
    GW-->>U: stream

    AR-->>TM: spans (planner, router, tool, critic, agg)
```

### Flow C - Catalog browse and fork

1. Consumer hits `/catalog` → `Gateway` → `CatalogAPI` → Redis cache hit on hot agent list.
2. Consumer clicks "Fork agent X" → `CatalogAPI POST /agents/{id}/fork` with consumer's auth.
3. `CatalogAPI` reads source agent manifest from `Postgres`, **deep-copies persona, skill references, RAG corpus schema, and connector schema** under the consumer's `tenant_id`. Skill script blobs in `S3` are referenced by content-hash, not copied.
4. **Credentials are not copied.** Consumer must reconnect their own Gmail / Slack OAuth via `OrchestratorAPI` before the forked agent can be run.
5. **RAG corpus content is not auto-copied.** Consumer can opt to clone the original corpus chunks (if author marked corpus as "shareable") via `IngestionPipeline` re-write into consumer's `Qdrant` partition.
6. Forked agent appears under the consumer's account, runnable via Flow B.

```mermaid
sequenceDiagram
    autonumber
    participant U as Consumer
    participant GW as Gateway
    participant C as CatalogAPI
    participant O as OrchestratorAPI
    participant PG as Postgres
    participant S3 as S3
    participant IP as IngestionPipeline
    participant PV as Qdrant

    U->>GW: GET /catalog
    GW->>C: list popular
    C-->>U: page (cache hit)

    U->>GW: POST /agents/{id}/fork
    GW->>C: forward
    C->>PG: SELECT source agent manifest
    C->>PG: INSERT forked agent (tenant=consumer)
    C->>S3: skill blob ref (no copy, content-hash)
    C-->>U: forked agent_id

    U->>GW: connect own Gmail
    GW->>O: oauth-start
    O-->>U: provider URL

    opt corpus is shareable
        U->>GW: clone corpus
        GW->>IP: re-ingest into consumer tenant
        IP->>PV: UPSERT vectors
    end
```

---

## 5. Component Responsibilities

| Component | One-line job | Scale concern | Failure mode |
|---|---|---|---|
| `Gateway` | TLS, auth, rate limit, route to control vs data plane | Connection fan-in during launches | Fail closed; circuit-break upstream |
| `OrchestratorAPI` | Authoring CRUD + OAuth callbacks + skill upload | Postgres write IOPS | 5xx returns; client retries idempotent PUT |
| `CatalogAPI` | Browse / fork / install | Redis cache stampede on viral agent | Stale-while-revalidate fallback |
| `AgentRuntime` | Run the LangGraph DAG with checkpoint + retry semantics (resume.txt:51-54) | Per-pod active runs ~ 50 | Checkpoint in `Postgres`; another pod resumes |
| `Planner` | Decompose prompt into steps | Token cost per plan | Falls back to single-step |
| `Router` | Decide tool vs RAG vs respond | Tight latency budget | Default to "respond" with apology |
| `ToolCaller` | Invoke connectors / skills with idempotency key | Side-effect safety (blackbox-experience.md point 17) | Idempotency-key dedupe in Redis |
| `Critic` | Validate node outputs against schema + policy | Adds latency to every hop | Bypass on critical path with degraded mode flag |
| `Aggregator` | Join parallel branch results | Memory footprint of joined state | Spill to S3 if > 1MB |
| `HITL` | Pause + resume with human approval | Pause-state count in Postgres | TTL of 72h then auto-cancel |
| `SkillExecutor` | Run andboxed user scripts. Note: `SkillExecutor` is the sandbox **service**; `SkillRunner` is the graph **node** that invokes it. | 1M+ executions/day envelope | Sandbox crash → return structured error, no leak |
| `ConnectorBroker` | OAuth + MCP proxy, token vault | Token decryption hot path | Token expiry → refresh + retry |
| `MemoryService` | Facade over 4 memory types | Read p99 < 80ms | Degrade to working memory only |
| `RAGService` | Hybrid retrieval (HNSW + bm25) (resume.txt:60-61) | Index pressure during ingest | Fallback to bm25-only |
| `IngestionPipeline` | Chunk + embed + index | Embedding provider rate limit | Backpressure to job queue |
| `ModelGateway` | Multi-provider routing (resume.txt:55-56) | 1B+ tokens/month budget | Provider failover with capability match |
| `GuardrailService` | Policy enforcement in-line | Sub-30ms p99 | Fail-closed for tool-call checks, fail-open for shadow checks |
| `TelemetryMesh` | OTel collector → Clickhouse (resume.txt:58-59) | 50M spans/day | Local disk buffer, then drop with stat counter |

---


## 6. Multi-region Considerations

| Item | Launch decision | Future state |
|---|---|---|
| Primary region | `us-east-1` (EKS, Postgres primary, Qdrant primary, Redis primary, Clickhouse) | - |
| EU read replica | `eu-west-1` Postgres read replica for GDPR data-locality preview | Promote to active-active once write paths are conflict-free |
| Memory replication | `MemoryService` Postgres → DMS async replication to eu-west-1; Redis is not replicated (working memory is ephemeral per run) | Active-active needs CRDT or single-writer routing |
| RAG corpus locality | Corpus is **pinned to the user's home region** at corpus-create time; queries route to home region | Cross-region replicate explicitly only if user enables |
| `S3` artifacts | Single bucket with Cross-Region Replication for skill scripts; user uploads stay in home region | - |
| `Clickhouse` | Single region at launch; per-region cluster + ClickHouse Keeper later | - |
| Catalog | Replicated read-only via Postgres logical replication to all read regions | - |

---

## 7. Tenant Isolation Model (Consumer Scale)

| Boundary | Mechanism |
|---|---|
| `Postgres` | `tenant_id` column on every row, row-level security policy `USING (tenant_id = current_setting('app.tenant_id'))` |
| `Qdrant` | Per-tenant partition: `documents_tenant_<id>` table inheriting from `documents`; HNSW index per partition |
| `Redis` | Key prefix `t:<tenant_id>:` on every key; Redis ACL user-per-shard with prefix scope |
| `S3` | Object prefix `tenant=<id>/`; bucket policy + KMS key per high-value tenant |
| `ConnectorBroker` token vault | Token encrypted with envelope encryption; DEK per `(tenant_id, agent_id)`; KMS-CMK per region |
| `SkillExecutor` | One Sandbox instance per execution; no shared memory; resource limits per `tenant_id` quota |
| `AgentRuntime` | Pod-shared but run-scoped context object; tenant_id flows through every node as part of the run envelope; OTel baggage carries `tenant.id` for end-to-end tracing |
| `RAGService` | Query rewritten with `WHERE tenant_id = ?` before vector kNN; deny if tenant_id missing |
| `ModelGateway` | Per-tenant token bucket for provider quota; per-tenant prompt-hash cache to avoid cross-tenant cache pollution |
