# 05 - Scaling and Capacity

The capacity model that gets Qale from Alpha → Public Launch → 1M+ users. Anchor codes defined in `00-question-and-context.md`.

## 1. SLOs and targets

| Surface | p50 | p95 | p99 | Availability SLO |
| --- | --- | --- | --- | --- |
| WebSocket connect (cold) | 200ms | 500ms | 1s | 99.95% |
| Message send (in-region) | 60ms | 150ms | 250ms | 99.95% |
| Message fanout-to-recipient | 80ms | 200ms | 400ms | 99.9% |
| Presence event delivery | 100ms | 300ms | 500ms | 99.9% |
| Read receipt | 100ms | 300ms | 600ms | 99.5% |
| Search (lexical+vector) | 200ms | 600ms | 1.2s | 99.5% |
| AI first-token | 600ms | 1.5s | 3s | 99.5% |
| AI run complete (short) | 2s | 8s | 15s | 99.5% |
| Attachment upload (50MB) | 3s | 8s | 20s | 99.9% |
| Notification push | 500ms | 2s | 5s | 99.5% |

Error budget: each SLO maps to a monthly burn budget; > 25% burn in 6h pages on-call; > 50% halts non-critical deploys (Microsoft AutoML had the same gate - A-MS3, A-MS5).

## 2. Capacity model

Derive from 1M MAU. Conservative assumptions (A6 in `00`):

| Metric | Estimate | Reasoning |
| --- | --- | --- |
| MAU | 1,000,000 | Target |
| DAU | 200,000 | 20% of MAU (assumption A6) |
| Peak concurrent online | 150,000 | ~75% of DAU at peak hour |
| Peak concurrent WS sessions | 180,000 | Slight multi-device fanout (1.2x) |
| Avg messages / DAU / day | 40 | Replacing email + chat hybrid (assumption) |
| Total messages / day | 8,000,000 | DAU × 40 |
| Peak msg/s (5x avg) | ~5,000 | Steady-state peak |
| Burst msg/s (incident, broadcast) | ~15,000 | Mass channel post |
| Presence events / s peak | ~10,000 | Typing + online/offline churn |
| AI runs / DAU / day | 1.5 | Mix of summarize, draft, search |
| AI runs / day | 300,000 | DAU × 1.5 |
| AI runs peak / s | ~25 | 4x avg |
| Avg tokens / AI run (input + output) | ~1,500 | Heavy use of context cache |
| Token spend / month | ~450M tokens | 300K runs × 1500 × 30, anchor BlackBox 1B+/mo (A-BB4) |
| Attachment GB / day | ~500 GB | DAU × 2.5 MB avg |
| Telemetry spans / day | ~50–80M | comparable to BlackBox 50M (A-BB5) |
| Search QPS peak | ~200 | DAU × few searches/day, peak |

**These are the numbers I memorize for the interview.** They line up with the cheat sheet (10) and 01.

## 3. Connection plane sizing

**WebSocket gateway pod budget:**

| Resource | Budget | Notes |
| --- | --- | --- |
| Memory / connection | ~40 KB | Heap + buffers; tuned for Go |
| CPU / connection at idle | ~0.1% of a vCPU | Heartbeat + occasional event |
| CPU / connection at active chat | ~0.5–1% | Send/recv hot path |
| Pod size | 4 vCPU, 8 GB | EKS m6i.xlarge sweet spot |
| Connections / pod ceiling | ~75,000 | Memory + GC headroom |
| Pods at peak | ⌈180,000 / 75,000⌉ = 3 | Plus 100% headroom = 6 |
| Pods provisioned baseline | 8 | Surge + zone failure |

Why 75K/pod and not 200K: GC tail latency on a Go process holding 200K idle WS connections starts producing visible p99 spikes during fanout; 75K is the empirical sweet spot. **Anchor:** TunDRA scaled to 1M+ Compute Instances (A-MS1) - the lesson there was that per-connection memory dominates and you size by pod-level GC, not by connection arithmetic.

