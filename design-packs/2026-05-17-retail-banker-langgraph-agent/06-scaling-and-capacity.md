# 06 - Scaling and Capacity

## Steady-state load (from 02-design-estimates)

| Metric | Avg | Peak (3x) |
|---|---|---|
| Sessions | 4.5M/day | 13.5M/day |
| Turns | 25M/day ≈ 290/s | ~900/s |
| Tool calls | ~75M/day ≈ 870/s | ~2.6k/s |
| Core Banking reads | ~30M/day ≈ 350/s | ~1k/s |
| LLM calls | ~75M/day ≈ 870/s | ~2.6k/s |
| Trace storage | ~300 GB/day raw | ~900 GB/day raw |

Peak times: 1st of month (salary credit + EMI day), 25th (credit-card
billing cycle for major issuers), Friday evenings.

## Capacity model per node

| Node | CPU/Mem profile | Tokens/turn | Latency budget (p95) | Notes |
|---|---|---|---|---|
| `persona_router` | I/O bound, LLM | 400 in / 30 out | 150 ms | Haiku-class, KV cache hit on system prompt |
| `context_fetch` | I/O bound (network) | 0 | 250 ms | parallel fan-out, 4-6 downstream calls |
| `calculators` | CPU bound, pure | 0 | 30 ms | numpy / pure python |
| `risk_agent` | LLM + tools | 800 in / 200 out × ~2 iters | 1.2 s | Sonnet-class |
| `budget_agent` | LLM + tools | 1.2k in / 250 out × ~2 iters | 1.5 s | Sonnet-class |
| `savings_agent` | LLM + tools | 1.0k in / 200 out × 1-2 iters | 1.0 s | Sonnet-class |
| `reflection` | CPU, pure | 0 | 5 ms | comparator |
| `explainer` | LLM | 1.5k in / 400 out | 1.5 s | Sonnet (retail) / Opus (premium) |
| `action_gate` | CPU + OPA call | 0 | 20 ms | |
| `action_executor` | I/O | 0 | 200 ms | |
| `emit` | CPU | 0 | 10 ms | |

End-to-end conversational budget: ~3 s p95 (most paths skip a sub-agent).
Deep analysis budget: ~6-10 s p95 (router + fetch + calc + sub + reflect +
explain), within the 15 s NFR.

## Throughput plan

- **Runtime workers.** Stateless Python workers behind a load balancer.
  Each worker handles ~30 concurrent turns (bound by LLM concurrency, not
  CPU). 1k peak QPS / 30 = ~35 workers; provision 60 for headroom.
- **LangGraph checkpointer.** Postgres write per node transition = ~10
  writes per turn = 9k writes/s at peak. Sharded by `session_id` mod N
  (8 shards initial). Hot-shard mitigation: writes are append-only to a
  partitioned `checkpoints` table with hash partitioning.
- **Memory store.** Postgres + pgvector for `user_facts`. Read-heavy
  (every turn fetches facts). Hot user cache via Redis (TTL 60 s) keeps
  Postgres at <500 QPS even at peak.
- **Tool layer.** Each tool is async; the registry enforces per-tool
  timeout and per-user rate limits. Slow tools (Core Banking under
  pressure) trip a per-tool circuit breaker that returns a graceful
  `degraded` and lets `context_fetch` continue with partial data.
- **LLM layer.** Model router maintains a pool per provider; per-route
  semaphore caps in-flight calls; provider-side 429 triggers immediate
  failover to the next-best provider.

## Cost model

| Cost line | Logic | Daily ($) | Monthly ($) |
|---|---|---|---|
| Router LLM | 25M × 430 tok × $0.25/M | ~$2.7k | ~$80k |
| Sub-agent LLMs | ~10M turns × 3k tok × $3/M | ~$90k | ~$2.7M |
| Explainer LLM | 25M × 1.9k tok × $3/M | ~$143k | ~$4.3M |
| Compute (workers) | 60 × $5/day | $300 | $9k |
| Checkpoint store | ~300 GB writes/day, retain 30d | $200 | $6k |
| Trace store (ClickHouse + zstd ~10x) | ~30 GB/day net, 7y retention via tiering | $400 | $12k |
| Core Banking reads | bank-internal, ~0 incremental | - | - |
| **Total** | | **~$235k/day** | **~$7M/month** |

