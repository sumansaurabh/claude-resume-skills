# 08 — Reliability, Observability, and Failure Modes

This document covers the reliability contract, failure-mode taxonomy, retry semantics, checkpointing, compensation, observability stack, deterministic replay, debugging playbooks, disaster recovery, and chaos discipline for the B2C agent orchestrator + catalog. The design is anchored on durable execution + telemetry mesh patterns from `resume.txt:53-54`, `resume.txt:58-59`, `resume.txt:60-61`, `blackbox-experience.md` points 8, 12, 13, 15, 20, 34, 35, 36, and gang-scheduled retry behavior from `microsoft-experience.md` point 9.

---

## 1. SLOs per surface

SLOs are tiered: control plane (synchronous CRUD), data plane (asynchronous agent run), catalog (browse / discovery). Free tier degrades first under load; paid tier holds the harder targets.

| Surface | Endpoint examples | Availability (monthly) | p50 latency | p99 latency | Error budget / 30d | Free vs Paid |
|---|---|---|---|---|---|---|
| Control plane — `OrchestratorAPI` CRUD | create agent, update prompt, save tool config | 99.95% | 80 ms | 400 ms | 21.6 min | Same target; free tier rate-limited to 60 req/min |
| Control plane — `CatalogAPI` browse | list, search, get-by-slug | 99.95% | 60 ms | 350 ms | 21.6 min | Cached at edge; same target both tiers |
| Data plane — `AgentRuntime` run start (queue accept) | `POST /runs` returns `run_id` | 99.9% | 120 ms | 700 ms | 43.2 min | Same target |
| Data plane — agent run completion (single-node simple agent) | end-to-end wall clock | 99.5% (success rate) | 3 s | 18 s | 3.6 hr | Free: 99.0% success, p99 30 s; Paid: 99.5%, p99 18 s |
| Data plane — agent run completion (multi-step DAG, 5–20 nodes) | end-to-end | 99.0% (success rate) | 12 s | 90 s | 7.2 hr | Free: 98.0%, p99 180 s; Paid: 99.0%, p99 90 s |
| `ModelGateway` token throughput | first-token-latency | 99.9% | 350 ms | 1.8 s | 43.2 min | Paid pinned to faster pool; free shares burst pool |
| `MemoryService` retrieval (RAG read) | top-k pgvector + rerank | 99.9% | 90 ms | 450 ms | 43.2 min | Same target |
| `ConnectorBroker` tool call | OAuth-mediated upstream call | 99.5% (success rate) | 250 ms | 2.5 s | 3.6 hr | Same target; upstream dependent |
| `HITL` decision turnaround | user approval click | n/a (user-bound) | n/a | 24 h default TTL | n/a | Free: 4 h TTL; Paid: 24 h TTL |

**Budget enforcement:** burn-rate alerts at 2% / hr (page on-call), 5% / hr (page lead + freeze risky rollouts). Mirrors the AutoML 15M+ jobs/month operational discipline in `microsoft-experience.md` point 13 — high-volume orchestration with explicit success-rate SLOs is non-negotiable.

---

## 2. Failure mode taxonomy