**Surge handling:** after a global notification (e.g., "new release! check it out"), reconnect storms can 3–5x peak briefly. Mitigations:
- Client-side jittered reconnect (random 0–10s).
- Server-side connection budget per pod with 503-after-budget (load shedder).
- HPA on `connections_active` gauge with 60s window so we scale before the storm peaks.

## 4. Event bus sizing (Kafka primary)

| Topic class | Partitions | Replication | Retention | Notes |
| --- | --- | --- | --- | --- |
| `workspace.{id}.thread.events` | 64–256 (per workspace tier) | 3 | 7d | Workspace-bucketed; compaction off |
| `presence.changes` | 128 | 3 | 1h | Volume-heavy, short retention |
| `ai.requests` | 64 | 3 | 24h | Replay-friendly |
| `ai.responses` | 64 | 3 | 24h | |
| `notifications.outbound` | 64 | 3 | 7d | |
| `audit.security` | 32 | 3 | 1y (with tiered storage) | Compliance |
| `telemetry.spans` | 256 | 2 | 6h before ClickHouse | High volume |

**Brokers:** start with 6 r6i.xlarge brokers (3 AZs × 2). Scale by partition assignment, not just broker count. Kafka monitoring on under-replicated partitions.

**Hot partition mitigation:** for hot threads (e.g., AI summary thread with 5K subscribers), shed read fanout to a per-thread Redis Stream and have gateways tail it instead of consuming the Kafka partition directly. Anchor: ShareChat ad serving used the same Pub/Sub-fronted-by-Redis pattern for hot DSP responses (A-SC2, A-SC3).

## 5. Storage sizing

**Postgres (hot, last 90d):**

| Table | Rows / day | Avg row | 90d size | Index overhead |
| --- | --- | --- | --- | --- |
| `messages` | 8M | 1.2 KB | ~870 GB | ~30% |
| `read_receipts` | 30M | 60 B | ~165 GB | ~50% |
| `ai_runs` | 300K | 800 B | ~21 GB | |
| `ai_run_steps` | 1.5M | 600 B | ~80 GB | |
| `audit_log` | ~500K | 400 B | ~10 GB | high index |

Total hot Postgres ≈ 2–4 TB at 1M users + indexes. Single-instance ceiling is `db.r6g.16xlarge` ≈ 8 TB practical. Plan for **logical sharding by workspaceId hash → 4 shards** before crossing 5 TB. Anchor: Microsoft AutoML metadata store evolved through the same growth - split before forced (A-MS3).

**Cold tier (Parquet on S3):** rolled-off `messages` after 90d → `s3://qale/cold/ws=.../year=.../month=.../`. Estimated ~30–60 TB / yr at 1M users. Queried via Athena/Trino for compliance pulls and search re-index.

**Object store (attachments):** ~500 GB/day = ~180 TB/year. Lifecycle: hot (Standard) 30d → IA 90d → Glacier-IR 1y → Deep Archive after 1y unless still referenced. Cross-region replication for enterprise tier only (cost gate).

**Vector store (Qdrant):**
- 8M messages/day × ~3 chunks/message × 768-dim float = ~7 GB/day raw.
- 90d hot in HNSW = ~600 GB. Memory-served indexes need ~3 nodes with 256 GB RAM at this scale.
- Re-embedding on edit = ~5% of writes; budget for it in the embedding worker pool.

**Search (OpenSearch):**
- One alias per workspace (large customers) or shared index per shard (small).
- Rollover at 50 GB or 30d, whichever first.
- Estimate at 1M users: ~5–8 nodes, hot/warm tiered.

**ClickHouse (telemetry + analytics):**
- 50–80M spans/day at ~1 KB raw → ~70 GB/day, ~7 GB compressed.
- 30d hot, 90d aggregated, 1y rolled-up. ~5 ClickHouse nodes. Anchor BlackBox 50M spans/day (A-BB5).

## 6. AI plane capacity and cost model

This is the line item that dominates infra spend at scale and where my BlackBox model router experience (A-BB4) directly transfers.