At 25M turns/day, blended cost per turn is ~$0.009 - roughly the cost of
a 2-second voice IVR menu, but with a *real* answer. This is the
load-bearing reason for tiered routing (Haiku for cheap paths) and
prompt caching; without them, the explainer LLM alone would be
~$10-15M/month.

### Cost levers (priority order)

1. **Prompt caching on system prompt + tool schemas** - ~40% reduction on
   sub-agent + explainer calls. Both Anthropic and OpenAI support 5-min
   TTL caching; we keep the system+tools block stable per route.
2. **Tiered routing.** Trivial intents (balance lookup, smalltalk) skip
   sub-agent entirely - calculator → explainer with Haiku-class.
3. **Context compaction.** Trim transactions to top-K relevant; never
   ship raw 90-day lists to the LLM.
4. **Result caching for idempotent queries.** "What is my balance" within
   60 s returns cached explainer output keyed by `(customer_id,
   intent, balance_version_hash)`.
5. **Batch eval / offline replay** uses cheap model for non-customer-facing
   regression checks.

## Bottlenecks and mitigations

| Bottleneck | Signal | Mitigation |
|---|---|---|
| Core Banking API throttling on 1st-of-month | spike in `tool.timeout`, `fetch_errors` | Pre-warm balance cache for top-decile users; request-coalesce identical reads in the worker |
| LLM provider rate-limit | 429 burst | Provider failover via router; preemptive load shedding (queue with bounded wait) |
| Checkpoint Postgres write contention | replication lag, p95 write > 50 ms | Hash-partition `checkpoints` by `session_id`; promote to a 2nd shard at 80% util |
| pgvector query latency for long-term memory | p95 > 100 ms | Move to Qdrant once `user_facts` > 50 M rows; same pattern we used at BlackBox |
| Trace ingestion firehose | OTel collector backlog | ClickHouse + Kafka buffer; same shape as BlackBox 50M spans/day (`resume.txt` L58-59) |
| HITL queue backlog | aging tickets | Tier by risk score; auto-escalate aged tickets to senior reviewer pool |
| Memory write storm during onboarding (every turn writes a fact) | pg connections saturated | Buffer + debounce fact writes per session; coalesce on session end |

## Quotas

Per-user budgets (defended at the gateway and the runtime):

| Quota | Limit | Why |
|---|---|---|
| Turns | 200/day per user | typical retail user is 10-30; abuse cap |
| LLM tokens | 100k/day per user | hard ceiling for runaway prompts |
| Tool calls | 500/day per user | derived from turns + iterations |
| Concurrent turns per session | 1 | sessions are conversational; concurrency = client bug |
| HITL action rate | 5/day per user | prevent flood of risky actions queued for humans |

Per-tenant (bank) quotas exist too (we are a multi-bank platform in this
design), so noisy-neighbor effects do not cross bank boundaries.

## Growth plan

| Stage | Trigger | Action |
|---|---|---|
| 1M MAU → 10M | sustained 70% worker util | Add 2nd region (active-active), shard checkpoint store ×2 |
| 10M → 50M | Core Banking read rate > 5k/s | Read-replica fanout; introduce read-through cache layer at API gateway |
| 50M → 200M | LLM cost dominates 80% of P&L | Move sub-agents to in-house fine-tuned model; keep explainer on frontier model |
| Multi-tenant (multi-bank) | first ISV bank lands | Per-bank cluster slice; per-bank policy bundle; cross-bank audit log isolation |

The MAU ladder above intentionally mirrors the AutoML scale arc - 15M+
jobs/month, 200K+ global users via AI Studio and SDK (`resume.txt`
L91-92) - because the operational lessons (quota, isolation, growth)
transferred from there.
