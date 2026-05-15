# 05 — Scaling and Capacity

## Anchored Volume Model

Resume facts that bound the design:

- **10K+ agent runs/day** (`resume.txt`, `blackbox-experience.md` #11)
- **1B+ tokens/month** through the model orchestration layer (`resume.txt`,
  `blackbox-experience.md` #19)
- **50M spans/day** OTel ingest, **2.5TB+/month** trace data
  (`blackbox-experience.md` #20)

We design for headroom of ~10× on top.

## Per-Tier Throughput Estimates

Assume:

- 10K runs/day → average ~12 runs/min, peak 5–10× → up to ~1500 runs/min.
- Average run = 8 ReAct steps. So ~80K steps/day, peak ~12K/min.
- Each step generates: 1 `pre_step`, 1 `post_step`, 0–2 tool/model events ⇒
  ~3 exec_event rows/step ⇒ ~240K rows/day, peak ~36K/min ≈ **600 RPS**.
- Average context build: 1 STM read, 1 episodic summary read, 2–5 LTM key
  reads, 1 vector query → ~40K context builds/day, peak ~6K/min ≈ **100 RPS**.

| Surface | Steady RPS | Peak RPS | Sized for |
| --- | --- | --- | --- |
| `exec_event` writes | ~10 | ~600 | 6,000 |
| Short-term Redis ops | ~50 | ~2,000 | 20,000 |
| Episodic events | ~20 | ~600 | 6,000 |
| Long-term reads | ~30 | ~500 | 5,000 |
| Long-term writes | ~1 | ~30 | 300 |
| Vector queries | ~5 | ~100 | 1,000 |
| Vector upserts (async batched) | ~10 | ~200 | 2,000 |
| OTel spans (memory ops only) | ~100 | ~3,000 | 30,000 |

## Storage Sizing

| Store | Per item | Daily volume | Monthly |
| --- | --- | --- | --- |
| `exec_event` | ~2 KB hot row + payload blob avg 8 KB | 240K rows × 10 KB ≈ **2.4 GB/day** | ~70 GB/month |
| Short-term (Redis) | per active run; ~64 KB | 1K concurrent active × 64 KB ≈ **64 MB live** | snapshot to PG ≤ 1 GB/day |
| Episodic events | ~3 KB JSONB row | ~250K events/day → **~0.75 GB/day** | ~22 GB/month |
| Episodic summaries | ~4 KB row + 1 KB embedding | ~10K rollups/day → **~50 MB/day** | ~1.5 GB/month |
| Long-term | ~1 KB row | ~10K writes/day → **~10 MB/day** | ~0.3 GB/month |
| Vector | ~1 KB metadata + 1.5 KB vector (1024-dim fp16) | ~10K new vecs/day → **~25 MB/day** + index overhead | ~0.75 GB/month + ~25% HNSW |
| Trace data (Clickhouse, all platform) | per-span ~512 B compressed | 50M/day | **~2.5 TB/month** (matches resume) |

`exec_event` is the largest hot store. Hot-row payloads are bounded at 32 KB;
above that, the payload is offloaded to blob storage and only a URI plus hash
is kept in PG. This is what keeps Postgres footprint flat.

## How Each Store Scales

### Execution state — Postgres + blob

- Partition `exec_event` by `tenant_id` hash + `produced_at` month.
- Hot tier kept ~30 days online; older partitions detached and archived to
  blob in a Parquet rollup (preserves replay for the retention window).
- Synchronous replication to a standby for durability; reads served from the
  primary because the SLO needs strong consistency.
- Connection pooling via PgBouncer; per-tenant connection limits prevent a
  noisy tenant from starving others.

### Short-term — Redis

- Sharded Redis cluster keyed by `tenant_id|run_id`.
- Eviction: `volatile-lru` with TTL set per run; eviction is acceptable
  because Postgres is the source of truth at every checkpoint.
- Lease pattern: a worker holds a lease key for the run; lease loss triggers
  rehydrate-from-PG on reassignment.

### Episodic — Postgres + S3 + rollup workers

- Same partitioning strategy as `exec_event`.
- Rollup workers run on a separate pool, throttled per tenant. A rollup is
  allowed to lag (it's not on the hot path); SLO is "rollup within 5 min of
  N events or T idle."

### Long-term — Postgres only

- Tiny by volume; the constraint is **schema correctness**, not throughput.
- A read replica in each region for low-latency reads.
- Per-key version + audit row on every change.

### Vector — Qdrant

- Per-tenant collections; HNSW with `m=16`, `ef_construct=128`,
  `ef_search=64–128` tunable per query.
- Cold tenants (>30d idle) are unloaded; warm-up on first query (~1–2 s
  one-time cost — accepted because cold tenants don't have latency-sensitive
  agents).
- bm25 sidecar (Tantivy/OpenSearch index of the same payload text) for
  hybrid retrieval.
- Cross-encoder rerank served on a small autoscaled GPU pool; batched per
  request (top-100 → top-5). Rerank is the *only* GPU-bound dep in the
  memory plane.

### Telemetry (referenced, not designed here)

- OTel collector → Kafka → Clickhouse, sampling-aware. This is the same mesh
  the resume describes for **50M spans/day**; memory ops are a fraction of
  that volume.

## Bottlenecks And Mitigations

| Bottleneck | Symptom | Mitigation |
| --- | --- | --- |
| `exec_event` insert hotspots | tail-latency spikes on a popular tenant | hash-partition by tenant + `produced_at`; per-tenant write quotas |
| Cross-encoder rerank latency | p99 > 200ms for context build | batched inference + adaptive top_n; tier-skip rerank when budget < 4K tokens |
| Vector ANN latency on huge tenants | p95 > 100ms | per-tenant collection sharding; ef_search tuning |
| Postgres replica lag during heavy episodic rollups | stale reads of `exec_event` | route step-write reads to primary; rollup uses a logical replica |
| Redis hot run | a long agent holds a single key | scratch namespacing; periodic compact-to-PG and reload |
| Embedding pipeline backlog | episodic rollups outrun embed workers | backlog visible in metric; horizontal scale by partition; backlog is acceptable because vector is derived |
| Schema-registry change blast radius | breaking long-term key changes | only additive changes; deprecations have a 90-day window |

## Backpressure Strategy

The Memory Manager **never silently drops writes**. The signals:

1. Redis full or hot → `STORE_DEGRADED` 503 → workflow engine pauses the step
   at its current checkpoint.
2. PG quota → 429 with `Retry-After`.
3. Vector upsert backlog → upserts are async; the workflow engine doesn't
   wait. If backlog grows past threshold, episodic rollups are throttled to
   protect retrieval latency.
4. Cross-encoder pool saturated → degrade to "no rerank, return ANN ∪ bm25
   top-K with a flag in the manifest." Replay can see the degraded path.

## Cost Model Sketch

Rough monthly numbers (for "the platform handles 10K+ runs/day" envelope):

| Component | Monthly cost driver |
| --- | --- |
| Postgres (HA + replica + backups) | ~150 GB hot, IOPS-driven, ~$1–2k/mo |
| S3 / Blob | ~0.1 TB hot + cold trickle, ~$50/mo |
| Redis | ~64 MB working set + headroom, ~$200/mo |
| Qdrant | ~50 GB indices, modest CPU, ~$500/mo |
| Cross-encoder GPU pool | bursty, autoscaled; ~$1–2k/mo |
| Clickhouse trace store | 2.5 TB/mo compressed, multi-replica, ~$3–5k/mo |
| Embedding API spend | ~10K rollups/day × small text, ~$200–500/mo |

The cost punchline at interview: **memory is cheap; the cross-encoder and
the trace store dominate, and both pay for themselves via the 60% MTTR
reduction**.

## Anchors

- 10K+ runs/day, 1B+ tokens/month — `resume.txt`, `blackbox-experience.md`
  #11, #19.
- 50M spans/day, 2.5TB+/month trace — `resume.txt`,
  `blackbox-experience.md` #20.
- Vector + HNSW + bm25 + cross-encoder — `resume.txt` technologies line.
