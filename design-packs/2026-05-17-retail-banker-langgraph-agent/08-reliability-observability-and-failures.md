# 08 - Reliability, Observability, and Failures

## Reliability principles

1. **Fail safe, not silent.** Every node has an explicit error path that
   either degrades (returns partial answer with a `confidence: low`) or
   refuses (asks the user to retry / escalates). No node ever silently
   returns wrong numbers.
2. **Checkpoint per node.** LangGraph's checkpointer snapshots
   `BankerState` after every node transition. A worker crash mid-turn
   is resumed by another worker from the last completed node, not from
   scratch.
3. **Idempotent writes.** Every action carries an idempotency key
   (`sha256(turn_id || tool || canonical(args))`). Replays produce the
   same outcome.
4. **Per-tool circuit breakers.** Three consecutive failures or p95
   > 4x baseline trips the breaker; node-level handlers see a
   `ToolDegraded` exception and either skip or fall back.
5. **Provider failover by capability class.** LLM provider down → next
   provider with same capability (tool-calling, structured output);
   if class can't be matched, the explainer falls back to a templated
   answer with the deterministic calculator output.
6. **Bounded retries.** Default 2 retries with jitter for transient I/O.
   No retry on policy-denied or schema-validation errors — those are
   user-visible.

This is the same durability story we built at BlackBox: graph workflow
engine with DAG execution, checkpointing, retry semantics, durable
execution supporting 10K+ agent runs/day (`resume.txt` L51-54,
`blackbox-experience.md` #12-#15). The lift to a higher-availability
banking surface is mostly about *more aggressive* circuit-breaking and
*stricter* HITL on writes, not new primitives.

## Failure taxonomy

| Class | Example | Detection | Handling | User-visible |
|---|---|---|---|---|
| **Transient I/O** | Core Banking 5xx | 5xx + retryable code | retry 2x w/ jitter | none if recovered, else degraded answer |
| **Tool timeout** | RAG store slow | timeout > spec | drop tool, continue, mark partial | "I couldn't fetch full context — quick answer below" |
| **LLM provider down** | 429 / 5xx storm | error-rate + p99 | failover to alt provider, then template | none if failover succeeds |
| **Schema validation** | LLM returned malformed JSON | Pydantic raises | one repair attempt with stricter prompt; else templated | "I had trouble formatting — here's the data" |
| **Policy deny** | action disallowed | OPA decision = deny | surface as decline w/ reason | yes — explicit refusal |
| **Reflection failure** | LLM cited number drifted | comparator | force retry with hard-pinned number | none |
| **Calculator error** | invalid input from tool | Pydantic raises | fail closed; user sees "couldn't compute right now"; alert on-call | yes — apologetic |
| **Idempotency conflict** | replayed confirm with different payload | unique constraint | reject 409 | yes — "this looks like a duplicate" |
| **Quota exhausted** | user hit 200 turns/day | gateway | 429 w/ Retry-After | yes — "please come back tomorrow" |
| **PII redaction failure** | egress regex catch | telemetry alert | fail closed; reject prompt | yes — generic "try again" + page on-call |
| **Memory contamination** | fact write rejected by review gate | gate decision | skip write; log | none (silent correctness) |
| **HITL backlog** | aged ticket | queue monitor | escalate; notify customer | yes — proactive update |

## Retry and backoff matrix

| Component | Strategy | Cap |
|---|---|---|
| Core Banking read | exp backoff 50ms × 2 | 2 retries |
| LLM call | retry once on 5xx; failover otherwise | 1 retry + 1 failover |
| Checkpoint write | retry 3x | hard fail trips SEV-3 |
| Tool write (action) | idempotent → safe; retry 3x | 3 retries |
| Memory write | retry 2x; coalesce | 2 retries |

## Observability stack

Same shape as BlackBox's LLMOps telemetry mesh (50M spans/day, 2.5 TB
monthly, 60% MTTR cut — `resume.txt` L58-59) sized down to this
product:

| Layer | Tool | What it captures |
|---|---|---|
| App + node spans | OpenTelemetry SDK | hierarchical span per turn → per node → per tool |
| Collector | OTel Collector | batch, attribute-redact PII, ship |
| Storage | ClickHouse | sharded by `customer_id` hash, partitioned by day, zstd |
| LLM-specific traces | Langfuse | prompts, responses, model, latency, cost, eval scores |
| Metrics | Prometheus | rate, error, latency per node/tool; cost/turn; quota usage |
| Logs | structured JSON via OTel logs | redacted; correlation by `trace_id` |
| Alerting | Alertmanager + PagerDuty | SLO breach, error budget burn, eval regression |
| Dashboards | Grafana | per-route p95, per-node error rate, per-model cost share |

## Span shape (per LLM call)

