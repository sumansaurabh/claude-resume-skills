# 08 — Reliability, Observability, and Failure Modes

This file specifies the reliability, observability, and failure-handling design for the Multi-Persona AI Banker (Retail / SME / CFO) running on the shared platform. It is the operational counterpart to the architecture and the agentic graph: the architecture says *what runs*, this file says *how it stays running, how we know it is running correctly, and what we do when it isn't.*

The design intentionally borrows from two anchors on the resume. First, the LangGraph durable-execution stack with checkpointing, retry semantics, memory persistence, and fault-tolerant execution across distributed environments (`resume.txt:52-54`) — that is the substrate that lets an agent run survive a pod crash. Second, the LLMOps telemetry mesh at BlackBox.AI: 50M spans/day, 2.5TB monthly trace data, deterministic replay, and a 60% MTTR cut for AI logic anomalies (`resume.txt:58-59`) — that is the observability spine we replicate here so a regulated banking workflow is debuggable, replayable, and auditable in production.

---

## 1. Reliability targets

We separate SLIs from SLOs from contractual SLAs. SLIs are what we measure. SLOs are what we commit to internally and burn error budget against. SLAs are what we promise externally (to enterprise SME/CFO tenants) and pay penalties on if breached.

| Path | SLI | SLO (internal) | SLA (external) | Notes |
|---|---|---|---|---|
| Sync chat (Retail/SME/CFO) | End-to-end latency from request to first token streamed | p50 ≤ 900ms, p95 ≤ 2.2s, p99 ≤ 3.5s | p99 ≤ 5s (enterprise) | Streamed answer; first token target is the user-perceptible one |
| Sync chat | Availability of the chat path | 99.9% rolling 30 days | 99.5% | Includes orchestrator + model router + tool path |
| Proactive notification | Time from event publish to user-visible notification | p50 ≤ 8s, p95 ≤ 25s, p99 ≤ 60s | p99 ≤ 120s | Event-bus → orchestrator → policy → dispatch |
| Proactive notification | Availability | 99.95% | 99.9% | Higher SLO than chat because money-moving alerts |
| HITL approval queue poll | Latency for reviewer-side poll | p99 ≤ 200ms | n/a | Internal reviewer console |
| HITL approval | Time-to-decision SLA (reviewer side) | p95 ≤ 4 min (low-risk), p95 ≤ 15 min (high-risk) | per-tenant contract | Reviewer SLA is human, not system |
| Audit log | Durability | 11 nines (S3 + Postgres dual-write) | per regulator | Money-moving actions cannot proceed without audit confirm |
| Calc Service | Determinism | 100% (same input → same output, bit-stable) | n/a | Property: not a probability |
| Calc Service | Availability | 99.95% | 99.9% | Stateless, easy to replicate |
| Memory layer (read) | p99 latency | ≤ 150ms | n/a | Hot path; cache-backed |
| Memory layer (write) | p99 latency | ≤ 300ms | n/a | Async fan-out |
| RTO / RPO | Recovery time / data loss | RTO 30 min, RPO 5 min | RTO 1 hr, RPO 15 min | Quarterly DR drill |

Error budget burn drives prioritization: any quarter that consumes >50% of the chat-availability error budget freezes new agent-graph node additions for 2 weeks while we stabilize. The 99.95% bar for notifications is deliberately tighter than chat because a missed overdraft warning is worse than a slow answer to "what did I spend last month."

### 1.1 Failure-rate assumptions (planning baseline)

The reliability budget above is only credible if it's built against quantified failure rates, not aspirational ones. Numbers below are what the design *assumes*; they're tracked as SLIs so reality can correct them.

