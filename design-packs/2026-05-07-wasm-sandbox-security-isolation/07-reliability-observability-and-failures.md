# 07 - Reliability, Observability, and Failures

> Resume anchor: *"50M+ spans/day telemetry mesh"* and *"1M+ daily zero-shot code executions."*

---

## Failure Taxonomy

| Failure Class | Detection Signal | Immediate Action | Error Returned to Client | Recovery Path | Orphan Risk |
|---|---|---|---|---|---|
| **Execution timeout** | `context.WithDeadline` fires; Go context cancelled | `module.Close(ctx)` interrupts WASM execution synchronously; worker goroutine unblocks | `EXECUTION_TIMEOUT` | Worker returns to pool; no instance reuse; new execution dispatched fresh | None - context cancel is synchronous; no goroutine leak |
| **OOM (memory bomb)** | cgroup `memory.events` fd listener detects `max` event; host reads fd in separate goroutine | Host process sends `SIGKILL` to itself via `runtime.Goexit()` on the worker goroutine *or* cgroup OOM killer fires SIGKILL from kernel | `OOM_KILLED` | Worker goroutine exits; pool manager detects heartbeat miss; spawns replacement worker | None - WASM linear memory is in worker goroutine; SIGKILL is clean |
| **CPU quota throttled** | cgroup `cpu.max` throttles worker's CPU time (does not kill) | cgroup throttling is passive - worker runs slower but does not die. Wasmtime fuel depletion is the *kill* mechanism; fuel fires first | `EXECUTION_TIMEOUT` (via fuel) | Fuel-based kill returns execution to pool normally; worker healthy | None - fuel kill is deterministic and fires before cgroup throttling becomes a problem at normal limits |
| **Sandbox escape attempt** | seccomp-bpf issues `SIGSYS` to worker process on blocked syscall | Go runtime's signal handler catches `SIGSYS`; execution is flagged as `security_event=true`; `module.Close()` called; worker removed from pool | `INTERNAL_SANDBOX_ERROR` (sanitized; no leak of attack detail to client) | SecurityEvent record written to Clickhouse; PagerDuty alert fires; worker node cordoned in Kubernetes; ops team investigates | Low - SIGSYS kills the offending thread; cgroup provides fallback SIGKILL |
| **WASM engine crash / panic** | `recover()` in Go defer catches panic from wazero internal | `defer` block catches panic; logs stack trace; marks worker unhealthy; closes module | `INTERNAL_SANDBOX_ERROR` | Pool manager detects worker unhealthy flag; removes from pool; spawns replacement; panicked instance never reused | None - defer/recover is synchronous; Go panic does not leak goroutines |
| **Worker node failure** | Kubernetes liveness probe fails; pod evicted or node NotReady | In-flight executions on that node fail (execution goroutine context cancelled by pod shutdown) | `INTERNAL_SANDBOX_ERROR` (client retries) | Client retries with same `idempotency_key`; new worker on a healthy node picks up execution; idempotency key prevents duplicate side effects | None - WASM executions are stateless; no side effects to undo |

---

## CPU Quota vs. Fuel: Why Fuel Wins

A common interview trap: "Won't cgroup `cpu.max` kill infinite loops?"

No. `cpu.max` *throttles* - it reduces the CPU time slice the process is allocated but does not send any signal. A tight loop will run indefinitely at reduced speed. Fuel is the correct kill mechanism:

```go
// At store creation time, not per-execution - set once
store := wasmtime.NewStore(engine)
store.AddFuel(5_000_000)  // 5M instructions ≈ ~50ms of Python compute at typical throughput

// At execution time - fuel is consumed by every WASM instruction
// When fuel hits zero, wasmtime traps with "all fuel consumed"
_, err := instance.Call("_start")
if wasmtime.IsTrap(err) && strings.Contains(err.Error(), "all fuel consumed") {
    return ExecutionResult{ExitCode: -1, ErrorCode: "EXECUTION_TIMEOUT"}
}
```

Use cgroup `cpu.max` as a backstop for cases where the WASM runtime itself is compromised (e.g., after a JIT exploit), not as the primary kill mechanism.

---

## OOM Detection: cgroup memory.events fd Listener

