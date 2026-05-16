# 07 — Reliability, Observability, and Failures

The reliability story for an agentic platform is different from a normal
microservice. Three properties matter more than the usual SLO chart:

1. **Resumability** — runs survive worker death, provider outage, and
   transient failure without restarting from scratch.
2. **Determinism on replay** — a non-deterministic LLM run can be
   reconstructed bit-for-bit from logs + cached observations.
3. **Bounded blast radius** — a single bad run can't damage another tenant,
   another run, or the platform.

## Failure taxonomy

| Class | Example | Detection | Recovery |
| - | - | - | - |
| Worker crash mid-node | Pod OOM during `coder` | Lease expiry after 30 s | Re-enqueue; another worker resumes from last checkpoint |
| Provider 429 | Claude TPM exceeded | First chunk = error | Router retries next candidate; `degraded=true`; agent records routing decision |
| Provider 5xx / timeout | OpenAI 500, 30s | Per-call deadline | Router fails over; if all candidates fail, run pauses with `MODEL_PROVIDER_DOWN`, retried in 60 s |
| Tool exit non-zero | `pnpm tsc` fails | gRPC ExitCode | Observation fed back to coder; bounded by `max_iterations` |
| Sandbox node unavailable | Node draining | Broker returns `RESOURCE_EXHAUSTED` | Broker reroutes; if cluster-wide, run pauses |
| Postgres connection loss | Network blip | asyncpg error | Worker retries up to 3x; if still failing, lease released; run resumes elsewhere |
| Checkpoint write fails | Disk full / row too large | Transaction error | Spill large fields to blob; retry; if persistent, run fails with `CHECKPOINT_CORRUPT` and is paged |
| Plan invalid | Planner output won't parse | Schema validation | Re-prompt with feedback up to 2x; then fail `PLAN_INVALID` |
| Loop on same tool | 3 identical args | `loop_signature` check in coder | Park to `human_gate` |
| Budget exhausted | tokens > max_tokens | Pre-call check | Terminate with `RUN_BUDGET_EXCEEDED` |
| Policy block | Destructive tool without approval | Policy gate | Either pause for human or skip with observation; depends on tool |
| Tenant quota exceeded | Monthly tokens hit | Gateway / worker check | New runs rejected with 429; in-flight runs allowed to finish |
| Replay drift | Cached observation mismatch | Replay engine | Quarantine; alert; manual review |

## Retry policy — explicit, not default

Default `retry-everything-3x` is poison in agent systems because tool calls
have side effects. Retries are scoped:

- **Read tool calls** (`READ` side-effect class): retried at the gRPC layer
  with exponential backoff (3 attempts, jitter, 1s base).
- **Write / execute tool calls**: **never auto-retried** at the gRPC layer.
  Retries happen at the *graph* layer, by re-emitting a tool call from the
  coder node. Idempotency is enforced by `envelope_id`, so re-emitting the
  exact same envelope returns the cached result.
- **External-mutation tool calls** (e.g. webhook send): **never retried by
  the platform**. If the model wants to retry, it has to reason about it
  explicitly.
- **Model calls**: failover within the router, not retry of the same model.
  Idempotent by `call_id`.
- **Postgres writes**: retried at the asyncpg layer up to 3x with backoff.

## Replay — the load-bearing reliability feature

Anchored on the resume claim: *"50M spans/day, 2.5TB+ monthly trace data for
deterministic replay; cut org-wide MTTR for complex AI logic anomalies by 60%."*

### How replay actually works

A run is a sequence of `(node_name, input_state, model_calls, tool_calls,
output_state)`. Replay reconstructs the run by:

1. Pulling all checkpoints for `run_id` ordered by `seq`.
2. For each model call, hashing the canonicalized prompt; if the hash matches
   a cached response in the replay store, feeding the cached response back.
3. For each tool call, looking up the `envelope_id`; if cached, feeding the
   cached observation back.
4. Running the graph in a special **replay mode** that skips real network I/O
   in favor of cached responses, and asserts that the resulting state at each
   checkpoint matches the original.

Drift causes:

- Non-determinism in the prompt construction (rare but possible — e.g. `now()`).
- Floating-point reductions in scoring nodes.
- Node code changes since the original run (this is *expected* drift, not a
  bug; replay records the divergence point for the engineer).

### What's in a span

Every model call emits a span with:

