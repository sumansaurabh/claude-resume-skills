# 07 — Reliability, Observability, and Failures

## Failure Taxonomy

| Failure Class | Detection | Immediate Action | Recovery Path | User Impact |
|---|---|---|---|---|
| **Worker process crash** | Heartbeat miss; OS SIGCHLD | Mark worker FAILED; remove from pool | Restart worker; retry execution on new worker | Transparent retry; ~200ms delay |
| **WASM execution timeout** | context.WithTimeout fires | Runtime.Close() terminates WASM | Return TIMEOUT error to client; emit span | Client sees timeout event in SSE |
| **WASM memory exceeded** | Runtime enforces page limit; traps | Module instance faulted; Close() | Return MEMORY_EXCEEDED event | Client sees memory error |
| **WASM trap (unreachable, OOB)** | wazero returns trap error | Extract trap type; return error event | No retry (likely bad code); surface to LLM | LLM gets error text for re-generation |
| **Redis unavailable** | Connection error on rate limit check | Fail open (allow execution) with warning metric | Redis failover; rate limiter reconnects | Rate limiting temporarily disabled |
| **Pool saturation** | `warm_count == 0` for >5s | Return QUEUED event; queue in Redis | Autoscaler spawns workers; cold starts accepted | User sees "queued" status; latency spikes |
| **OTel collector unavailable** | Span emit fails | Log span to local buffer; retry batch | Collector recovers; buffer flushes | Audit log delayed; no execution impact |
| **API server crash** | Load balancer health check fails | Route traffic to other replicas | Kubernetes restarts pod; takes <30s | In-flight SSE connections dropped; client reconnects |
| **Clickhouse write failure** | OTel collector error | Span buffered in collector memory | Clickhouse recovers; collector flushes | Audit log delayed up to buffer TTL |

---

## Worker Crash Handling

Worker crash is the most operationally significant failure — it must be transparent to the user.

**Detection:**
- Each worker runs a goroutine that sends a heartbeat every 1s to the Pool Manager via a channel.
- If the heartbeat channel closes (goroutine exits, worker panics), the Pool Manager detects it within 1s.

**Recovery:**
1. Pool Manager marks the worker FAILED and removes it from the pool.
2. Any execution dispatched to the crashed worker that had not yet completed is retried automatically on a new worker.
3. The retry is transparent: the SSE stream for the client shows a brief pause (re-dispatch + re-execution), then continues.

**Retry safety:** WASM executions are idempotent (given the same code and stdin, same output — unless code reads a clock or uses randomness). For executions that use `random` or `datetime.now()`, a retry produces different output — but this is acceptable for the zero-shot use case. Users are not promised deterministic retry behavior.

**Goroutine panic recovery:**
```go
func (w *Worker) safeExecute(ctx context.Context, req *ExecutionRequest) (err error) {
    defer func() {
        if r := recover(); r != nil {
            err = fmt.Errorf("worker panic: %v\n%s", r, debug.Stack())
            w.metrics.IncrementPanics()
        }
    }()
    return w.Execute(ctx, req)
}
```

---

## Observability Stack

### OpenTelemetry Spans

Every execution emits one parent span with the full execution lifecycle:

```json
{
  "trace_id": "abc123",
  "span_name": "wasm.execute",
  "start_time": "2026-05-06T12:00:00.000Z",
  "end_time":   "2026-05-06T12:00:00.087Z",
  "duration_ms": 87,
  "status": "OK",
  "attributes": {
    "execution.id": "ex-uuid4",
    "execution.tenant_id": "t-abc",
    "execution.language": "python",
    "execution.exit_code": 0,
    "execution.memory_peak_mb": 12,
    "execution.stdout_bytes": 5,
    "execution.stderr_bytes": 5,
    "execution.timed_out": false,
    "execution.worker_id": "worker-07",
    "execution.was_cold_start": false,
    "execution.queue_wait_ms": 3,
    "execution.code_hash": "sha256:abc..."
  }
}
```

Child spans:
- `wasm.dispatch` — time from API receipt to worker dispatch
- `wasm.module_instantiate` — time to create a new module instance
- `wasm.run` — actual execution time inside WASM

### Key Metrics (Prometheus)

