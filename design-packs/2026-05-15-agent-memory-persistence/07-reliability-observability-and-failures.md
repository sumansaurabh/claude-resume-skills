# 07 - Reliability, Observability, and Failures

## SLOs

| Surface | SLO | Why |
| --- | --- | --- |
| `POST /v1/exec/runs/{id}/steps` | p99 < 50 ms, success > 99.95% | hot path of every ReAct loop |
| `POST /v1/context/build` | p99 < 200 ms | gates the next model call |
| `GET /v1/stm/.../trace` | p99 < 20 ms | hot read |
| Vector hybrid query | p99 < 100 ms (no rerank), 250 ms (with rerank) | retrieval should be cheaper than the model call |
| Episodic rollup lag | < 5 min p95 | rollup is async; bounded staleness |
| Embedding lag | < 60 s p95 | freshness for new docs/events |
| Replay determinism | 100% same content_hash for replayed steps | core invariant |

## Failure Taxonomy

| Failure | Where | Detection | Recovery |
| --- | --- | --- | --- |
| Worker crash mid-step | DAG runner | lease expiry on `exec_event` draft | janitor abandons draft; retry recreates with same `step_id`, no double work |
| Postgres primary failover | exec/episodic/long-term | replica promotes; gateway 503s for ~30s | workflow engine pauses steps, retries with backoff |
| Redis node loss | short-term | sentinel; cache miss | rehydrate from PG `stm_snapshot`; cost is one extra read per affected run |
| Qdrant unavailable | vector | health check; query timeouts | ContextBuilder degrades: skip vector tier, mark `manifest.vector=null`; agent runs with reduced recall but does not stall |
| Cross-encoder pool saturated | rerank | queue depth metric | degrade to no rerank; manifest records `rerank=skipped` |
| Embedding API outage | embed pipeline | provider error | episodic rollups continue; embeddings backfill on recovery |
| Model router outage | model | error class | workflow engine pauses run, surfaces actionable status |
| Schema-registry mismatch on long-term write | LongTermService | 422 at PolicyEngine | write rejected; metric incremented; no corruption |
| Cross-tenant tenancy assertion fires in ContextBuilder | gateway/CTX | abort + P0 alert | run paused; security incident workflow triggered |
| `STEP_ID_CONTENT_MISMATCH` | exec event uniqueness | 409 | indicates retry with different inputs (bug or attack); run paused for inspection |
| Rollup loop generates pathological summary | episodic rollup | safety eval gate fails | summary discarded; manual rollup option; alert on rate |

## Retries, Backoff, And Idempotency

- All hot-path APIs are idempotent by `step_id` / `event_id` / content hash.
- The workflow engine retries with **exponential backoff + jitter** on
  `503/429/STORE_DEGRADED`, capped at `max_retries_per_step` (default 5).
- Tool calls follow the same shape; tool-level idempotency is the tool's
  job, but the platform records `tool_call_id` so the *same* result is
  deterministic on replay even if the tool itself is re-invoked.

## Durable Execution Semantics

- Every step is bracketed by `BeginStep` (writes a `draft`) and `CommitStep`
  (writes the `committed` event with `inputs_hash`, `outputs_hash`,
  `model_call`, `tool_call`).
- A step is only "done" when its `committed` event is durable in PG.
- Resume = "find latest committed event for `run_id`, ask the workflow
  engine to start the next graph node from that checkpoint."
- The runtime is **at-least-once**; idempotency makes it effectively
  **exactly-once** at the memory plane.

## Deterministic Replay (the headline observability feature)

The 60% MTTR reduction (`resume.txt`, `blackbox-experience.md` #20) is built
on this. Replay works because:

1. Every model call records `prompt_hash`, `model`, `params_hash`,
   `output_hash`. Outputs themselves are stored (within retention window).
2. Every retrieval records the **provenance manifest**: every
   `(store, key, version, content_hash)` that contributed to the context.
3. Every tool call records `tool`, `args_hash`, `result_hash`, plus the
   sandbox run id.
4. The execution event log is append-only and time-ordered.

Replay procedure:

- Pick `(run_id, up_to_checkpoint)`.
- Walk the event log; rebuild context per step from the manifest.
- For model calls in **inspect mode**, do not call the provider; show the
  stored output.
- For model calls in **rerun mode**, call the provider with the same prompt
  and diff outputs. Useful for "the same prompt now produces different
  output - is the model drifting?"
- For tool calls in **inspect mode**, show the stored result. **Never**
  re-execute side-effect tools.

## Observability Plane

Every memory op emits an OTel span with these attributes (subset shown):

```
mem.tier                = exec | stm | episodic | long_term | vector | context_build
mem.op                  = read | write | delete | query | upsert | rollup
mem.tenant_id           = ...
mem.session_id          = ...
mem.run_id              = ...
mem.step_id             = ...
mem.checkpoint_version  = ...
mem.bytes               = int
mem.items_returned      = int
mem.cache_hit           = bool
mem.policy_decision     = allow | deny | redact | hold
mem.degraded            = none | rerank_skipped | vector_skipped | ...
mem.error_class         = ...
mem.duration_ms         = int
```

These plug into the broader telemetry mesh on the resume:
**OTel → Clickhouse, 50M spans/day, 2.5TB+/month, deterministic replay,
60% MTTR reduction** (`resume.txt`, `blackbox-experience.md` #20). Memory ops
are a slice of those spans, indexed by the same `trace_id` that the
workflow engine uses for the run.

### Dashboards (the ones that earned their keep)

- **Per-tenant memory pressure** - STM hot keys, episodic backlog, vector
  query latency. Catches noisy-neighbor early.
- **Tier degradation rate** - % of context builds with `degraded != none`.
  When this rises, retrieval quality is dropping before users notice.
- **Replay divergence** - % of replays whose model output differs from the
  stored output. A spike means model drift or a non-deterministic tool.
- **Schema-rejection rate** - long-term writes denied by the registry. A
  spike means an agent author shipped a key that doesn't exist.
- **Cross-tenant assertion firings** - must always be zero. A non-zero is a
  P0 page.

### Logs vs Spans vs Audit (kept separate)

| Channel | Purpose | Retention |
| --- | --- | --- |
| OTel spans | ops debugging, replay | 30–90 days hot, archive cold |
| Structured logs | engineer-readable narrative for failed runs | 14 days |
| Audit log | compliance evidence | 7 years per SOC-2 controls |

These are not the same channel because mixing them either bloats hot
storage or weakens retention guarantees on audit.

## Debugging Playbook (the one a real on-call uses)

1. Open the run in the trace viewer; find the failing step.
2. Look at the step's manifest - was retrieval degraded?
3. Replay the step in **inspect mode** to see exact prompt and stored
   output.
4. If output looks wrong: re-run in **rerun mode** to test for model drift.
5. If retrieval looks wrong: rerun the vector query *as of* the step's
   timestamp; compare top-K then vs now.
6. If state looks wrong: walk the event log; look for `STEP_ID_CONTENT_MISMATCH`
   or `CHECKPOINT_STALE` upstream.
7. If tool call looks wrong: pull the sandbox run id, inspect inputs/outputs.
8. If nothing looks wrong but the user disagrees: pull episodic events
   around the user's complaint; sometimes the bug is *agreement that the
   user did not give*.

## Anchors

- DAG checkpointing + retry semantics - `resume.txt` BlackBox bullet 3,
  `blackbox-experience.md` #12, #13.
- Deterministic replay + 60% MTTR reduction + 50M spans/day - `resume.txt`
  BlackBox bullet 5, `blackbox-experience.md` #20.
- Durable execution definition - `blackbox-experience.md` #15.