| # | Failure mode | Likely root cause | Blast radius | Detection signal | Mitigation |
|---:|---|---|---|---|---|
| F1 | LLM provider 5xx | Anthropic/OpenAI/xAI outage or 429 throttle | All runs routed to that provider; cross-tenant | `ModelGateway` 5xx rate > 2% over 60 s; provider-tagged p99 latency spike | `Router` fails over to alt provider with same capability class; emit `model_fallback` event; cost flag if fallback is more expensive |
| F2 | LLM provider rate-limit | Tenant token bucket exhausted at provider | Single tenant or whole org bucket | 429 from provider; `tokens_inflight` near cap | Per-tenant local rate-limit smoothing; queue with backoff; degrade free tier first |
| F3 | LLM provider quality regression | Provider silently updated model weights | Cross-tenant; subtle (no error) | Eval-canary score drop on shadow traffic; user thumbs-down rate spike | `Router` mirrors 1% of traffic to a frozen reference build; if canary eval drops > 5 pts MMLU-style, pin model_version and fall back |
| F4 | `ToolCaller` timeout | Slow upstream, network blip, big payload | Single run step | Span duration > per-tool budget; `tool_timeout` counter | Per-tool budget enforced by `ToolCaller`; step marked failed; escalate to `Critic` for retry decision or to `HITL` if effect was `external_send` |
| F5 | Connector OAuth token expired | Token TTL elapsed mid-run | Single user-connector pair | 401 from upstream; pre-flight refresh failure | Background refresh worker runs at TTL × 0.7; mid-run `ConnectorBroker` refresh attempt; if refresh fails, run pauses with `ConnectorReauthRequired` |
| F6 | Connector upstream outage | Gmail / Slack / GitHub / Notion down | All runs that use that connector | Connector error rate > 10% over 2 min; provider status page webhook | Circuit breaker per connector (open after 20 errors / 60 s, half-open after 30 s); degrade to cached data where read-only; surface `ConnectorDegraded` to user |
| F7 | `SkillExecutor` sandbox kill | Sandbox enforced timeout / memory / syscall limit | Single skill invocation | Exit code from sandbox supervisor; `sandbox_kill_reason` tag | Kill is correct behavior from isolation POV (per `blackbox-experience.md` point 4 — 1M+ daily executions must isolate); run treats as `ToolError`; `Critic` decides retry vs fail |
| F8 | `SkillExecutor` OOM | User code grew heap past WASM linear memory cap | Single skill invocation | OOM signal from WASM runtime | Kill, return `MemoryLimitExceeded` to `ToolCaller`; not retried automatically (likely deterministic) |
| F9 | `MemoryService` pgvector slowdown | HNSW index hot-shard, vacuum lag, noisy neighbor | All runs using that namespace | Per-query timeout > 300 ms p99; `pgvector_query_ms` histogram | Per-query timeout 500 ms; on timeout, fall back to no-RAG context with `degraded=true` flag in run-event log; user sees soft warning |
| F10 | Pgvector index corruption | Disk corruption, partial write during crash, bad migration | One namespace | HNSW probe checksum mismatch; query results semantically wrong | Rebuild index from `documents` table (source of truth); reads served from prior read-replica snapshot during rebuild |
| F11 | Run worker crash mid-run | Pod OOM, node loss, deploy-time SIGTERM | Single run | Worker heartbeat lost; `run_state=Running` but no events for > heartbeat × 3 | Durable run state in Postgres + run-event log; lease reaper unblocks lease; another worker resumes from last checkpoint. Anchored on `resume.txt:53-54` (checkpointing for resumable agents) |
| F12 | Run queue backup | Surge of free-tier traffic; provider lag stretching runs | Whole platform | Queue depth > 3× normal; oldest-message-age > 60 s | Shed load: return 503 to free tier with `Retry-After`; paid tier preserved; client SDK exponential backoff |
| F13 | Postgres primary failover | HA failover triggered | Whole platform briefly | Connection errors; replication lag stall | 30 s failover budget (managed RDS / Aurora-style); runs pause at next checkpoint until WAL catches up; `Gateway` returns 503 for control plane writes only |
| F14 | Redis eviction of `WorkingMemory` | Cluster memory pressure under load; LRU eviction | Affected runs | `run:{id}:hot` cache miss with active run; eviction count metric | Re-derive working memory from run-event log; if event log gap or non-replayable side effect, fail run with `retryable=true` and `reason=hot_state_lost` |
| F15 | `Gateway` WAF rule false positive | Overzealous WAF on legitimate prompt content | Subset of users matching the pattern | `waf_block` rate jumps; user-reported failures cluster | Auto-rollback rule via canary (5% sample mode for new rules); manual override list for known-good tenants |
| F16 | `HITL` never approved | User abandoned, missed notification, away | Single run | TTL hit (4 h free / 24 h paid) | Run fails with `HITLTimeout`; partial work + reasoning trace preserved; user can clone+resume from checkpoint |
| F17 | Deterministic replay diverges | Provider stochasticity (temperature > 0, hidden randomness) | Single replay attempt | Replay output hash ≠ recorded output hash | Surface as warning, not error; recommend re-run with `temperature=0` + `seed` pinned; replay tool can still inspect recorded prompts/responses |
| F18 | `GuardrailService` regex/classifier false positive | Overly broad PII or jailbreak pattern | Subset of prompts | Block rate spike; user complaints | Tenant-scoped allowlist override; shadow mode for new rules for 7 days before enforce |
| F19 | `IngestionPipeline` poison document | Adversarial doc reshapes RAG retrieval | One namespace | Embedding distribution drift; retrieval grounded-ness eval drop | Per-document provenance and revocation; bad doc tombstoned; index re-derived from remaining docs |
| F20 | `TelemetryMesh` ingestion lag | Clickhouse buffer pressure; Kafka backpressure | Visibility loss, not user-facing | Span ingest lag > 60 s; Kafka consumer lag | Drop INFO/DEBUG spans first; preserve ERROR/HITL/guardrail spans (100% retained per sampling policy in §6) |