| Failure class | Assumed rate | Source / rationale | Budget cost |
|---|---|---|---|
| Orchestrator pod loss (crash, OOM, eviction) | 0.5% per pod per day | Industry baseline for stateful Go/Python workloads on EKS; matches observed BlackBox LangGraph fleet (`resume.txt:51-54`) | At 30 pods → 1 pod loss every ~6h on average; absorbed by checkpoint-resume in <15 s |
| Tool API call failure (transient, 5xx/timeout) | 0.1% per call | Plaid/RazorpayX/payment-rail published SLOs; verified against BlackBox model-router 1B+ token/month operational telemetry | At ~2.5M tool calls/day → ~2500 retries/day, all absorbed by `Idempotency-Key` retry path |
| Tool API call failure (permanent, 4xx/policy) | 0.05% per call | Typically schema drift or auth lapse; not retried, escalates to FallbackHandler | ~1250 hard failures/day → user-visible "couldn't complete" on a sub-step |
| Model provider outage (full unavailability) | 0.5% downtime per provider | Anthropic/OpenAI/xAI published SLAs; 3-provider router masks single-provider outage (joint outage prob ≈ 1.25e-7) | Capability-aware fallback; 1-2% answers fall to cheaper model during outage |
| Postgres primary failover | <1 per quarter | RDS Multi-AZ; ~60 s observable failover | Brief write-pause; no data loss (synchronous replica) |
| Redis cluster slot migration / failure | ~1 per quarter, planned | Cluster resize for capacity; 1-2 s slot blip | None ideally |
| Kafka broker loss (MSK) | <1 per quarter | 3-AZ replication factor 3 | None |
| pgvector replica lag spike | ~5 per month | Heavy ingest bursts | Retrieval p99 inflates ~30%; allowed by 80 ms memory-tier budget headroom |
| Whole-AZ loss | ≤2 per year (assumption) | Historical us-east-1 record | 60-90 s control-plane re-route; fleet absorbs at 66% capacity (PDB 80%) |
| Region loss | ≤1 per 3 years (assumption) | Multi-AZ DR drilled quarterly; cross-region DR is RTO 1 h / RPO 15 m | DR drill — see §9 |

The aggregate failure rate driving error-budget burn is dominated by transient tool failures (~3750/day across all classes) and model provider partial outages. Pod loss is structurally invisible to users because of the durable-execution model (§3) — it shows up as a 5-15 s latency tail on a tiny fraction of runs, not as an availability event.

**What this rules out.** With these numbers, the chat-availability SLO of 99.9% over 30 days gives a budget of ~43 m/month. Provider outages alone (1.25e-7 joint × 3 providers × ~17M chat runs/month ≈ 6 runs/month) are negligible; pod loss masked by checkpointing is ~0 runs; the budget is essentially consumed by long-tail tool failures that cascade past FallbackHandler. This is why the saga contract below (§4.1) matters: side-effect compensation is the difference between "tool failed cleanly" (1 budget event) and "tool half-succeeded, downstream node failed, run aborted with money already moved" (1 incident).

---

## 2. Retry policy and idempotency

The system has four distinct retry surfaces, each with its own semantics. Mixing them is the most common source of silent double-execution in agentic systems, so we keep them explicit.

**2.1 Tool calls (external integrations: Plaid, ledger, payment rails, KYC, etc.)**

- Every tool call carries an `Idempotency-Key` header derived as `sha256(run_id || step_no || tool_id || canonical_payload)`. The same key on retry guarantees the upstream returns the same response and does not duplicate side effects.
- Retry policy: exponential backoff with full jitter (`base=200ms, cap=4s, attempts ≤ 3`).
- Retryable error classes: network timeout, 502/503/504, 429 (rate limit). Backoff doubled on 429.
- Non-retryable: 4xx (except 408 and 429), policy-block from the tool router, schema-validation failure on the tool input.
- Each retry emits a span with `retry_attempt` attribute. After cap exhaustion, the agent supervisor decides the next step — either circuit-break the tool and degrade gracefully (Section 4), or surface the error to the user.
- Money-moving tool calls (e.g., schedule transfer) require the tool registry to confirm idempotency support; tools without idempotency keys are disallowed from the money-moving allow-list.

**2.2 LLM calls (via the model router, anchored on `resume.txt:55-56`)**

