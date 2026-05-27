# 08 - Reliability, Observability, and Failure Modes


---

## 1. SLOs per surface

SLOs are tiered: control plane (synchronous CRUD), data plane (asynchronous agent run), catalog (browse / discovery). Free tier degrades first under load; paid tier holds the harder targets.

| Surface | Endpoint examples | Availability (monthly) | p50 latency | p99 latency |
|---|---|---|---|---|
| Control plane - `OrchestratorAPI` CRUD | create agent, update prompt, save tool config | 99.95% | 80 ms | 400 ms |
| Control plane - `CatalogAPI` browse | list, search, get-by-slug | 99.95% | 60 ms | 350 ms |
| Data plane - `AgentRuntime` run start (queue accept) | `POST /runs` returns `run_id` | 99.9% | 120 ms | 700 ms |
| Data plane - agent run completion (single-node simple agent) | end-to-end wall clock | 99.5% (success rate) | 3 s | 18 s |
| Data plane - agent run completion (multi-step DAG, 5–20 nodes) | end-to-end | 99.0% (success rate) | 12 s | 90 s |
| `ModelGateway` token throughput | first-token-latency | 99.9% | 350 ms | 1.8 s |
| `MemoryService` retrieval (RAG read) | top-k pgvector + rerank | 99.9% | 90 ms | 450 ms |
| `ConnectorBroker` tool call | OAuth-mediated upstream call | 99.5% (success rate) | 250 ms | 2.5 s |
| `HITL` decision turnaround | user approval click | n/a (user-bound) | n/a | 24 h default TTL | n/a |

**Budget enforcement:** burn-rate alerts at 2% / hr (page on-call), 5% / hr (page lead + freeze risky rollouts).

---

## 2. Retry semantics


| Tier | Examples | Default policy | Backoff | Idempotency requirement |
|---|---|---|---|---|
| Idempotent read | `CatalogAPI` list, `MemoryService` retrieve, `OrchestratorAPI` GET | 3 retries | Exponential w/ full jitter, base 100 ms, cap 5 s | None - read-only |
| Non-idempotent write (client → us) | `POST /runs`, `POST /agents`, billing-affecting writes | 0 retries by default | n/a | Client MUST provide `Idempotency-Key`; server stores key + result for 24 h |
| Tool call (agent → upstream) | Gmail send, Slack post, GitHub API write, HTTP webhook | Per-descriptor `safe_to_retry` flag; default false | Descriptor-specified; default 1 retry after 500 ms for `safe_to_retry=true` | Tool descriptor declares `effect` class (see §5) |
| Model call (`ModelGateway` → provider) | Anthropic, OpenAI, xAI | Provider-side retry with budget (2 attempts, 1 s + 4 s) before fallback | Exponential | Provider responses cached by `(model, prompt_hash, temperature, seed)` for replay |

**Hard rule:** any tool descriptor with `effect ∈ {write, external_send, irreversible}` defaults to `safe_to_retry=false`. The author must explicitly justify safe-to-retry with an idempotency story (e.g., `Idempotency-Key` header to Stripe, or `messageId` for Slack chat.postMessage).

---

## 3. Checkpointing model
**Resume from checkpoint logic** (worker takes lease on a `Running` run with no recent heartbeat):

1. Load `runs` row; verify `run_state ∈ {Running, Paused}` and lease expired.
2. Replay `run_events` for that `run_id` from the last `node.exit` event to rebuild working state in Redis.
3. Resume from the next node after the last completed node. If the last event is a `node.entry` without matching `node.exit`, re-execute that node (idempotency must hold per §3 + §5).
4. Emit `run.resumed` event with `previous_worker_id` and `attempt_count++`.
5. Heartbeat every 10 s to renew lease.

---

## 4. Compensation / SAGA model

Long-running agents are not transactional. A run can apply real-world side effects (email sent, GitHub issue created, Stripe charge made) and then fail two steps later. We use a **per-tool descriptor effect model + best-effort compensation** rather than a true distributed transaction.

**Tool descriptor declares one of:**

| `effect` | Semantics | Default retry | HITL default | Compensation |
|---|---|---|---|---|
| `read` | Pure read; no upstream state change | 3 retries | No | n/a |
| `write` | Mutates upstream state; idempotent if key provided | 1 retry if `safe_to_retry=true` | No (unless tenant policy says yes) | Best-effort undo if API exists |
| `external_send` | Sends a message visible to a third party (Gmail send, Slack post, SMS) | 0 retries by default | **Yes** by default | Retract within provider undo window (e.g., Gmail undo, Slack delete) |
| `irreversible` | No undo possible (Stripe charge, prod deploy, DB DROP, payment refund) | 0 retries | **Yes** mandatory | None - `Critic` MUST gate; run aborts to `HITL` before execution |

---

## 5. Observability stack

**Tracing - OpenTelemetry from every service.**

- Each agent run is a single root trace.
- One span per node (`Planner`, `Router`, `ToolCaller`, `Critic`, `HITL`, `Memory`).
- Child spans: every `ModelGateway` call (with `model`, `prompt_hash`, `temperature`, `seed`, `model_version`, `prompt_tokens`, `completion_tokens`, `cost_usd`), every `ConnectorBroker` call, every `MemoryService` retrieve.
- Spans per run: 50–200 average for multi-step DAGs.

