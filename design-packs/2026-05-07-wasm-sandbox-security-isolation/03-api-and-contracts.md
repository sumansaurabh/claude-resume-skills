# 03 - API and Internal Contracts

## Public REST API

### POST /v1/executions

Submit a code execution request.

**Request headers**

| Header | Required | Description |
|---|---|---|
| `Authorization` | Yes | `Bearer <jwt>` - identifies tenant and principal |
| `Idempotency-Key` | Recommended | Client-generated UUID; replays return the cached response without re-execution |
| `Content-Type` | Yes | `application/json` |

**Request body**

```json
{
  "code": "def solution(n):\n    return n * 2",
  "language": "python",
  "resource_limits": {
    "cpu_ms": 2000,
    "memory_mb": 128,
    "fs_quota_mb": 10,
    "timeout_ms": 5000,
    "network_allowed": false
  }
}
```

| Field | Type | Constraints | Default |
|---|---|---|---|
| `code` | string | Max 512 KB | required |
| `language` | string | Enum: `python`, `javascript`, `go`, `rust`, `c`, `cpp`, `java` | required |
| `resource_limits.cpu_ms` | integer | 100–10000 | 2000 |
| `resource_limits.memory_mb` | integer | 16–512 | 128 |
| `resource_limits.fs_quota_mb` | integer | 1–100 | 10 |
| `resource_limits.timeout_ms` | integer | 100–30000 | 5000 |
| `resource_limits.network_allowed` | boolean | Always `false` in production; field accepted for forward-compat | false |

`network_allowed` is validated server-side. If a client sends `true`, the server returns `400 Bad Request` with error code `NETWORK_NOT_ALLOWED`. This field exists for internal staging environments only.

**Response - 201 Created (async) or 200 OK (sync inline)**

For executions completing within a fast-path threshold (< 500ms wall time), the response is synchronous:

```json
{
  "execution_id": "exec_01HV3K9JZMX5BW4G6D8R7TQNP",
  "status": "COMPLETED",
  "stdout": "42\n",
  "stderr": "",
  "exit_code": 0,
  "resource_usage": {
    "cpu_ms_used": 87,
    "memory_peak_mb": 23,
    "wall_ms": 134
  },
  "security_events": []
}
```

For executions exceeding the fast-path threshold, the response is async:

```json
{
  "execution_id": "exec_01HV3K9JZMX5BW4G6D8R7TQNP",
  "status": "PENDING"
}
```

The client polls `GET /v1/executions/{execution_id}` until `status` leaves `PENDING`.

**Response - terminal states**

| `status` | Meaning |
|---|---|
| `COMPLETED` | Exited cleanly within all limits |
| `FAILED` | Non-zero exit code, no policy violation |
| `TIMEOUT` | Wall clock deadline exceeded |
| `RESOURCE_LIMIT_EXCEEDED` | CPU, memory, or FS quota hit |
| `SECURITY_VIOLATION` | Sandbox escape attempt detected |

**Response with security events**

```json
{
  "execution_id": "exec_01HV3K9JZMX5BW4G6D9S8UQMP",
  "status": "SECURITY_VIOLATION",
  "stdout": "",
  "stderr": "Aborted",
  "exit_code": -1,
  "resource_usage": {
    "cpu_ms_used": 12,
    "memory_peak_mb": 18,
    "wall_ms": 8
  },
  "security_events": [
    {
      "type": "BLOCKED_IMPORT_CALL",
      "timestamp": "2026-05-07T10:04:33.112Z",
      "detail": "module attempted to call 'sock_connect' which is not in the import allowlist"
    }
  ]
}
```

---

## Error Model

All errors follow a uniform envelope:

```json
{
  "error": {
    "code": "EXECUTION_TIMEOUT",
    "message": "Execution exceeded wall-clock deadline of 5000ms",
    "execution_id": "exec_01HV3K9JZMX5BW4G6D8R7TQNP",
    "retryable": false
  }
}
```

### Error Codes