Cross-anchor: F11 retry-from-checkpoint, F13 worker-loss handling, and F7 sandbox-kill semantics together mirror the `microsoft-experience.md` point 9 retry pattern (node loss, CUDA OOM, network failure, bad user code, data corruption all funnel through one retry pipeline with different policies per cause).

---

## 3. Retry semantics

Retry policy is **per-tier**, not global. Wrong-tier retries are the #1 source of duplicate side effects in agent systems.

| Tier | Examples | Default policy | Backoff | Idempotency requirement |
|---|---|---|---|---|
| Idempotent read | `CatalogAPI` list, `MemoryService` retrieve, `OrchestratorAPI` GET | 3 retries | Exponential w/ full jitter, base 100 ms, cap 5 s | None — read-only |
| Non-idempotent write (client → us) | `POST /runs`, `POST /agents`, billing-affecting writes | 0 retries by default | n/a | Client MUST provide `Idempotency-Key`; server stores key + result for 24 h |
| Tool call (agent → upstream) | Gmail send, Slack post, GitHub API write, HTTP webhook | Per-descriptor `safe_to_retry` flag; default false | Descriptor-specified; default 1 retry after 500 ms for `safe_to_retry=true` | Tool descriptor declares `effect` class (see §5) |
| Model call (`ModelGateway` → provider) | Anthropic, OpenAI, xAI | Provider-side retry with budget (2 attempts, 1 s + 4 s) before fallback | Exponential | Provider responses cached by `(model, prompt_hash, temperature, seed)` for replay |
| Fallback to alt provider | After F1/F2 exhausts primary | At most 1 fallback per node | Immediate switch | `model_fallback` event recorded; cost delta tracked |
| Run-level resume after worker loss | F11 | Unbounded (driven by lease reaper); each resume increments `attempt_count` | Lease reaper polls every 10 s | Idempotency anchored on `run_id` + `node_id` + `attempt_count` |

Anchors: `resume.txt:53-54` ("retry semantics enabling long-running, resumable agents with memory persistence and fault-tolerant execution"), `blackbox-experience.md` point 13 (DAG execution + checkpointing + retry semantics together), `microsoft-experience.md` point 9 (heterogeneous retry causes need heterogeneous retry policy).

**Hard rule:** any tool descriptor with `effect ∈ {write, external_send, irreversible}` defaults to `safe_to_retry=false`. The author must explicitly justify safe-to-retry with an idempotency story (e.g., `Idempotency-Key` header to Stripe, or `messageId` for Slack chat.postMessage).

---

## 4. Checkpointing model

Anchored on `resume.txt:53-54` and `blackbox-experience.md` point 12 (graph workflow engine with DAG execution + checkpointing + retry semantics).

**What gets checkpointed per `AgentRuntime` node:**

