# 03 — APIs and Contracts

Three contract surfaces matter:

1. The **public HTTP API** the BlackBox UI calls.
2. The **internal gRPC contracts** between agent workers, the sandbox broker,
   and the model router.
3. The **tool call envelope** that every ReAct tool invocation must satisfy.

## 1. Public HTTP API

Versioned at `/v1`. JSON over HTTPS. Auth: OIDC bearer token bound to a tenant
+ project.

### POST `/v1/runs`

Start an agent run.

```http
POST /v1/runs
Authorization: Bearer <token>
Idempotency-Key: 7c2f...           // client-supplied UUID
Content-Type: application/json

{
  "project_id": "prj_8f12",
  "prompt": "design a website like Slack",
  "archetype": "webapp-scaffold",  // optional; planner can pick
  "budget": {
    "max_tokens": 800000,
    "max_tool_calls": 200,
    "max_wallclock_ms": 1800000
  },
  "options": {
    "preferred_models": ["claude-sonnet", "gpt-4.1"],
    "stream": true
  }
}
```

Response:

```http
HTTP/1.1 202 Accepted
{
  "run_id": "run_19f3",
  "status": "queued",
  "stream_url": "https://api.blackbox.ai/v1/runs/run_19f3/events",
  "result_url": "https://api.blackbox.ai/v1/runs/run_19f3"
}
```

Idempotency: same `Idempotency-Key` within 24 hours returns the original
`run_id` and **does not** start a new run.

### GET `/v1/runs/{run_id}`

Returns the current materialized state — used by the UI on reconnect.

```json
{
  "run_id": "run_19f3",
  "status": "running",
  "current_node": "coder",
  "milestone": 4,
  "milestone_total": 8,
  "tokens_used": 218430,
  "cost_usd": 1.74,
  "started_at": "2026-05-15T14:02:11Z",
  "checkpoint_id": "ckpt_19f3_4",
  "artifacts": [
    {"kind": "preview_url", "url": "https://sbx.blackbox.ai/p/run_19f3/preview"}
  ]
}
```

### GET `/v1/runs/{run_id}/events` (SSE)

Server-Sent Events stream. Each event has a stable `id` for resume via
`Last-Event-ID`. Event types:

| Event | Payload | Notes |
| - | - | - |
| `node_started` | `{node, milestone?}` | Emitted on every graph transition |
| `node_completed` | `{node, duration_ms, tokens, cost_usd}` | After persist |
| `model_chunk` | `{token, model}` | Token-by-token stream for UI typing |
| `tool_started` | `{tool, args_redacted}` | `args_redacted` hides secrets |
| `tool_completed` | `{tool, exit_code, duration_ms}` | |
| `file_changed` | `{path, op, size}` | Driven by sandbox file-watch |
| `preview_ready` | `{preview_url, expires_at}` | |
| `policy_block` | `{tool, reason}` | When the policy gate blocks an action |
| `error` | `{code, message, recoverable}` | Non-fatal if `recoverable=true` |
| `done` | `{status, artifact_url}` | Terminal |

### POST `/v1/runs/{run_id}/actions`

Used for human-in-the-loop approval and run control.

```json
// approve a guarded tool call
{ "action": "approve", "policy_decision_id": "pd_abc" }

// cancel
{ "action": "cancel", "reason": "user_cancel" }

// pause / resume
{ "action": "pause" }
{ "action": "resume" }

// fork from a past checkpoint into a new run
{ "action": "fork", "checkpoint_id": "ckpt_19f3_3" }
```

### Error model

All errors share a shape so the UI can render them uniformly:

```json
{
  "error": {
    "code": "RUN_BUDGET_EXCEEDED",
    "message": "Run exceeded max_tokens budget of 800000.",
    "recoverable": false,
    "retry_after_s": null,
    "trace_id": "0af7..."
  }
}
```

Top-level codes:

`AUTH_INVALID`, `TENANT_QUOTA_EXCEEDED`, `RUN_BUDGET_EXCEEDED`,
`POLICY_BLOCK`, `MODEL_PROVIDER_DOWN`, `SANDBOX_UNAVAILABLE`,
`TOOL_VALIDATION_FAILED`, `CHECKPOINT_CORRUPT`, `INTERNAL`.

## 2. Internal gRPC contracts

### `SandboxBroker` — between agent worker and Go sandbox plane

