# 06 — Scaling & Capacity: AI Banker for SMB Owners

> **Voice:** Principal Engineer. Numbers are load-bearing. Every multiplier is anchored against a real system I have shipped, or marked explicitly as an extrapolation assumption.
>
> **Anchors used throughout:**
> - BlackBox agent runtime: **10K+ agent runs/day**, **1B+ tokens/month**, **50M spans/day**, **2.5TB+/month trace data** (resume.txt L51-59, blackbox-experience.md #11, #19, #20)
> - Microsoft AML: **15M+ jobs/month**, **200K+ users**, **gang scheduling + bin-packing** for multi-tenant GPU (resume.txt L88-92)
> - ShareChat Ads: **40M DAU**, real-time RTB at sub-100ms (resume.txt L109-114)
> - TunDRA: **1M+ Compute Instances** over QUIC (resume.txt L97-98)
>
> The platform target — **1M SMB MAU / 300K DAU / 8M agent runs/month / 18B LLM tokens/month** — is a **27x extrapolation** on BlackBox runs/day and an **18x extrapolation** on BlackBox monthly tokens. Treat the multiplier as an assumption; the sub-system math below shows what survives the extrapolation and what breaks first.

---

## 1. Capacity assumptions baseline

Restated from `02-design-estimates.md` and pinned here so this file is self-contained.

| Dimension | Value | Anchor / derivation |
|---|---|---|
| MAU SMBs | **1,000,000** | Target |
| DAU (30%) | **300,000** | SMB owners check cashflow 5-15 days/month |
| Peak concurrent conversations | **50,000** | 8 AM / 9 AM IST morning brief peak |
| Agent runs/month | **8,000,000** | 8 runs/MAU/month avg (1 morning brief + 7 ad-hoc) |
| Agent runs/day (peak) | **~270,000** | 8M / 30 days × 1.0; daily peak amplified separately |
| **vs BlackBox 10K runs/day** | **27x** | resume.txt L51-52; assumption: same orchestrator pattern scales horizontally |
| LLM tokens/month | **18,000,000,000 (18B)** | avg 2,250 tokens/run × 8M |
| **vs BlackBox 1B tokens/month** | **18x** | resume.txt L55-56; assumption: model router pattern holds, fan-out is similar |
| Telemetry spans/day | **1.3B** | 5K spans/run × 270K runs/day |
| **vs BlackBox 50M spans/day** | **26x** | resume.txt L58-59; ClickHouse cluster grows linearly |

**Assumption flag:** the 27x extrapolation assumes (a) the BlackBox orchestrator's per-run cost profile (5 hops, ~4s wall-clock) holds for SMB cashflow runs and (b) the supervisor/specialist split has the same fan-out. Both are validated in `04-architecture.md`. If avg hops climbs from 5 → 8 (richer planning), all downstream numbers in this file go up **60%** and we re-derive.

---

## 2. Throughput model per service tier

Every tier sized for **peak**, not average. Steady-state target utilization is 50% on stateless, 40% on stateful — leaves 2x headroom for the burst section below.

| Tier | Peak RPS | p95 budget | CPU/req | Mem/req | Util target | Fleet sizing (8 vCPU node) |
|---|---:|---:|---:|---:|---:|---|
| Edge (NLB + ALB + WAF) | 100,000 | < 5 ms LB hop | n/a (managed) | n/a | n/a | NLB cross-zone; ALB on m8g; WAF managed |
| BFF (NestJS / gRPC fanout) | 60,000 | 80 ms | 50 mCPU | 5 MB | 50% | 60K × 0.05 / (8 × 0.5) = **~750 pods → 200 nodes** |
| Orchestrator (create-run) | 10,000 | 100 ms | 80 mCPU | 8 MB | 50% | 10K × 0.08 / (8 × 0.5) = **~200 pods → 50 nodes** |
| Orchestrator (step events) | 30,000 | 50 ms | 30 mCPU | 4 MB | 50% | 30K × 0.03 / (8 × 0.5) = **~225 pods → 60 nodes** |
| Supervisor agent | 10,000 concurrent runs | n/a (long-lived) | avg 200 mCPU/run | 80 MB/run | 60% | 10K × 0.2 / (8 × 0.6) = **~420 pods → 110 nodes** |
| Specialist agents (fan-out 3) | 7,500 active hops/sec | n/a | avg 250 mCPU/hop | 60 MB/hop | 60% | 7.5K × 0.25 / (8 × 0.6) = **~390 pods → 100 nodes** |
| Tool gateway | 30,000 | 50 ms | 25 mCPU | 3 MB | 50% | 30K × 0.025 / (8 × 0.5) = **~190 pods → 50 nodes** |
| Forecast engine | 5,000 (95% cached) | 500 ms on miss / 20 ms on hit | 100 mCPU (miss) / 5 (hit) | 50 MB | 50% | warm pool 60 pods on c8g + GPU optional |
| Model router | 2,000 LLM calls/sec | 80 ms routing decision | 40 mCPU | 4 MB | 50% | **~40 pods**; provider calls are bound by their RPS, not ours |
| Postgres (run state) | 50K w/s + 100K r/s | 10 ms p95 | n/a | n/a | 60% | Aurora r8g.16xlarge × 8 shards (writer + 3 readers each) |
| Redis (cache/session/dedupe) | 200K ops/sec | 1 ms p95 | n/a | n/a | 50% | ElastiCache r8g.4xlarge × 6 shards, cluster mode |
| Vector store (pgvector / Qdrant) | 30K queries/sec | 30 ms p95 | n/a | n/a | 50% | 16-shard cluster; HNSW M=32 ef=128; anchor on BlackBox HNSW work (resume.txt L61, blackbox-experience.md #21) |
| Kafka (event bus) | 100K msg/sec | 20 ms produce-ack | n/a | n/a | 50% | MSK m8g.4xlarge × 12 brokers, RF=3, 96 partitions per topic |
| ClickHouse (telemetry) | **1.5M spans/sec peak** | 100 ms ingest, 2 s query | n/a | n/a | 60% | 24-node cluster on i4i.4xlarge with NVMe; **anchored on BlackBox 50M spans/day (resume.txt L58-59) scaled 25x** |

**Math checks:**
- Edge 100K RPS = 50K live conversations × 2 RPS (1 user keystroke debounce + 1 server-push poll). Consistent with ShareChat-style real-time fanout at lower scale (resume.txt L109-114).
- Supervisor 10K concurrent runs = (50K peak conv) × (20% in active agent step at any instant).
- Specialist 7.5K hops/sec = supervisor 2.5K hops/sec × fan-out 3 (cashflow specialist + receivables specialist + lender specialist).
- Tool gateway 30K = 7.5K hops × 4 tool calls/hop (bank API + accounting API + lender API + RAG kb.search).
- Model router 2K LLM/sec = supervisor 2.5K + specialist 7.5K hops/sec × 20% (most hops are deterministic post-tool synthesis, only 20% need a fresh LLM call after caching).

---

## 3. Bottleneck analysis — what runs out first

Ranked by likelihood of being the first ceiling we hit. Each row says **what runs out**, **how we detect it**, **what we do about it**.

| Rank | Bottleneck | Detection signal | Mitigation |
|---:|---|---|---|
| 1 | **LLM token budget** (cost + provider RPM) | `model_router.tokens_per_minute` per provider vs published rate limit; cost burn rate dashboard | Model router shifts to cheaper model (Haiku/Mistral-small) for low-risk intents; cache top 50 question templates; pre-canned answers for FAQ; queue overflow to lower-tier model. Anchor: capability-aware routing from BlackBox (resume.txt L55-56) |
| 2 | **Postgres write IOPS on `run_state`** at 50K writes/sec | Aurora write latency p95 > 15 ms; binlog lag > 500 ms | (a) **Batch checkpoints every N hops**, not every event; (b) jsonb column compression (lz4); (c) split into append-only `run_event_log` + periodic snapshot table; (d) shard by tenant_id mod 8. Anchor: BlackBox checkpointing pattern (blackbox-experience.md #12-13) |
| 3 | **Tool gateway connection pool to bank providers** (rate-limited externally, often 100-500 RPS/customer) | 429 rate from provider > 1%; queue depth on bank-API worker > 2K | Per-provider per-tenant token bucket; coalesce reads (one balance fetch / tenant / 60s); webhook-first design so we are push-fed not poll-driven |
| 4 | **Vector store p99 latency** under 30K QPS | pgvector / Qdrant p99 > 80 ms; HNSW recall drop | Shard by tenant_id; tier hot tenants into dedicated shards; pre-compute embeddings for top 1K queries; smaller `ef` at query time when QPS spike. Anchor: HNSW + bm25 hybrid (resume.txt L61) |
| 5 | **ClickHouse compaction pressure** at 1.5M spans/sec | merge_queue_size > 100 per part; disk write amplification > 8x | Increase part target size; offload cold partitions (>7 days) to S3-backed table; sample non-error spans 1:10 above QPS threshold. Anchor: BlackBox 50M spans/day → 2.5TB/month (resume.txt L58-59) is the *proven* baseline; everything above is extrapolation |
| 6 | Kafka partition saturation on `agent.events` topic at 100K msg/sec | producer batching < 16 KB; broker CPU > 70% | Pre-sharded to 96 partitions; key by `run_id` for ordering; spillover topic for telemetry-only events |
| 7 | Forecast engine cold-cache stampede after model retrain | request_queue_depth > 1K; p99 > 2 s | Request coalescing (singleflight per `tenant_id+horizon`); pre-warm top 10K tenants nightly |

---

## 4. Quotas, fairness, and rate limiting

Multi-tenant fairness is the single largest risk to a 1M-MAU SMB platform. One noisy tenant running 5K LLM-driven what-ifs at 8 AM IST can blow the budget for everyone else. Pattern anchored on **Microsoft secure multi-tenant ML infra with gang-scheduling and bin-packing (resume.txt L88-89)**.

### Quota matrix

| Quota dimension | Free tier (default) | Paid tier | Enforced at |
|---|---:|---:|---|
| LLM tokens / day | 100,000 | 5,000,000 | Model router (pre-call) |
| Concurrent agent runs | 5 | 50 | Orchestrator (create-run) |
| Tool calls / provider / day | 500 | 25,000 | Tool gateway (per-provider bucket) |
| Conversations / day | 30 | unlimited (soft cap 5,000) | BFF |
| KB documents stored | 100 | 10,000 | Ingestion pipeline |
| Embeddings / month | 10,000 | 1,000,000 | Embedding worker |

### Global limits (anti-abuse, applies to all tiers)

| Limit | Value | Enforced at |
|---|---:|---|
| Per source IP | 100 RPS | WAF |
| Per `tenant_id` aggregate | 1,000 RPS | Edge ALB + BFF |
| Per `user_id` chat messages | 10/min | BFF |
| Per `tool_provider` global circuit | trip at 5% 5xx in 60s | Tool gateway |

### Fair scheduling at the supervisor

Weighted-fair-queue per `tenant_id` inside the supervisor's work-stealing pool. Weight = `tier_weight × (1 - recent_usage_ratio)`. Free tier weight 1, paid 10. Prevents the classic noisy-neighbor in shared LLM compute — same pattern I used for **GPU gang-scheduling at Microsoft AML where 15M jobs/month across 200K users had to coexist (resume.txt L88-92)**.

---

## 5. Backpressure strategies

Backpressure is layered. Each layer can independently shed before downstream collapses.

| Layer | Mechanism | Trigger | User-visible effect |
|---|---|---|---|
| WAF | Global IP rate limit | > 100 RPS / IP | 429 with no Retry-After (abuse) |
| BFF | Per-user token bucket | > 10 msgs/min | 429 with `Retry-After: 6` |
| Orchestrator | Queue depth shedding | `create_run.queue_depth > 5,000` | 429 with `Retry-After: 30`; UI shows "high demand" banner |
| Supervisor | Weighted-fair-queue + per-tenant concurrency cap | tenant > concurrent cap | run is **queued**, not failed; user gets "queued (2 ahead)" |
| Tool gateway | Per-provider circuit breaker | 5% 5xx in 60s window | tool call returns `degraded`; agent falls back to cached data |
| Model router | Token-budget shedding | tenant > daily token quota | switch to cheaper model; if global LLM budget at 90%, switch all free-tier traffic to pre-canned answers |
| Forecast | Singleflight + stale-while-revalidate | engine queue > 1K | serve last-known forecast with `is_stale=true` flag |

### Degraded modes (graceful, named, observable)

| Mode | Triggered when | What's disabled | What still works |
|---|---|---|---|
| `READ_ONLY` | Postgres writer down or write tier > 90% | new conversations, action approvals | view past briefs, view forecast (cached) |
| `CACHED_FORECAST` | Forecast engine saturated | re-forecast on new transactions | yesterday's forecast served with banner |
| `PRECANNED` | LLM budget at 95% for free tier | open-ended chat for free users | top-50 templated answers (balance, top expense, runway) |
| `OBSERVABILITY_LITE` | ClickHouse ingest > 1.2M spans/sec | full-fidelity traces | head-sampled (1:10) traces + always-on error traces |

All modes are **named, observable** (emit `degraded_mode_active{mode="..."}` metric), and **auto-recoverable** (re-evaluated every 30s).

---

## 6. Cost model at 1M MAU

Monthly direct infrastructure cost. AWS reserved instances assumed for steady fleet; spot for batch ingestion.

| Line item | Monthly cost | Derivation / anchor |
|---|---:|---|
| LLM tokens (inference) | **$90,000** | 18B tokens × $5/M blended; 70% Haiku-class, 25% Sonnet-class, 5% Opus-class. Anchored on BlackBox **1B tokens/month** baseline (resume.txt L55-56) × 18x with router optimizing the mix |
| Compute — stateless fleet (BFF, orchestrator, tool gateway, model router) | $35,000 | ~360 m8g nodes reserved 1yr |
| Compute — agent runtime (supervisor + specialists) | $40,000 | ~210 r8g nodes (memory-bound) |
| Compute — forecast / embedding workers | $25,000 | c8g + occasional g5/g6 for embedding batches |
| Postgres (Aurora, 8 shards × writer + 3 readers, multi-AZ) | $40,000 | r8g.16xlarge × 32 instances + IO + storage |
| Redis (ElastiCache, 6 shards) | $8,000 | r8g.4xlarge × 18 nodes |
| Vector store (16-shard pgvector / Qdrant cluster) | $12,000 | i4i.4xlarge × 16 with NVMe |
| ClickHouse (telemetry, 24 nodes + S3 cold) | $25,000 | i4i.4xlarge × 24 + 60 TB S3 |
| Kafka (MSK, 12 brokers) | $9,000 | m8g.4xlarge × 12 + storage |
| S3 + archive + backups | $10,000 | 500 TB warm + 2 PB Glacier IR |
| Bandwidth + NLB/ALB + WAF | $8,000 | 60 TB egress @ avg $0.07/GB after volume discount |
| Third-party APIs (bank Plaid/Setu, accounting Zoho/Tally, lender) | $15,000 | variable; assumes per-tenant aggregator $0.015/call × 1M calls/day |
| **Total** | **~$317,000 / month** | |

### Unit economics

| Metric | Value |
|---|---:|
| Direct cost per MAU | **$0.317** |
| Direct cost per agent run | **$0.040** (317K / 8M) |
| Direct cost per conversation | **~$0.05** (mostly LLM) |
| Free-tier burden (5 convos/MAU/month × 60% of base) | $0.25 / free MAU / month |
| Paid-tier headroom ($20/mo plan) | $20 - ~$5 direct = $15 gross margin before sales/marketing |
| Break-even paid conversion | ~2% paid converts free; in practice we target 5-8% |

**Assumption flag:** $5/M blended is conservative-realistic for May 2026 pricing with prompt caching enabled (Anthropic-style 90% cache discount on system prompts). If cache hit rate is < 50% (vs target 75%), blended jumps to $8/M and LLM line item is $144K (+60%). Cost-per-MAU climbs to $0.42 — still well within $20 paid ARPU.

---

## 7. Growth plan — what scales how

Three growth jumps. Each one has a different scaling boundary that *will* fail without architectural change.

### Phase A: 100K → 1M MAU (10x)
- Stateless tiers (BFF, orchestrator, tool gateway, model router) scale **linearly** via HPA — no architecture change.
- **Vector store hits sharding boundary around 500K MAU** (single pgvector instance saturates HNSW memory at ~50M vectors). Mitigation: shard by `tenant_id mod N` with N=16; cross-shard query only for global KB.
- Postgres run-state hits write IOPS ceiling around 700K MAU on a single Aurora writer. Mitigation: shard by `tenant_id mod 8` *before* hitting 600K.
- Model router does not need architecture change — provider mix shifts toward cheaper models.

### Phase B: 1M → 10M MAU (10x more)
- **Cell-based architecture**. Split the platform into 10-20 cells, each cell holding ~500K-1M MAU and owning its own Postgres + agent runtime + Kafka. Cell assignment is sticky per tenant (consistent hash of `tenant_id`). Anchor: **Microsoft AML pattern that runs 15M jobs/month across 200K users with multi-cell isolation (resume.txt L88-92)**.
- Per-region Postgres (no global write); CDC into a central analytics warehouse.
- Tool gateway shared across cells with per-cell quotas.
- Telemetry ClickHouse goes per-region with central read federation.

### Phase C: 10M+ MAU
- **Self-host LLM inference** for cheap intents. Llama-3.1-70B or Mistral-Large-2 on H100/H200 fleet for 60% of traffic; provider models reserved for hard reasoning. Cuts blended token cost from $5/M to ~$2/M (60% saving on LLM line item).
- Anchor: **vLLM and PyTorch Distributed expertise from Microsoft AI Fine-tuning (resume.txt L74, L101)** — already shipped multi-tenant vLLM at scale.
- Cross-region active/active for read APIs; per-region write residency.

### Per-customer (per-SMB) growth
Inside one tenant, as the SMB adds more bank accounts, ledger volume, and history:
- Ingest scales **linearly** with transactions/day.
- Embedding store scales **O(documents × log(time))** because of deduplication on transaction patterns.
- Forecast cost is **O(1) per tenant per day** (one forecast covers all accounts).

---

## 8. Capacity planning playbook

| Practice | Threshold / cadence | Owner |
|---|---|---|
| Synthetic load test pre-launch | 1.5x measured peak, 30 min sustain, every release | SRE on-call |
| HPA on stateless tiers | CPU target 60% **and** custom metric `queue_depth > 1K` (whichever fires first) | Platform |
| VPA | **off** in prod (causes pod restarts; we right-size manually quarterly) | Platform |
| PodDisruptionBudget | `minAvailable: 50%` for all stateless tiers, `maxUnavailable: 1` for stateful sets | Platform |
| Cluster autoscaler | 5-minute scale-up, 15-minute cooldown scale-down | Platform |
| Aurora global database | Active in primary region; passive replica in DR region with < 1 s lag SLO | DBRE |
| Multi-region read APIs | Active/active behind Route 53 latency routing | Platform |
| Multi-region write APIs | Active/passive (write to home region only, residency-bound) | Platform |
| Burn-rate alerts | LLM token spend > 1.5x daily forecast; compute > 1.2x | FinOps |
| Quarterly capacity review | Fleet utilization vs forecast; re-derive multipliers | Principal Eng |

Anchored on the **Microsoft secure multi-tenant ML infra pattern (resume.txt L88-89)** where 30+ architecture reviews per quarter (resume.txt L95-96) enforced this discipline.

---

## 9. Multi-region scaling

Residency is a hard constraint (RBI DPDP for India, GDPR for EU, US data law for US). Compute and storage are partitioned by region; **control plane is the only cross-region surface**.

| Region | Primary customers | Stack footprint | Cross-region |
|---|---|---|---|
| **AP-South-1 (Mumbai)** | India SMBs (RBI DPDP residency) | Full stack — BFF, orchestrator, agent runtime, Aurora primary, Redis, Kafka, ClickHouse, pgvector | Telemetry roll-up to central analytics (anonymized); control-plane config replicated |
| **US-East-1 (Virginia)** | US + LATAM SMBs | Full stack mirror | Same |
| **EU-Central-1 (Frankfurt)** | EU SMBs (GDPR + DPDP-adjacent) | Full stack mirror | Same |
| (Future) AP-Southeast-1 | SEA expansion | Cell-pattern bootstrap | — |

Write tier is **never** cross-region for customer data. Read tier can be cross-region for the control plane (feature flags, model catalog, prompt library). Anchored on the **Microsoft secure multi-tenant infra isolation strategies (resume.txt L88-89)**.

---

## 10. Headroom and burst handling

### Steady-state targets
- Stateless tiers: **50% provisioned utilization** → 2x headroom
- Stateful tiers (Postgres, vector, Kafka, ClickHouse): **40% utilization** → 2.5x headroom
- LLM provider rate limits: **70% of contracted RPM** → 1.4x headroom (provider rate limits are the least elastic)

### Daily peak
- **8 AM IST and 9 AM IST** — morning cashflow brief — drives **3x average load**.
- Fleet is sized for this peak, **not** for the daily average. HPA stays warm with `minReplicas` set to peak / 1.2 (so the morning rush doesn't wait for pod cold-start).
- Embedding refresh, batch ingestion, telemetry compaction all scheduled at **2 AM - 5 AM local** during the trough.

### Monthly peak
- **Last 3 days of month (payroll runway questions) + GST filing day** — drives **5x average load**.
- Strategy: **warm reserved capacity** pre-provisioned 24h ahead based on calendar; cluster autoscaler set to aggressive scale-up (3-min) and slow scale-down (30-min).
- Anchor: **ShareChat ad-serving handled 40M DAU with calendar-aware burst patterns (resume.txt L109-114)**.

### Black-swan burst
- 10x sudden spike (viral event, regulator change): degraded modes engage automatically — `PRECANNED` for free tier, `CACHED_FORECAST` for everyone, `OBSERVABILITY_LITE` for telemetry. Maintains availability with controlled quality regression rather than collapsing.

---

## Appendix — assumption ledger (explicit)

| Assumption | Source / risk |
|---|---|
| 27x BlackBox runs/day extrapolates linearly | resume.txt L51-52; risk: avg hops/run may climb from 5 → 8 if planning gets richer → all numbers +60% |
| 18x BlackBox tokens with cache hit rate 75% | resume.txt L55-56; risk: cache hit < 50% → LLM line $144K/mo |
| 50% peak conversation read+write RPS | Best estimate from chat UX patterns; not directly anchored — load test to validate |
| Provider per-tenant rate limits 100-500 RPS | Industry-typical for Plaid / Setu / Zoho APIs; per-provider contract negotiation may shift this |
| Self-host break-even at 10M MAU | Based on H100 hourly cost vs $5/M blended; if model prices fall further, break-even moves to 20M+ |
| Aurora write IOPS shard boundary at 700K MAU | Extrapolated from observed 50K writes/sec ceiling on r8g.16xlarge writer; not load-tested at full scale |

---

**File:** `/Users/sumansaurabh/Documents/startup-3/resume-skiller/design-packs/2026-05-17-ai-banker-smb-cashflow-agent/06-scaling-and-capacity.md`