- `node_id`, `node_type` (Planner / Router / ToolCaller / Critic / HITL / Memory / Model)
- Node entry: input bindings (resolved from prior node outputs + run inputs), prompt hash, model + version, tool descriptor IDs
- Node exit: output payload, tool results, model response (cached by `(prompt_hash, model, temperature, seed)`), token counts, cost
- Side-effect class (read / write / external_send / irreversible) and whether the effect was applied

**Where it lives:**

- **Postgres `runs.state_json`** — cold, durable, source of truth. Compact projection of state needed to resume. Fsync'd on every node exit.
- **Postgres `run_events`** — append-only event log keyed by `(run_id, seq)`. Every node entry and exit emits an event; tool calls and model calls emit child events. Used for replay and for re-deriving working memory if Redis evicts (F14).
- **Redis `run:{id}:hot`** — hot working memory: rolling conversation window, current node, in-flight tool call handles. TTL 1 h sliding; backed by `run_events` so eviction is recoverable.

**Resume from checkpoint logic** (worker takes lease on a `Running` run with no recent heartbeat):

1. Load `runs` row; verify `run_state ∈ {Running, Paused}` and lease expired.
2. Replay `run_events` for that `run_id` from the last `node.exit` event to rebuild working state in Redis.
3. Resume from the next node after the last completed node. If the last event is a `node.entry` without matching `node.exit`, re-execute that node (idempotency must hold per §3 + §5).
4. Emit `run.resumed` event with `previous_worker_id` and `attempt_count++`.
5. Heartbeat every 10 s to renew lease.

This is structurally the same pattern as the Microsoft AutoML state machine (`microsoft-experience.md` point 22 — queued / preparing / running / retrying / failed / canceled / completed / artifact-publishing), narrowed to agent-run semantics.

---

## 5. Compensation / saga model

Long-running agents are not transactional. A run can apply real-world side effects (email sent, GitHub issue created, Stripe charge made) and then fail two steps later. We use a **per-tool descriptor effect model + best-effort compensation** rather than a true distributed transaction.

**Tool descriptor declares one of:**

| `effect` | Semantics | Default retry | HITL default | Compensation |
|---|---|---|---|---|
| `read` | Pure read; no upstream state change | 3 retries | No | n/a |
| `write` | Mutates upstream state; idempotent if key provided | 1 retry if `safe_to_retry=true` | No (unless tenant policy says yes) | Best-effort undo if API exists |
| `external_send` | Sends a message visible to a third party (Gmail send, Slack post, SMS) | 0 retries by default | **Yes** by default | Retract within provider undo window (e.g., Gmail undo, Slack delete) |
| `irreversible` | No undo possible (Stripe charge, prod deploy, DB DROP, payment refund) | 0 retries | **Yes** mandatory | None — `Critic` MUST gate; run aborts to `HITL` before execution |

**Run-level rules:**

1. For `irreversible`, the run **must checkpoint immediately before** the call and immediately **after** the call. The next node is gated until the after-checkpoint commits.
2. For `external_send`, default to `HITL` unless the tenant has explicitly waived approval for that tool (e.g., a marketing tenant pre-approves Slack-to-internal-channel sends).
3. Compensation is best-effort: per-tool registered `compensate(tool_call_id)` function. Gmail: send recall within window. Slack: `chat.delete`. GitHub: close issue with note. Stripe: refund (recorded as separate ledger entry — never silent reversal).
4. If compensation fails or is not possible, run is marked `PartiallyCompleted`. User sees an explicit summary: "Sent email to X (cannot recall), then failed before scheduling follow-up. No retry — clone run to continue."

This avoids the worst failure mode of agents-with-tools: silent duplicate side effects from naive retry. Maps directly to `blackbox-experience.md` point 16 (partial failure with already-executed side effects) and point 17 (idempotency for tool calls made by AI agents).

---

## 6. Observability stack

Anchored on `resume.txt:58-59` (50M spans/day, 2.5TB+ monthly trace data, deterministic replay), `resume.txt:60-61` (Clickhouse + OpenTelemetry stack), and `blackbox-experience.md` point 34 (sampling without losing rare failures).

