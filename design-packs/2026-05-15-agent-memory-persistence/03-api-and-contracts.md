# 03 — API and Contracts

The Memory Manager exposes a small, opinionated gRPC + REST surface. The agent
runtime never touches the underlying stores directly. All APIs are
**tenant-scoped** and **idempotent** by construction.

## Identity Conventions

Every memory operation carries:

| Field | Purpose |
| --- | --- |
| `tenant_id` | Hard isolation boundary (RLS in PG, namespace in Qdrant). |
| `org_id` / `user_id` | Scope owner inside the tenant. |
| `session_id` | The chat / workflow conversation; episodic anchor. |
| `run_id` | One DAG execution. Multiple per session. |
| `step_id` | One node execution inside the DAG. **Idempotency key.** |
| `checkpoint_version` | Monotonic per `run_id`; lets replay pin a moment. |
| `actor` | `agent`, `tool`, `user`, `system` — for audit + replay. |
| `trace_id` / `span_id` | OTel; flow into Clickhouse. |

## Top-Level APIs

### 1. Execution State

```
POST   /v1/exec/runs                         # create run
GET    /v1/exec/runs/{run_id}                # status, current checkpoint
POST   /v1/exec/runs/{run_id}/steps          # append step event (idempotent)
GET    /v1/exec/runs/{run_id}/events         # ordered event log (replay)
POST   /v1/exec/runs/{run_id}/checkpoints    # commit checkpoint
GET    /v1/exec/runs/{run_id}/checkpoints/{ver}   # fetch a checkpoint
POST   /v1/exec/runs/{run_id}/cancel         # cooperative cancel
```

`POST /steps` request:

```json
{
  "step_id": "stp_01HVZ...",
  "parent_checkpoint": "v_42",
  "kind": "react_step",
  "inputs_hash": "sha256:...",
  "model_call": {
    "provider": "anthropic",
    "model": "claude-opus-4-7",
    "prompt_hash": "sha256:...",
    "params_hash": "sha256:..."
  },
  "tool_call": {
    "name": "code_exec",
    "args_hash": "sha256:...",
    "sandbox_run_id": "sbx_..."
  },
  "observation_hash": "sha256:...",
  "thought": "I should run the code to verify the output...",
  "produced_at": "2026-05-15T10:14:22Z"
}
```

Response:

```json
{
  "step_id": "stp_01HVZ...",
  "checkpoint_version": "v_43",
  "status": "committed"
}
```

**Idempotency rule.** Re-`POST` of the same `step_id` returns the existing
record with HTTP 200 (not 409). This is what makes retries safe under
at-least-once delivery from the workflow engine.