**Token math:**

| Component | Tokens / run avg | Model class | $/1M tokens (mixed assumption) | Monthly cost (300K runs/day) |
| --- | --- | --- | --- | --- |
| Cheap model (router default, 80% of calls) | 1,200 | small | $0.60 in / $1.80 out | ~$5,400/mo |
| Mid model (15%) | 2,500 | mid | $3 in / $15 out | ~$10,000/mo |
| Big model (5%, hard prompts) | 4,000 | large | $15 in / $60 out | ~$22,000/mo |
| **Total AI provider spend** | | | | **~$37K/mo** at Public Launch projection |

At 1M users: ~3–5x → **$110K–$180K/mo** AI provider envelope.

**Levers (all proven at BlackBox A-BB4):**
1. **Capability-aware routing** - saves 40–60% vs always-large. Route by required context length, tool support, structured-output need, latency budget.
2. **Prompt caching** - cache system prompts and large repeated context (provider-side prompt cache where supported). Saves 30–50% input tokens on repeat-context flows.
3. **Context summarization** - summarize old messages instead of including verbatim; 90d of thread history in 200 tokens of summary.
4. **Per-workspace token budget with hard cap** - denial before the call leaves the queue. Stops the "runaway agent burned $5K overnight" failure mode.
5. **Embedding cache** - never re-embed unchanged content.
6. **Speculative cancellation** - if user navigates away, cancel in-flight run.

**Anchor:** at BlackBox the router served 1B+ tokens/month with capability-aware routing - same playbook applies here, just with messaging-shaped workloads instead of agentic-coding ones (A-BB4).

## 7. Backpressure and degradation ladder

When the system is hot, we degrade in a stable order rather than collapsing:

| Tier | Action | Affects |
| --- | --- | --- |
| 1 | Drop typing indicators (P3 events) | Cosmetic only |
| 2 | Coalesce presence updates (5s window) | Slight presence lag |
| 3 | Defer read-receipt write to async | UI shows local checkmark, server eventually syncs |
| 4 | Route AI runs to small model only | AI quality degraded, still usable |
| 5 | Queue AI runs with surfaced ETA | User sees "queued, ~2 min" |
| 6 | Throttle non-priority workspaces | Free-tier slows down before paid |
| 7 | 503 + Retry-After on new connections | Existing sessions preserved |
| 8 | Read-only mode | Last resort |

Anchor: ShareChat ads (A-SC2) had a similar shed ladder for RTB - the SLA there was even tighter (sub-100ms) and the principle of "shed cosmetic before functional" came from that environment.

## 8. Top 8 bottlenecks

| # | Bottleneck | Detection | Mitigation |
| --: | --- | --- | --- |
| 1 | Hot fanout for noisy workspaces | Kafka partition lag, gateway-pod CPU spike | Per-thread Redis Stream; cap subscribers per gateway pod |
| 2 | AI provider rate limits / outage | Provider-class circuit breaker tripping | Multi-provider router + small-model fallback |
| 3 | Kafka rebalance during deploy | Consumer lag spike | Cooperative-sticky assignor; staggered rolling deploy |
| 4 | Postgres write amplification on read receipts | High WAL volume | Batch receipts in Redis, flush async |
| 5 | WS reconnection storm | Connect-rate spike post-incident | Server-side connect-budget; jittered client backoff |
| 6 | Vector re-embed cost | Qdrant write QPS, embedder pool queue | Batch embed; incremental dirty-list |
| 7 | Presence churn on mobile networks | Presence event QPS > expected | Client-side coalescing; longer heartbeat on mobile |
| 8 | Telemetry pipeline lag | Span buffer in OTel collector growing | Tail-based sampling kicks in; drop low-value spans first |

## 9. Sharding and growth path

