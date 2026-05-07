# 03 — API and Contracts

## Public REST API

### POST /v1/execute — Submit Code Execution

**Request:**
```http
POST /v1/execute
Authorization: Bearer <tenant-jwt>
Content-Type: application/json
Accept: text/event-stream
Idempotency-Key: ex-550e8400-e29b-41d4-a716-446655440000
```

```json
{
  "language": "python",
  "code": "import sys\nprint(sum(range(100)))\nprint('done', file=sys.stderr)",
  "stdin": "",
  "timeout_ms": 10000,
  "memory_mb": 64,
  "env": {},
  "tags": {
    "agent_run_id": "run-abc123",
    "tool_call_id": "tc-xyz"
  }
}
```

**Field constraints:**

| Field | Type | Max | Default | Notes |
|---|---|---|---|---|
| `language` | enum | — | required | `python`, `javascript`, `typescript`, `bash` |
| `code` | string | 100KB | required | UTF-8; binary rejected |
| `stdin` | string | 10KB | `""` | Passed to WASM stdin pipe |
| `timeout_ms` | int | 30000 (enterprise), 5000 (free) | 10000 | Hard cap enforced by runtime |
| `memory_mb` | int | 256 (enterprise), 64 (free) | 64 | Maps to WASM memory pages |
| `env` | object | 10 keys max | `{}` | Explicit allowlist per tenant; empty by default |
| `tags` | object | 20 keys max | `{}` | Propagated to audit log; not accessible inside sandbox |

**Response: SSE stream**

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
X-Execution-Id: ex-550e8400-e29b-41d4-a716-446655440000
Cache-Control: no-cache

data: {"event":"queued","execution_id":"ex-...","position":0,"estimated_wait_ms":45}

data: {"event":"started","execution_id":"ex-...","worker_id":"w-07","language":"python","timestamp":"2026-05-06T12:00:00.045Z"}

data: {"event":"stdout","execution_id":"ex-...","chunk":"4950\n","seq":1}

data: {"event":"stderr","execution_id":"ex-...","chunk":"done\n","seq":2}

data: {"event":"done","execution_id":"ex-...","exit_code":0,"duration_ms":87,"memory_peak_mb":12,"stdout_bytes":5,"stderr_bytes":5}
```

**Error events (inline in SSE stream):**
```
data: {"event":"error","execution_id":"ex-...","code":"TIMEOUT","message":"Execution exceeded 10000ms limit"}

data: {"event":"error","execution_id":"ex-...","code":"MEMORY_EXCEEDED","message":"Execution exceeded 64MB memory limit"}

data: {"event":"error","execution_id":"ex-...","code":"RUNTIME_ERROR","message":"WASM module trapped: unreachable instruction"}
```

**HTTP-level error responses (before SSE stream opens):**

| Status | Code | Condition |
|---|---|---|
| 400 | `INVALID_LANGUAGE` | Language not supported |
| 400 | `CODE_TOO_LARGE` | Code > 100KB |
| 400 | `INVALID_TIMEOUT` | timeout_ms > tenant max |
| 401 | `UNAUTHORIZED` | Invalid or expired JWT |
| 429 | `RATE_LIMITED` | Token bucket exhausted; `retry_after` header set |
| 503 | `EXECUTION_POOL_SATURATED` | All workers busy; queue full |

---

### GET /v1/executions/{execution_id} — Retrieve Stored Result

For cases where the SSE connection dropped mid-execution, the result is stored in Redis for 24h.

**Response:**
```json
{
  "execution_id": "ex-550e8400-e29b-41d4-a716-446655440000",
  "status": "COMPLETED",
  "exit_code": 0,
  "stdout": "4950\n",
  "stderr": "done\n",
  "duration_ms": 87,
  "memory_peak_mb": 12,
  "language": "python",
  "created_at": "2026-05-06T12:00:00.000Z",
  "completed_at": "2026-05-06T12:00:00.087Z"
}
```

Note: `code` is NOT returned in the result — the code is one-way input; storing it in the result creates unnecessary data retention risk for SOC-2.

---

### GET /v1/execute/stream/{execution_id} — Reconnect to Existing SSE Stream

If a client loses the SSE connection while execution is in progress, it can reconnect and receive events from the last delivered `seq` number.

```http
GET /v1/execute/stream/ex-550e8400-e29b-41d4-a716-446655440000
Last-Event-ID: 3
```

The Stream Manager buffers the last 100 events per execution in memory. On reconnect, events after `seq=3` are replayed.

---

## Idempotency

The `Idempotency-Key` header is a client-generated UUID. If the same key is submitted twice:

1. First submission: execution starts, SSE stream opens.
2. Retry before execution completes: the new request joins the same SSE stream (deduplication at the Stream Manager).
3. Retry after execution completes: result is returned from Redis cache (no re-execution). This prevents double-billing and double side-effects.

---

## Internal Contracts: Scheduler → Worker

The Scheduler dispatches to workers via a Go channel (not an external queue — all within the same process for low latency):

```go
type ExecutionRequest struct {
    ExecutionID  string
    TenantID     string
    Language     Language
    Code         string
    StdinData    string
    TimeoutMs    int
    MemoryMB     int
    EnvVars      map[string]string
    ResultChan   chan<- ExecutionEvent  // worker writes events to this channel
    CancelCtx    context.Context        // control plane cancels if client disconnects
}