**Tracing — OpenTelemetry from every service.**

- Each agent run is a single root trace.
- One span per node (`Planner`, `Router`, `ToolCaller`, `Critic`, `HITL`, `Memory`).
- Child spans: every `ModelGateway` call (with `model`, `prompt_hash`, `temperature`, `seed`, `model_version`, `prompt_tokens`, `completion_tokens`, `cost_usd`), every `ConnectorBroker` call, every `MemoryService` retrieve.
- Spans per run: 50–200 average for multi-step DAGs.
- At platform scale: 10K runs/day baseline (per `resume.txt:51-52`) growing to the BlackBox-anchored **50M spans/day** target (`resume.txt:58-59`).

**Storage:**

- **Clickhouse** for spans, run events, eval scores (`resume.txt:60-61`). Column-oriented, cheap aggregate queries over 2.5TB+ monthly trace data.
- TTL: 30 days hot, 90 days cold (S3-backed Clickhouse), 13 months sampled archive for trend analysis.

**Sampling policy (head + tail):**

| Class | Sampling | Rationale |
|---|---|---|
| Run with any error span | 100% kept | Always debug errors |
| Run that triggered `HITL` | 100% kept | Human decisions are audit-worthy |
| Run that triggered `GuardrailService` block | 100% kept | Safety review |
| Free tier successful run | 100% kept | User support pipeline — free users complain loudest, fastest to surface bugs |
| Pro tier successful run | 10% kept (tail-sampled) | Volume control without blinding ourselves to regressions |
| `ModelGateway` calls inside kept runs | 100% kept | Replay depends on full prompt/response chain |
| `TelemetryMesh` internal spans | 1% kept | Avoid recursion explosion |

Tail sampling is done at the `TelemetryMesh` collector — a span is buffered until the run terminates, then the keep/drop decision is made with full trace context. This matches the `blackbox-experience.md` point 34 design pattern (sampling that does not lose rare failures).

**Metrics — USE per service, RED per endpoint.**

- USE: Utilization (CPU, mem, GPU), Saturation (queue depth, pool wait), Errors (per-cause counter) on `AgentRuntime`, `ModelGateway`, `MemoryService`, `ConnectorBroker`, `SkillExecutor`.
- RED: Rate, Error %, Duration (p50 / p95 / p99) per `Gateway` / `OrchestratorAPI` / `CatalogAPI` endpoint.
- Business: `runs_per_tenant_per_day`, `cost_per_run`, `tokens_per_tenant`, `hitl_response_time`, `eval_score_rolling_p50`.

**Logs — structured JSON.**

- One log entry = one event with `run_id`, `tenant_id`, `node_id`, `event_type`, `severity`.
- PII and OAuth token redaction at the SDK layer (regex + denylist of header names + structured field tagging).
- 30-day retention; ERROR severity replicated to 90-day cold.

---

## 7. Deterministic replay

Anchored on `resume.txt:58-59` (telemetry mesh for deterministic replay), `blackbox-experience.md` point 8 (deterministic replay for code execution + agent workflows under nondeterministic LLM calls), and `blackbox-experience.md` point 20 (50M spans/day for deterministic replay, MTTR cut 60%).

**How it works:**

1. Every node's inputs, model call (prompt + response + `model_version` + `temperature` + `seed`), tool call (request + response), and memory retrieval (query + results) are persisted to `run_events` with monotonic `seq`.
2. The replay tool reads `run_events` for a `run_id` and runs the agent graph in **replay mode**: `ModelGateway` and `ToolCaller` are wired to read recorded outputs from `run_events` instead of calling the real provider.
3. Replay produces a new trace tagged `replay_of=<original_run_id>` and a diff of node outputs.

**Stochasticity caveats:**

