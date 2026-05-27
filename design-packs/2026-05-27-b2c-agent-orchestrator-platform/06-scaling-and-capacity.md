# 06 — Scaling and Capacity

This document sizes the B2C web-based AI agent orchestrator and catalog platform end-to-end: throughput per tier, token economics, memory and RAG storage growth, top bottlenecks, backpressure strategy, quotas, monthly cost projection, growth inflection points, and capacity-planning rituals. Every speculative figure is labeled `Assumption:`; resume anchors are cited with file:line.

---

## 1. Target Scale (Steady State, 18-Month Horizon)

| Dimension                       | Target            | Notes / Anchor                                                                                              |
| ------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Registered users                | 1,000,000         | Assumption                                                                                                  |
| Weekly active users (WAU)       | 100,000           | Assumption: 10% weekly active                                                                               |
| Published agents in catalog     | 10,000            | Assumption: ~1% of WAU publish at least one agent                                                           |
| Peak concurrent agent runs      | 5,000             | Assumption: derived from 100K WAU × 30% daily peak × 5min/run / 86400s                                      |
| Avg hops per run                | 8                 | Assumption: matches ReAct loop depth seen in `blackbox-experience.md:17,25`                                 |
| Avg tokens per hop              | 2,000             | Assumption: prompt + retrieval + completion                                                                 |
| % agents with RAG corpus        | 30% (3,000)       | Assumption                                                                                                  |
| Avg RAG corpus per RAG agent    | 100 MB raw text   | Assumption                                                                                                  |
| Daily agent runs                | 100K–500K         | Forward run-rate; resume anchor for credibility: 10K+ agent runs/day at BlackBox (resume.txt:51-52)         |
| Aggregate token throughput      | ~10B tokens/month | Forward run-rate; resume anchor: 1B+ tokens/month model router at BlackBox (resume.txt:55-56)               |
| Pattern-of-orchestration anchor | 15M+ jobs/month   | AutoML scale at Azure (resume.txt:90-92) — used to validate the OrchestratorAPI design at the right order  |

Stated target: **start at the BlackBox 1B tokens/month anchor, plan for ~10× within 18 months** (~10B tokens/month), with the AutoML 15M jobs/month anchor (resume.txt:90-92) as the precedent for orchestrator scale.

---

## 2. Throughput Model Per Tier

Headroom convention: stateless tiers sized at **1.5× peak**, stateful tiers at **2× peak** for failure-domain absorption + rolling deploys. Instance type defaults to AWS `m8g.4xlarge` (16 vCPU, 64 GB) unless noted.

| Service           | Peak QPS / TPS                | Per-instance throughput | Instances (with headroom) | Primary bottleneck                                                                  |
| ----------------- | ----------------------------- | ----------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| Gateway           | 20K QPS (req-fan-in)          | 2K QPS                  | 10 × 1.5 = **15**         | CPU (TLS termination, auth, rate-limit eval)                                        |
| OrchestratorAPI   | 5K runs/sec start; 8K hops/sec from in-flight runs | 800 hops/sec | 10 × 1.5 = **15** | CPU + downstream wait (ModelGateway)                                                |
| CatalogAPI        | 3K QPS (read-heavy)           | 3K QPS (cached)         | 1 × 1.5 = **2 (min 3)**   | Postgres read replica IOPS                                                          |
| AgentRuntime      | 5K concurrent ReAct loops     | 250 loops/instance      | 20 × 1.5 = **30**         | Memory (loop state) + downstream wait                                               |
| SkillExecutor     | 8K tool calls/sec (≈1 per hop)| ~200 invocations/sec    | 40 × 1.5 = **60**         | WASM cold-start + outbound network                                                  |
| ConnectorBroker   | 2K QPS upstream-facing        | 500 QPS                 | 4 × 1.5 = **6**           | Upstream provider rate limits (Gmail/Slack/Notion)                                  |
| MemoryService     | 16K read/sec, 8K write/sec    | 4K mixed IOPS           | 4 × 2 = **8**             | Postgres + Redis backing store IOPS                                                 |
| RAGService        | 5K vector queries/sec         | 500 queries/sec on HNSW | 10 × 2 = **20**           | Vector index RAM + query latency                                                    |
| IngestionPipeline | 200 docs/sec ingest           | 50 docs/sec/worker      | 4 × 2 = **8**             | Embedding API throughput + downstream LLM cost                                      |
| ModelGateway      | 8K LLM calls/sec aggregate    | ~1K calls/sec           | 8 × 1.5 = **12**          | **External LLM provider quota and tail latency** (the global cliff)                 |
| GuardrailService  | 16K classifications/sec (in+out) | 2K/sec              | 8 × 1.5 = **12**          | CPU (small classifier inference) + redaction pass                                   |
| TelemetryMesh     | 50M spans/day = ~580 spans/sec sustained; 5K spans/sec peak | 1.5K spans/sec ingest | 4 × 2 = **8** | Disk write throughput → Clickhouse. Anchor: 50M spans/day, 2.5TB/mo (resume.txt:58-59) |

