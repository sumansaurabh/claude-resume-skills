# 05 — Scaling and Capacity

## Headline numbers (from the resume)

- **10K+ agent runs / day** at the agentic layer.
- **1M+ daily zero-shot code executions** through the WASM sandbox plane.
- **1B+ tokens / month** through the model router.
- **50M spans / day** in the telemetry mesh, **2.5 TB / month** of trace data.

Translating to per-second arithmetic:

| Quantity | Daily | Per second average | Peak (assume 3x) |
| - | - | - | - |
| Agent runs | 10,000 | 0.12/s | 0.36/s |
| Sandbox calls | 1,000,000 | ~12/s | ~36/s |
| Tokens (in+out, both billed) | ~33M/day | ~390/s | ~1.2K/s |
| Spans | 50M | ~580/s | ~1.7K/s |

These are healthy but not extreme — the bottleneck is **dollars and provider
rate limits**, not requests per second.

## Capacity model — derivation

### Tokens per run

Working backwards from `1B tokens / month / 30 days ≈ 33M tokens/day` and
`10K runs/day`:

- **~3,300 tokens/run** *averaged*. The product mix is heavily skewed by
  "Slack-clone-grade" prompts which are much heavier (~120K–400K tokens) and
  many lightweight follow-ups (a few thousand tokens). The router's job is
  to keep the heavy class on appropriate models without dragging the cost.

For a Slack-clone walkthrough:

| Phase | Tokens (input / output) | Calls |
| - | - | - |
| Intake + retriever | ~3K / 0.5K | 1 |
| Planner | ~12K / 4K | 1–2 |
| Critic-of-plan | ~6K / 0.4K | 1 |
| Coder per milestone | ~10K / 3K | 1–4 per milestone × 8 milestones |
| Milestone critic | ~8K / 0.6K | 8 |
| Vision critic (UI screenshot) | ~6K / 0.3K | 1–3 |
| Memory writes (embedding) | ~3K | many |
| **Total** | **~180K–350K tokens** | ~40–80 model calls |

At ~$3/M input and ~$15/M output for the higher tier, this is **roughly
$0.50–$1.80 per Slack-clone run** in raw model spend, before retries.

### Sandbox tool calls per run

A Slack-clone run typically generates **30–80 sandbox calls**:

- 1 project scaffold (heavy: 20–40s)
- ~25 `write_files` (cheap: <100ms each)
- ~30 `run("tsc")` / `run("vitest")` (5–15s each)
- ~5 `preview` snapshots (2–5s each)
- 1 final `package_artifact` (10–20s)

### Compute footprint per run

The agent worker itself does almost no CPU work — it spends ~95% of wall-clock
in I/O wait on model and sandbox calls. **One worker pod with 4 in-flight
runs and 2 vCPU / 4 GiB RAM** is the sweet spot.

For 10K runs/day at 7-minute average wall-clock:

- Concurrent runs = `10000 × (7×60) / 86400` ≈ **49 concurrent runs**.
- Peak (3x burst, weekday afternoon US) = ~150 concurrent.
- At 4 runs/pod that's **~40 pods at peak**.
- HPA target: 70% of concurrent-run-quota per pod, scale on Redis stream lag.

## Bottlenecks, in order of likeliness

### 1. Model provider rate limits

By far the most common production constraint at this scale.

- Per-org TPM (tokens per minute) ceilings: Claude and GPT both enforce.
- A burst of 30 simultaneous Slack-clone runs can saturate a single API key.
- **Mitigation:** per-model **token-bucket** in the router, sharded across N
  API keys, with cross-region fanout. Adaptive concurrency that backs off
  on the first 429 instead of stampeding.

### 2. Sandbox cold-start latency

Each new sandbox workspace needs a filesystem prepared and a WASM runtime
booted. Cold start is ~500 ms; warm start (pooled) is ~30 ms.

- **Mitigation:** a warm pool sized to peak concurrent runs × 1.5. The
  pool autoscaler watches sandbox queue depth at the broker.

### 3. Postgres write throughput on `checkpoints`

Every node transition writes a row plus typically 2–4 model_call / tool_call
rows. For peak ~150 concurrent runs × ~12 nodes/run / ~7-min wall-clock that's
roughly **~5 writes/s steady, ~30 writes/s peak** — small. The real concern
is row width when `state_jsonb` grows.