**Error model.**

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_PARENT_CHECKPOINT` | parent doesn't match current run head |
| 409 | `STEP_ID_CONTENT_MISMATCH` | same `step_id`, different `inputs_hash` — replay attack or bug |
| 412 | `CHECKPOINT_STALE` | optimistic concurrency lost; retry from latest |
| 422 | `TENANT_QUOTA_EXCEEDED` | per-tenant write rate hit |
| 503 | `STORE_DEGRADED` | Postgres replica lag > threshold; backoff and retry |

### 2. Short-Term Memory

```
GET    /v1/stm/runs/{run_id}/trace
PATCH  /v1/stm/runs/{run_id}/trace          # append working note
DELETE /v1/stm/runs/{run_id}                # explicit purge (run end)
```

`trace` is the agent's working scratchpad — list of `{role, content, tool, ts}`
items. Reads are served from Redis, with a Postgres fallback if the Redis key
is gone (e.g., after a node failover). Write-through to Postgres happens at
checkpoint commit, not on every `PATCH`, to keep the hot path fast.

### 3. Episodic Memory

```
POST   /v1/episodic/sessions/{session_id}/events
GET    /v1/episodic/sessions/{session_id}/events
GET    /v1/episodic/sessions/{session_id}/summary
POST   /v1/episodic/sessions/{session_id}/rollup     # force rollup
```

Event payload (append-only):

```json
{
  "event_id": "evt_...",
  "kind": "user_message" | "agent_action" | "tool_result" | "user_feedback" | "system_event",
  "actor": "user",
  "ref": { "run_id": "...", "step_id": "..." },
  "payload": { "text": "...", "redactions": [...] },
  "occurred_at": "2026-05-15T10:14:22Z"
}
```

Rollup contract: when a session crosses N events or T minutes idle, a
background job calls the model router with a fixed prompt + the new events
since the last rollup, produces a summary + extracted facts, writes the
summary into episodic, optionally promotes facts into long-term, and embeds
the summary into vector memory.

### 4. Long-Term Memory

```
GET    /v1/ltm/{scope}/{owner_id}/keys/{key}
PUT    /v1/ltm/{scope}/{owner_id}/keys/{key}
DELETE /v1/ltm/{scope}/{owner_id}/keys/{key}
GET    /v1/ltm/{scope}/{owner_id}/keys?prefix=
```

`scope` ∈ `user`, `org`, `tenant`. Values are typed (declared in a registry,
see `04-low-level-design.md`). Unknown keys are rejected — no free-form writes.

Write payload:

```json
{
  "value": { "preferred_language": "Go", "indent": "tabs" },
  "schema_version": 3,
  "source": { "kind": "rollup_extraction", "session_id": "...", "confidence": 0.82 },
  "ttl_seconds": null,
  "review_required": false
}
```

`review_required: true` puts the write into a **pending bucket** that needs
human-in-the-loop confirmation (used for risky facts like billing details).

### 5. Vector Memory

```
POST   /v1/vector/{collection}/upsert
POST   /v1/vector/{collection}/query
DELETE /v1/vector/{collection}/items/{item_id}
```

Query payload (hybrid retrieval):

```json
{
  "query_text": "How did we resolve the OAuth refresh bug?",
  "filters": {
    "tenant_id": "t_acme",
    "scope": ["session:abc", "long_term:org:acme"]
  },
  "ann": { "top_n": 50, "ef_search": 128 },
  "bm25": { "top_n": 50 },
  "rerank": { "model": "ce-marco-mini", "top_k": 5 },
  "max_age_days": 90
}
```

Response:

```json
{
  "items": [
    {
      "item_id": "vm_...",
      "source": { "store": "episodic", "ref": "evt_..." },
      "snippet": "...",
      "score": { "ann": 0.81, "bm25": 0.62, "rerank": 0.93 },
      "metadata": { "tenant_id": "t_acme", "created_at": "..." }
    }
  ],
  "manifest_id": "ctx_..."
}
```

`manifest_id` is the handle the workflow engine stores with the step so the
exact retrieval set can be replayed.

### 6. Context Build (the convenience API)

The thing the LangGraph node actually calls:

```
POST   /v1/context/build
```

```json
{
  "run_id": "...",
  "session_id": "...",
  "tenant_id": "...",
  "user_id": "...",
  "query": "user's latest message + current goal",
  "budget_tokens": 24000,
  "tiers": ["short_term", "episodic_summary", "long_term:user", "vector:rag"]
}
```

Response includes the packed context **and the provenance manifest** that gets
attached to the next `POST /v1/exec/runs/{run_id}/steps`. The manifest is what
allows replay to reconstruct the same context window even if a vector item has
since been deleted (we keep a content-addressed snapshot of retrieved items in
the execution log for retention-window-bounded periods).

## Idempotency, Concurrency, And Ordering

| Concern | Mechanism |
| --- | --- |
| Duplicate step writes | `step_id` as PK, content-mismatch returns 409 |
| Concurrent step writes (workflow worker dup) | `parent_checkpoint` optimistic lock |
| Out-of-order episodic events | server-assigned `seq` per `session_id`; `occurred_at` is descriptive only |
| Concurrent long-term writes | per-key version + last-writer-wins with audit, **except** when `review_required: true` (queues instead) |
| Vector upsert reordering | upserts are content-addressable; same `(source, ref, content_hash)` → same `item_id` |

## Backpressure And Quotas

Per-tenant quotas (configurable, defaults shown):

| Surface | Default |
| --- | --- |
| Steps appended | 200 RPS sustained, 1000 RPS burst |
| Episodic events | 100 RPS sustained |
| Long-term writes | 20 RPS sustained, 5/min `review_required` |
| Vector upserts | 50 RPS sustained (async batched) |
| Context builds | 50 RPS sustained |

Over-quota → 429 with `Retry-After`. The workflow engine treats 429 as a
*pause-the-step* signal rather than a hard failure: the step gets re-queued at
its current checkpoint without losing progress.

## What Is Deliberately Not An API

- "Forget this" via fuzzy search. We require a *key* for long-term deletes and
  a *ref* for episodic deletes. Fuzzy "delete by topic" is too easy to get
  wrong and too easy to use as an exfiltration vector.
- Direct vector writes from agent code. Vector is a **derived index**; writes
  flow through episodic / long-term first. This was a 2-week-of-debugging
  lesson early in the platform.
- Cross-tenant queries — no API, no flag, no admin override. Cross-tenant
  reads only happen through a separate offline analytics pipeline with audited
  access.