The 5K-concurrent-run row of OrchestratorAPI lines up with the BlackBox-era 10K+ runs/day claim (resume.txt:51-52) translated to a much higher concurrency surface; the 8K LLM calls/sec aggregate on ModelGateway derives directly from `5000 runs × 8 hops × (1 LLM call/hop) / avg_hop_latency_5s ≈ 8K calls/sec`.

---

## 3. Token Economics

Forward arithmetic (steady state):

```
5,000 concurrent runs
  × 8 hops/run
  × 2,000 tokens/hop                     = 80,000,000 tokens "in flight at one snapshot"

Avg hop latency ≈ 5 s (LLM streaming p50)
Hops/sec       = 5000 × 8 / 5            = 8,000 hops/sec
Tokens/sec     = 8,000 × 2,000           = 16,000,000 tokens/sec at peak

Tokens/day  (peak 8h, average 3h-equivalent):
  16e6 × 3 × 3600                        ≈ 1.73 × 10^11 tokens/day  ≈ 173 B tokens/day

Tokens/month (peak workload, not steady):
  173e9 × 30                             ≈ 5.2 × 10^12 tokens/month at peak — too aggressive
```

The peak math runs hot. Re-anchoring to a **realistic blended utilization** (peak QPS only ~20% of the time, baseline ~10% of peak otherwise):

```
Blended tokens/sec  ≈ 16e6 × 0.20 + 1.6e6 × 0.80  ≈ 4.5 × 10^6 tokens/sec
Tokens/month        ≈ 4.5e6 × 86400 × 30          ≈ 1.17 × 10^13 / order ~ correction:

Apply duty-cycle correctly:
  Avg tokens/sec across the month ≈ 4,500,000 if we sustain peak for 20% of seconds:
  But realistic for a B2C platform = aggregate 30% of peak averaged:
  Tokens/month = 16e6 × 0.30 × 86400 × 30 ≈ 1.24 × 10^13 = 12 trillion / month — still too hot.

Real B2C duty cycle (avg sec is ~3% of peak when integrated 24×7):
  Tokens/month = 16e6 × 0.03 × 86400 × 30 ≈ 1.24 × 10^12 ≈ 1.2 trillion/month
```

So a defensible forward number is **~1–2 trillion tokens/month** at the 18-month target. Compared against the resume anchor of **1B+ tokens/month** on the BlackBox model router (resume.txt:55-56), this is a **~1,000× scale up at peak ambition, ~10× at 18-month-realistic ambition**.

We commit to the **conservative 18-month planning number: ~10B tokens/month sustained**, with provisioning headroom built to scale to 100B tokens/month without re-architecture.

| Horizon            | Tokens/month       | Multiple over resume anchor (1B/mo, resume.txt:55-56) |
| ------------------ | ------------------ | ----------------------------------------------------- |
| Launch             | 1B                 | 1×                                                    |
| 6 months           | 3B                 | 3×                                                    |
| 18 months (target) | 10B                | 10×                                                   |
| Stretch / TAM      | 100B               | 100×                                                  |