```json
{
  "name": "llm.call",
  "attributes": {
    "purpose": "explainer",
    "provider": "claude",
    "model": "claude-sonnet-4-6",
    "prompt_hash": "sha256:...",
    "input_tokens": 1487,
    "output_tokens": 312,
    "cached_input_tokens": 1200,
    "latency_ms": 1340,
    "cost_usd": 0.0043,
    "structured_output_ok": true,
    "tool_calls": 0,
    "trace_id": "01HXZ...",
    "turn_id": "turn_01HXZ...",
    "customer_id": "cust_***",      // tokenized
    "reflection_pass": true
  }
}
```

Span shape for tool calls mirrors the LLM call but adds
`tool.name`, `tool.version`, `args_hash`, `result_hash`,
`side_effect`. The full tool-call envelope from
[04-api-and-contracts.md](04-api-and-contracts.md) is the on-disk
representation.

## Deterministic replay

The single most valuable observability capability for an agent product.
Same pattern as BlackBox (`blackbox-experience.md` #20).

**Replay = re-execute a turn deterministically, given:**

1. The original `BankerState` at the turn's entry.
2. The captured tool envelopes (input + output hash) — *or*, in
   **live-replay** mode, re-execute the tools against current data.
3. The pinned model versions and seeds (where the provider exposes them).
4. The policy bundle hash that was active at the time.

**Two replay modes:**

- **Fixture replay** (audit, dispute): use captured tool outputs. Useful
  for "what did the system say last Tuesday at 14:32, and why?" Tool
  outputs are frozen; LLM outputs may differ (frontier models drift),
  so we compare on **decision** (intent, recommendation, action) not
  literal token output.
- **Live replay** (drift detection, eval): re-execute tools against
  *current* data. Useful for "if a customer asked this question today,
  what would we answer?" Used in nightly eval against golden set.

**Why both:** the dispute story needs Fixture; the regression story
needs Live. We learned at BlackBox that conflating these two is the
fastest way to lose trust in your replay output.

## SLOs

| Slo | Target | Error budget (30d) |
|---|---|---|
| Conversational turn success | 99.9% | 43 min |
| Conversational p95 latency | < 3 s | 30 min/month above |
| Action success | 99.95% | 21 min |
| HITL action SLA | < 10 min p95 | 1% violations |
| Numerical correctness (random audit) | 100% | 0 incidents |
| Eval regression on golden set | < 5% drift | 1 release block/week max |

## Eval harness

- **Golden set:** 500 curated conversations across personas, intents,
  languages.
- **Replay:** run candidate model/prompt against the set in CI; LLM-judge
  + rule-judge score.
- **Rule judges** check: (a) all numbers match deterministic calculator
  output; (b) `confidence` is calibrated against historical accuracy;
  (c) no PII tokens leak in output; (d) refusals trigger on out-of-scope.
- **Gate:** any 4-point drop on the composite score blocks deploy until
  reviewed.

## Debugging a real incident

Walkthrough for "customer says agent told them they had ₹3 lakh but
their balance was ₹30k":

1. Open trace by `customer_id` + timestamp → find `turn_id`.
2. Inspect `state_redacted` at every node.
3. Read `calc.balance_delta` — was the number wrong at the source?
4. Read tool envelope for `core_banking.get_balances` — what did core
   actually return?
5. Read `draft.numbers_cited` vs `calc.balance_delta` — did reflection
   pass when it shouldn't have?
6. Read LLM `explainer` span — did the model invent the number? If
   `prompt_hash` shows the right number in input but output drifted,
   that's a reflection-gap bug; fix the comparator.
7. Reproduce with **Fixture replay**; verify fix removes the bug.

Target MTTR for this class of bug: **< 60 minutes**. The 60% MTTR
reduction at BlackBox was exactly this story (`resume.txt` L58-59).

## Disaster recovery

| Scenario | RTO | RPO | Plan |
|---|---|---|---|
| Region outage (active-active) | < 5 min | 0 | LB failover; checkpointer cross-region replication ≤ 5 s lag |
| Postgres primary loss | < 10 min | < 5 s | standby promotion; quorum write |
| ClickHouse cluster loss | < 30 min | < 1 hr | restore from S3 tier; new turns served, replay degraded during restore |
| LLM provider outage | < 30 s | 0 | router failover; cached-explanation mode for high-traffic intents |
| Total agent platform down | < 15 min | 0 | gateway routes to "agent unavailable, here's the IVR" fallback; no money lost |

## Game days

Quarterly:

1. Inject Core Banking 5xx → verify graceful degradation.
2. Drop a primary Postgres → verify checkpoint resume on new worker.
3. Disable Claude provider entirely → verify failover.
4. Corrupt a tool's response schema → verify reflection catches mismatch.
5. Replay 1k golden turns in live mode → verify no regression spike.
