# 07 - Reliability, Observability, and Failures

How Qale stays up under real load, fails gracefully, and is debuggable when AI gets weird. Anchor codes from `00-question-and-context.md`.

## 1. Reliability targets

| Surface | Availability SLO | Error budget / month |
| --- | --- | --- |
| Message send + fanout | 99.95% | 21.6 min |
| Connection plane (WS connect) | 99.95% | 21.6 min |
| AI plane (streaming) | 99.5% | 3h 36m |
| Search | 99.5% | 3h 36m |
| Notifications (push, email) | 99.5% | 3h 36m |
| Admin / control plane | 99.9% | 43.2 min |

SLA published to enterprise customers is 1 nines below the SLO, with credit schedule. Error-budget policy: > 25% burn in 6h pages on-call; > 50% halts non-critical deploys; 100% burn = release freeze + post-mortem before next launch.

## 2. Failure taxonomy

| Class | Where | Blast radius | Detection | Mitigation | Recovery |
| --- | --- | --- | --- | --- | --- |
| Gateway pod crash | Connection plane | Connections on that pod | Pod restart count, conn drop spike | HPA replaces pod; clients auto-reconnect | < 5s |
| Kafka broker loss | Bus | Partition leader churn | Under-replicated partitions alert | RF=3, controller re-elects | < 30s |
| Postgres primary failover | Storage | Brief writes paused | RDS event, lag spike | Multi-AZ failover | < 60s |
| AI provider outage | AI plane | Affected route | Provider 5xx + circuit breaker | Failover to next provider in router | < 10s |
| AI provider degraded latency | AI plane | p95 spike | Latency SLO burn | Shift weight to other provider | < 60s |
| Vector store rebuild | Search/AI | Reduced semantic search quality | Index version skew | Read from prior index until rebuild | minutes |
| Bad migration | Storage | Possible data corruption | Canary failure | Auto-rollback, replay from WAL | < 15min |
| Cert expiry | Edge / mTLS | TLS errors | Cert-manager alert 30d/7d/1d before | Auto-renew via cert-manager | n/a |
| DNS glitch | Edge | Connect failures | External probe loss | Multi-resolver clients, short TTLs | minutes |
| Regional outage | Whole region | Tenants in that region | Health-check cascade | Read failover; write delay until restore | < 15min read, hours write |
| Runaway AI loop | AI plane | One workspace's budget | Budgeter trip | Budgeter cuts at policy ceiling; alert | seconds |
| Reconnect storm | Connection plane | All gateways | Connect-rate spike | Connect-budget + 503; jittered client backoff | < 60s |
| Telemetry pipeline lag | Observability | Delayed visibility | Buffer size alert | Tail-based sampling drops low-value first | < 5min |

## 3. Retry, dedup, idempotency

**Per call class:**

| Call class | Retry policy | Idempotency | Dedup window |
| --- | --- | --- | --- |
| Client → REST send | Client retries with `Idempotency-Key` UUID v7 | Server dedups (userId, key) | 24h |
| Client → WS send | clientMessageId; ack window | Server dedups per (sessionId, clientMessageId) | session lifetime + 60s grace |
| Service → Service (gRPC) | 3 retries, exp backoff + jitter, retry budget 10% | Required at every external boundary | Per-call request-id |
| Service → AI provider | 2 retries, then route fallback | request-id cached for 5 min | 5 min |
| Service → DB | 1 retry on transient | DB constraints + ON CONFLICT | n/a |
| Webhook out | Exp backoff up to 24h, capped 50 attempts | HMAC includes nonce | recipient enforces |

**Retry storm prevention:**
- Token-bucket retry budget per service (max 10% of inbound RPS spent on retries).
- Circuit breaker per upstream - open after 50% errors over 30s window, half-open after 30s.
- Exponential backoff with full jitter. Anchor BlackBox tool-call retry pattern (A-BB3).

## 4. Circuit breakers and bulkheads

- **Per-AI-provider** circuit breaker - when open, router shifts traffic to the next provider in the routing table. Decision is per-route-class, not global.
- **Per-tenant bulkhead** thread/connection pools so one workspace cannot starve another at the AI Orchestrator.
- **Hedged requests** for read-heavy critical paths (search): fire to two replicas after 100ms; first response wins. Costs ~10% extra read traffic for ~50% p99 reduction.

## 5. Connection plane resilience