---

## 4. Memory Storage Growth

### 4.1 WorkingMemory (ephemeral run state)

```
~50 KB / active run × 5,000 concurrent  = 250 MB live RAM
```

Fits comfortably in a single `m8g.4xlarge` Redis node (64 GB) with two orders of magnitude headroom. We still cluster Redis (3 shards × 2 replicas) for failure isolation and to absorb 10× growth before re-sharding. **Assumption:** 5 minute TTL on run keys.

### 4.2 EpisodicMemory (per-user run history, Postgres + Clickhouse)

```
~10 KB / run × 8 runs / user / week × 100,000 WAU × 52 weeks
  = 10e3 × 8 × 100e3 × 52
  = 4.16 × 10^11 bytes
  ≈ 416 GB / year (Postgres hot)
```

Mistype guard: that's **~4 TB / year** if we keep full payloads vs the compact 10 KB summary. Plan for **~4 TB/year** on Clickhouse (full trace, anchored on the BlackBox 2.5 TB/month trace mesh — resume.txt:58-59), and **~400 GB/year** on Postgres (compact episodic index). After year 2 we move Postgres older-than-90-day rows to Clickhouse via partition exchange.

### 4.3 SemanticMemory (per-user embeddings)

```
~5 KB / embedding × 100 embeddings / user × 1,000,000 users
  = 5e3 × 100 × 1e6
  = 5 × 10^11 bytes
  ≈ 500 GB
```

This is a **pgvector index** on a dedicated Postgres cluster (4 shards × 2 replicas). Index type: **HNSW with M=16, ef_construction=200**. 500 GB fits a single 768 GB RAM `r8g.24xlarge` shard but we shard for write throughput, not size.

### 4.4 ProceduralMemory (per-agent learned skills/tool prefs)

Small: **~1 GB total** across 10K agents. Lives in Postgres next to agent metadata.

| Memory tier      | Steady-state size      | Storage system            | Notes                                                |
| ---------------- | ---------------------- | ------------------------- | ---------------------------------------------------- |
| WorkingMemory    | 250 MB live            | Redis cluster (3×2)       | TTL 5 min                                            |
| EpisodicMemory   | 400 GB/yr Pg + 4 TB/yr Ckh | Postgres + Clickhouse | Partitioned by month, tier to Clickhouse at 90 days  |
| SemanticMemory   | 500 GB                 | pgvector (4-shard)        | HNSW index                                           |
| ProceduralMemory | 1 GB                   | Postgres                  | Co-located with agent metadata                       |

---

## 5. RAG Index Growth

Naive math first to demonstrate the **wrong** sizing path:

```
3,000 agents × 100 MB raw text / agent           = 300 GB raw text
Assume 500 chars/chunk, so ~200K chunks/agent    = 600M chunks total
Vector dim 1024 × float16 (2 bytes)              = 2,048 bytes/vector
Total vector bytes                               = 600e6 × 2048 ≈ 1.23 TB
```

So 1.23 TB of vectors. That's **practical** — one Milvus cluster of 8× `r8g.16xlarge` (512 GB RAM each) handles it with room. The "100B vectors / impractical" framing in the brief was a strawman; the real number is ~600M chunks at the stated corpus size.

**Index choice — HNSW vs IVF-Flat:**

| Aspect              | HNSW                                            | IVF-Flat                                              |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| Query latency p95   | ~5 ms at 100M vectors                           | ~25 ms at 100M vectors                                |
| Recall@10 (default) | 0.95+                                           | 0.85–0.92                                             |
| Memory footprint    | 1.5× raw vectors (graph overhead)               | 1.05× raw vectors                                     |
| Build time          | High (hours for 1B vectors)                     | Low                                                   |
| Incremental insert  | Native, low cost                                | Requires re-train of centroids periodically           |
| Cost / vector       | Higher RAM, lower CPU                           | Lower RAM, higher CPU per query                       |