- The model router retries internally with provider fallback. Order is capability-aware (a CFO-grade reasoning call doesn't fall back to a 7B model just because the primary 200K-context model is throttled).
- On a 5xx or timeout from provider A, the router waits `min(50ms, jitter)`, then routes to provider B with the same prompt and stop conditions.
- A `model_fallback` span is emitted on every switch with `from_model`, `to_model`, `reason`, and `degradation_class`.
- Retries are capped at 2 internal hops. Beyond that, the router returns a `model_unavailable` failure to the orchestrator, which decides whether to (a) wait and retry the whole node with backoff, (b) degrade to a non-LLM answer (Calc-only), or (c) escalate to a human.
- Deterministic-mode runs (replay/audit) skip retries to preserve reproducibility — the original response is fetched from the replay store instead.

**2.3 HITL approval**

- Every approval ticket has an `action_id` derived from the agent run state. The reviewer console is idempotent on `action_id`: submitting the same decision twice is a no-op; submitting a conflicting decision is rejected with a 409 and surfaces in the audit chain.
- Reviewer decisions are append-only; reversing a decision creates a new compensating action with its own `action_id`, never overwrites the original.
- Idempotent replay (audit playback months later) returns the same outcome because the decision is part of the durable run state, not a recomputation.

**2.4 Notification dispatch**

- Idempotency key per `(event_id, user_id, channel)`. The notification orchestrator records the key with the dispatch attempt; a second attempt with the same key short-circuits to the original result.
- Double-dispatch detection: a daily reconciliation job scans dispatched-notification keys for the previous 24h and alarms on any collisions that bypassed the idempotency check (defensive, not primary).
- Per-channel retries: 3 attempts with backoff for transient provider errors; non-retryable on permanent failures (user opted out, device unreachable for 7 days). Channel failover (push → SMS → email) is treated as a *new* notification with its own idempotency key, not a retry of the failed one.

---

## 3. Durable execution model

This is where the LangGraph anchor (`resume.txt:52-54`) does the heavy lifting. Agent runs are not in-memory python coroutines — they are durable state machines whose state is checkpointed and recoverable.

**3.1 State model**

A run has `(run_id, persona, tenant, user, current_node, state_blob, last_checkpoint_ts, status)`. The `state_blob` is the LangGraph state — accumulated tool outputs, retrieved memory, model responses, intermediate reasoning, and the node-transition history.

**3.2 Where checkpoints land**

- **Postgres (durable):** the source of truth. Every node-transition that crosses a *side-effect boundary* (tool call, model call, memory write, calc invocation) writes a checkpoint row inside the same transaction as the side-effect record. Write durability is the ACID guarantee plus synchronous replica.
- **Redis (hot cache):** mirrors the latest checkpoint per `run_id` for sub-10ms reads on the next node. If Redis is stale or down, the orchestrator falls back to Postgres.

**3.3 Recovery semantics**

- On pod crash mid-run, a new orchestrator pod picks up the run by querying Postgres for `status = 'running' AND last_heartbeat < now() - 30s`, leases the run, replays the state from the last checkpoint, and resumes from the next node. The leased run holds an advisory lock so two pods can't resume the same run.
- The combination of checkpoint + idempotent tool calls means resumption never causes double-spending or double-notification: even if the crash happened *between* the tool call returning and the checkpoint writing, the retried tool call returns the cached idempotent response.
- This is identical in shape to the state-machine retries on Microsoft AutoML (`resume.txt:91-92`), where 15M+ jobs/month had to survive worker death without losing in-flight work. The lesson there transfers cleanly: idempotency is what makes resumption safe; checkpoints are what make it possible.

**3.4 Checkpoint frequency trade-off**

We do *not* checkpoint after every micro-step. Checkpointing is expensive (a Postgres synchronous write) and high-frequency checkpointing tanks orchestrator throughput. The rule is:

- Checkpoint after any *external observable side effect*: tool call complete, model call complete, memory write complete, calc invocation complete, HITL ticket created, notification dispatched.
- Skip checkpoints between purely-internal state mutations (a planner picking the next node, a small in-memory transformation).

This keeps checkpoint write rate around 4–8 writes per chat turn on average, which Postgres handles comfortably. For background proactive runs, average is 2–3 because the graphs are shorter.

---

## 4. Failure modes and handling

The single largest table in this document. Each row is a specific, named failure with detection signal, automated handling, and user-visible impact. Anything not in this table is a gap and gets added on first occurrence.

| Failure | Detection | Handling | User-visible |
|---|---|---|---|
| Model provider 5xx | Provider 5xx response + latency spike | Router falls back to next provider in capability tier; `model_fallback` span emitted | None unless *all* providers fail → degraded mode (Calc-only answer) |
| Model provider rate-limited (429) | 429 response + Retry-After header | Router routes to alternate provider; if all rate-limited, queue with backpressure and increase backoff window | Slight latency increase (sub-second usually) |
| Tool API down (e.g., Plaid) | Tool registry health probe fail + recent error-rate > 50% over 30s | Circuit-break the tool, agent supervisor takes the "data unavailable" branch in the graph, user informed in answer text | Partial answer with disclaimer ("I couldn't pull your latest transactions just now") |
| Calc Service crash | Liveness fail + 5xx rate spike | k8s replaces pod, supervisor retries call; if persistent across replicas, runs degrade to "advice unavailable, escalate to RM" | None ideally; advisory delay if persistent |
| Persona-resolver inconsistency | Mismatched persona signals (auth token vs URL vs explicit request) | **Lowest-privilege wins.** Run halted, audit entry written, user prompted to re-authenticate with intended persona | User asked to re-auth |
| Memory write contention | Optimistic concurrency violation (version mismatch on memory row) | Retry with read-modify-write up to 3 times; if cap exceeded, escalate as run failure (rare, indicates hot key) | Possible "please retry" |
| Postgres failover | Connection error + replica lag spike | App-layer retry with exponential backoff (driver-level + ORM-level); briefly read-only mode if write replica unavailable >30s | Slight latency, no data loss |
| Redis cluster slot move | MOVED/ASK redirect from cluster topology change | Client follows redirect transparently; 1–2s blip possible during slot migration | None ideally |
| Event bus (Kafka) lag spike | Consumer lag > 30s threshold per partition | Auto-scale consumers via KEDA; if backed up further, drop lowest-priority proactive runs (those go to DLQ for replay) | Delayed nudges, not lost |
| Notification channel down (push provider) | Provider error rate > 20% over 60s | Channel failover (push → SMS → email per user preference); per-user channel-preference cache invalidated for that user | Channel change for that one notification |
| Approval reviewer SLA breach | Ticket age > tier SLA threshold | Escalate to backup reviewer pool; if breach severity high, auto-deny + notify user with explanation and human-callback option | Slower decision; user knows it's slower |
| Persona memory cross-bleed detected | Memory query trace shows wrong tenant attribute on result row | **Halt run, alarm SOC, audit chain entry, quarantine the offending memory row, page on-call** | Run failure with apology message and ticket reference |
| Audit log write fail | Postgres + S3 dual-write inconsistency detected by reconciliation | **Run halted until audit guaranteed; refusal to proceed.** This is the right answer — we do not proceed without audit guarantee | Run failure (correct behavior) |
| LLM hallucination on advice | Output guardrail (hallucination check against retrieved context) fails | Suppress output, retry with stricter prompt and explicit citation requirement; if persistent, fall through to "I'm not confident enough — let me connect you to a relationship manager" | Advice withheld, fallback offered |
| Looping ReAct agent | `step_count > cap (20)` or cycle-detector matches repeated `(node, state_hash)` pair | Force termination, return partial state with explanation, alarm on graph; run captured for offline analysis | Truncated answer with apology |
| Forecast outside confidence band | Posterior variance on cashflow forecast exceeds threshold | Suppress numerical prediction, give qualitative answer with hedge, mark `confidence: low` in trace | Answer is hedged, not false |
| Cost budget breach (per-tenant) | Token-cost-per-hour > tier budget cap | Switch tier to lower-cost models for non-critical paths; alert tenant admin; never silently degrade money-moving paths | Slightly lower-quality answers on browse-y questions, no impact on critical paths |
| Webhook signature failure (inbound tool) | HMAC verification fail on inbound webhook | Drop event, alarm; do not process | None for user; SOC paged for repeated occurrences |

Two rows in this table deserve emphasis: **audit log write fail** and **persona memory cross-bleed**. Both are designed to *halt and refuse* rather than degrade. In a regulated banking context the worst possible behavior is silently proceeding with an unauditable or cross-tenant action. The user-visible impact of "your action failed, here's a ticket reference" is strictly preferable to the regulatory consequence of acting without an audit chain or leaking memory across tenants.

### 4.1 Saga and compensating transactions for partially-executed actions

Idempotency keeps a single tool retry safe. It does **not** keep a *multi-step action* safe when the action has been partially executed and a later step fails. The canonical scenario: the agent has already executed `bank_transfer.move_funds(...)` (returning a `transfer_ref`), the funds are gone from account A, and the subsequent `audit.write(transfer_ref, ...)` write fails because the audit cluster is in failover. The transfer cannot just be "retried" — the money already moved. The transfer cannot just be "abandoned" — the regulator requires a chain. The orchestrator must run a **compensating transaction**.

We model multi-step actions as **sagas**: an ordered list of `(forward, compensation)` pairs, recorded durably alongside the run's checkpoint, executed step-by-step with each forward's result and compensation's input keyed by the action's `action_id`.

| Step | Forward action | Compensation action | When compensation fires |
|---|---|---|---|
| 1 | `holds.create(amount, account_id)` — soft-reserve funds | `holds.release(hold_id)` | If any later step in the saga fails after step 1 succeeded |
| 2 | `bank_transfer.move_funds(hold_id, dest)` — convert hold to debit | `bank_transfer.reverse(transfer_ref, reason)` — issue reversal txn | If step 3 or 4 fails after step 2 succeeded |
| 3 | `audit.write(action_id, transfer_ref, decision_chain)` | `audit.write_compensation(action_id, "reverted", reason)` | If step 4 fails after step 3 succeeded |
| 4 | `notify.send(user_id, "transfer complete", ...)` | `notify.send(user_id, "transfer was reversed due to a system issue", ...)` | Never fires (last step); failures here are logged-only because reversal would cause confusion |

**Saga state machine.** The orchestrator's checkpoint includes a `saga_log: list[SagaStep]` where each step has `{step_no, forward_ref, forward_result, compensation_ref, status ∈ {PENDING, FORWARD_DONE, COMPENSATED, FAILED_OPEN}}`. Forward execution writes `FORWARD_DONE` before advancing. On any downstream failure, the orchestrator runs the compensation pipeline **in reverse order** of forward execution, marking each step `COMPENSATED`. The saga is closed only when all `FORWARD_DONE` steps are `COMPENSATED` or all steps reached `FORWARD_DONE` cleanly.

**The hardest case: compensation itself fails.** If `bank_transfer.reverse(...)` returns a 5xx for a transfer that already moved, the saga step transitions to `FAILED_OPEN`. This is a P1 — pages the on-call directly with the `action_id`, freezes that user's money-movement allow-list, and creates a manual reconciliation ticket pre-populated with the transfer reference, original instruction, and the failure span. The system does **not** retry the compensation in a loop — repeated reverse attempts on the same transaction can themselves cause double-reversal in some rails. The system fails loudly to a human; this is the right answer.

**Why not just two-phase commit?** Two-phase commit would require the bank rails, audit cluster, and notification provider to participate as resource managers in a distributed transaction. None of them do; this is a reality of integrating with external financial systems. Sagas are the correct primitive when the participants don't support 2PC, which is essentially always in banking integrations. The cost is that compensation must be designed per-action; the benefit is that the design works across heterogeneous external systems with weeks-old recovery semantics.

**Tooling rule.** Every tool in the money-moving allow-list must declare a compensation handler in the tool registry. A tool without a registered compensation handler is statically rejected from money-moving sagas at registry-load time — it can only appear as the *last* step of a saga (because nothing after it can need a compensation), or in read-only contexts. This is enforced in CI against the tool registry manifest.

**Where the saga fits in the graph.** The `ApprovalCoordinator` specialist constructs the saga from the approved `ActionDescriptor`; the `ToolCaller` executes saga steps and updates the saga log; the `FallbackHandler` is where the reverse pipeline runs on failure. The full saga log is part of the run's audit chain and replays deterministically.

This is the closest the design gets to a transactional guarantee across external systems. It is not perfect — `FAILED_OPEN` exists for a reason — but it bounds the unrecoverable surface to "compensation itself returned 5xx," which is rare and gets a human eyes-on response within minutes via the P1 page.

---

## 5. Observability mesh

This is the section most directly anchored on `resume.txt:58-59`. The shape of the mesh is the BlackBox.AI LLMOps mesh shape, adapted to a multi-persona regulated banking workload. We expect roughly 4B+ spans/day at full scale (~10x the BlackBox 50M/day anchor) given the per-step instrumentation density of an agentic system at multi-million-user scale.

**5.1 Instrumentation**

- OpenTelemetry SDK in every service: FastAPI (orchestrator, persona-resolver), Go (tool router, notification orchestrator, model router shell), Rust (high-throughput workers for ingestion and calc).
- Auto-instrumentation for HTTP, gRPC, Kafka, Postgres, Redis. Manual instrumentation around every agent-graph node, model call, tool call, calc invocation, memory operation, and policy decision.

**5.2 Trace propagation**

- W3C trace context (`traceparent`) carried through HTTP and gRPC.
- Kafka headers carry `trace_id` and `span_id` for async fan-out (event bus → notification orchestrator).
- Run-checkpoint metadata stores `trace_id` so a replay knows which trace to anchor against.

**5.3 Per-span attribute schema**

Every agent-step span carries a consistent attribute set. This is the schema we query against in dashboards and in incident triage.

| Attribute | Type | Source | Use |
|---|---|---|---|
| `persona` | enum(retail/sme/cfo) | resolver | SLO board partitioning |
| `tenant_id` | string | resolver | per-tenant dashboards |
| `user_id` | string (hashed) | resolver | per-user troubleshooting |
| `run_id` | string | orchestrator | run-level reconstruction |
| `step_no` | int | orchestrator | ordering within a run |
| `tool_id` | string | tool router | tool-success-rate board |
| `model_id` | string | model router | per-model latency/cost |
| `prompt_hash` | sha256 | model router | replay anchor |
| `retrieval_keys` | string[] | memory layer | knowing what context was used |
| `latency_ms` | int | OTel | the SLI |
| `token_in` / `token_out` | int | model router | cost + capacity |
| `cost_usd` | float | model router | per-tenant cost board |
| `confidence` | float | guardrails | confidence-distribution tracking |
| `hitl_required` | bool | policy | tail-sampling trigger |
| `money_moving` | bool | policy | tail-sampling trigger + audit |
| `audit_chain_id` | string | audit | linking trace ↔ audit log |
| `retry_attempt` | int | tool/model wrappers | retry-storm detection |

**5.4 Ingest path**

Spans → OTLP collector → Kafka → ClickHouse cluster (the BlackBox-style shape from `resume.txt:58-59`). ClickHouse is the analytical home for trace queries because per-span ad-hoc queries on attributes scale and stay cheap. A small Postgres mirror holds run-summary rows for product-side queries (showing a user their last run).

**5.5 Sampling**

- **Head-based:** 5% of normal-traffic traces sampled at the SDK level.
- **Tail-based:** 100% of any trace with an error span; 100% of any trace where `hitl_required=true` or `money_moving=true`; 100% of any trace exceeding the persona-path p99 latency budget. Tail-sampling is implemented at the OTel collector level so the SDK doesn't have to know which traces become interesting.
- Result: roughly 8–12% effective sample rate by volume, ~100% coverage of the spans we actually care about.

**5.6 Dashboards (the daily-driver set)**

- Per-persona SLO board: latency percentiles, error rate, availability burn-down.
- Model-router health: success rate, fallback rate, per-provider availability, cost-per-1k-tokens.
- Tool-call success rate: per-tool, with circuit-breaker state overlay.
- HITL SLA: open tickets by tier, age distribution, reviewer load.
- Proactive fatigue: notifications-per-user-per-day, opt-out rate, snooze rate. (Fatigue is a reliability metric — over-notifying erodes trust.)
- Memory layer: read/write latencies, contention rate, cache hit ratio.
- Calc Service: input-distribution drift, determinism check pass rate.

---

## 6. Deterministic replay

This is the second-half of the BlackBox.AI anchor (`resume.txt:58-59`) — deterministic replay was the mechanism that produced the 60% MTTR cut for AI logic anomalies. We replicate the pattern exactly because the regulated context demands it even more strongly than the developer-tool context did.

**6.1 What we capture per run**

- Prompt hashes (full prompt stored separately, keyed by hash).
- Retrieved context snapshots at the moment of retrieval (memory rows, RAG chunks) with their own TTL'd retention.
- Tool inputs and outputs (canonical JSON, hashed for integrity, content stored in object storage).
- Model responses (raw bytes, including the streaming chunks if applicable).
- Model seed and decoding params if a deterministic mode was used.
- All policy decisions (allow/deny + rationale).
- The full sequence of node transitions with their checkpoint states.

**6.2 Replay mechanics**

A replay reconstructs a run by feeding the captured tool outputs and model responses *back* through the orchestrator instead of re-calling the live services. The same prompts hit the same node logic and produce the same state transitions. Determinism is property-of-construction, not property-of-luck: we don't call live LLMs during replay.

**6.3 Trade-off: replay storage cost**

Tool outputs can be large (a transaction-history pull is hundreds of KB; a market-data pull can be MB). At 10M+ runs/day, replay storage is non-trivial. The retention policy reflects this:

- **30 days** default retention for ordinary runs.
- **7 years** retention for any run that produced a money-moving action — driven by financial regulation, this is a hard requirement, not a nice-to-have.
- **Tiered storage:** hot tier on S3 standard for the first 30 days, transitions to S3 Glacier Deep Archive for the 7-year tail. Retrieval latency from Glacier (hours) is acceptable because regulator audits are scheduled, not real-time.

**6.4 What replay buys us**

The same thing it bought at BlackBox.AI: an engineer triaging a customer complaint can pull the run, replay it, step through the agent graph node by node, see exactly which context was retrieved, see exactly which tool returned what, and see exactly which policy decision was made. The 60% MTTR cut came from eliminating the "I can't reproduce this" failure mode — and a regulated banking workload makes that even more valuable because the alternative is reading raw logs, which a regulator will not accept as a satisfactory investigation.

---

## 7. Health checks

Three concentric layers, each with a distinct purpose.

**7.1 Liveness**

- TCP socket open + `/healthz` returning 200 with a static payload.
- Goal: detect a deadlocked or hung process so k8s can restart it.
- Cheap, fast (< 50ms target), runs every 10s.
- Does *not* depend on downstream services — a hung process should restart even if Postgres is down.

**7.2 Readiness**

- `/ready` returns 200 only when the pod is genuinely able to serve traffic.
- Dependency-aware: Postgres reachable, Redis reachable, model router reachable, tool registry reachable, memory layer reachable.
- Slower (200–400ms acceptable), runs every 5s.
- A failed readiness probe pulls the pod from the load balancer rotation without restarting it — so transient downstream issues don't restart-storm the pods.
- For the orchestrator, readiness also checks LangGraph state-store connectivity. A pod that can't checkpoint shouldn't accept new runs.

**7.3 LB chain (matches the architecture in `03-architecture.md`)**

- AWS Network Load Balancer at the edge: TCP healthcheck only, fast.
- Application Load Balancer behind it: HTTP healthcheck on `/ready` with the dependency-aware payload.
- k8s pod-level liveness and readiness probes complete the chain.

The triple-layer means a node can be unhealthy at any of three layers and the right thing happens at each: NLB drops at the AZ level for catastrophic failure, ALB drops the pod for ordinary readiness failure, k8s restarts the pod for liveness failure.

---

## 8. Capacity buffering and circuit breakers

The pattern here is anchored in the Microsoft AutoML retry-and-circuit experience (`resume.txt:91-92`), where 15M+ jobs/month exposed every failure mode in the state-machine-retry handbook.

**8.1 Per-tool circuit breaker**

- Window: 30s rolling.
- Threshold: success rate < 80% triggers OPEN.
- OPEN duration: 60s, then transitions to HALF-OPEN.
- HALF-OPEN: 5 probe calls; if ≥ 4 succeed, CLOSE; else back to OPEN with exponential extension (60s → 120s → 240s, cap 10 min).
- When OPEN, the tool is unavailable to the agent supervisor, which selects the documented degrade path for that tool in the graph (Section 4).

**8.2 Per-model-provider circuit breaker**

- Same window-and-threshold pattern at the model router.
- When OPEN on provider A, all traffic for that capability tier flows to provider B until A recovers.
- If all providers in a tier are OPEN simultaneously (rare but real — a multi-provider outage), the router returns `model_unavailable` and the orchestrator drops into degraded mode (Section 4 row "Model provider 5xx").

**8.3 Per-tenant rate quota**

- Token-bucket per tenant, sized by tier.
- Overflow allowed into a per-tier shared pool with priority < dedicated quota.
- When a tenant exhausts both its dedicated quota and shared overflow, requests queue (with a max wait of 2s) and then fail with 429 if the queue exceeds wait budget.
- Persona-aware: a CFO tier tenant has dedicated quota larger than Retail tier; cross-persona traffic on the same shared platform never starves a paying enterprise tenant.

**8.4 Backpressure ladder**

When the system is overall hot — high CPU on orchestrators, model-router queue depth growing — we apply backpressure top-down:

1. Shed lowest-priority proactive runs (educational nudges).
2. Shed medium-priority proactive runs (informational alerts).
3. Increase HITL queue priority for money-moving actions.
4. Reduce parallelism inside single runs (sequential tool calls instead of parallel).
5. Last resort: return 503 on new chat runs with a polite "try again in a moment."

Critical paths (notifications for money-moving events, HITL approvals) are never shed.

---

## 9. DR and failover

**9.1 Active-active multi-AZ**

- Stateless tiers (orchestrator, model router, tool router, calc, notification orchestrator) run across 3 AZs in active-active mode.
- Health probes drop unhealthy AZs from the ALB target group; recovery is automatic when probes pass again.

**9.2 Postgres**

- Synchronous replica in a second AZ; asynchronous replica in a third AZ for read scaling.
- Failover: managed by RDS multi-AZ with ≤ 60s typical failover; app-layer retries absorb the gap.
- Audit-log Postgres has the same shape plus a dedicated cross-region read replica for DR.

**9.3 Cross-region warm standby**

- Hottest critical paths replicate to a warm-standby region: audit log, transaction ingestion, money-moving HITL queue.
- Active region runs full traffic; standby region runs reduced capacity but warm. Failover requires a deliberate trigger (the "right" thing to do, not the automatic thing, to avoid split-brain).

**9.4 RTO 30 min, RPO 5 min**

- RTO 30 min for chat path: includes DNS swing + standby warm-up + dependency check.
- RPO 5 min: driven by the async cross-region replication lag.
- Money-moving and audit paths: RPO target tightened to 1 min via synchronous cross-region write for that subset.

**9.5 Quarterly DR drill**

- Cross-region failover exercised quarterly with a deliberate region drain.
- Post-drill: every gap surfaces as a runbook delta, and runbooks are updated within 1 week.

---

## 10. Runbooks — top 5

These are the on-call's daily-driver runbooks. Full set lives in the internal wiki; the top 5 cover ~80% of expected page volume.

**10.1 Agent runs stuck in `tool_calling`**

- Inspect: query Postgres for `runs WHERE status='running' AND current_node='tool_calling' AND last_checkpoint_ts < now() - INTERVAL '60 seconds'`.
- Pull the trace for each stuck run. Identify which tool.
- If the tool is broken: confirm circuit-breaker state, force-open it if needed, terminate the runs with explanation to user.
- If the tool is fine but the orchestrator is stuck: force-terminate, replay the run offline to verify it's a one-off, capture for postmortem.

**10.2 Notification fatigue spike**

- Inspect: per-user notification rate dashboard; identify the offending event class.
- If a faulty proactive rule is firing too often: disable the rule at the policy layer (hot config), drain the in-flight events, re-enable after fix.
- Override available: per-tenant cooldown ratchet (e.g., 2x cooldown for next 24h).

**10.3 HITL SLA breach**

- Inspect: HITL dashboard, ticket-age distribution per tier.
- Auto-escalation should already have triggered. Manually escalate to backup reviewer pool if not.
- For severity-high tickets past SLA: notify user with explanation, offer human-callback, do NOT silently auto-deny without notification.

**10.4 Cross-tenant memory leak suspected**

- Confirm: pull the offending trace, verify the `tenant_id` mismatch on the memory query.
- Quarantine: write a row to the `quarantined_memory` table; the memory layer refuses to serve quarantined rows.
- Halt all runs for both involved tenants until investigation closes.
- Page SOC, file incident under "data-isolation breach" class, follow the regulatory notification SOP.

**10.5 Model router 100% provider outage**

- Confirm: model router dashboard shows all providers OPEN circuit.
- Switch the orchestrator into "degraded mode": disable all money-moving graph branches, allow only Calc-driven advisory answers, prominent banner in chat UI.
- Communicate: status page, in-app banner, push notification to tenant admins.
- Restore: when at least one provider recovers, run smoke test (1% canary), then ramp back up over 10 minutes.

---

## 11. Eval harness for advice quality

Reliability isn't only "does the system stay up" — for a banking advisor it's also "does the advice stay correct." We treat advice quality as a first-class SLO with its own measurement infrastructure.

**11.1 Offline eval set**

- Per-persona curated test suites:
  - Retail: financial coaches author 500+ scenarios across budgeting, savings, debt, emergencies.
  - SME: accountants author 300+ scenarios across cashflow, receivables, payroll, tax.
  - CFO: treasury professionals author 200+ scenarios across liquidity, FX, hedging, working capital.
- Each scenario has a golden answer (the response a senior advisor in that domain would give) and a set of "must contain" and "must not contain" assertions.
- Automated similarity (embedding distance) + human grading on a stratified sample.
- Run nightly on the latest model + prompt configuration.

**11.2 Online eval**

- A/B test minor changes (prompt tweaks, retrieval threshold changes) on 5% of traffic for a week, measure deltas on advice-quality grades, action-success rate, and user satisfaction.
- Canary major changes (model swap, new graph node) at 1% for 48 hours; rollback automatically on any regression > 2% on advice-quality grade or > 1% on action-success rate.

**11.3 Metrics**

- Advice quality (graded by domain experts on rotating sample) — the headline.
- Forecast accuracy: MAPE on cashflow projections (SME/CFO).
- Action-success rate: fraction of agent-suggested actions that the user actually took and didn't regret (rated 30 days later).
- User satisfaction: thumbs-up/down per turn, NPS quarterly.
- Hallucination rate: guardrail-flagged outputs as % of total outputs, plus a manually-graded sample.

---

## 12. Why this design hits the BlackBox 60% MTTR target

The BlackBox.AI LLMOps mesh cut MTTR by 60% for AI logic anomalies (`resume.txt:58-59`). The mechanism wasn't a single feature — it was the *combination* of three things working together: dense instrumentation across every step, deterministic replay capturing enough state to reconstruct any run, and tail-based sampling guaranteeing the interesting traces were always available. In a multi-persona regulated banking workload the case for that same combination is even stronger, because the consequence of slow incident response isn't just a delayed feature ship — it's a regulator asking why a money-moving action proceeded incorrectly and us not having an answer.

We replicate the exact pattern here. Every agent step, every tool call, every model call, every calc invocation, every memory read and write, every policy decision lands in the span schema. Tail-sampling ensures error spans, HITL-required spans, and money-moving spans are 100% captured. Deterministic replay reconstructs any run from durable storage. The LangGraph durable-execution substrate (`resume.txt:52-54`) makes the run state itself replayable, not just the telemetry around it. Circuit breakers and idempotent tool calls (lessons from the AutoML 15M-jobs-per-month operational substrate at `resume.txt:91-92`) prevent the failure cascades that would otherwise inflate MTTR. The result is that when a Retail user complains about an incorrect savings recommendation, when an SME accountant flags a cashflow-forecast error, or when a CFO desk reports an FX advisory that didn't match their playbook, the on-call engineer has a replayable run on screen in under a minute and a root cause in under fifteen. That is the 60% MTTR cut, applied to the higher-stakes context of regulated personal and business finance.