```proto
service SandboxBroker {
  rpc OpenWorkspace(OpenWorkspaceRequest) returns (OpenWorkspaceResponse);
  rpc Exec(ExecRequest) returns (stream ExecChunk);
  rpc WriteFiles(WriteFilesRequest) returns (WriteFilesResponse);
  rpc ReadFile(ReadFileRequest) returns (ReadFileResponse);
  rpc Preview(PreviewRequest) returns (PreviewResponse);
  rpc CloseWorkspace(CloseWorkspaceRequest) returns (CloseWorkspaceResponse);
}

message ToolEnvelope {
  string envelope_id = 1;          // ULID; idempotency key
  string run_id = 2;
  string tenant_id = 3;
  string project_id = 4;
  string node_name = 5;            // which graph node issued this
  string tool = 6;
  bytes  args_canonical = 7;       // canonical-JSON of args
  bytes  signature = 8;            // Ed25519 over (envelope_id|run_id|args)
  Budget budget = 9;
  Deadline deadline = 10;
}

message Budget {
  uint32 cpu_ms     = 1;
  uint32 memory_mb  = 2;
  uint32 wallclock_ms = 3;
  uint32 stdout_kb  = 4;
  uint32 egress_kb  = 5;
}

message ExecRequest {
  ToolEnvelope envelope = 1;
  string workspace_id   = 2;
  repeated string cmd   = 3;
  map<string,string> env = 4;
  string cwd            = 5;
}

message ExecChunk {
  oneof event {
    LogLine    log     = 1;
    FileChange file    = 2;
    ExitCode   exit    = 3;
    QuotaWarn  warn    = 4;
  }
}
```

Key invariants:

- **Envelope is signed.** Sandbox broker rejects any envelope not signed by the
  worker's per-run key, derived from the run's auth token by the dispatcher.
- **Idempotency by envelope_id.** A retried call with the same `envelope_id`
  returns the cached `ToolResult` without re-executing — critical for at-least-once
  delivery from a worker that may have crashed after dispatch.
- **Budget is mandatory.** No tool call without an explicit budget. The broker
  rejects requests whose budget exceeds the run's remaining budget.

### `ModelRouter` — between agent worker and providers

```proto
service ModelRouter {
  rpc Invoke(ModelCallRequest) returns (stream ModelChunk);
  rpc Embeddings(EmbeddingsRequest) returns (EmbeddingsResponse);
}

message ModelCallRequest {
  string call_id = 1;              // ULID; idempotency key for cache
  string run_id = 2;
  string tenant_id = 3;
  string node_name = 4;
  RoutingHints hints = 5;
  repeated Message messages = 6;
  ResponseFormat response_format = 7;  // text, json_schema, tool_use
  Budget budget = 8;
  bytes prompt_hash = 9;           // sha256 of canonicalized prompt
}

message RoutingHints {
  uint32 min_context_tokens = 1;
  bool requires_tool_use = 2;
  bool requires_vision = 3;
  bool requires_json_mode = 4;
  string preferred_family = 5;     // "claude" | "gpt" | "grok" | ""
  CostClass cost_class = 6;        // CHEAPEST | BALANCED | BEST_QUALITY
}

message ModelChunk {
  oneof event {
    TextDelta text = 1;
    ToolUseDelta tool_use = 2;
    Usage usage = 3;
    RoutingDecision routing = 4;   // emitted once, first
    Error error = 5;
  }
}

message RoutingDecision {
  string chosen_model = 1;
  repeated string candidates = 2;
  string reason = 3;               // human-readable
  bool degraded = 4;               // failover happened
}
```

The `RoutingDecision` chunk is **always emitted first** — the worker, telemetry
mesh, and SSE stream all depend on knowing which model actually answered before
output starts.

## 3. The tool registry contract

Tools are declared in a versioned registry. Adding a tool is a config change,
not a code change in the agent.

```json
{
  "name": "sandbox.run",
  "version": "1.4.0",
  "schema": {
    "type": "object",
    "properties": {
      "cmd": {"type": "array", "items": {"type": "string"}},
      "cwd": {"type": "string"},
      "env": {"type": "object"}
    },
    "required": ["cmd"]
  },
  "side_effect_class": "EXECUTE",
  "required_scopes": ["workspace.exec"],
  "cost_weight": 5,
  "default_budget": {
    "cpu_ms": 30000,
    "memory_mb": 512,
    "wallclock_ms": 60000,
    "stdout_kb": 1024,
    "egress_kb": 0
  },
  "policy_gate": "default",
  "allowed_archetypes": ["webapp-scaffold", "data-pipeline", "open"]
}
```

`side_effect_class` ∈ `{READ, WRITE, EXECUTE, EXTERNAL_MUTATION,
DESTRUCTIVE}`. The policy node consults this to decide whether human approval
is required before dispatch.

## Example: the planner → sandbox.run round-trip

1. **Planner node** produces:

   ```json
   {
     "milestones": [
       {"id":"m1","title":"scaffold-next-ts","tool_plan":["sandbox.exec(create_project)"]},
       ...
     ]
   }
   ```

2. **Coder node** for milestone `m1` produces a tool call:

   ```json
   {
     "tool": "sandbox.run",
     "args": {"cmd": ["npx","create-next-app@latest","slack-clone","--ts","--tailwind","--app"]}
   }
   ```

3. Worker wraps it in a `ToolEnvelope`, signs, ships to broker.
4. Broker dispatches; the sandbox node streams `ExecChunk`s.
5. Worker accumulates the result, writes it to the checkpoint, advances graph.

The interview-grade thing to point out: this round-trip is **the only place**
the agent can affect the outside world. Everything else — model calls,
memory writes, checkpoints — is observable but reversible. That property is
what makes the policy gate small and the replay system possible.
