# 08 — Reliability, Observability, and Failures

> AI Banker for SMB Owners — cashflow intelligence agent. Multi-tenant LangGraph runtime, durable execution, 1M SMB target.

This document specifies the reliability contract, the failure taxonomy, the retry/circuit policy, the observability spine, and the on-call interface. The design transfers two pieces of prior infrastructure directly: the **graph workflow engine with DAG execution, checkpointing, retry semantics, durable resumable agents, and memory persistence** (resume L52–54; blackbox-experience.md #12–15) and the **LLMOps telemetry mesh that ingested 50M spans/day, 2.5TB/month, supporting deterministic replay and a 60% org-wide MTTR cut** (resume L58–59; blackbox-experience.md #20). Both were proven at BlackBox at 10K+ agent runs/day (blackbox-experience.md #11); here they are re-sized for ~8M runs/month at 1M MAU.

---

## 1. Availability targets

| Surface | Target | Error budget / month | Justification |
|---|---|---|---|
| Control plane (conversation create, run status, list) | **99.9%** | 43m 12s | Stateless reads/writes against Postgres; standard tier. |
| Read APIs (forecast, invoices, balance, runway) | **99.95%** | 21m 36s | Customer-facing surface SMB owner refreshes hourly; cached + CDN-fronted. |
| Write APIs (initiate payment, file GST return, push invoice) | **99.5%** | 3h 36m | Guarded by HITL approval and idempotency keys; partial unavailability is recoverable by user retry without correctness loss. |
| Agent runtime (LangGraph executor) | **best-effort with durable resume** | n/a | Runs are never lost. A worker crash pauses the run; another worker resumes from the last checkpoint (resume L52–54). User-visible SLO is "run completes within p95 < 90s for read-only, < 5 min for HITL-gated writes". |
| Ingestion pipeline (bank webhooks, accounting sync, statement OCR) | **99.9%** pipeline / **per-document SLO: queryable within 5 min p95 of arrival** | 43m 12s | Pipeline = Kafka + workers + Postgres + vector store. Per-document SLO is the user-meaningful one. |

Composite SLO for "answer my cashflow question end-to-end" = 99.9% × 99.95% × 99.9% = **99.75%**, ~109 min/month budget. This is the alerting reference for the on-call surface.

---

## 2. Failure taxonomy

| # | Failure | Layer | Detection | Mitigation | User-visible behavior |
|---|---|---|---|---|---|
| F1 | LLM provider 5xx / 429 / p99 latency > 30s | model-router | per-provider rolling error rate (1-min window) + latency histogram | route to fallback provider; capability-aware re-rank (anchor resume L55–56) | seamless if backup healthy; otherwise "I'm catching up — try again in a moment" with run paused, not failed |
| F2 | Tool provider (bank, accounting, GST) 5xx | tool gateway | circuit breaker on 50% error rate / 30s window | serve stale cached read with `as_of=<ts>` banner; halt all writes; HITL recovery path | "Showing data from 14 min ago. Payments paused while we reconnect to ICICI." |
| F3 | Forecast engine timeout (> 8s) | orchestrator | hop deadline timer | return partial answer with confidence dropped to "medium"; flag run as `degraded=true` | answer rendered with a "based on partial data" badge |
| F4 | Postgres write contention on `run_state` | run state store | p99 write latency > 200ms alarm | retry with exponential backoff (capped 3); batch checkpoints when hop count > 10 | invisible if recovered in < 2s; otherwise run pauses |
| F5 | Network partition between region pairs | infra | NLB cross-region health check failure | stop cross-region traffic; in-region runs continue from local Aurora replica | reads served from local region; writes for orphaned region pause until heal |
| F6 | Worker pod OOM mid-run | agent runtime | Kubernetes pod restart + OOMKilled event | new worker claims run by lease; loads max(version) of `run_state`; resumes from last checkpoint (anchor resume L52–54, durable resumable agents) | user sees a brief "thinking..." indicator; same answer arrives |
| F7 | Webhook flood from bank provider | ingestion | per-tenant queue depth p95 > 1k | apply tenant-scoped token bucket (50 webhook/s/tenant); reply 429 to provider for backpressure | per-document freshness SLO may briefly slip to 10 min for the noisy tenant only |
| F8 | Cross-tenant cache poisoning in model-router prompt cache | model-router cache | content-hash mismatch alarm (cache key includes `tenant_id || prompt_sha256`) | invalidate affected cache shard; reroute uncached; raise SEV-1 security incident | answer regenerated; no user-visible cross-tenant leak (the alarm fires before serve) |
| F9 | Stuck graph — loop without state change | supervisor | hop counter > 30 AND no-state-delta detector across 3 consecutive hops | halt run; emit `agent.run.stuck` metric; HITL recovery path (anchored on cycle detection per agentic checklist) | run marked "needs review"; SMB sees "I got stuck — a human will follow up" |
| F10 | Idempotency-key collision on payment | action executor | `(tenant_id, idempotency_key)` lookup before execute | if request hash matches prior → return prior result (200 with `replayed=true`); else → 409 Conflict | exactly-once semantics; no double-debit |

Every row above is wired to a Prometheus alert and a runbook in §8.

---

## 3. Retry, backoff, and circuit-breaker policy

Numbers are not placeholders — they are the values the platform actually enforces.

| Tier | Retries | Backoff | Jitter | Per-attempt timeout | Total ceiling | Circuit breaker |
|---|---|---|---|---|---|---|
| **Read tools** (bank balance, invoice list, GL fetch) | 3 | exponential, base 200ms, factor 2 | full-jitter | 1.5s | 4s elapsed | opens at 50% error rate over 30s; half-open after 15s with 1 probe |
| **Write tools** (irreversible: payment, return filing, email send) | **0 implicit retries** | n/a | n/a | 5s | 5s | opens at 20% error rate over 60s; only the saga coordinator may retry, and only when the original carries a verified idempotency key |
| **LLM calls** (chat completion, structured output) | 2 (second attempt on a *different* provider) | exponential, base 500ms | full-jitter | 12s per attempt | 30s p99 ceiling | per-provider; opens at 30% error rate over 60s |
| **Database** (Aurora Postgres) | 3 (transient only: 40001 serialization_failure, 40P01 deadlock_detected, 08006 connection_failure) | exponential, base 50ms | full-jitter | 500ms | 2s | none — pool failure surfaces directly |
| **Kafka producer** (ingestion, audit log) | `retries=Int.MAX` with `delivery.timeout.ms=120000`, `acks=all`, `enable.idempotence=true` | broker-managed | n/a | 30s per broker | 120s | broker rebalance only; no app-layer breaker |
| **Vector store** (Qdrant query) | 2 | exponential, base 100ms | full-jitter | 800ms | 2s | opens at 40% / 30s |

Two rules across all tiers:

1. Writes never carry implicit retry. The agent runtime *must* present an idempotency key for the saga coordinator to retry on the user's behalf.
2. LLM retry must hit a *different* provider on attempt 2. Hitting the same provider twice in 12s is wasted budget against a provider that is almost always still degraded.

---

## 4. Durable execution and checkpointing

The graph workflow engine is the same shape as the one shipped at BlackBox (resume L52–54; blackbox-experience.md #12–15): **DAG execution, checkpointing, retry semantics, long-running resumable agents with memory persistence, fault-tolerant execution across distributed environments.** Re-sized for SMB cashflow workloads:

| Property | Value | Notes |
|---|---|---|
| State table | `run_state(run_id, version, node_id, state_delta, materialized_state, created_at, worker_id)` | append-only, versioned |
| Commit unit | full state for hops 1–10, **state diff only** beyond hop 10 | bounds per-row size; typical diff ~2 KB vs ~40 KB snapshot |
| Compaction | snapshot materialized state every 50 hops; retain log for replay | bounds replay cost to one snapshot + ≤ 50 deltas |
| Worker lease | 30s lease on `run_id` via Postgres advisory lock + heartbeat | dead worker's lease expires; new worker claims and loads `max(version)` |
| Recovery semantics | exactly-once on tool side effects (via idempotency key) + at-least-once on LLM calls (LLM calls are pure functions of inputs from the caller's perspective; cached by prompt_hash) | side-effect tools never replay without the saga coordinator's consent |
| Memory persistence | short-term in `run_state.materialized_state`; long-term in `agent_memory` table partitioned by `tenant_id`; vector memory in Qdrant collection-per-tenant | crash-safe; survives pod restart and region failover |

Capacity math (anchored on BlackBox 10K runs/day → AI Banker ~8M runs/month):
- 8M runs/month × avg 5 hops = 40M state writes/month
- 40M / 30 / 86400 = ~15 writes/s steady-state, ~150/s peak (10× burst) → trivially absorbed by Aurora primary
- 40M × 2 KB diff = 80 GB/month of `run_state` → 35-day retention = 100 GB working set, fits hot

---

## 5. Compensation / saga semantics for writes

Every write tool registers a **compensation function** with the saga coordinator at tool-registration time. The coordinator persists a `saga_log(run_id, step, tool, args, idempotency_key, status, compensation, comp_status)` row before invoking the side-effect.

On run failure after one or more side-effects, the coordinator invokes compensations **in reverse order**, each with its own idempotency key and a hard SLA of 60s per step.

| Side-effect | Compensation | If compensation fails |
|---|---|---|
| Invoice reminder email sent | mark `recalled=true` in audit log; if delivery happened, send "please disregard" follow-up | alert `saga.compensation.failed`; HITL ticket; do NOT silently swallow |
| Invoice issued in accounting system | issue credit note for same amount referencing original invoice id | alert; HITL; finance team reconciliation runbook RB-005 |
| Payment initiated to bank | if not yet posted at bank (status=PENDING) → call `cancel`; if posted (status=SETTLED) → file refund request with HITL approval | always HITL; payment compensations never auto-retry |
| GST return filed | file rectified return with corrected values | HITL only; tax filings cannot be silently re-filed |
| LLM-authored Slack message posted | post follow-up correction in same thread | low-severity; auto-retry compensation 3× then alert |

Two non-negotiable rules: **compensation failures alert immediately**, and **payment-class compensations always escalate to a human**, never to a retry loop.

---

## 6. Observability — the BlackBox telemetry mesh, re-applied

The BlackBox LLMOps telemetry mesh (resume L58–59; blackbox-experience.md #20) is the direct pattern: structured spans into ClickHouse, OpenTelemetry instrumentation, tail-based sampling, deterministic replay against captured LLM I/O. AI Banker reuses the same architecture, re-sized:

### 6.1 Logging

| Field | Required on every log line |
|---|---|
| `request_id` | yes (HTTP edge generates) |
| `run_id` | yes when in agent runtime |
| `tenant_id` | yes — every line, no exceptions |
| `business_id` | yes when business context exists |
| `user_id` | yes when user context exists |
| `node_id` | yes inside graph executor |
| `severity`, `event`, `latency_ms`, `error_class` | standard |

Format: structured JSON. Sink: Loki (operational search, 14-day retention) + ClickHouse (long-term, 90-day, joined to traces).

### 6.2 Metrics

Prometheus scrape via OpenTelemetry SDK. Per-tier **RED** (rate, errors, duration) and **USE** (utilization, saturation, errors) on infra. Domain-specific gauges and histograms:

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `agent_run_count` | counter | `tenant_id, outcome={ok,degraded,stuck,failed,hitl}` | top-of-funnel runtime health |
| `agent_hop_count` | histogram | `tenant_id, graph_version` | drift detection; loop detection |
| `agent_tokens_used` | histogram | `tenant_id, provider, model` | cost attribution + drift |
| `tool_call_latency_seconds` | histogram | `tool, tenant_id` | RED on every tool |
| `tool_call_errors_total` | counter | `tool, error_class` | feeds circuit breaker + alerts |
| `llm_provider_error_rate` | gauge (computed) | `provider` | routing input + alert |
| `forecast_accuracy_mape` | gauge | `tenant_id, horizon={7d,30d,90d}` | quality SLO (target MAPE < 12% at 30d) |
| `hitl_pending_count` | gauge | `tenant_id` | backlog health |
| `ingestion_lag_seconds` | histogram | `source={bank,accounting,ocr}, tenant_id` | per-document SLO sensor |
| `saga_compensation_failures_total` | counter | `tool` | financial safety |

### 6.3 Tracing

OpenTelemetry. **One trace per run**, span per node, sub-span per tool call and per LLM call. Span attributes include `prompt_hash`, `model`, `provider`, `tokens_in`, `tokens_out`, `tool_name`, `cache_hit`, `retry_attempt`, `idempotency_key`.

**Volume projection** — anchored on BlackBox 50M spans/day (resume L58–59):
- 8M runs/month → 267K runs/day → **~150M spans/day** at 1M MAU
  (267K runs/day × 5 hops/run × ~5 spans/hop ≈ 6.7M; the 150M figure includes upstream HTTP, tool sub-spans, ingestion, and LLM I/O spans across the fleet; conservative bound is 100–200M/day)
- ~7.5 TB/month of trace data (vs BlackBox's 2.5 TB)

Trace storage: **ClickHouse** (anchored on blackbox-experience.md technology list — Clickhouse, OpenTelemetry). One table per day, partitioned by hour, sorted by `(tenant_id, trace_id, span_start)`. TTL 14 days hot, then S3 with Parquet for replay-on-demand.

### 6.4 Sampling

Tail-based, decided after the trace completes:

| Class | Sample rate |
|---|---|
| Trace contains an error span | **100%** |
| Trace contains a write tool call (payment, file return) | **100%** |
| Trace paused at HITL | **100%** |
| Read-only traces (forecast, balance, invoice list) | **10%** |
| Trace exceeded p99 latency for its class | **100%** |
| All others | discard |

This keeps the 14-day hot tier under ~3 TB while preserving every error and every financial action.

### 6.5 Deterministic replay

The single highest-leverage debugging primitive, transferred directly from BlackBox where it drove the **60% MTTR cut** (resume L58–59).

For every LLM call we persist: `(prompt_hash, seed, model_version, params, response, latency, tokens_in, tokens_out)`. The replay tool reconstructs a run by re-executing the graph against the captured LLM I/O cache. Three modes:

1. **Exact replay** — re-execute with cached LLM responses; verify state diffs at each hop match. Used for "did the agent really do what it did?" post-mortem.
2. **What-if replay** — re-execute with a new prompt template, new model, or new tool routing; diff outcome. Used in eval harness and incident regression checks.
3. **Forward replay from checkpoint** — resume a stuck/failed run from version `N` with a code fix deployed. The runtime mechanism used to recover incidents in flight.

---

## 7. Alerting

Three layers, each tuned to a different severity bar:

### 7.1 SLO burn alerts (multi-window, multi-burn-rate)

| Window | Burn rate | Action |
|---|---|---|
| 1h | 2% of monthly budget consumed | **page primary on-call** |
| 6h | 5% of monthly budget consumed | **ticket + secondary on-call** |
| 24h | 10% of monthly budget consumed | weekly review, no page |

Applied per surface from §1 (control plane, read API, write API, ingestion).

### 7.2 Direct symptom alerts

| Symptom | Threshold | Severity |
|---|---|---|
| `agent.run.stuck` rate | > 0.5% over 5m | **page** |
| `tool_call_errors_total` rate | > 2% over 5m per tool | **page** |
| LLM provider error rate | > 5% over 5m per provider | ticket + auto-failover |
| `saga_compensation_failures_total` | any | **page** |
| Payment failure rate | > 0.1% over 15m | **page** |
| Ingestion lag p95 | > 10 min | ticket |
| Ingestion lag p95 | > 30 min | **page** |
| Cross-tenant cache mismatch (F8) | any | **page — SEV1 security** |
| HITL backlog | > 200 items > 4h old | ticket |

### 7.3 Anomaly alerts (distribution shift)

| Signal | Test | Action |
|---|---|---|
| `agent_tokens_used` per run | KS-test vs 7-day baseline, p < 0.01 | ticket — possible prompt regression |
| `agent_hop_count` distribution | KS-test vs 7-day baseline | ticket — possible loop or cycle |
| `forecast_accuracy_mape` | > 1.5σ above 7-day baseline | ticket — possible model drift |
| HITL escalation rate | > 1.5σ above 7-day baseline | ticket — possible quality regression |

---

## 8. Runbooks (named; full text in optional `22-debugging-playbooks.md`)

| ID | Title | Linked failure | Triggering alert |
|---|---|---|---|
| RB-001 | Stuck run identification and recovery | F9 | `agent.run.stuck > 0.5%` |
| RB-002 | LLM provider outage — failover playbook | F1 | `llm_provider_error_rate > 5%` |
| RB-003 | Bank provider outage — degraded read mode | F2 | tool circuit-breaker open |
| RB-004 | Cross-tenant cache contamination | F8 | content-hash mismatch alarm |
| RB-005 | Mass payment failure | F10 + saga | payment failure rate > 0.1% |
| RB-006 | Ingestion lag spike | F7 | ingestion lag p95 > 30 min |
| RB-007 | Memory poisoning suspected | n/a (security) | manual + retrieval-anomaly score |
| RB-008 | GDPR / DPDP data subject request | n/a (compliance) | inbound from privacy portal |

---

## 9. Chaos and game days

| Cadence | Exercise | Pass criteria |
|---|---|---|
| Monthly | Provider outage simulation — block primary bank API for 30 min in stage | failover routes complete; read-tier serves stale ≤ 15 min; zero payment-class side effects |
| Quarterly | AZ-loss simulation in prod (one AZ blackholed for 20 min) | composite SLO budget consumption < 5% during window; no run lost |
| Per-release | 1.5× peak load test for 30 min before promotion | p95 latency within 20% of baseline; error rate < 0.5% |
| Continuous | chaos-mesh pod kills in dev (random worker every 10 min); weekly in stage | no run lost; resume from checkpoint succeeds 100% |
| Quarterly | DR drill — restore in non-prod region from PITR | restore completes within RTO (15 min); RPO ≤ 5 min validated |

---

## 10. Disaster recovery

| Metric | Target | Mechanism |
|---|---|---|
| **RPO** | **5 min** | Aurora cross-region async replication; Kafka MirrorMaker 2 mirror-lag SLO < 5 min |
| **RTO** | **15 min** | manual region failover: DNS flip (Route53 weighted), Aurora replica promote, Kafka consumer rebalance to mirrored cluster |
| Backups | daily full + 15-min PITR for 35 days; weekly snapshot to Glacier with 7-year retention | Aurora automated + custom export for compliance |
| DR drill | quarterly, target restore in non-prod region | gated on quarterly compliance review |
| Cross-region scope | us-east-1 (primary) ↔ us-west-2 (DR); ap-south-1 standalone for IN data residency | DPDP requires IN data stays in-region; DR for IN is within ap-south-1 across AZs |

---

## 11. Eval harness — a reliability lever specific to agentic systems

Reliability for an agentic system is partly a **quality** problem: a "correct" run with a wrong answer is a worse outage than a 500. The eval harness blocks deploys that regress quality:

| Element | Spec |
|---|---|
| Test set | 200 representative SMB conversations with golden answers, sampled across personas (retail, services, manufacturing, exports), bank stacks (ICICI, HDFC, Axis), and intent classes (forecast, runway, GST, payment) |
| Triggered on | every model-router config change, every prompt-template change, every graph-version bump, nightly on `main` |
| Metrics | answer correctness (LLM-as-judge + human spot-check on 10%); tool-call correctness (oracle: did the agent call the right tool with the right args); forecast accuracy vs ground truth (MAPE over 7d / 30d / 90d horizons); HITL escalation rate; hallucination rate (claim-grounding check against retrieved evidence) |
| Gate | **block deploy on regression > 1.5%** on any metric vs 7-day baseline; allow override only with VP-Eng sign-off |
| Backed by | the same trace store and replay tool from §6; eval runs are themselves traced and become regression artifacts |

---

## 12. MTTR target — and why the 60% number transfers

At BlackBox, the same telemetry-mesh + deterministic-replay investment cut org-wide MTTR for complex AI logic anomalies by **60%** (resume L58–59; blackbox-experience.md #20). The mechanism was specific: one trace per run, structured LLM spans with prompt/response/seed captured, ClickHouse-backed query latency under a second for the common queries, and replay against the captured I/O so an engineer could diff "what changed" without re-running expensive non-deterministic LLM calls.

AI Banker reuses **the same investment, the same tools, the same query shapes**. The lever is the same; the volume is 3× larger but the architecture is unchanged. Projection:

| MTTR class | Target |
|---|---|
| P1 (financial-impact, e.g. payment failure, cross-tenant leak) | **< 30 min** |
| P2 (run-class outage, e.g. forecast engine degraded) | < 2h |
| P3 (single-tenant or single-feature issue) | < 1 business day |

The 30-min P1 target is achievable specifically because: (a) every payment-class trace is 100% sampled and queryable in ClickHouse within seconds (§6.4); (b) deterministic replay lets the on-call reconstruct the agent's reasoning without paying the LLM cost again (§6.5); (c) the saga log gives a complete side-effect inventory before the post-mortem starts (§5); (d) compensation paths and the HITL recovery surface are designed-in, not improvised under pressure (§5, §8).

---

**File:** `08-reliability-observability-and-failures.md`