| Code | HTTP Status | Retryable | Description |
|---|---|---|---|
| `EXECUTION_TIMEOUT` | 200 (in body) | No | Wall-clock deadline fired before completion |
| `MEMORY_LIMIT_EXCEEDED` | 200 (in body) | No | WASM memory.grow or cgroup OOM kill |
| `CPU_QUOTA_EXCEEDED` | 200 (in body) | No | Fuel exhausted or cgroup CPU quota hit |
| `SANDBOX_ESCAPE_ATTEMPT` | 200 (in body) | No | seccomp violation, namespace escape attempt |
| `FILESYSTEM_VIOLATION` | 200 (in body) | No | Path traversal outside pre-open dir, or fs quota exceeded |
| `BLOCKED_IMPORT_CALL` | 200 (in body) | No | WASM module called non-allowlisted host function |
| `COMPILATION_FAILED` | 422 | No | Source could not be compiled to WASM |
| `LANGUAGE_NOT_SUPPORTED` | 400 | No | Language value is not in the supported enum |
| `NETWORK_NOT_ALLOWED` | 400 | No | Client sent network_allowed: true |
| `IDEMPOTENCY_CONFLICT` | 409 | No | Same Idempotency-Key with different request body |
| `RATE_LIMITED` | 429 | Yes | Per-tenant rate limit exceeded |
| `INTERNAL_ERROR` | 500 | Yes | Orchestrator internal failure |

Security-class codes (`SANDBOX_ESCAPE_ATTEMPT`, `BLOCKED_IMPORT_CALL`, `FILESYSTEM_VIOLATION`) are treated as terminal: the execution is killed, the result is stored, and the event is emitted to the security audit log. They are not retried and they increment per-tenant anomaly counters.

---

## Idempotency

The `Idempotency-Key` header is a client-generated UUID. The orchestrator stores a mapping of `(tenant_id, idempotency_key) -> execution_id` with a 24-hour TTL.

- If the same key arrives while the first request is still in-flight, the second request blocks and waits for the first to complete, then returns the same response.
- If the same key arrives after completion, the stored response is returned immediately without re-executing.
- If the same key arrives with a different request body, `409 IDEMPOTENCY_CONFLICT` is returned.

This is directly applicable to AI code evaluation platforms where the client may retry on timeout without wanting to bill the user twice for the same execution.

---

## Internal Enforcement Contract

### SandboxConfig (Go)

```go
// SandboxConfig is constructed by the Orchestrator from the validated API request
// and passed to the WASM worker. All resource limits are resolved and clamped
// to per-tenant tier maximums before reaching this struct.
type SandboxConfig struct {
    // Execution identity
    ExecID   string // ULID, e.g. "exec_01HV3K9JZMX5BW4G6D8R7TQNP"
    TenantID string

    // WASM runtime limits
    MaxMemoryBytes uint64 // enforced at WASM instantiation (memory page cap)
    MaxFuelUnits   uint64 // per-instruction budget; 0 disables fuel metering (test only)
    WallTimeoutMs  uint64 // context.WithDeadline duration in milliseconds

    // WASI / filesystem limits
    FsQuotaBytes    uint64 // max bytes written to pre-open dir
    EphemeralTmpDir string // absolute path: /tmp/exec-<tenant_id>-<exec_id>

    // Host import policy
    AllowedImports []string // e.g. ["fd_write", "clock_time_get", "proc_exit"]
    NetworkBlocked bool     // always true in production; blocks sock_* registration

    // OS / cgroup limits (applied by the worker process's cgroup membership)
    // These are set at pod/cgroup creation time, not at instantiation time.
    // Listed here for documentation; not programmatically applied by Go code.
    CgroupCPUQuotaUs  int64 // microseconds per period (e.g. 200000 = 200ms per 1s)
    CgroupMemoryBytes int64 // cgroup memory.max in bytes
    CgroupPIDsMax     int64 // cgroup pids.max

    // Language and code
    Language string
    Code     []byte // source; the worker compiles to WASM internally

    // AOT cache key (optional; skip compilation if cache hits)
    WASMCacheKey string // sha256(Language + Code)
}
```

### SandboxResult (Go)