```go
// Spawned as a goroutine per worker cgroup at worker startup
func watchCgroupMemoryEvents(cgroupPath string, kill func()) {
    eventsPath := filepath.Join(cgroupPath, "memory.events")
    fd, _ := os.Open(eventsPath)
    defer fd.Close()

    // inotify on the cgroup events file - kernel notifies on every counter increment
    watcher, _ := fsnotify.NewWatcher()
    watcher.Add(eventsPath)

    for range watcher.Events {
        content, _ := io.ReadAll(fd)
        fd.Seek(0, io.SeekStart)
        counts := parseCgroupMemoryEvents(content)
        if counts["max"] > 0 || counts["oom"] > 0 {
            // Memory limit hit - kill worker goroutine immediately
            kill()
            return
        }
    }
}
```

This fires *before* the kernel OOM killer (which can kill random processes on the node). The host detects the event, calls `module.Close()`, and returns `OOM_KILLED` to the client cleanly.

---

## Sandbox Escape Response Protocol

When seccomp-bpf fires `SIGSYS` indicating a blocked syscall from within a WASM execution:

1. Signal handler records `SecurityEvent{Type: "SECCOMP_TRAP", Syscall: syscallNr, ExecutionID: currentExecutionID, TenantID: currentTenantID, Timestamp: now}`.
2. `module.Close(ctx)` terminates the WASM execution.
3. Worker goroutine returns `INTERNAL_SANDBOX_ERROR` to the SSE stream (no detail about the syscall leaked to the client).
4. High-priority OTel span emitted with `security_event=true`, `security_event_type="SECCOMP_TRAP"`.
5. Span triggers PagerDuty alert within 30 seconds (OTel → Prometheus alertmanager → PagerDuty).
6. On-call engineer runs the **node isolation runbook**:
   - `kubectl cordon <node>` - prevents new pod scheduling on the node.
   - `kubectl drain <node> --ignore-daemonsets` - evicts all pods to healthy nodes.
   - Node is quarantined for forensics; worker pod logs and cgroup audit logs preserved.
7. If the CVE is confirmed in the WASM engine: blue-green worker rollout with pinned updated engine version (see CC8.1 runbook below).

---

## WASM Engine CVE Response (CC8.1)

When a security CVE is disclosed in wazero (or the underlying JIT):

1. Security team creates a Jira ticket tagged `P0-SECURITY`.
2. CI bot bumps `go.mod` to the patched wazero version; runs integration test suite.
3. New worker container image built, tagged with the wazero version in the image tag (e.g., `worker:2026-05-07-wazero-1.8.2`).
4. Blue-green deployment: new worker Deployment rolled out alongside old; traffic shifted via Kubernetes pod readiness; old Deployment scaled to zero after health check passes.
5. Rollback if new engine fails: `kubectl rollout undo deployment/wasm-workers`.
6. Post-incident: WASM bytecode allowlist hash updated if Pyodide/QuickJS artifact also changed; hash verified at worker startup.

---

## Observability: OpenTelemetry Span Schema

Every execution emits one parent span into the 50M-spans/day telemetry mesh:

```json
{
  "trace_id": "7f3c2a...",
  "span_name": "wasm.execute",
  "start_time": "2026-05-07T09:14:22.001Z",
  "end_time":   "2026-05-07T09:14:22.088Z",
  "status": "OK",
  "attributes": {
    "execution.id":             "ex-550e8400-e29b-41d4-a716",
    "execution.tenant_id":      "t-acme-corp",
    "execution.language":       "python",
    "execution.duration_ms":    87,
    "execution.cpu_ms_used":    42,
    "execution.memory_peak_mb": 14,
    "execution.exit_code":      0,
    "execution.error_code":     "",
    "execution.security_events": 0,
    "execution.fuel_remaining":  3_812_004,
    "execution.was_cold_start": false,
    "execution.queue_wait_ms":  3,
    "execution.worker_id":      "worker-12",
    "execution.code_hash":      "sha256:d7a8fbb3...",
    "security_event":           false
  }
}
```

**Security event span (high-priority path):**

When `execution.security_events > 0`, an additional child span is emitted:

```json
{
  "span_name": "wasm.security_event",
  "attributes": {
    "security_event":            true,
    "security_event.type":       "SECCOMP_TRAP",
    "security_event.syscall_nr": 59,
    "security_event.execution_id": "ex-550e8400-...",
    "security_event.tenant_id":  "t-acme-corp",
    "security_event.worker_id":  "worker-12"
  }
}
```

This span has `security_event=true` as an OTel attribute. The OTel collector routes all spans with this attribute to a dedicated high-priority Prometheus counter (`wasm_security_event_total`) and triggers real-time alerting independent of normal batch aggregation.

---

## Metrics

| Metric | Type | Labels | Alert Threshold | Alert Routing |
|---|---|---|---|---|
| `wasm_execution_total` | Counter | `language`, `exit_code`, `error_code` | - | - |
| `wasm_execution_error_rate` | Gauge (derived) | `error_type` | > 5% in 5-min window → SLO breach | PagerDuty P2 |
| `wasm_security_event_total` | Counter | `event_type` | Any event in 60s window | PagerDuty P0 |
| `wasm_execution_duration_ms` | Histogram | `language`, `was_cold_start` | p99 > 500ms | PagerDuty P2 |
| `wasm_cpu_ms_used` | Histogram | `language` | - | Capacity planning |
| `wasm_memory_peak_mb` | Histogram | `language` | - | Capacity planning |
| `wasm_oom_rate` | Gauge (derived) | `language` | > 1% in 5-min window | PagerDuty P2 (capacity alert) |
| `wasm_pool_utilization` | Gauge | `language` | > 90% | PagerDuty P3 |
| `wasm_cold_start_rate` | Gauge (derived) | `language` | > 5% | PagerDuty P3 |
| `wasm_worker_panic_total` | Counter | `worker_id` | Any panic in 5-min window | PagerDuty P1 |
| `wasm_seccomp_trap_total` | Counter | `worker_id`, `syscall_nr` | Any trap | PagerDuty P0 |

---

## Alerts and Runbook Summary

| Alert | Condition | Severity | Response |
|---|---|---|---|
| `SecurityEventFired` | `wasm_security_event_total` rate > 0 in 60s | P0 | Cordon node; drain executions; investigate syscall; page security team |
| `SLOBreach` | `wasm_execution_error_rate` > 5% over 5 min | P1 | Check pool utilization; check worker panic rate; check cgroup events |
| `OOMRateHigh` | `wasm_oom_rate` > 1% over 5 min | P2 | Scale worker pool; review memory limit settings; check for memory bomb pattern in code_hash |
| `PoolSaturation` | `wasm_pool_utilization` > 90% over 2 min | P3 | Trigger autoscaler; review per-tenant execution rate for abuse |
| `EngineVersionDrift` | Worker image tag mismatch vs. pinned version in deployment manifest | P1 | Rollout pinned version; investigate how drift occurred |

---

## Recovery Matrix

| Scenario | Detection | Isolation Step | Rollback / Recovery | SLO Impact |
|---|---|---|---|---|
| Sandbox escape (SIGSYS) | seccomp trap → OTel alert | Cordon + drain worker node within 5 min | Re-deploy workers to healthy nodes; forensic hold on compromised node | Single node's executions fail; retry on healthy node; ~200ms per retry |
| WASM engine CVE disclosed | Security advisory | Immediately cordon workers running affected version | Blue-green rollout of patched engine; old workers drained after readiness passes | Zero downtime if blue-green healthy; fallback via `kubectl rollout undo` |
| OOM storm (spike in memory-heavy code) | `wasm_oom_rate` alert | No node isolation needed; cgroup kills individual workers | Autoscaler adds capacity; optionally lower per-execution memory cap | Increased error rate for memory-heavy executions; healthy executions unaffected |
| Worker panic storm | `wasm_worker_panic_total` alert | Redeploy worker Deployment (rolling restart) | Investigate panic stack trace in logs; fix root cause in next deploy | Elevated cold starts during rolling restart |
| Node failure (cloud provider) | Kubernetes node NotReady | Kubernetes automatically evicts pods | Scheduler places pods on healthy nodes; pool replenishes | Transient error spike (~30s) until pods rescheduled |