- **Mitigation:** spill `messages` over 10 KB into S3 blobs by reference;
  keep the JSONB compact. Partition `checkpoints` by month and `run_id` hash.

### 4. ClickHouse ingestion at 50M spans/day

580 spans/s steady, 1.7K spans/s peak. ClickHouse handles this comfortably
with one shard, but the **OTel collector tier** is the bottleneck if span
sizes balloon (LLM spans can carry 100 KB prompt payloads).

- **Mitigation:** tail-sample LLM spans — keep 100% of error / slow / replay
  candidate spans, 5% of healthy fast spans. Drop free-form prompt payloads
  into a side blob and reference them by hash on the span.

### 5. Vector store query latency

Hybrid BM25+HNSW with cross-encoder rerank takes ~150–250 ms per retriever
call. At 0.4 retriever calls/s steady this is fine, but cross-encoder reranks
are CPU-hungry.

- **Mitigation:** keep cross-encoder rerank to a single 30-doc shortlist per
  call; scale rerank workers independently.

## Backpressure

The flow has three queues, each with explicit backpressure:

| Queue | Sized for | Backpressure signal | Action |
| - | - | - | - |
| Redis run stream | 30 s of peak | lag > 30 s | reject new `POST /v1/runs` with 503 + Retry-After |
| Sandbox broker dispatch | 5 s of peak | dispatch p95 > 2 s | broker returns `RESOURCE_EXHAUSTED`; agent worker exponential-backoffs |
| Model router queue | 200 ms of peak | queue wait > 200 ms | router returns `degraded=true` and routes to cheaper tier |

Backpressure must propagate **all the way to the UI**: if rate-limits are
biting, the user sees a real "rate-limited, will retry in N seconds" message,
not a silent stuck spinner. Each backpressure event is its own SSE `error`
with `recoverable=true`.

## Quotas

Quotas are checked at three layers:

1. **Tenant quota** (per month): tokens, runs, sandbox seconds, artifact bytes.
   Enforced by the gateway and by the worker before every model/tool call.
2. **Project budget** (per run): user-supplied `max_tokens`,
   `max_tool_calls`, `max_wallclock_ms`. Enforced by the executor.
3. **Per-tool budget** (per call): the `Budget` field in the gRPC envelope.
   Enforced by the sandbox broker.

The first quota check failure terminates the run with `RUN_BUDGET_EXCEEDED`
or `TENANT_QUOTA_EXCEEDED` so the UI can show a useful message.

## Cost controls

A 1B-tokens/month platform that doesn't actively manage cost dies of margin
compression. Concrete controls:

- **Routing tiers**: heavy planning to Claude long-context, code patches to
  GPT 4.1, bulk classification / critics to Haiku-tier or Grok.
- **Prompt cache reuse**: Claude prompt cache for the planner system prompt
  + plan + repository context. Reuses save ~70% of input tokens on
  multi-milestone runs.
- **Context budgeting**: each node has a token budget for the prompt; the
  retriever and memory layer must fit inside it. Over-budget = summarize.
- **Cache observations by `args_hash`**: the same `pnpm tsc` after the same
  diff returns the cached observation. Saves 10–20% of sandbox cost on
  ReAct loops that get stuck retrying.
- **Per-tenant pricing tiers** map to `CostClass` hint; cheaper tenants
  default to Grok-first routing.

## Growth plan

| Horizon | Step | Cost / Effort |
| - | - | - |
| 30K runs / day | Scale agent worker pods 3x, add second Postgres replica, double sandbox node count | low — same architecture |
| 100K runs / day | Shard `runs` and `checkpoints` by tenant hash, move tool registry to a stronger cache, regional model API keys | medium |
| 1M runs / day | Externalize the LangGraph IR (protobuf), make the executor a Go service, keep node bodies in Python over an in-process bridge — Python is the bottleneck above ~20K concurrent runs | high — multi-quarter |
| 10M runs / day | Hot/warm tiering for trace data; ClickHouse on object storage; multi-region active-active control plane | high |

The honest principal-engineer answer is that LangGraph's executor is fine for
the 10K runs/day reality; the upgrade path is "stop using LangGraph as the
runtime, keep using its graph definition" — and that's a year-long migration
to do well.