```go
// SandboxResult is returned by the WASM worker to the Orchestrator
// after the execution completes (any terminal state).
type SandboxResult struct {
    ExecID string
    Status ExecutionStatus // COMPLETED | FAILED | TIMEOUT | RESOURCE_LIMIT_EXCEEDED | SECURITY_VIOLATION

    // Execution output
    Stdout   []byte
    Stderr   []byte
    ExitCode int

    // Resource accounting
    CPUMsUsed      int64 // wall-attributed CPU milliseconds
    MemoryPeakBytes int64 // peak RSS inside the WASM linear memory
    WallMs         int64 // total wall-clock time from instantiation to cleanup

    // Security and policy events
    SecurityEvents []SecurityEvent

    // Internal metadata
    WorkerID    string    // which worker goroutine handled this execution
    CompletedAt time.Time
}

type ExecutionStatus string

const (
    StatusCompleted              ExecutionStatus = "COMPLETED"
    StatusFailed                 ExecutionStatus = "FAILED"
    StatusTimeout                ExecutionStatus = "TIMEOUT"
    StatusResourceLimitExceeded  ExecutionStatus = "RESOURCE_LIMIT_EXCEEDED"
    StatusSecurityViolation      ExecutionStatus = "SECURITY_VIOLATION"
)
```

### SecurityEvent (Go)

```go
// SecurityEvent records a single security-relevant event during execution.
// Multiple events can occur in one execution (e.g. blocked import + FS violation).
type SecurityEvent struct {
    Type      SecurityEventType
    Timestamp time.Time
    Detail    string // human-readable, safe to surface in API response and audit log
}

type SecurityEventType string

const (
    // BLOCKED_SYSCALL: seccomp-bpf rejected a syscall from the sandbox process.
    // Detail includes syscall name and calling instruction address.
    EventBlockedSyscall SecurityEventType = "BLOCKED_SYSCALL"

    // BLOCKED_IMPORT: WASM module attempted to call a host function not in AllowedImports.
    // Detail includes the import name (e.g. "sock_connect").
    EventBlockedImport SecurityEventType = "BLOCKED_IMPORT"

    // OOM_KILL: cgroup memory.max or WASM memory cap triggered OOM kill.
    // Detail includes which limit fired (WASM_MEMORY_CAP or CGROUP_OOM).
    EventOOMKill SecurityEventType = "OOM_KILL"

    // TIMEOUT_KILL: Wall-clock deadline exceeded; context cancelled.
    // Detail includes the configured deadline and actual wall time.
    EventTimeoutKill SecurityEventType = "TIMEOUT_KILL"

    // FS_QUOTA_EXCEEDED: WASI host fs quota interceptor rejected a write.
    // Detail includes bytes attempted vs quota limit.
    EventFSQuotaExceeded SecurityEventType = "FS_QUOTA_EXCEEDED"

    // FUEL_EXHAUSTED: Wasmtime fuel counter reached zero.
    // Detail includes total fuel consumed and configured budget.
    EventFuelExhausted SecurityEventType = "FUEL_EXHAUSTED"
)
```

---

## Internal API: Orchestrator -> Worker

The orchestrator dispatches work to the WASM worker pool via a typed Go channel. This is an internal contract, not an HTTP API.

```go
type ExecutionRequest struct {
    Config  SandboxConfig
    ResultC chan<- SandboxResult // worker writes result here; orchestrator reads
}

// Worker loop (simplified)
func (w *Worker) Run(ctx context.Context, jobs <-chan ExecutionRequest) {
    for {
        select {
        case req := <-jobs:
            result := w.execute(req.Config)
            req.ResultC <- result
        case <-ctx.Done():
            return
        }
    }
}
```

The orchestrator enforces a per-request deadline on the `ResultC` channel read that is `WallTimeoutMs + 500ms` (grace period for cleanup). If the worker has not written a result by then, the orchestrator synthesizes a `StatusTimeout` result and emits a `TIMEOUT_KILL` security event. The worker is then forcibly replaced (its goroutine context is cancelled and a new worker is spun up from the pool).

---

## Observability Hooks

Every `SandboxResult` is forwarded to three sinks after the orchestrator receives it:

1. **Response store** - written to Redis (TTL 24h) keyed by `exec_id` for async polling and idempotency replay.
2. **Metrics** - Prometheus counters/histograms emitted per `status`, `language`, and `tenant_tier`. Key metrics:
   - `sandbox_executions_total{status, language, tenant_tier}`
   - `sandbox_cpu_ms_used_histogram{language}`
   - `sandbox_memory_peak_bytes_histogram{language}`
   - `sandbox_security_events_total{type, tenant_id}` - alerted on if > 0 in a 5-minute window
3. **Audit log** - structured JSON to an append-only log sink (e.g. Kafka topic → S3 → Athena). Includes full `SecurityEvents` array. Required for SOC-2 CC7.2.