- Provider stochasticity at `temperature > 0` means replay may diverge from the original. We record `temperature`, `seed` (when provider supports it), `top_p`, `model_version` per call.
- If replay diverges, the tool reports it as `ReplayDivergence` with the diff, not an error.
- For audit and support cases, we run replay with `temperature=0` and reuse recorded model outputs — this is structurally deterministic and is the supported "what did the agent see and decide" debug path.

**Use cases:**

- Debugging an anomalous run (root cause without re-paying for tokens).
- Reproducing a customer-reported bug.
- Pre-rollout regression check: replay 10K representative runs against a new model version and diff outputs (this is also how F3 is detected).

---

## 8. Debugging playbooks

Anchored on `blackbox-experience.md` points 35 and 36 (debug AI logic anomalies; cut MTTR 60% via observability + replay).

**Playbook A — "Run stuck in Planning state"**

1. Open run trace by `run_id`. Inspect `Planner` span duration.
2. If `model_call.duration > 30 s`: check `ModelGateway` provider-tagged latency dashboard. Likely F1/F2.
3. If `planner_loop_count > MAX_PLANNER_ITERATIONS`: the planner is thrashing — inspect last 3 plans for cyclic intent; check if `Critic` is rejecting plans (it should escalate to `HITL` after N rejects, see §5).
4. If span is short but state is stale: F11 (worker crash). Check worker heartbeat; lease reaper should resume.
5. If none above: check `run_queue_depth` — F12 means the run never started.

**Playbook B — "User says agent returned wrong tool output"**

1. Pull run trace; find `ToolCaller` span for the disputed step.
2. Examine raw tool request and response in `run_events` (PII-redacted view).
3. If response looks right but agent reasoned wrong: replay deterministically (§7); inspect `Critic` decision.
4. If response looks wrong: check `ConnectorBroker` span for upstream version / API contract drift; check connector dashboard for F5/F6.

**Playbook C — "Memory not retrieved as expected"**

1. `MemoryService` span — confirm query embedding model version matches the index version.
2. Top-k similarity score distribution: if max score < 0.4, query is off-topic for that namespace.
3. Namespace filter: confirm `tenant_id` + `namespace` match what was indexed.
4. If embedding model was upgraded but namespace was not re-embedded: that's the bug — re-embedding job needs to run.

**Playbook D — "Connector returned 401 mid-run"**

1. `ConnectorBroker` span — extract `connector_id`, `token_id`.
2. Check token expiry vs span timestamp: if expired, F5.
3. Check refresh worker logs for that `token_id` — did refresh attempt run? Did it succeed? Did the refresh token itself expire (re-auth required from user)?
4. If refresh worked but call still 401'd: scope drift at upstream — user revoked scope; surface to user with re-auth prompt.

MTTR target: **median 8 min** for these four playbooks (anchored on the 60% MTTR reduction claim in `resume.txt:58-59`).

---

## 9. Disaster recovery

**Targets:**

- **RPO: 5 min.** Postgres logical replication to standby region every 5 min + S3 base backups every 6 h with WAL shipping. `run_events` and `runs` are the survival-critical tables.
- **RTO: 30 min** for primary-region partial outage; **4 hours** for full region loss.

**Runbook — region failover:**

1. Confirm primary-region health via three signal sources (cloud provider status, internal synthetic, `TelemetryMesh` from out-of-region prober).
2. Promote standby Postgres in DR region; verify WAL replay caught up.
3. Cut over `Gateway` DNS (TTL 60 s) to DR region's load balancer.
4. Resume `AgentRuntime` workers in DR; lease reaper picks up paused runs from the promoted Postgres.
5. `ModelGateway` reconfigured to use provider regional endpoints local to DR.
6. Announce `RegionFailover` status on status page; in-app banner.

**User-visible impact:**

- In-flight runs **pause** (not fail) at the next checkpoint.
- Once standby promotes, runs **resume** from checkpoint per §4.
- Catalog browse and unauthenticated reads stay available via edge cache during the window.
- Free tier may be temporarily throttled to preserve DR capacity for paid tier.

The pause-then-resume property is only possible because checkpointing (§4) is the foundation, not bolt-on — same architectural choice as the durable-execution claim in `resume.txt:53-54`.