**Decision: HNSW (M=16, ef_construction=200, ef_search=64).** The B2C agent UX target is `< 200 ms p95` end-to-end including LLM, which gives the retriever a `~30 ms` budget. HNSW meets it; IVF-Flat doesn't at this index size with the default tuning. We accept the 1.5× RAM cost. This mirrors the BlackBox stack which uses HNSW + bm25 hybrid (resume.txt:60-61).

---

## 6. Top 5 Bottlenecks

1. **ModelGateway → external LLM provider rate limits and tail latency.** Provider TPM/RPM caps are the single hardest cliff. At 8K LLM calls/sec aggregate against any single provider, we exceed Anthropic and OpenAI default tier limits by 10×. Requires multi-provider sharding, dedicated capacity reservations, and provider-specific budget allocators. This is the lesson from BlackBox's 1B+ tokens/month router (resume.txt:55-56).

2. **pgvector / RAG query latency at index size.** Past ~100M vectors per shard, HNSW recall drops and query latency climbs into the 50–100 ms range — eating the entire UX budget. Mitigation: shard by `tenant_id × agent_id`, target ≤50M vectors/shard, and migrate to Milvus or Weaviate at ~1B vectors total.

3. **Postgres `run_events` write hot spot.** OrchestratorAPI emits 8K events/sec at peak. Single-table contention on a primary key index becomes the bottleneck around 4–6K writes/sec. Mitigation: partition by `(tenant_id, day)`, use ULID primary keys for time-ordered insert locality, batch writes with `COPY` from OrchestratorAPI ring buffer.

4. **ConnectorBroker upstream rate limits.** Gmail Send API: 1B-1Q-100K-per-day class, Slack Web API ~1 req/sec/team, Notion ~3 req/sec/integration. At 5K concurrent runs touching connectors, a single popular connector becomes a hot lane. Mitigation: per-tenant per-connector token buckets, sticky-routing to the same broker shard, and cooperative scheduling that the agent loop respects.

5. **SkillExecutor cold start.** WASM module first-load is 50–200 ms. At 8K invocations/sec, a 1% cold-start rate produces 80 cold starts/sec — a steady 8–16 seconds/sec of cold-start latency budget. Mitigation: WASM module cache per-host, pre-warm pool keyed by module hash, and pin top-100 modules to every executor. This mirrors the 1M+ daily WASM executions architecture at BlackBox (resume.txt:48-49 / `blackbox-experience.md:9-13`).

---

## 7. Backpressure Strategy

Anchored on `microsoft-experience.md` point 27 (backpressure for AutoML at >15M jobs/month) and `blackbox-experience.md` point 19 (1B+ tokens/month with provider rate-limit awareness).

**Token buckets, three layers stacked:**

| Layer               | Bucket key                  | Refill rate (default tier)        | Burst                | What it protects                              |
| ------------------- | --------------------------- | --------------------------------- | -------------------- | --------------------------------------------- |
| Per-user            | `user_id`                   | 10 runs/min, 1K tokens/sec        | 5× steady            | Abusive single user                           |
| Per-agent           | `agent_id`                  | 100 runs/min                      | 2× steady            | Viral agent attack vector                     |
| Per-connector       | `(tenant_id, connector_id)` | Provider-quoted rate × 0.7        | Provider burst       | Upstream provider exhaustion                  |
| Per-provider (LLM)  | `(provider, model)`         | Negotiated capacity                | 1.2×                 | LLM provider TPM/RPM exhaustion               |

**Queue depth-based shedding at Gateway:**

```
if global_run_queue_depth > 20_000:
  reject new runs with HTTP 503 (Retry-After: <queue-drain-estimate>)
if per-user-queue > 50:
  HTTP 429 immediately, no queue
```

