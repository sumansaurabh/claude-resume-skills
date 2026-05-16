# 08 - Tradeoffs and Alternatives

## Tier-by-tier Alternatives Considered

### Execution state

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **PG append-only event log + checkpoints (chosen)** | Strong durability, transactional, easy to reason about, replay-friendly | Operationally heavier than KV; needs partitioning at scale | Picked: replay was a top-3 requirement |
| Temporal / Cadence | Mature durable workflow engine; well-known semantics | Another runtime to operate; opinionated about how the graph is expressed; integration with LangGraph is bolt-on | Considered as the substrate; we ended up *implementing the LangGraph CheckpointStore* on top of PG to keep one event log shape |
| Kafka log + materialized view | Naturally append-only, fast | Harder for replay-by-key, harder for arbitrary range scans, ops cost of Kafka for relatively low write volume here | Rejected: write volume doesn't justify it |
| etcd / Consul | Strong consistency for small state | Wrong tool - too small for arbitrary payload, ops cost | Rejected |

### Short-term

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **Redis primary + PG write-through (chosen)** | Hot reads in single-digit ms; survives Redis loss via PG rebuild | Two stores in the loop | Picked: latency budget required cache; we accepted dual-store complexity |
| In-process per-worker | Zero network hop | Loses on worker rebalance; complicates affinity | Rejected: worker churn is too high |
| Postgres only | Simplest | p99 read on hot path likely > 30ms under load | Rejected for hot loop, but used as the durable backbone |
| Memcached | Faster than Redis for pure cache | No data structures we needed (lists, hashes, leases) | Rejected |

### Episodic

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **PG append-only events + LLM rollups (chosen)** | Lossless event store + cheap-to-query summary | Rollup pipeline is its own thing | Picked |
| Vector-only "store every turn as embedding" | Simple | Loses fidelity; expensive to embed everything; fuzzy retrieval of facts that should be exact | Rejected - this is *the* failure mode of naive memory designs |
| Graph DB | Good for relationships | Operational complexity; ROI unclear at this scale | Rejected for v1; revisit when "show me the chain of decisions across 5 sessions" becomes a top use case |

### Long-term

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **PG JSONB + schema registry (chosen)** | Typed, audited, queryable, gateable | Requires registry discipline | Picked: registry is the safety belt |
| Free-form K/V (Redis or DynamoDB) | Zero ceremony | No schema → easy poisoning | Rejected |
| Vector DB as long-term | Trendy | Wrong primitive for "what is the user's preferred indent" | Rejected |
| Per-user JSON file in blob | Cheap | Hard to query, no ACID | Rejected |

### Vector

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **Qdrant HNSW + bm25 + cross-encoder (chosen)** | Mature, supports filters and per-collection isolation, hybrid + rerank improved retrieval quality dramatically | Cross-encoder needs GPUs | Picked |
| pgvector | One less store | Index quality and concurrency story behind dedicated vector DB at our scale | Considered for low-volume tenants; rejected as default |
| Weaviate / Milvus | Solid alternatives | Operational comfort with Qdrant + tighter feature fit (named vectors, scalar filters) | Considered, didn't switch |
| Naive cosine over PG | Trivial | Doesn't scale | Rejected |

## Cross-Cutting Tradeoffs

### Determinism vs LLM realism

We chose to make the **system** deterministic (event log, manifests, content
hashes), not the **model** (we don't pin temperature or model versions
universally). This means replay can show "same context, different output -
that's the model" cleanly. Pinning the model would lock product velocity.

### Five tiers vs one

A single store would be operationally simpler. We rejected it because:

- The tiers have **incompatible latency budgets** (5 ms STM vs 250 ms
  vector).
- The tiers have **different durability needs** (Redis ephemeral vs PG WAL).
- The tiers have **different write semantics** (append-only events vs
  schema-typed K/V).

Pretending these are one thing pushes complexity out of the storage layer
into agent code, where it hurts more.

### Memory Manager as a service vs a library

A library is faster to build. We picked a service because tenant isolation,
audit, and replay all benefit from a single chokepoint. The cost is one
extra hop (~1 ms on the network) - well below the ReAct step budget.

### Schema registry vs free-form long-term

The registry feels heavy. It is heavy. It is also the single biggest reason
the platform did not get an "agent wrote nonsense to my account" incident
in the first six months.

### Sync vs async vector indexing

Async, every time. Vector is derived data. Blocking the ReAct loop on
embedding pipelines is a recipe for tail-latency disasters. The cost is
"a brand-new fact is not retrievable for ~30 s," which is acceptable
because the same fact is in episodic + long-term immediately.

### Per-tenant Qdrant collections vs single collection with filters

Filters are cheaper to operate but a soft boundary. We chose collections
because:

- ANN with filters degrades unpredictably when filter selectivity is low.
- Tenant deletion = drop collection (one op). Filters require scan + delete.
- Hard storage boundary closes a class of cross-tenant bugs.

The cost is collection overhead per tenant; we collapse low-volume tenants
into "shared-low-volume" collections with filter-based scope, accepting the
tradeoff for the long tail.

## What We'd Revisit

- **Tiered embedding models.** Right now one model embeds everything. A
  smaller cheap model for high-volume episodic events and a larger one for
  long-term + RAG would cut ~40% embedding spend.
- **CRDT-style episodic for collaborative agents.** Multi-agent runs that
  share a session need a stronger model than "PG append-only with
  server-assigned `seq`." We hand-rolled it; a CRDT would be cleaner.
- **Native checkpoint compression.** Step payloads have heavy duplication
  (system prompt, tool schemas). A delta-encoded layer over the event log
  would cut ~30% of hot row volume.
- **Federated long-term across tenants in the same enterprise.** Right now
  org-scope is the highest shared scope; some enterprise customers want
  sub-org / project scoping. The schema scope enum needs to be parameterized.

## Anchors

- The whole "five tiers, not one" thesis is the answer to the
  `blackbox-experience.md` #21 question, anchored in
  `resume.txt` BlackBox bullet 3.
- LangGraph integration anchored in `resume.txt` BlackBox bullet 2.
- Vector stack choices anchored in `resume.txt` technologies line.
- 60% MTTR reduction (drives the determinism choice) - `resume.txt`
  BlackBox bullet 5, `blackbox-experience.md` #20.