| Metric | Type | Labels | Alert threshold |
|---|---|---|---|
| `wasm_execution_duration_ms` | Histogram | language, exit_code, timed_out | p99 > 5000ms |
| `wasm_pool_warm_workers` | Gauge | language | warm < 10% of target |
| `wasm_pool_busy_workers` | Gauge | language | busy > 90% of total |
| `wasm_execution_rate` | Counter | language, tenant | — (for billing, not alerting) |
| `wasm_cold_start_rate` | Counter | language | > 5% of executions |
| `wasm_timeout_rate` | Counter | language | > 1% of executions |
| `wasm_worker_panics_total` | Counter | worker_id | Any panic in 5 min |
| `wasm_queue_depth` | Gauge | — | > 100 queued |
| `wasm_stream_subscribers` | Gauge | — | for capacity planning |

### Oncall Dashboard

Primary alert path: Prometheus → PagerDuty.

Dashboard sections:
1. **Execution rate** (req/s, 5min rolling)
2. **Latency** (p50/p95/p99 total, dispatch, execution separately)
3. **Pool state** (warm / busy / spawning per language)
4. **Error rates** (timeout / memory / trap / crash)
5. **Cold start rate** (% of executions requiring cold start)

---

## Debugging Runbook: High p99 Latency

When p99 execution latency spikes to >2s:

1. **Check warm pool depth.** `wasm_pool_warm_workers{language="python"}` near zero? Pool is drained → cold starts happening → 800ms+ latency.

2. **Check if traffic spiked.** `wasm_execution_rate` sudden increase? Pool hasn't autoscaled yet. Autoscaler should respond in <30s; if not, check Pool Watchdog goroutine health.

3. **Check worker crash rate.** `wasm_worker_panics_total` elevated? Workers crashing faster than respawning → pool draining. Investigate worker logs for panic type.

4. **Check for long-running executions blocking pool.** `wasm_pool_busy_workers` high but execution rate normal? Some executions are running near their timeout. Check `wasm_execution_duration_ms{quantile="0.99"}` by tenant — one tenant may be monopolizing workers with slow code.

5. **Check Redis health.** Rate limiter and queue use Redis. If Redis latency spikes, dispatch latency spikes. Check Redis `INFO latency` metrics.

6. **Check OS-level resource pressure.** High memory pressure → OOM killer → worker crashes. Check node memory utilization and `wasm_worker_panics_total`.

---

## SLOs

| SLO | Target | Measurement |
|---|---|---|
| Execution availability | 99.9% | (executions completed or failed with user-code error) / (total executions requested) |
| Execution start latency P99 | < 200ms | `wasm.dispatch` span duration |
| Total execution latency P99 | < 500ms (excluding execution time) | `wasm_execution_duration_ms` minus user code runtime |
| Cold start rate | < 2% of executions | `wasm_cold_start_rate / wasm_execution_rate` |
| Worker crash rate | < 0.01% of executions | `wasm_worker_panics_total / wasm_execution_rate` |
| Audit log delivery | < 60s to Clickhouse | OTel span delivery latency |

---

## SOC-2 Audit Evidence Generated

Every execution produces an immutable audit record in Clickhouse:

```sql
CREATE TABLE execution_audit (
    execution_id     String,
    tenant_id        String,
    language         String,
    exit_code        Int32,
    duration_ms      Int64,
    memory_peak_mb   Int32,
    timed_out        Bool,
    was_cold_start   Bool,
    worker_id        String,
    code_hash        String,      -- sha256(code); not the code itself
    stdout_bytes     Int64,
    stderr_bytes     Int64,
    error_code       String,
    created_at       DateTime,
    completed_at     DateTime,
    INDEX            (tenant_id, created_at)  -- for per-tenant audit queries
) ENGINE = MergeTree()
ORDER BY (created_at, tenant_id)
TTL created_at + INTERVAL 2 YEAR;  -- SOC-2 requires 1y retention; keep 2y
```

SOC-2 auditors can query:
- All executions by tenant in a date range
- All executions that timed out or raised errors
- Execution volume per tenant (for billing verification)
- Worker crash events

The `code_hash` field satisfies the "we know what ran" requirement without storing customer code long-term (which would create a data retention liability).