**Storage:**

- **Clickhouse** for spans, run events, eval scores. Column-oriented, cheap aggregate queries over 2.5TB+ monthly trace data.
- TTL: 30 days hot, 90 days cold (S3-backed Clickhouse), 13 months sampled archive for trend analysis.

**Sampling policy (head + tail):**

| Class | Sampling | Rationale |
|---|---|---|
| Run with any error span | 100% kept | Always debug errors |
| Run that triggered `HITL` | 100% kept | Human decisions are audit-worthy |
| Run that triggered `GuardrailService` block | 100% kept | Safety review |
| Free tier successful run | 100% kept | User support pipeline - free users complain loudest, fastest to surface bugs |
| Pro tier successful run | 10% kept (tail-sampled) | Volume control without blinding ourselves to regressions |
| `ModelGateway` calls inside kept runs | 100% kept | Replay depends on full prompt/response chain |
| `TelemetryMesh` internal spans | 1% kept | Avoid recursion explosion |

Tail sampling is done at the `TelemetryMesh` collector - a span is buffered until the run terminates, then the keep/drop decision is made with full trace context.

**Metrics - USE per service, RED per endpoint.**

- USE: Utilization (CPU, mem, GPU), Saturation (queue depth, pool wait), Errors (per-cause counter) on `AgentRuntime`, `ModelGateway`, `MemoryService`, `ConnectorBroker`, `SkillExecutor`.
- RED: Rate, Error %, Duration (p50 / p95 / p99) per `Gateway` / `OrchestratorAPI` / `CatalogAPI` endpoint.
- Business: `runs_per_tenant_per_day`, `cost_per_run`, `tokens_per_tenant`, `hitl_response_time`, `eval_score_rolling_p50`.

**Logs - structured JSON.**

- One log entry = one event with `run_id`, `tenant_id`, `node_id`, `event_type`, `severity`.
- PII and OAuth token redaction at the SDK layer (regex + denylist of header names + structured field tagging).
- 30-day retention; ERROR severity replicated to 90-day cold.

---

## 6. Deterministic replay


**How it works:**

1. Every node's inputs, model call (prompt + response + `model_version` + `temperature` + `seed`), tool call (request + response), and memory retrieval (query + results) are persisted to `run_events` with monotonic `seq`.
2. The replay tool reads `run_events` for a `run_id` and runs the agent graph in **replay mode**: `ModelGateway` and `ToolCaller` are wired to read recorded outputs from `run_events` instead of calling the real provider.
3. Replay produces a new trace tagged `replay_of=<original_run_id>` and a diff of node outputs.


---

## 7. Debugging


**Playbook A - "Run stuck in Planning state"**

1. Open run trace by `run_id`. Inspect `Planner` span duration.
2. If `model_call.duration > 30 s`: check `ModelGateway` provider-tagged latency dashboard. Likely F1/F2.
3. If `planner_loop_count > MAX_PLANNER_ITERATIONS`: the planner is thrashing - inspect last 3 plans for cyclic intent; check if `Critic` is rejecting plans (it should escalate to `HITL` after N rejects, see §5).
4. If span is short but state is stale: F11 (worker crash). Check worker heartbeat; lease reaper should resume.
5. If none above: check `run_queue_depth` - F12 means the run never started.

**Playbook B - "User says agent returned wrong tool output"**

1. Pull run trace; find `ToolCaller` span for the disputed step.
2. Examine raw tool request and response in `run_events` (PII-redacted view).
3. If response looks right but agent reasoned wrong: replay deterministically (§7); inspect `Critic` decision.
4. If response looks wrong: check `ConnectorBroker` span for upstream version / API contract drift; check connector dashboard for F5/F6.

**Playbook C - "Memory not retrieved as expected"**

1. `MemoryService` span - confirm query embedding model version matches the index version.
2. Top-k similarity score distribution: if max score < 0.4, query is off-topic for that namespace.
3. Namespace filter: confirm `tenant_id` + `namespace` match what was indexed.
4. If embedding model was upgraded but namespace was not re-embedded: that's the bug - re-embedding job needs to run.

**Playbook D - "Connector returned 401 mid-run"**

1. `ConnectorBroker` span - extract `connector_id`, `token_id`.
2. Check token expiry vs span timestamp: if expired, F5.
3. Check refresh worker logs for that `token_id` - did refresh attempt run? Did it succeed? Did the refresh token itself expire (re-auth required from user)?
4. If refresh worked but call still 401'd: scope drift at upstream - user revoked scope; surface to user with re-auth prompt.

MTTR target: **median 8 min** for these four playbooks (anchored on the 60% MTTR reduction claim in `resume.txt:58-59`).

---

## 8. Disaster recovery

**Targets:**

- **RPO: 5 min.** Postgres logical replication to standby region every 5 min + S3 base backups every 6 h with WAL shipping. `run_events` and `runs` are the survival-critical tables.
- **RTO: 30 min** for primary-region partial outage; **4 hours** for full region loss.