**Graceful drain on deploy:**
1. Pod marked NotReady; ALB stops sending new connects.
2. Pod broadcasts `server.drain` to all sessions with a hint to reconnect in 0–5s.
3. Clients reconnect (jittered) to a fresh pod.
4. Pod waits up to 30s for socket close; force-closes after.

**Sticky reconnect with resume token:**
- On connect, server issues `resumeToken = (sessionId, lastSeenSeq, expiry, signature)`.
- On reconnect within window (5 min), client sends `resumeToken` + `lastSeenSeq`; server replays missed events from the per-thread monotonic sequence.
- If beyond window, client re-subscribes to threads and resyncs from cursors (cheap because per-thread sequences are monotonic).

Anchor: TunDRA at 1M+ Compute Instances under unreliable networks - same lessons about client-driven resume + server-side state minimization (A-MS1).

## 6. Message delivery semantics

- **At-least-once on the bus** between services.
- **Exactly-once at the client** through `clientMessageId` dedup at send and per-thread monotonic `seq` on receive.
- **Ordering:** strict per (`workspaceId`, `threadId`); no global ordering. Clients show messages in `seq` order.
- **Read-your-writes:** session-pinned read replica (sticky for 30s after a write) so the user sees their own send immediately even on read replicas.

## 7. AI plane reliability

**Fallback ladder (in order):**
1. Primary provider, requested model class.
2. Same provider, smaller model.
3. Secondary provider, equivalent model class.
4. Cached or templated response (for deterministic flows like greetings, summaries from cache).
5. Polite degradation message: "AI is briefly unavailable; your message is delivered."

**Durable resume:** every node in the DAG run is checkpointed (anchor A-BB3). If the executor pod dies mid-run, another pod picks up the run from the last checkpoint. Tool calls keyed by `(runId, nodeId, attempt)` - idempotent or have explicit compensation. This is the durable execution muscle from BlackBox.

**Tool-call safety:** for non-idempotent tools (send external email), retries require an explicit re-confirm; the saga is recorded in `ai_run_steps` with compensation hooks.

## 8. Observability stack

```
Service (OTel SDK)
  → OpenTelemetry Collector (sidecar / DaemonSet)
    → Kafka (topic: telemetry.spans)
      → ClickHouse ingest worker
        → ClickHouse (hot 30d, rollup 90d)

Metrics
  → Prometheus (in-cluster) + remote-write to Mimir/Cortex
    → Grafana dashboards

Logs
  → Vector (DaemonSet) → S3 + Loki (queryable)

Client
  → Sentry (JS errors, perf), RUM beacon → ClickHouse
```

Anchor: same shape as the BlackBox telemetry mesh that ingested 50M spans/day and managed 2.5TB+ monthly trace data (A-BB5). The point of building it in-house instead of buying Datadog: at 1M users the vendor bill becomes a six-figure monthly line and we lose the freedom to do deterministic replay our way.

## 9. What we trace

| Span type | Required attributes | Retention |
| --- | --- | --- |
| HTTP | route, method, status, latency, userId(hash), workspaceId | 30d hot |
| WS message | type, sessionId(hash), workspaceId, threadId, latency | 14d |
| DB query | statement-template, table, latency, rows | 14d |
| Kafka publish/consume | topic, partition, key-hash, latency, lag | 14d |
| Tool call (AI) | runId, nodeId, tool, args-hash, result-hash, latency, gate-outcome | 90d |
| **LLM span** | `prompt_hash, model, route_reason, latency, input_tokens, output_tokens, tool_calls[], retrieval_doc_ids[], safety_class, error_class, traceId, ws_id` | 90d |

LLM spans are the workhorse of debugging AI. They make deterministic replay possible. Anchor A-BB5.

## 10. Sampling strategy

| Span class | Sampling |
| --- | --- |
| Routine HTTP / WS event | Head-based 5% |
| DB / Kafka span | Head-based 10% |
| Errors | 100% (always) |
| LLM run spans | 100% (low volume, high value - anchor A-BB5) |
| Tool calls inside LLM run | 100% |
| Slow events (latency > p99 thresh) | 100% (tail-based) |

The point: never lose a rare-but-important AI failure to head-based sampling. BlackBox taught me this - we lost an entire weekend of debugging once because the worst tool-call traces were the ones we'd sampled away.

## 11. Dashboards and alerts