```
attrs:
  run_id, tenant_id, project_id, node_name
  call_id, prompt_hash, model_chosen, candidates
  tokens_in, tokens_out, cost_micros
  duration_ms, ttfb_ms
  request_format, response_format
  routing_reason, degraded
events:
  routing_decision
  first_chunk
  tool_use_emitted (if any)
links:
  parent_run_span, prior_node_span
```

Every tool call emits a span with:

```
attrs:
  envelope_id, tool, args_hash, side_effect_class
  workspace_id, exit_code, duration_ms, observation_blob_key
  cpu_ms_used, memory_mb_peak, stdout_kb, egress_kb, cached
events:
  dispatched, log_lines, exit
links:
  emitting_model_call_span
```

The `prompt_hash` and `args_hash` are what give replay its leverage —
deduping by hash is what makes 2.5 TB of monthly data queryable instead of
inert.

### Trace sampling

- **100%** of error spans, runs flagged for replay, runs over $X cost, runs
  hitting `human_gate`.
- **5%** of successful runs sampled uniformly for SLO calculation.
- **100% of routing decisions** regardless of sampling — the router's
  decisions are small and we want a complete picture for evaluating the
  router.

Sampling decisions are made at the OTel collector tier, tail-based, so a
run that errors at node 11 still has all of nodes 1–10 retained.

## SLOs

The numbers we'd commit to externally for the agent layer (not the sandbox):

| Metric | SLO | Window |
| - | - | - |
| Run creation latency (POST /v1/runs to ack) | p95 < 500 ms | 30 d |
| Time-to-first-event (POST → first SSE) | p95 < 8 s | 30 d |
| Worker hot-failover after pod death | p95 < 60 s | 30 d |
| Successful run rate (modulo user-intent failures) | ≥ 98% | 30 d |
| Cost / run drift from baseline | ≤ 15% | weekly review |

Internal SLOs that drive paging:

- Sandbox dispatch p95 > 2 s for 5 min → page.
- Model router 429 rate > 5% for 5 min → page (likely API key saturation).
- Postgres checkpoint write p95 > 200 ms for 5 min → page.
- Run lease reaper backlog > 50 → page (workers churning).

## Observability layers

```
[ App OTel SDK ]    [ Go OTel SDK ]
       \                /
        v              v
   [ OTel Collector tier ]
        |     |     |
        v     v     v
    [ ClickHouse ]  [ Langfuse ]  [ Prometheus ]
        |
        v
  [ Replay engine + evidence exporter ]
```

- **ClickHouse** for span querying, replay, cost analytics. Schema designed
  around `prompt_hash`/`args_hash` so dedup happens at query time.
- **Langfuse** for the LLM-specific developer UX: prompt diffs, eval
  scoring, "show me the model output side-by-side with the cached version".
- **Prometheus** for the boring SLOs and dashboards.
- **Replay engine** is a separate service that pulls spans + blobs + state
  and runs the graph in replay mode.

## Debugging playbook for a failing Slack-clone run

The interview-grade version of "how do you debug an AI logic anomaly":

1. Open the run in Langfuse. Find the failing node and its parent span.
2. From the span, get the `prompt_hash` and the routing decision. Note the
   model and any failover.
3. Pull the surrounding tool calls. Was a sandbox call returning weird
   stderr that the coder misinterpreted?
4. Pull the last good checkpoint. Fork the run from there in **replay mode**.
5. Replay node-by-node. Watch for the divergence point — usually a brittle
   regex on tool output, a model that started returning a different JSON
   shape, or a retrieval that pulled stale memory.
6. Reproduce locally with the same `prompt_hash` and cached observations.
7. Fix in code, rerun replay, confirm convergence, ship.

Steps 1–6 take ~15 minutes when the trace data is good. That's the 60% MTTR
reduction the resume claims — and it's enabled by every model call having a
hash, every tool call having an envelope ID, and every checkpoint being a
complete state snapshot.

## Chaos drills I'd run quarterly

- Kill an agent worker pod in mid-run; confirm resume within 60 s.
- Block one model provider for 5 minutes; confirm router failover and SLO holds.
- Drain a sandbox node mid-run; confirm broker reroute.
- Corrupt a checkpoint row; confirm worker fails the run cleanly with
  `CHECKPOINT_CORRUPT` and alerts.
- Inject a prompt with a runaway loop pattern; confirm `loop_signature`
  detection parks the run.

Each drill produces a runbook entry. The list of runbooks is itself a SOC-2
evidence artifact.