type ExecutionEvent struct {
    Type      EventType  // STARTED, STDOUT, STDERR, DONE, ERROR, TIMEOUT
    Seq       int
    Chunk     string     // non-empty for STDOUT/STDERR events
    ExitCode  int        // set on DONE
    DurationMs int64     // set on DONE
    MemPeakMB  int       // set on DONE
    Error     error      // set on ERROR
}
```

The `CancelCtx` is important: if the user closes the browser tab or the agent times out, the control plane cancels the context, which signals the worker to stop execution (calls `wazero.Runtime.Close()`). This prevents orphaned executions consuming CPU and memory.

---

## Agent Tool-Call Contract

In the LangGraph/LangChain context, the WASM sandbox is exposed as a tool:

```python
@tool
def execute_code(
    language: Literal["python", "javascript"],
    code: str,
    stdin: str = "",
    timeout_ms: int = 10000
) -> ExecutionResult:
    """
    Execute code in a secure WASM sandbox. Returns stdout, stderr, and exit code.
    Use for: calculations, data transformations, running generated scripts.
    Do NOT use for: network requests, file system access, or long-running processes.
    """
    ...

class ExecutionResult(BaseModel):
    stdout: str
    stderr: str
    exit_code: int
    duration_ms: int
    timed_out: bool
```

The tool's docstring is part of the prompt — the "Do NOT use for: network requests" constraint informs the LLM what the sandbox cannot do, preventing it from generating code that will fail with confusing errors.

---

## Error Model

**Error taxonomy for execution failures:**

| Error Code | Meaning | Retryable | Agent guidance |
|---|---|---|---|
| `TIMEOUT` | Execution exceeded timeout_ms | Yes (with increased timeout or reduced computation) | LLM told: "code ran too long; try simpler approach or increase timeout" |
| `MEMORY_EXCEEDED` | Linear memory hit the cap | Yes (with reduced memory usage in code) | LLM told: "code used too much memory; try streaming or chunking" |
| `RUNTIME_ERROR` | WASM trap (e.g., stack overflow, unreachable, null dereference) | Yes (with fixed code) | LLM told: exact WASM trap type if available |
| `SYNTAX_ERROR` | Code failed to parse before execution | Yes (with fixed code) | LLM told: parse error message |
| `WORKER_CRASH` | Worker process died unexpectedly | Yes (transparent retry) | Transparent to LLM; retry on different worker |
| `RATE_LIMITED` | Tenant quota exceeded | Yes (after retry_after) | User notified; agent waits |
| `POOL_SATURATED` | All workers busy | Yes (queue or retry) | Queue with position feedback to user |
