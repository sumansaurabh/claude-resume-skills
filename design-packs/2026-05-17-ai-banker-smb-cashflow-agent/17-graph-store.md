# 17. Graph Store - Durable LangGraph State

> Consolidated build plan for the "durable graph store" referenced in `01-executive-summary.md`. This file is a reference index that pulls together the checkpointer / `run_state` / `agent_checkpoint` design that was previously scattered across `05`, `08`, `12`, and `13`. Source-of-truth DDL and per-node state shapes stay in those files; this file is the entry point for anyone asking "how is the graph state stored, and how does a paused payroll conversation survive Monday → Wednesday?"

Resume anchors: BlackBox graph workflow engine with DAG execution, checkpointing, retry semantics, memory persistence, and fault-tolerant execution across distributed environments (resume.txt L52-54; blackbox-experience.md #12-#15); LangGraph/LangChain ReAct + DAG orchestration at 10K+ agent runs/day with durable execution (resume.txt L51-54; blackbox-experience.md #7-#11).

---

## 1. What this file is (and isn't)

**Is:** the build plan for the durable storage layer that backs LangGraph state - tables, write semantics, recovery, sharding, schema versioning. Build sequence.

**Isn't:**
- *Per-node state shapes* - those live in `12-agentic-graph-structure.md` Layer 2 (§Per-Node State and Edge Conditions).
- *Memory beyond per-run state* - episodic, semantic, procedural, domain, audit memory live in `13-memory-layer-design.md`.
- *Tool side-effect durability* - that uses Temporal sub-workflows with idempotency keys, specced in `12-agentic-graph-structure.md` §1035 and `05-low-level-design.md` §5.4 (`actions` table + saga).
- *Reliability contract, RPO/RTO, failure taxonomy* - that's `08-reliability-observability-and-failures.md`.

This file consolidates what is **specific to storing graph execution state**. Nothing here is new design - every decision was already made; this file just makes the decisions findable.

---

## 2. Scope - what lives in the graph store

| Data | In graph store? | Where instead |
|---|---|---|
| Per-run conversation state (transcript, plan, hop counter, scratchpad) | **Yes** - `run_state` jsonb | - |
| Per-node `durable` checkpointed state (see `12` Layer 2 table for the full key list) | **Yes** - `agent_checkpoint` rows | - |
| HITL pause state (proposal, evidence_snapshot, idempotency_key, signed approval payload on resume) | **Yes** - checkpoint on node-entry barrier | `12` §HITL Interrupt/Resume |
| Join state (received[], expected, partial_lock) | **Yes** - under row-level lock on the checkpoint row | `12` §Joins |
| Ephemeral tool observations, partial LLM scratchpads, intermediate scores | **No** - Redis side-cache, 30-min TTL, recompute-on-miss | `12` §365-373 |
| Long-term episodic / semantic / procedural / domain memory | **No** - `memory_episodes`, `business_profile`, etc. | `13-memory-layer-design.md` |
| Tool-call records, idempotency, saga compensation state | **No** - `tool_calls`, `actions` tables | `05-low-level-design.md` §5.4 |
| Audit log (7-year WORM) | **No** - `audit_log` partitioned table + S3 cold | `05` §5.4, `13` row "Audit/replay" |

The graph store is **per-run execution state only**. Everything that outlives a run - memory, audit, saga state, tool history - lives in dedicated tables.

---

## 3. Storage - tables and ownership

Aurora Postgres (same cluster as the rest of the application data; co-location is intentional - see §9 for the hot-spot mitigation plan if this becomes the bottleneck).

| Table | Purpose | Source-of-truth DDL |
|---|---|---|
| `runs` | One row per agent run; status + lease columns for worker handoff | `05-low-level-design.md` §5.3 lines 321-336 |
| `run_state` / `agent_checkpoint` | Append-only checkpoint log; one row per `(run_id, version)` | `05-low-level-design.md` lines 338-345; `12-agentic-graph-structure.md` §367 |

Both tables are owned by the **Orchestrator service** (`05-low-level-design.md` §3 line 25): `RunController`, `RunClaimer`, `HITLInbox`, `CheckpointWriter`. No other service writes them. The Agent Runtime calls into the Orchestrator over gRPC for every checkpoint.

**Key schema invariants:**
- `(run_id, version)` is the primary key. `version` is a monotonic bigint per run, incremented on every checkpoint write. Latest by `max(version)` on resume.
- `state` is `jsonb`. Compressed with Aurora's `pglz` page-level compression by default; lz4 column-level compression planned at scale (see §9).
- No `UPDATE`s on `run_state` - append-only. Compaction is a separate batch job that snapshots and truncates old versions per run after retention TTL.
- `runs.claimed_by` + `runs.claim_expires` implement the lease - see §6.

---

## 4. Two state classes - durable vs run-scoped-ephemeral

The graph runtime distinguishes two classes of state with very different durability contracts. This is the most important load-bearing decision in the graph store and the easiest one to get wrong on day 2.

| Class | Storage | Survives | Lost on | Examples (per `12-agentic-graph-structure.md` §367-373) |
|---|---|---|---|---|
| `durable` | Postgres `agent_checkpoint` row, write-through on node entry/exit | Worker crash, fleet roll, HITL pause of arbitrary duration, region failover | Explicit deletion or TTL expiry (90d default; ∞ for HITL-waiting runs until timeout) | Run-level facts, plan, hop counter, all approval payloads, audit lineage, HITL proposals, join `received[]` |
| `run_scoped_ephemeral` | In-process map + Redis side-cache keyed by `run_id`, 30-min TTL | Single worker restart (Redis side-cache restores) | Both worker AND Redis shard down; >30 min idle | Tool observations (cheap to re-fetch), partial LLM scratchpads, intermediate scores |

**The load-bearing invariant** (`12-agentic-graph-structure.md` line 1066): *"If it isn't in a `durable` checkpoint, it didn't happen."* Any consumer reading `run_scoped_ephemeral` after a resume MUST tolerate a miss and recompute. No saga, no HITL approval, no side-effect tool call may read from the ephemeral class to make a decision.

This split is why a Monday-pause Wednesday-resume payroll conversation works: the HITL proposal (`{vendor_id, amount, idempotency_key, expected_balance_after, evidence_snapshot}`) is `durable`; the half-finished forecast scratchpad that was in working memory at pause time is ephemeral and recomputed on resume.

---

## 5. Write semantics - when checkpoints fire

| Trigger | Barrier | Reason |
|---|---|---|
| Node exit (default for every node) | `write_through=true` | The standard durable-execution contract: if the node completed, its output is durable. |
| Node entry - HITL nodes | additional barrier | The pause point itself must be recoverable even if the worker crashes between accepting input and serializing it. Same reason `12` §917 makes HITL "first-class" rather than callback-based. |
| Node entry - join nodes | additional barrier | Same reason - the aggregation point must survive a crash during the join policy evaluation (`12` §903-906). |
| Saga step boundary | yes | The saga state in `actions` table writes synchronously; the graph state checkpoint is the matching durable marker so resume can re-resolve workflow ids without re-issuing (`12` line 1035). |

**Hop-batch optimization at scale** (`06-scaling-and-capacity.md` line 73): when a single run exceeds 10 hops without a HITL or join, the runtime batches checkpoint writes (every Nth hop, where N is configurable; default 5). This trades a small recompute cost on crash for a 5× reduction in Aurora write IOPS. Never batched: HITL nodes, join nodes, any node that issues a saga step.

**Write amplification budget** (`20-critical-agent-approval.md` line 53 - surfaced by the critic): roughly 6 writes per node today. The critic flagged this as a launch-gate item; the mitigation menu is in §9.

---

## 6. Recovery - claim, lease, resume

A worker crash never loses a run. The recovery path is the same one shipped at BlackBox at 10K+ runs/day (`resume.txt` L52-54; `blackbox-experience.md` #15), re-anchored on Postgres advisory locking.

**Claim** (`05-low-level-design.md` line 594):

```sql
SELECT * FROM runs
WHERE status IN ('queued', 'running')
  AND (claim_expires IS NULL OR claim_expires < now())
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;

UPDATE runs
SET claimed_by = $pod_id,
    claim_expires = now() + interval '30 seconds',
    status = 'running'
WHERE run_id = $run_id;
```

**Heartbeat:** the owning worker re-runs the `UPDATE` every 10 seconds to extend the lease. Crash ⇒ lease expires within 30s ⇒ another worker picks it up.

**Resume:** the new worker reads `max(version)` from `run_state` for that `run_id`, deserializes the jsonb into the LangGraph state object, and re-enters the runtime at the node that wrote that checkpoint. Any `run_scoped_ephemeral` state is reconstructed on demand by the runtime (or the consumer tolerates the miss and recomputes).

**HITL pause recovery is the same path:** a HITL node writes a checkpoint on entry, returns control, the worker releases the lease. The run row sits idle in `runs.status='waiting_hitl'` (no `claimed_by`) until the approval webhook arrives. Webhook handler claims the run with the same `SELECT FOR UPDATE SKIP LOCKED` pattern and resumes from the HITL checkpoint with the approval payload injected.

---

## 7. Schema versioning - graph definition changes

The danger: renaming a node or changing a state field would break checkpoint deserialization for every in-flight run mid-execution. The defenses (`10-cross-questions.md` line 46; `12-agentic-graph-structure.md` §support_window):

1. **Graph definitions are versioned, immutable, content-hashed.** A graph version = SHA256(serialized topology + state schema + node prompts). The checkpoint row carries the graph version it was written against.
2. **New deploys only affect new runs.** In-flight runs continue on the old graph version until completion or a configurable drain timeout (default 24h).
3. **Last 3 graph versions kept hot in every executor.** Cost: 3× graph code in memory. Acceptable vs the alternative of a 30-minute outage every deploy.
4. **Support window:** ≥ 30 days after a version becomes non-current (`12` §335). Older runs continue to resolve their checkpoints against the pinned version.
5. **Dual-write window:** 7 days minimum (`12` §338). New checkpoints written in both old and new schema during transition.
6. **Deprecation:** mark `deprecated_at` → stop new runs after T+30d → reap after the longest-living checkpoint TTL expires (`12` §337).

State schema changes (adding/removing keys on `state.run.*`) follow the same lifecycle. Removing a key is N-2 supported: readers tolerate absence for 90 days; only after that does the column or jsonb path get dropped.

---

## 8. Hot-path optimization - Redis side cache

The durable checkpoint is the source of truth, but reads on the hot path don't go to Postgres. The orchestrator maintains a Redis side cache (`12-agentic-graph-structure.md` §368) keyed by `run_id`, holding the materialized state object with a 30-min TTL.

- **Read path:** Redis hit → deserialize in-memory → execute next node. Postgres only on Redis miss (cold run resumed after worker handoff or HITL wake).
- **Write path:** Postgres write-through is synchronous (durable barrier); Redis update fires asynchronously after the Postgres commit. A failed Redis update is non-fatal - next read goes to Postgres.
- **Cache invalidation:** TTL-based only. On HITL pause, the cache entry is deleted explicitly so the run isn't held in memory across multi-day waits.

Sizing in `13-memory-layer-design.md` §307: working-memory checkpoints retained 35d = ~70 GB rolling, ~2 GB/day net new at 300K active SMBs.

---

## 9. Scale plan - sharding, IOPS, mitigation menu

Sizing math from `08-reliability-observability-and-failures.md` §4 (line 78): 40M diff-events/month × ~2 KB = 80 GB/month of `run_state` → 35-day retention = ~100 GB working set, fits hot.

But the IOPS envelope is tight (`20-critical-agent-approval.md` line 53): Aurora at 6× `r8g.4xl` sized in `06-scaling-and-capacity.md` §5.4 must absorb roughly `50K concurrent runs × 10 hops × 2 writes/hop = 1M writes/sec peak` if we wrote naively. We don't - the optimizations below collapse that by 1-2 orders of magnitude.

**Mitigation menu** (in order of when to apply, from `06-scaling-and-capacity.md` line 73 and `08` §4):

1. **Batch checkpoints every N hops** for non-HITL non-join nodes. Default N=5 at launch; tunable up to 10. Single biggest lever.
2. **jsonb column compression (lz4)** - switch from Aurora's default `pglz` to column-level lz4 once the table exceeds 50 GB. Cuts IO by ~40% on typical state payloads.
3. **Split into append-only `run_event_log` + periodic snapshot table.** Snapshot every 50 hops or 5 min idle. Resume reads the snapshot + tails the log forward. Reduces row count on the hot table by ~10×.
4. **Shard by `tenant_id mod 8`** as a logical partition. Aurora doesn't shard natively - this is a routing layer in the Orchestrator that picks one of 8 Aurora clusters (or 8 Citus shards if we go that route at year 2). Cutover trigger: when a single Aurora cluster's `run_state` write p99 exceeds 80 ms sustained for 1 hour.
5. **Fork the LangGraph checkpointer** (`10-cross-questions.md` line 38): if LangGraph's upstream checkpointer interface forces inefficient round trips (e.g., serializing the whole state on every node), replace it with a Postgres+Redis implementation we own. Diff-based writes only.
6. **Port hot paths to Temporal** (`09-tradeoffs-and-alternatives.md` line 25): trigger condition is fleet > 200K runs/day per region AND mitigation 1-5 are not enough. Keep LangGraph for prototyping; long-running side-effect sagas move to Temporal activities. This is already partially true - saga sub-workflows are Temporal (`12` §1035).

---

## 10. Build sequence

Order to ship the graph store, with the gate that justifies moving to the next step.

| Step | Ship | Gate to advance |
|---|---|---|
| 1 | `runs` + `run_state` tables, simple `(run_id, version)` append-only, Postgres-only checkpointer, no Redis cache, no batching | Single-tenant happy path: a 5-hop run completes and resumes after a forced pod kill |
| 2 | Lease-based claim with `SELECT FOR UPDATE SKIP LOCKED`, 30s TTL, 10s heartbeat | Worker crash mid-run is recovered by another worker in ≤ 30s; integration test asserts this |
| 3 | Two state classes: durable jsonb in `run_state` + run-scoped-ephemeral in process | HITL pause node holds a proposal, pod is killed, pod restart resumes from checkpoint with proposal intact (ephemeral scratchpad gone, that's fine) |
| 4 | Redis side cache for hot-path reads | Postgres read QPS on `run_state` drops by ≥ 80% under steady-state load |
| 5 | Graph version pinning + 3-version-hot executor | Mid-deploy regression test: a run started on version N completes successfully after version N+1 is deployed |
| 6 | Hop-batch checkpoint compaction (N=5 default) | Write IOPS to `run_state` drops by ≥ 4× under steady-state load; recovery cost on forced crash is still ≤ 1 node-replay |
| 7 | HITL pause survival across a multi-day window | End-to-end test: payroll approval started Monday, resumed Wednesday after a fleet rolling deploy and an Aurora failover in between |
| 8 | lz4 jsonb compression, `run_event_log` split, snapshot table | Triggered at 50 GB hot table size (not before - premature) |
| 9 | `tenant_id mod 8` sharding cutover | Triggered at write p99 > 80 ms sustained 1h on a single Aurora cluster (not before) |

Steps 1-7 are launch-blockers. Steps 8-9 are scale-time, not launch-time.

---

## 11. Cross-file index - where each detail lives

| Question | Authoritative file |
|---|---|
| What is the actual DDL for `run_state` and `runs`? | `05-low-level-design.md` lines 321-345 |
| What state keys does each node checkpoint, and at what durability class? | `12-agentic-graph-structure.md` §Layer 2, §Per-Node State Table |
| How does an HITL pause serialize its proposal and resume? | `12-agentic-graph-structure.md` §HITL Interrupt/Resume contracts |
| How do parallel joins survive worker crashes mid-aggregation? | `12-agentic-graph-structure.md` §Joins, lines 903-906 |
| What's the reliability contract - RPO, RTO, SLO? | `08-reliability-observability-and-failures.md` §1, §3, §4 |
| How big is the graph store at 1M MAU? | `08-reliability-observability-and-failures.md` §4 line 78; `13-memory-layer-design.md` §13 |
| When do we shard, switch checkpointers, or move to Temporal? | `09-tradeoffs-and-alternatives.md` lines 22-25 + this file §9 |
| What does a checkpoint write look like on the hot path? | `05-low-level-design.md` §3 (`CheckpointWriter`), §574-594 |
| How does graph-definition versioning interact with in-flight runs? | `10-cross-questions.md` line 46; `12-agentic-graph-structure.md` §support_window |
| Why LangGraph + Postgres checkpointer over Temporal / Step Functions / raw asyncio? | `09-tradeoffs-and-alternatives.md` rows 1 and 4 |

If a future reader of this pack asks "where is the graph store designed?", point them to this file first - every other detail is one hop away.

---