**Per-service "golden signals" dashboard:** rate, errors, duration, saturation. Standard. Templated; new services inherit.

**Per-surface SLO dashboards:** burn rate (multi-window: 1h, 6h, 24h, 30d), error budget remaining, top-3 errors.

**AI plane dashboards:**
- Token spend per workspace (top 20).
- Route distribution (which model fraction of traffic).
- Fallback rate per provider.
- Safety-event rate.
- Tool-call distribution + failure rate.
- p95 first-token, p95 complete.

**Alert routing:** PagerDuty primary; secondary auto-engaged if primary doesn't ack in 10 min. Slack `#alerts-eng` mirror. Sev-thresholded.

## 12. Logs and audit

- **Structured JSON** logs with `traceId, spanId, ws_id, user_id_hash`.
- 30-day hot in Loki / S3+Athena, 1-year cold in S3 with lifecycle.
- **Audit log** is separate, append-only Postgres table replicated to S3 immutable bucket (Object Lock enabled). Required for SOC-2 evidence (anchor A-BB1).
- Log redaction at the SDK level: never log full message body, never log full prompt, never log secrets. Specific allowlist of safe-to-log fields.

## 13. Deterministic replay

The single most-bang-for-buck investment for AI debugging. Anchor: at BlackBox, replay was the lever that cut MTTR by 60% (A-BB5). Same lever here.

**Mechanism:**
- Every AI run captures: full prompt sent, model + version, deterministic seed where supported, tool-call args, tool-call results, retrieval doc IDs and content hashes, provider response (cached for 7d).
- Replay tool: `qale ai replay <runId>` - re-runs the DAG against captured inputs. If the model is deterministic in seed, the output matches; if not, you can A/B against the original to spot drift.
- For end-to-end: `qale event replay <eventId>` re-publishes a captured event to a sandbox env to reproduce a downstream failure.

**Cost:** prompt+response cache adds ~500 GB/mo at 1M users (a few hundred dollars). Worth it for a 60% MTTR cut.

## 14. Chaos and gameday

**Routine experiments (chaos-mesh / litmus):**
- Kill random gateway pod every 6h in staging.
- Inject 200ms latency on AI provider 1 for 10 min weekly.
- Drop 10% packets on a random AZ for 5 min weekly.
- Expire all access tokens at once and watch the rebind path.

**Quarterly gameday:** scripted scenario, full team, IC rotation. Past examples (from Microsoft cadence - A-MS5):
- "Region ap-south-1 is gone" - read failover, comms flow.
- "Provider X has banned us at 10am" - router fallback, customer comms.
- "Cross-tenant leak found" - security IR flow, evidence preservation.

## 15. Top 10 incident runbooks

Each is a 1-page runbook (linked from PagerDuty alert) with: signals, diagnosis steps, mitigation commands, escalation, comms template.

| # | Runbook | Trigger |
| --: | --- | --- |
| 1 | Gateway pod CrashLoop | Pod restart count > 3 in 5min |
| 2 | Kafka under-replicated partitions | Alert from MSK |
| 3 | AI provider 5xx burst | Circuit breaker open > 60s |
| 4 | Postgres replica lag | Lag > 30s |
| 5 | Cert expiry imminent (< 7d) | Cert-manager alert |
| 6 | Workspace rate-limit cliff | Workspace WS-conn > policy |
| 7 | Runaway AI run | Token budgeter trip + same workspace > 5x in 1h |
| 8 | DSR delete in flight | Compliance ticket opened |
| 9 | Data-deletion verification mismatch | Reconciler job alert |
| 10 | Vector index drift | Outbox lag > 10min |

## 16. Post-mortem culture

**Template:** summary, timeline, root causes (multiple - never just one), impact, what went well, what went poorly, action items with owner + due date.

**Cadence:** Sev1 in 3 business days, Sev2 in 5, Sev3 reviewed in weekly ops review.

**Blameless rule:** post-mortems describe systems and decisions, never people. The person who pushed the bad change is the same person who has the most context to explain it - make it safe to write.

**Action item enforcement:** every PM action item lands in Jira with owner + due date; weekly review. Stale > 30d escalates to me.

Anchor: this is the same operational rhythm that produced the BlackBox 60% MTTR reduction (A-BB5) and the Microsoft architecture-review cadence (A-MS5). Reliability is process, not heroics.