| Milestone | Topology | Trigger |
| --- | --- | --- |
| Alpha (<10K) | Single Postgres, single region | Start |
| Public Launch (~100K) | Postgres + read replicas, single region | Read load > 10K QPS |
| 250K | Logical sharding by `workspace_id hash` (4 shards) | Hot DB > 5 TB |
| 500K | Citus or Vitess; physical shards | Single primary CPU > 60% sustained |
| 1M | Multi-region read; primary still single region | Latency complaints from non-IN customers |
| 2M+ | Multi-region active-active for chosen tenants | Enterprise demand or DR posture |

Mark as **assumption** - exact triggers depend on workload mix; the principle (shard before forced, never during incident) is from Microsoft AutoML A-MS3.

## 10. Multi-region topology

**v1 (Alpha → Public Launch):** single primary region (Mumbai for Hyderabad team + Indian users; ap-south-1). CDN/edge global.

**v2 (Public Launch +6mo):** add a read region (US East) with async-replicated Postgres + read-only Qdrant + replicated S3. Writes still go to primary. Cross-region p99 visible for non-primary-region writes (acceptable: ~120ms vs 60ms in-region).

**v3 (toward 1M):** workspace-pinned region. New enterprise workspaces choose region at creation; pinning is sticky. Same data residency story we had to support at Microsoft for VNet workloads (A-MS2).

**Honest caveat:** active-active multi-master messaging across regions is hard (clock skew, ordering). I would not promise it at v3 - workspace-pinning gets you 95% of the value at 20% of the complexity.

## 11. Cost envelope at three milestones

Rough monthly $ (assumptions, AWS, ap-south-1 baseline). Real bill will surprise us; budget by line.

| Line | Alpha (10K MAU) | Public Launch (100K) | 1M users |
| --- | --: | --: | --: |
| EKS compute (gateways, services) | $3K | $15K | $80K |
| RDS Postgres + replicas | $2K | $10K | $50K |
| Redis (ElastiCache) | $1K | $4K | $20K |
| Kafka (MSK or self) | $2K | $8K | $35K |
| OpenSearch | $1K | $5K | $25K |
| Qdrant + embedder pool | $2K | $8K | $40K |
| ClickHouse (self-hosted) | $1K | $4K | $20K |
| S3 (storage + requests) | $0.5K | $4K | $35K |
| Egress | $1K | $5K | $25K |
| **AI provider spend** | $1K | $37K | $150K |
| Observability vendors (Sentry, etc.) | $0.5K | $3K | $12K |
| **Total** | **~$15K/mo** | **~$103K/mo** | **~$490K/mo** |

Anchor: cost-aware allocation discipline from Microsoft secure ML infra (A-MS2) - every line above has an owner who is asked monthly "why is this number what it is."

## 12. Load testing strategy

**Tooling:**
- **k6** for HTTP and WS API surface.
- Custom Go-based WS load generator that simulates 100K connections + chat patterns + AI run patterns. Scripted scenarios: steady-state, broadcast, reconnect storm, hot-thread spike.
- **AI shadow traffic** mode: replay last week's AI runs against the new release to spot quality / latency / token-count regressions.

**Cadence:**
- Pre-merge: smoke load test (5 min, 5K connections) on PR labeled `perf`.
- Weekly: full load test against staging at 50% of projected peak.
- Pre-release: full load test at 100% projected peak + chaos drill (kill a pod, partition Kafka, throttle AI provider).

**Chaos:** quarterly company-wide gameday. Same model I ran at Microsoft via 30+ architecture reviews + Scrum execution (A-MS5).

## 13. What "good" looks like by Public Launch

Concrete acceptance gates I would not launch without:

- 50,000 concurrent WS sessions sustained 30 min in load test, p99 message-send < 250ms.
- 25 RPS sustained AI runs streaming, p95 first-token < 1.5s, < 1% provider-fallback events.
- Burst absorption: 10x reconnect spike absorbed in < 60s without > 5xx > 1%.
- Successful regional read failover drill in < 5 min with zero data loss.
- AI cost per DAU under $0.05/mo at 100K users (the lever for the unit economics conversation with the founders).
- SOC-2 Type I attestation in hand (Type II observation period started).

If we miss two of these, we delay launch. That's the deal I would make with the founders at week 1.