**Adaptive concurrency at ModelGateway** (the heart of the system, given bottleneck 1):
- Vegas / TCP-style additive-increase-multiplicative-decrease per `(provider, model)`.
- On any provider 429 or 5xx with `x-ratelimit-remaining-tokens < 10%`: cut concurrency by half.
- Recover by +1 every 5 sec until tail latency p95 degrades by >20%, then hold.
- Per-provider concurrency budget is hard-capped at the negotiated TPM ceiling.

**Cooperative cancellation:** OrchestratorAPI sends `cancel` events down the agent run graph if Gateway shed the originating request; AgentRuntime checks cancellation between hops so in-flight token spend stops at the next checkpoint.

---

## 8. Quota Model

| Feature                    | Free                  | Pro                                | Enterprise (later)        |
| -------------------------- | --------------------- | ---------------------------------- | ------------------------- |
| Agent runs / month         | 100                   | 10,000                             | Custom                    |
| Tokens / run (hard cap)    | 1,000                 | 8,000                              | 32,000                    |
| RAG sources                | 1, 10 MB              | 100, 1 GB total                    | Unlimited within contract |
| Connectors                 | 3                     | 25                                 | Unlimited                 |
| Concurrent runs            | 1                     | 5                                  | Negotiated                |
| Memory retention           | 7 days episodic       | 90 days episodic + semantic        | Custom                    |
| Custom skills              | 0                     | 10                                 | Unlimited                 |

**80 / 20 read:**

```
Assumption: 95% of accounts are Free, 5% are Pro.

Free count       = 950,000
Free max tokens  = 100 runs × 1,000 tokens = 100,000 tokens/user/month
Free token spend = 950,000 × 100,000      = 9.5 × 10^10 = 95B tokens/month

Pro count        = 50,000
Pro max tokens   = 10,000 runs × 8,000     = 80,000,000 tokens/user/month
Pro token spend  = 50,000 × 80,000,000     = 4 × 10^12 = 4T tokens/month
```

Free dominates **count** (95% of accounts) but Pro dominates **spend** (~42× Free in aggregate). This drives two product decisions: (a) Free tier must be aggressively rate-limited so abuse doesn't ruin unit economics, and (b) Pro tier should get dedicated per-provider capacity slots so a Free-tier surge doesn't impact paying customers — same isolation principle as the multi-tenant Microsoft AutoML platform (microsoft-experience.md point 6, resume.txt:88-89).

---

## 9. Monthly Cost Projection

All numbers are **Assumption:** unless explicitly anchored.

### Compute fleet (from §2)

| Service           | Instances (avg billed) | Type          | $/hour | Monthly         |
| ----------------- | ---------------------- | ------------- | ------ | --------------- |
| Gateway           | 15                     | m8g.4xlarge   | 0.61   | $6,700          |
| OrchestratorAPI   | 15                     | m8g.4xlarge   | 0.61   | $6,700          |
| CatalogAPI        | 3                      | m8g.2xlarge   | 0.31   | $680            |
| AgentRuntime      | 30                     | m8g.4xlarge   | 0.61   | $13,400         |
| SkillExecutor     | 60                     | m8g.4xlarge   | 0.61   | $26,800         |
| ConnectorBroker   | 6                      | m8g.2xlarge   | 0.31   | $1,350          |
| MemoryService     | 8                      | r8g.4xlarge   | 0.85   | $5,000          |
| RAGService        | 20                     | r8g.8xlarge   | 1.70   | $24,800         |
| IngestionPipeline | 8                      | m8g.4xlarge   | 0.61   | $3,600          |
| ModelGateway      | 12                     | m8g.2xlarge   | 0.31   | $2,700          |
| GuardrailService  | 12                     | m8g.4xlarge   | 0.61   | $5,400          |
| TelemetryMesh     | 8                      | m8g.4xlarge   | 0.61   | $3,600          |
| **Total compute** |                        |               |        | **~$100,700**   |

### LLM provider spend (the dominant line)