---

## 10. Chaos and resilience testing

Anchored on `microsoft-experience.md` point 9 (job retries / node loss / OOM / network failure / bad user code / data corruption — all of which are made real by chaos drills, not assumed).

**Game-day cadence:** monthly in staging, quarterly in production (limited blast radius, paid tier excluded).

**Drill inventory:**

| Drill | Method | Pass criteria |
|---|---|---|
| Kill random `AgentRuntime` pod mid-run | `kubectl delete pod` during 100 active runs | All 100 runs resume within 60 s; no duplicate side effects (audit via `run_events`) |
| `ModelGateway` provider throttle | Inject 429 for 50% of Anthropic calls for 5 min | Fallback to alt provider within 3 attempts; `model_fallback` event count matches; user-visible run success rate unchanged |
| Corrupt one pgvector namespace | Drop HNSW index manually | F9 fallback triggers; rebuild from `documents` completes within 10 min; reads served from snapshot during rebuild |
| Expire all OAuth tokens for one connector | Manual token revoke in test tenant | F5 path: background refresh worker triggers; runs in flight pause cleanly; user sees re-auth prompt |
| Redis flush during active runs | `redis-cli flushall` against a test cluster shard | F14 path: working memory re-derived from `run_events` for replayable runs; non-replayable runs fail with `retryable=true` |
| Postgres primary kill | Terminate primary instance | Failover within 30 s; runs resume; no `run_events` lost (verified by `seq` continuity check) |
| `Gateway` WAF false-positive injection | Add overly broad rule | Canary catches it within 5 min on 5% sample; auto-rollback |
| Saturate run queue | Burst 10× normal submission rate | F12 path: free tier 503'd with `Retry-After`; paid tier preserved; no run silently dropped |
| `SkillExecutor` mass kill | Trigger OOM in 100 concurrent sandboxes | All return `MemoryLimitExceeded` to caller; no runtime host destabilization (anchored on `blackbox-experience.md` point 4 — 1M+ daily isolated executions) |

Findings are tracked in a runbook scoreboard with regression counts per drill. A drill that fails twice in a row is escalated to a P1 fix-forward, mirroring the "30+ architecture reviews" governance discipline in `microsoft-experience.md` point 19.

---

## Resume anchor index

- `resume.txt:51-52` — 10K+ agent runs/day baseline scale.
- `resume.txt:53-54` — DAG execution, checkpointing, retry semantics, durable resumable agents → §3, §4, §9.
- `resume.txt:58-59` — 50M spans/day, 2.5TB+ monthly, deterministic replay, MTTR cut 60% → §6, §7, §8.
- `resume.txt:60-61` — Clickhouse + OpenTelemetry stack → §6.
- `blackbox-experience.md` point 4 — 1M+ daily isolated sandbox executions → F7, F8, §10.
- `blackbox-experience.md` point 8 — deterministic replay under nondeterministic LLM calls → §7.
- `blackbox-experience.md` point 12 — graph workflow engine with checkpointing → §4.
- `blackbox-experience.md` point 13 — long-running resumable agents → §4, §3.
- `blackbox-experience.md` point 16 — partial failure with already-executed side effects → §5.
- `blackbox-experience.md` point 17 — idempotency for tool calls → §3, §5.
- `blackbox-experience.md` point 20 — LLMOps telemetry mesh, MTTR 60% → §6, §8.
- `blackbox-experience.md` point 34 — sampling without losing rare failures → §6.
- `blackbox-experience.md` points 35–36 — debug anomalies, reduce MTTR → §8.
- `microsoft-experience.md` point 9 — heterogeneous retry causes (node loss, OOM, network, bad code, data corruption) → §2, §3, §10.
- `microsoft-experience.md` point 13 — 15M+ jobs/month operational discipline → §1.
- `microsoft-experience.md` point 19 — 30+ architecture reviews / governance → §10.
- `microsoft-experience.md` point 22 — job state machine pattern → §4.