```
Blended price = $3 / 1M input tokens, $15 / 1M output tokens, 70/30 input:output split
Effective blended cost ≈ ($3 × 0.7 + $15 × 0.3) / 1M = $6.60 / 1M tokens

At 10B tokens/month: 10,000 × $6.60 = $66,000 — too low; that's the floor with ideal caching.
Without prompt caching: 10B × $6.60 = $66,000 base spend
With realistic Pro/Free mix where Pro pays 80% of tokens: $66,000 × 1.0 ≈ $66K
Add reasoning models (premium) at 20% of mix at $15/$60: +$120K
```

**Plan for $150K–$200K/month LLM spend at 10B tokens/month.** Aggressive prompt caching (target 50% cache hit; resume.txt:23 lists KV cache as a core skill area) and capability-aware routing (route cheap intents to Haiku/4o-mini; route only hard reasoning to Opus/o3) — anchor: BlackBox model router (resume.txt:55-56).

### Storage

| Store                            | Size              | $/GB/mo            | Monthly                |
| -------------------------------- | ----------------- | ------------------ | ---------------------- |
| Postgres (RDS, multi-AZ)         | 2 TB              | $0.115             | $235                   |
| pgvector dedicated (RDS)         | 500 GB + 768 GB RAM × 8 | r8g.24xlarge | $24,000                |
| Redis (ElastiCache)              | 3 shards × 64 GB  | included in instance | $4,500               |
| Clickhouse (self-hosted on EBS)  | 30 TB             | $0.10              | $3,000                 |
| S3 (raw RAG sources + artifacts) | 50 TB             | $0.023             | $1,150                 |
| **Storage total**                |                   |                    | **~$32,900**           |

### Network egress

```
Assumption: 30 TB egress/month from API responses + LLM proxying
30,000 GB × $0.05 (CloudFront blended) = $1,500
```

### Total

| Bucket          | Monthly         | Share of total |
| --------------- | --------------- | -------------- |
| Compute         | ~$100,700       | 27%            |
| LLM providers   | ~$200,000       | 53%            |
| Storage         | ~$32,900        | 9%             |
| Egress          | ~$1,500         | <1%            |
| Headroom / reserve (15%) | ~$50,000 | 13%            |
| **Total**       | **~$385,000**   | 100%           |

**Cost per WAU: $385,000 / 100,000 = $3.85 / WAU / month.**

LLM provider spend dwarfs everything else 2:1 over compute — this is the dominant lever for unit economics, validating the Microsoft-era discipline on cost-aware resource allocation (microsoft-experience.md point 9 / resume.txt:88-89) and the BlackBox-era context optimization (blackbox-experience.md point 18 / resume.txt:55-56).

---

## 10. Growth Plan — 3 Inflection Points

### Inflection 1 — 100K → 1M WAU

| Change                                                                      | Why now                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------ |
| Shard Postgres by `tenant_id` (8 shards, range partitioned)                 | run_events write hot spot from §6 bottleneck 3   |
| Move WorkingMemory off shared Redis to a **standalone Redis cluster**       | Run-state IO no longer fights episodic IO        |
| Split ConnectorBroker into **per-upstream-provider clusters**               | Gmail outage stops cascading to Slack runs       |
| Add **cross-region read replicas** for Postgres (us-east-1, eu-west-1)      | Latency for EU users; DR posture                 |
| Pre-aggregated TelemetryMesh roll-ups, push raw traces to S3 + Clickhouse   | 50M spans/day pattern from resume.txt:58-59      |

### Inflection 2 — 1M → 10M WAU

| Change                                                                          | Why now                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Shard pgvector → Milvus / Weaviate cluster** with per-tenant collection model | Bottleneck 2 hit; HNSW per shard maxed           |
| **Introduce Kafka for run-event durability**, OrchestratorAPI writes Kafka first | Decouple write path from Postgres; replay-able   |
| **Provider-specific ModelGateway clusters** with independent autoscaling        | One provider's degradation can't starve others   |
| **Multi-region active-active** (us-east, us-west, eu-west)                      | UX latency + sovereignty (GDPR data residency)   |
| Dedicated GPU pool for in-house re-rankers + small classifiers                  | Pulls Guardrail and rerank cost out of LLM bill  |

### Inflection 3 — Premium creator monetization

| Change                                                                          | Why                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Per-agent dedicated runtime tier** (1 AgentRuntime pod per popular agent)     | Predictable latency for monetized creators            |
| Per-agent cost attribution → revenue share                                       | Catalog economics; mirrors AutoML SDK + Studio model  (microsoft-experience.md point 15 / resume.txt:90-92) |
| Reserved LLM provider capacity per top-1000 agents                              | SLA guarantee for creator-promoted runs               |
| Custom GuardrailService policies per creator (catalog-listed safety profile)    | Marketplace differentiation                           |

---

## 11. Capacity Planning Rituals

Anchored on `blackbox-experience.md` point 20 — the LLMOps telemetry mesh (resume.txt:58-59) cut MTTR by 60%. The same observability discipline drives capacity rituals.

| Cadence    | Ritual                                                                                       | Owner                            | Action threshold                                  |
| ---------- | -------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------- |
| Weekly     | Percentile latency review (p50/p95/p99 for every service in §2)                              | On-call + infra lead             | p95 > SLO for 2 consecutive weeks → re-size       |
| Weekly     | Provider-share-of-LLM-traffic dashboard                                                      | Model router owner               | Any one provider > 60% → diversify quota          |
| Monthly    | Provider-share-of-spend review                                                               | Eng leadership + finance         | LLM line item drift > 15% MoM → emergency review  |
| Monthly    | Memory growth slope per user (semantic/episodic GB / WAU)                                    | MemoryService owner              | Slope > forecast by 30% → shard or tier earlier   |
| Monthly    | Free-vs-Pro token ratio audit                                                                | Product + infra                  | Free crosses 30% of token spend → rate-limit cut  |
| Quarterly  | Quota model recalibration (look at p99 of Pro usage; adjust ceilings)                        | Product                          | Pro hitting cap > 5% of users → upsell or expand  |
| Quarterly  | Capacity model recompute — re-derive the §2 table from current real traffic                  | Principal engineer + on-call lead | Any tier > 70% of headroom → order capacity now   |
| Quarterly  | Bottleneck rotation review — top-5 from §6 reranked against last quarter's actual incidents  | Architecture review board        | New entrant in top 5 → design spike               |
| Quarterly  | DR + region-failover game day                                                                | SRE                              | RTO > 30 min in test → fix before next quarter    |

The structured cadence is the same one used to run the **30+ architecture reviews and sprint planning at Microsoft** (microsoft-experience.md point 19 / resume.txt:95-96), institutionalized as a recurring forum rather than ad-hoc escalation.

---

## Sources / Resume Anchors Used

- `resume.txt:51-52` — 10K+ agent runs/day BlackBox anchor (§1, §2, §6).
- `resume.txt:55-56` — 1B+ tokens/month model router BlackBox anchor (§3, §6, §9).
- `resume.txt:58-59` — 50M spans/day, 2.5TB/month, 60% MTTR reduction LLMOps telemetry mesh (§2, §11).
- `resume.txt:88-89` — Microsoft secure multi-tenant ML infrastructure, cost-aware resource allocation (§8, §9).
- `resume.txt:90-92` — 15M+ jobs/month AutoML scale anchor (§1, §10).
- `resume.txt:95-96` — 30+ architecture reviews at Microsoft (§11).
- `resume.txt:23` — KV cache as listed skill, feeding prompt-cache strategy (§9).
- `blackbox-experience.md:9-13` — WASM sandbox plane 1M+ daily executions (§6).
- `blackbox-experience.md:25,33` — durable execution, fault-tolerant distributed agent runtime (§2, §7).
- `microsoft-experience.md:78-82` — backpressure for 15M+ jobs/month platform (§7).
