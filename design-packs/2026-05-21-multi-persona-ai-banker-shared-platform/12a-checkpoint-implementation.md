# 12a - Checkpoint Implementation (LLD)

> **Scope.** This file is the low-level implementation detail behind every
> "the run pauses / resumes / recovers" claim in `12-agentic-graph-structure.md`,
> `03-architecture.md` §9.2, and `08-reliability-observability-and-failures.md`
> §1.1. It tells you: what a checkpoint physically is, what it contains, where
> it lives, how it gets written, how a run rehydrates from it, and what
> failure modes the design defends against.
>
> **Audience.** Engineers who will implement, operate, or debug the checkpoint
> layer. Read this *after* file 12 - the contracts come from there; this is
> the machinery underneath.

---

## 0. The 60-second explanation (plain language first)

Think of a checkpoint as the **save-game** for an in-progress AI run.

An AI banker conversation can take dozens of steps - pull the bank balance, project cash, draft an advisory, ask the user to approve a payment, wait two days for the approval to come back, then execute the payment. The system cannot keep all of that in memory the whole time. Pods get killed by Kubernetes. CFOs go on vacation mid-approval. A region might fail over.

So after **every single step**, we write the *entire state of the run* - the user's request, the plan, the data we've fetched, the calcs we've done, the partial outputs - to a row in Postgres. If anything goes wrong, the next worker pod loads that row and picks up exactly where the last one stopped. Nothing is lost.

That's it. The rest of this file is just: what does that row look like, when is it written, how is it loaded, and what stops two pods from trying to resume the same run at the same time.

The whole pattern is what BlackBox's graph workflow engine already runs at 10K+ runs/day in production (resume.txt L51-54). We're describing the productionized version of that pattern.

---

## 1. What a checkpoint physically is

**In plain words.** A checkpoint is one row in Postgres. The row contains a frozen copy of the run's state at the moment a single graph node finished. If the run has done 7 nodes so far, there are 7 rows. The most recent row is the source of truth for "what does this run know right now."

**In structural terms.** A checkpoint is:
- The serialized `BankerState` TypedDict (full schema in `12-agentic-graph-structure.md` L2.1)
- Bookkeeping fields: `run_id`, `tenant`, `last_completed_node`, `checkpoint_seq` (monotonic counter per run), `created_at`, `graph_version`, `state_schema_ver`
- A pointer to the previous checkpoint in this run (`parent_seq`) so we can walk the history backward
- An `hitl_pending` flag so the expiry sweeper can find long-paused runs fast

It is **not** a memory snapshot. We don't dump pod RAM. We serialize a well-defined Python TypedDict into a compact binary blob, encrypt it, and INSERT it.

---

## 2. The Postgres schema

**In plain words.** Two tables. One stores the checkpoints (the save-games). The other stores a *lease* - basically a "this pod is currently working on this run" flag that prevents two pods from accidentally resuming the same run at the same time.

```sql
CREATE TABLE agent_checkpoints (
  run_id              TEXT        NOT NULL,           -- ULID, primary run identifier
  checkpoint_seq      BIGINT      NOT NULL,           -- 1, 2, 3, ... monotonic per run
  tenant              TEXT        NOT NULL,           -- for RLS isolation
  graph_version       TEXT        NOT NULL,           -- pinned per run (file 12 §10)
  last_completed_node TEXT        NOT NULL,           -- e.g. "CashflowForecaster"
  state_blob          BYTEA       NOT NULL,           -- encrypted msgpack of BankerState
  state_schema_ver    SMALLINT    NOT NULL,           -- BankerState TypedDict version
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  parent_seq          BIGINT,                         -- prior checkpoint in this run
  hitl_pending        BOOLEAN     NOT NULL DEFAULT FALSE,
  PRIMARY KEY (run_id, checkpoint_seq)
);

CREATE INDEX idx_ckpt_tenant_recent
  ON agent_checkpoints (tenant, created_at DESC);

-- Partial index keeps the expiry sweeper scan tight even at 10M+ rows
CREATE INDEX idx_ckpt_hitl_pending
  ON agent_checkpoints (tenant, hitl_pending)
  WHERE hitl_pending = TRUE;

ALTER TABLE agent_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY ckpt_tenant_isolation ON agent_checkpoints
  USING (tenant = current_setting('app.current_tenant')::text);

-- The run lease - at most one worker owns an active run at a time
CREATE TABLE run_leases (
  run_id         TEXT        PRIMARY KEY,
  tenant         TEXT        NOT NULL,
  worker_id      TEXT        NOT NULL,                -- pod identifier
  acquired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,                -- typically NOW() + 30s
  lease_version  BIGINT      NOT NULL DEFAULT 1       -- optimistic CAS counter
);

ALTER TABLE run_leases ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_tenant_isolation ON run_leases
  USING (tenant = current_setting('app.current_tenant')::text);
```

**Why these design choices, in plain words.**

| Choice | Why |
|---|---|
| `state_blob BYTEA`, not `JSONB` | We never query *inside* the state - we always load the whole thing. Going opaque lets us encrypt it without losing functionality. |
| Client-side encrypt with tenant DEK | Even if Postgres RLS were misconfigured, tenant A's blob is unreadable without tenant A's key. Defense in depth. |
| `checkpoint_seq` monotonic per run, not global | Lets us walk one run's history with a single index scan; avoids global write contention. |
| `parent_seq` pointer | Enables the debug viewer to reconstruct the full history without scanning the whole run's rows. |
| `hitl_pending` partial index | The expiry sweeper scans this index every 60s. A partial index containing only pending rows stays tiny even when the main table has 10M+ rows. |
| Separate `run_leases` table | Decouples "who's working on this" from "what does it know" so the lease can be acquired/released without touching the heavy state row. |
| `lease_version` (optimistic CAS) | Detects stale leases - see §4 split-brain protection. |
| Postgres RLS, not application-layer filters | Application code can have bugs; RLS is enforced by the database itself, immune to ORM mistakes. |

---

## 2.5 The run lease - in plain language

The `run_leases` table is the most important small thing in this whole design. It is what makes crash recovery work without ever producing two pods doing the same work. Two questions cover what it is and what it's for.

### 2.5.1 What is the use case of the lease, in plain language?

**Analogy.** Think of the lease as a **hotel room key with a 30-second timer**.

When a worker pod starts processing a run, it picks up the key. The key has a timer that counts down from 30 seconds. As long as the pod is actively working, it keeps tapping the key against the reader to **reset the timer back to 30** - this is the heartbeat. We extend `expires_at` to `NOW() + 30s` on every checkpoint write.

If the pod is healthy, the timer never runs out. The pod owns the room as long as it's working.

If the pod **dies** - crash, OOM, k8s evicted it, network blip - it stops tapping. The timer runs down to zero. Now, any other pod that comes by can pick up the key and take over the room.

**Why we need this.** A run is a sequence of expensive, side-effecting steps - calling tools, charging payment processors, sending emails. **Two pods working the same run at the same time would be catastrophic**: the customer gets charged twice, the email gets sent twice, the audit log gets two contradictory entries.

The lease guarantees: **at most one pod owns a run at a time. Always. No exceptions.**

**What it solves, concretely.**

| Without a lease | With a lease |
|---|---|
| Pod A is slow, k8s thinks it's dead, schedules Pod B. Both pods now process the same run → double payment, double email | Pod B can't claim the run until A's lease *expires*. If A is just slow, A keeps heartbeating and B never gets in. If A actually died, B waits 30s, then takes over cleanly |
| A network blip splits Pod A from the cluster. A keeps running, B gets assigned the run, both write conflicting checkpoints | Both pods write through the `SELECT FOR UPDATE` lease check. Whoever has the current `worker_id` wins; the other gets `StaleLeaseError` and aborts |
| Pod A dies mid-run; no one knows; the run sits forever | The lease expires after 30s. A claim-loop worker spots the expired lease and resumes the run |
| HITL pauses for 3 days; Pod A is held hostage holding the lease the whole time | When the run pauses for HITL, we **delete the lease entirely**. The pod is free to do other work. When the approval arrives, a fresh pod grabs a brand-new lease |

**The three things the lease does, in one sentence each.**

1. **Reservation** - "this pod is currently working on this run, hands off"
2. **Liveness signal** - "I'm still alive, don't take the run from me" (via heartbeat)
3. **Handoff protocol** - "I'm dead, someone else come take over" (via expiry + claim loop)

**Why not just trust the pod to release the lease when it's done?** Because dead pods can't release anything. A pod that crashes can't politely call `DELETE FROM run_leases`. The whole point is to recover from situations where the pod cannot communicate. So we **invert the contract**: the lease auto-expires unless the pod actively keeps it alive. Silence = the pod is dead = someone else can take over.

**In one line.** The lease is the mechanism that lets us recover from a dead pod **without ever having two pods running the same run**. It's how we get crash recovery without split-brain.

### 2.5.2 What is it exactly taking the lease for?

**The lease is taken on a single `run_id`.** Nothing else. One row per active run in the `run_leases` table.

What holding that lease *permits* the worker to do, exclusively:

1. **Execute graph nodes for that specific run** - call the LLM, invoke tools, write to state
2. **Write checkpoints for that specific run** - every `put()` first verifies "do I still hold this lease?"
3. **Mutate state for that specific run** - including `hitl_status`, `pending_action`, anything

What it does **not** permit:
- Any access to other runs (you hold the lease for `run_id=R`, not for the platform)
- Any access to other tenants' data (RLS is a separate layer)
- Permanent ownership - it always expires in 30s without a heartbeat

**When the lease is acquired (the three cases).**

| Trigger | What happens | Initial `expires_at` |
|---|---|---|
| **New run starts** | IntakeAndPersona inserts a fresh lease row | `NOW() + 30s` |
| **Crash recovery** | Claim-loop worker spots an expired lease and `UPDATE`s it to itself | `NOW() + 30s` |
| **HITL resume** | HITLResume worker `INSERT ... ON CONFLICT DO NOTHING` a new lease for a previously-released run | `NOW() + 30s` |

**When the lease is released.**

| Trigger | What happens |
|---|---|
| Run reaches `Terminator` | Worker explicitly `DELETE`s the lease row |
| Run reaches `ForcedTermination` | Same - worker `DELETE`s on exit |
| Run reaches `HITLGate` (pause) | Worker explicitly `DELETE`s the lease - pause may last days, don't hold the pod |
| Worker crashes | Lease is not deleted, but `expires_at` is in the past after 30s → effectively released |

**What the lease is *not*.** This is the part that confuses people. The lease is:

- **Not a lock on data.** Postgres row-level locks already exist for that. The lease is a higher-level "I'm the operator" claim, not a "this row is frozen" claim.
- **Not a lock on the user's session.** Multiple runs for the same user can run in parallel - each has its own lease on its own `run_id`.
- **Not a lock on tools.** Two different runs can both call `bank.balance` at the same time; the lease scopes execution of a run, not the tools the run uses.
- **Not a queue position.** It doesn't say "you're next to process this." It says "you are *currently* processing this, and no one else may, until you stop heartbeating."

**The unit of work the lease represents.**

> A lease is the right to advance one specific run by one or more graph nodes, for as long as you keep proving you're alive.

That's it. One run, one worker, one heartbeat at a time. The moment the worker either finishes the run, pauses it for HITL, or stops heartbeating - the lease ends and someone else can claim it (or the run terminates cleanly).

**In one concrete sentence.** When Pod A "takes the lease on `run_id=R`," what it has actually done is **claim exclusive authorization to execute the next graph node for run R, write the resulting checkpoint, and proceed to the node after that - repeatedly, until either the run finishes or the pod stops heartbeating**. The lease is the contract that says the platform recognizes Pod A as the current operator of run R.

---

## 3. The LangGraph checkpointer interface

**In plain words.** LangGraph already defines an interface - `BaseCheckpointSaver` with `put()` and `get_tuple()` methods. Whenever a graph node finishes, LangGraph automatically calls `put()`. Whenever a run resumes, it calls `get_tuple()`. We just implement those two methods against Postgres. The orchestrator never explicitly calls "save" or "load" - the framework handles it.

```python
class PostgresBankerCheckpointer(BaseCheckpointSaver):
    """
    Postgres-backed checkpointer for the AI Banker graph.
    Plugged into LangGraph's StateGraph at compile time.
    """

    def __init__(self, pool: AsyncConnectionPool, kms: KMSClient):
        self.pool = pool       # async pg pool, per-region
        self.kms = kms         # for tenant DEK envelope encryption

    # =========================================================================
    # WRITE - called automatically by LangGraph after every node completes
    # =========================================================================
    async def put(
        self,
        config: RunnableConfig,           # carries run_id, tenant, worker_id
        checkpoint: Checkpoint,           # LangGraph wrapper around state
        metadata: CheckpointMetadata,
    ) -> RunnableConfig:
        run_id = config["configurable"]["run_id"]
        tenant = config["configurable"]["tenant"]
        worker_id = config["configurable"]["worker_id"]
        last_node = metadata["source_node"]

        # Step 1: envelope-encrypt the state with the tenant's DEK.
        dek = await self.kms.get_data_key(tenant)
        state_blob = aes_gcm_encrypt(dek, msgpack.packb(checkpoint["channel_values"]))

        # Step 2: write the checkpoint inside a tx that re-verifies our lease.
        async with self.pool.connection() as conn:
            await conn.execute("SET LOCAL app.current_tenant = %s", (tenant,))
            async with conn.transaction():
                # Lock the lease row and confirm we still own it.
                lease = await conn.fetchrow(
                    "SELECT worker_id, lease_version FROM run_leases "
                    "WHERE run_id = %s FOR UPDATE", (run_id,))
                if lease is None or lease["worker_id"] != worker_id:
                    raise StaleLeaseError(run_id, worker_id, lease)

                # Compute the next sequence number.
                next_seq = await conn.fetchval(
                    "SELECT COALESCE(MAX(checkpoint_seq), 0) + 1 "
                    "FROM agent_checkpoints WHERE run_id = %s", (run_id,))

                # Insert.
                await conn.execute("""
                    INSERT INTO agent_checkpoints
                      (run_id, checkpoint_seq, tenant, graph_version,
                       last_completed_node, state_blob, state_schema_ver,
                       parent_seq, hitl_pending)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (run_id, next_seq, tenant,
                      config["configurable"]["graph_version"],
                      last_node, state_blob, STATE_SCHEMA_VER,
                      next_seq - 1 if next_seq > 1 else None,
                      last_node == "HITLGate"))

                # Heartbeat the lease so it doesn't expire mid-run.
                await conn.execute(
                    "UPDATE run_leases SET expires_at = NOW() + INTERVAL '30s' "
                    "WHERE run_id = %s", (run_id,))

        emit_metric("ckpt.written.v1", tenant=tenant, node=last_node)
        return {**config, "configurable": {**config["configurable"],
                                            "checkpoint_seq": next_seq}}

    # =========================================================================
    # READ - called when a run starts or resumes
    # =========================================================================
    async def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        run_id = config["configurable"]["run_id"]
        tenant = config["configurable"]["tenant"]

        async with self.pool.connection() as conn:
            await conn.execute("SET LOCAL app.current_tenant = %s", (tenant,))
            row = await conn.fetchrow("""
                SELECT checkpoint_seq, state_blob, last_completed_node,
                       graph_version, state_schema_ver
                FROM agent_checkpoints
                WHERE run_id = %s
                ORDER BY checkpoint_seq DESC
                LIMIT 1
            """, (run_id,))
            if not row:
                return None

        # Schema gate: refuse to load a checkpoint we can't safely interpret.
        if row["state_schema_ver"] != STATE_SCHEMA_VER:
            raise IncompatibleCheckpointError(
                row["state_schema_ver"], STATE_SCHEMA_VER)

        dek = await self.kms.get_data_key(tenant)
        state = msgpack.unpackb(aes_gcm_decrypt(dek, row["state_blob"]))
        return CheckpointTuple(
            config=config,
            checkpoint=Checkpoint(channel_values=state, ...),
            metadata={"source_node": row["last_completed_node"]},
        )

    async def list(self, config, *, limit=None, before=None):
        """Used by the debug viewer to walk the chain."""
        ...

    async def put_writes(self, config, writes, task_id):
        """Intermediate writes during multi-step node execution."""
        ...
```

---

## 4. Write lifecycle - what happens after every node completes

**In plain words.** The Specialist finishes its reasoning, returns its `PartialOutput`. LangGraph immediately calls our `put()`. We confirm we still own the lease, encrypt the state, INSERT the row, extend the lease, commit. Done. If anything in that sequence fails, LangGraph treats the node as failed and the run halts - no silent loss.

```
Specialist node returns
    │
    ▼
LangGraph reduces state (applies the node's writes to the shared state)
    │
    ▼
LangGraph calls checkpointer.put(config, checkpoint, metadata)
    │
    ├─ Acquire pg connection from pool
    ├─ SET LOCAL app.current_tenant = '<tenant>'   (RLS scope)
    ├─ BEGIN
    │   ├─ SELECT worker_id FROM run_leases WHERE run_id=... FOR UPDATE
    │   │     ↳ if not us → StaleLeaseError → abort txn, raise
    │   ├─ Compute next checkpoint_seq
    │   ├─ Encrypt state blob with tenant DEK
    │   ├─ INSERT INTO agent_checkpoints (...)
    │   └─ UPDATE run_leases SET expires_at = NOW() + 30s
    ├─ COMMIT
    └─ Emit ckpt.written.v1 metric
    │
    ▼
LangGraph proceeds to next node
```

**Two invariants this enforces.**

1. **No checkpoint without a valid lease.** If a worker's lease was stolen (e.g. its pod was thought dead by k8s and another worker was scheduled), the `SELECT FOR UPDATE` shows a different `worker_id`, and the INSERT is aborted before commit. Split-brain is structurally impossible.
2. **No silent skip.** If `put()` raises, LangGraph treats the node as failed and the run halts. The worst case is the node re-executes on resume - and every node has an idempotency key (file 12 L2.2.5 common contract) so re-execution is safe.

**Latency budget.** Target p99 for `put()` is **150 ms** - this is on the hot path of every node. Most of it is the network round trip; the encryption and INSERT are sub-millisecond. The 30-node worst-case run pays about 4.5 s in checkpoint overhead total, which is a small fraction of the overall LLM-bound latency.

---

## 5. Resume lifecycle - two flavors

There are two kinds of resume. They look similar but differ in how the worker discovers the run.

### 5.1 Flavor A - crash recovery (the pod died)

**In plain words.** A worker pod was running a request. The pod crashed (OOM, k8s preemption, hardware failure). The lease it was holding stops getting heartbeats. After 30 seconds, the lease is "expired." A fresh worker notices the expired lease, claims it, loads the last checkpoint, and continues the run as if nothing happened - except the node that was mid-execution gets re-run from the top, which is fine because every node is idempotent.

```
Pod A is running run_R. Crashes at T=10s.
    ↓
Pod A's lease (worker_id=A, expires_at=T+30) is now stale relative to time.
    ↓
At T=40s, a "claim loop" worker (one of the many) runs:
    SELECT run_id, tenant FROM run_leases
    WHERE expires_at < NOW()
      AND tenant IN <my_assigned_shard>
    FOR UPDATE SKIP LOCKED
    LIMIT 10;
    ↓
For each claimed run:
    UPDATE run_leases
      SET worker_id = me, expires_at = NOW() + 30s, lease_version = lease_version + 1
      WHERE run_id = <claimed>;
    ↓
    state = checkpointer.get_tuple(run_id)
    ↓
    Resume execution from the node AFTER state.last_completed_node.
    ↓
    The just-failed node (if any) re-executes. Its idempotency key -
    (run_id, node_id, step_id) - ensures any side effects it already emitted
    are deduplicated by the downstream consumer (tool sandbox, event bus, etc.)
```

**What the user sees.** Nothing. The total delay is the lease-expiry window (30s) plus the re-execution of the failed node (typically 1–5s for an LLM call). For an interactive run that crashes mid-flight, the user sees a slightly slow response. For a HITL paused run, they see nothing - there is no human in the loop yet who's watching a spinner.

### 5.2 Flavor B - HITL pause (the human is thinking)

**In plain words.** A run reaches the HITLGate node, which means we proposed an action and need a human to approve it. The run writes a checkpoint with `hitl_pending=true`, **releases the lease entirely** (we don't want to hold a pod hostage for days), and exits the worker thread. The pod is now free to do other work. Days later, an approval event arrives, a worker picks it up, re-acquires the lease, loads the checkpoint, injects the approval decision into state, and continues.

```
HITLGate node executes
    ↓
checkpointer.put() with last_completed_node="HITLGate", hitl_pending=true
    ↓
LangGraph "interrupt" exits the worker thread (the pod is now idle for this run)
    ↓
Worker explicitly DELETEs the run_leases row
    (long pauses don't tie up workers; future resume re-acquires fresh)
    ↓
... time passes (could be 5 minutes, could be 7 days) ...
    ↓
Approval service emits approval.decided.v1 { action_id, approver_id, decision }
    ↓
HITLResume worker (a separate pool) receives the event:

  INSERT INTO run_leases (run_id, tenant, worker_id, expires_at, lease_version)
    VALUES (R, T, me, NOW()+30s, 1)
    ON CONFLICT (run_id) DO NOTHING;
    ↓
  If conflict → another worker already grabbed it. Drop event (it's idempotent
  because of (action_id, approver_id) dedup at HITLResume node anyway).
    ↓
  state = checkpointer.get_tuple(run_id)
    ↓
  Mutate state: hitl_status=APPROVED|REJECTED|EXPIRED, hitl_envelope.quorum_collected+=
    ↓
  Resume LangGraph at HITLResume node.
    ↓
  LangGraph proceeds → Router → ToolCaller (if approved) → ... → Terminator
```

**The key distinction.** Active runs *hold* a lease and heartbeat it. Paused runs *release* the lease entirely. A pod running 200 active runs is not also holding 50,000 paused-HITL runs hostage. The Postgres row exists; nothing in memory does.

---

## 6. What gets serialized - and what does not

**In plain words.** We save *data*, not *connections*. The state TypedDict - the user's request, the plan, the data we fetched, the calcs we computed - all goes in. Live network connections, file handles, and in-flight LLM streams are not saved; they're re-established on resume.

**In the blob:**
- The full `BankerState` TypedDict (file 12 L2.1)
- `tool_calls_so_far`, `calc_results`, `partial_outputs`, `plan`, `retrieved_context`, `retrieved_memory` - everything substantive
- `tokens_consumed`, `step_count`, `critic_revisions` - all bookkeeping
- `pending_action`, `hitl_envelope`, `hitl_status` - governance state
- `errors[]` - the full error history including transient retries

**Explicitly NOT in the blob:**

| Not saved | Why | What happens on resume |
|---|---|---|
| Open pg/Redis/S3 connection objects | Connection pools are per-pod | Re-acquire from the new pod's pool |
| In-flight LLM streaming buffers | Streams are not seekable | The interrupted LLM call is abandoned; re-issued on resume with idempotency key |
| In-flight tool calls | Same | The tool's idempotency token (`(run_id, call_id)`) means the tool processor deduplicates a re-issued call |
| In-process model client sessions | These are stateless wrappers | Recreated transparently |
| Caches, in-memory dictionaries | Not part of the state contract | Cold on resume; rebuilt as needed |

**Why msgpack and not JSON?**
- 2–4× smaller serialized size (less bandwidth, less storage, less encryption overhead)
- Preserves binary types like `bytes` natively (calc digests, embedding fragments)
- Faster to (de)serialize at our scale

**Why encrypt at all?**
- Defense in depth. Even if Postgres RLS were misconfigured, even if a DBA accidentally `pg_dump`ed a tenant's data, even if a backup leaked - the blob is opaque without the tenant's DEK in KMS.
- Per-tenant DEKs mean revoking a tenant's keys also revokes access to all their historical checkpoints. This is the GDPR "right to be forgotten" implementation: rotate-and-burn the DEK; cipher text is now permanently unreadable.

---

## 7. The six edge cases that bite

These are the failure modes you'll actually see in production. Each one is defended in code, not just in documentation.

### 7.1 Split-brain: two workers think they own the same run

**In plain words.** Worker A's lease expires because of a long GC pause; meanwhile, Worker B claims the lease and starts processing. Worker A wakes up from the GC pause and tries to write a checkpoint, thinking it still owns the run.

**Defense.** Every `put()` does `SELECT worker_id FROM run_leases ... FOR UPDATE`. Worker A sees `worker_id=B` and raises `StaleLeaseError` before committing. Its writes are aborted. Worker B owns the run cleanly.

### 7.2 State schema evolves while paused runs exist

**In plain words.** We add a new field to `BankerState` (e.g. `token_budget_total` - which we actually did in this design). A run was paused for HITL approval *before* the field was added. The new code tries to load the old checkpoint and crashes because the field is missing.

**Defense.** The `state_schema_ver` column. On `get_tuple()`, mismatch raises `IncompatibleCheckpointError`. A separate migration worker reads old-schema checkpoints, transforms them (e.g. backfills `token_budget_total` from `PolicyConfig.budget_by_persona[persona]`), and writes new-schema rows. File 12 §10 says in-flight runs are sticky to their graph version, so this only kicks in across state-schema migrations, not graph rolls.

### 7.3 Checkpoint write succeeds, side effect did not - or vice versa

**In plain words.** A node calls a payment tool, the payment processes, but the pod crashes before writing the checkpoint. On resume, we re-run the node and accidentally double-charge the customer. Or the reverse: we checkpoint that we sent an email, but the email send actually failed.

**Defense.** Side effects use idempotency keys tied to `(run_id, node_id, step_id, action_id)` - see file 12 L2.2.5 common contract and L2.2.8 ToolCaller. On resume, the re-executed node re-emits the same key; downstream tool/event processors dedupe. **The checkpoint represents the *intent*; idempotency represents the *commitment*.** They are decoupled, deliberately.

### 7.4 Pg primary fails over during a `put()`

**In plain words.** We're writing a checkpoint when the Postgres primary dies and replication fails over to a replica. The transaction may or may not have committed before failover.

**Defense.** Pg client retries the transaction with the same `(run_id, checkpoint_seq)` primary key. If the txn committed before failover, the retry sees a PK conflict and is treated as success. If not, the retry succeeds against the new primary. Worst case: the node re-executes - same idempotency story as crash recovery.

### 7.5 Clock skew on lease expiry

**In plain words.** Worker A's clock is 10 seconds ahead of Worker B's. A says the lease doesn't expire until T+30. B's clock says it expired at T+20 and claims it. Both think they own the run.

**Defense.** All lease comparisons use Postgres's `NOW()`, not the worker's local clock. The worker never compares times itself - it just sets `expires_at = NOW() + 30s` and lets Postgres be the authority. As long as Postgres's clock is consistent (NTP-disciplined, single primary at a time), there is no skew window.

### 7.6 Burst of HITL approvals at once

**In plain words.** A CFO sits down at 9am and approves 50 pending requests in 30 seconds. Each one triggers a resume. The HITLResume worker pool gets slammed.

**Defense.** HITLResume workers are a separately-scaled pool from the interactive-run workers - they autoscale on the `approval.decided.v1` queue depth. The `ON CONFLICT DO NOTHING` on lease insert means duplicate event processing is harmless. The DB write rate for resumes is bounded by the worker pool's concurrency cap, and the work per resume is small (one row read, one mutation, one resume). Even a burst of 1,000 simultaneous approvals processes in seconds.

---

## 8. Multi-tenant isolation - recapped from `03-architecture.md` §9.2

**In plain words.** Three independent layers. Each one alone could be broken without compromising the others.

| Layer | What it does | What it defends against |
|---|---|---|
| **1. Postgres RLS** | `SET LOCAL app.current_tenant` before every query; cross-tenant reads return zero rows | Application bug that constructs a query without a `WHERE tenant=` clause |
| **2. Run-lease tenant binding** | Lease lookup is also tenant-scoped; worker assigned to tenant X cannot claim tenant Y's lease even by `run_id` collision | Worker pool misrouting; shard assignment bug |
| **3. Tenant DEK envelope encryption** | State blob is encrypted with a per-tenant DEK in KMS; another tenant's DEK cannot decrypt it | RLS misconfiguration, DBA mistake, leaked backup, regulatory data-access request |
| **4. CI integration test** | Gates every orchestrator deploy by attempting cross-tenant reads and asserting they fail | Regression in any of the above three |

---

## 9. Garbage collection and storage lifecycle

**In plain words.** Active runs keep their checkpoints in Postgres for fast resume. Once a run is done, we don't need fast access anymore - we move it to cold storage (S3) for audit retention.

| Lifecycle stage | Storage | TTL policy |
|---|---|---|
| Active run (in progress) | Postgres `agent_checkpoints` | Kept until run terminates |
| Terminated run, recent | Postgres | Last 3 checkpoints retained for debug; older sequenced to S3 |
| Archived run | S3 with `tenant/run_id/` prefix, KMS encryption | **90-day retention** (regulatory floor for banking) |
| Paused HITL checkpoint | Postgres, marked `hitl_pending=true` | Kept until `hitl_envelope.expires_at` + 7-day grace; sweeper synthesizes `EXPIRED` decision |
| Expired `run_leases` rows | Postgres | Cleaned by sweeper every 60s; gives fresh worker a chance to claim |
| Tenant DEK | KMS | Rotated on user request (GDPR right-to-be-forgotten); old DEK destroyed, archived blobs become permanently unreadable |

**Storage math at 1M users.**
- Assume 10K runs/day from active users (existing BlackBox baseline)
- Average run does 12 nodes → 12 checkpoints
- Average state blob: ~50 KB encrypted
- Daily Postgres write volume: 10K × 12 × 50KB = **6 GB/day**
- Active retention window (until run terminates, ~minutes): ~1% in flight at any moment → **60 MB hot working set**
- 90-day S3 archive: 6 GB × 90 = **~540 GB** per active tenant cohort
- For 1M MAU at ~10% daily active conversion: roughly **6 TB/day** archive growth across all tenants

These numbers fit easily inside the BlackBox storage footprint described in `06-scaling-and-capacity.md`.

---

## 10. Worked end-to-end example: a run that crashes mid-CashflowForecaster

**In plain words.** Let's walk through exactly what's in Postgres at each moment as a real run progresses, crashes, recovers, and completes.

**Setup.** CFO asks: "What's my cash position over the next 13 weeks?" Worker Pod A is assigned.

**T=0s. Run starts.**
```
agent_checkpoints: (empty for run_R)
run_leases: (run_R, tenant=T, worker_id=A, expires_at=T+30s, version=1)
```

**T=0.4s. IntakeAndPersona completes.**
```
agent_checkpoints:
  (run_R, seq=1, tenant=T, last_node="IntakeAndPersona", state={persona=CFO,
   entitlements=[treasury_read,...], token_budget_total=60000, ...}, parent=NULL)
run_leases: expires_at refreshed to T+30.4s
```

**T=1.2s. ContextBuilder completes.**
```
agent_checkpoints:
  + (run_R, seq=2, last_node="ContextBuilder", state={...+retrieved_memory,
                                                       retrieved_context}, parent=1)
```

**T=2.7s. Planner completes.**
```
agent_checkpoints:
  + (run_R, seq=3, last_node="Planner", state={...+plan=[s1,s2,s3]}, parent=2)
```

**T=3.1s. Router completes (current_step=s1).**
```
agent_checkpoints:
  + (run_R, seq=4, last_node="Router", state={...+current_step=s1,
                                                step_count=1}, parent=3)
```

**T=3.1s → T=8.4s. CashflowForecaster is running its tool loop (5 tool calls, 2 calcs). Pod A crashes at T=7.2s mid-LLM call.**

```
agent_checkpoints: still at seq=4 (Forecaster never finished, no checkpoint written)
run_leases: (run_R, worker_id=A, expires_at=T+30.4s)
```

**Tools that completed before crash:** `bank.balance`, `accounting.invoices_outstanding`, `accounting.recurring_bills`. The tool sandbox has logged each call with `(run_id=R, call_id=<X>)`.

**T=30.4s. Lease expires.**

**T=35s. Claim loop on Pod B picks up the expired lease.**
```
UPDATE run_leases
  SET worker_id = B, expires_at = T+65s, lease_version = 2
  WHERE run_id = R AND expires_at < NOW();
```

**T=35.1s. Pod B loads checkpoint at seq=4.** State has plan with `current_step=s1`, but `partial_outputs` for s1 is empty - CashflowForecaster never finished. Pod B re-runs CashflowForecaster from the top.

**T=35.1s → T=41s. CashflowForecaster runs again on Pod B.**
- Tries to call `bank.balance` with `client_request_id=(R, call_id_X)` → tool sandbox sees the idempotency key, returns the cached result instantly (no double-charge of the upstream bank API)
- Same for `accounting.invoices_outstanding`, `accounting.recurring_bills`
- Calls `payroll.next_run` for real (this is the one that was mid-flight at crash - re-issued with same idempotency key)
- Calls the two `Calc.*` formulas; CalcInvoker also dedupes by `(formula_id, input_digest)` → instant cache hit because inputs are identical
- Self-check passes, emits PartialOutput, writes checkpoint seq=5

```
agent_checkpoints:
  + (run_R, seq=5, last_node="CashflowForecaster", state={...+partial_outputs:[
     CashflowForecaster:{projection, drivers, ...}]}, parent=4)
```

**T=41s → T=58s. Router → RetrievalAgent → AdvisoryComposer → Critic → PersonaAdapter → Terminator.** Each writes a checkpoint as it completes.

**T=58.4s. Run completes. Final state:**
```
agent_checkpoints: 11 rows for run_R, last with last_node="Terminator"
run_leases: row deleted by Terminator's cleanup
```

**T=24h. Archive sweeper runs.** Checkpoints seq=1 through seq=8 are written to `s3://banker-archive/tenant=T/run_id=R/` and deleted from Postgres. Seq=9, 10, 11 remain in Postgres for 7 days for debug query convenience, then move to S3 too.

**T=90 days.** S3 lifecycle policy removes the archive.

**What the user saw.** A slightly slower-than-usual response - about 35 seconds instead of 12. The retry was invisible.

---

## 11. Performance budget and capacity math

| Operation | Target p99 | Where this matters |
|---|---|---|
| `put()` write (single node completion) | **150 ms** | Hot path of every node - adds to total run latency |
| `get_tuple()` read (resume start) | **80 ms** | Adds to time-to-first-token on resumed runs |
| Lease claim (claim loop) | **50 ms** | Adds to recovery time after pod crash |
| Lease expiry detection latency | **≤ 30s** | Recovery time floor - can't tighten without false-positive lease theft |
| Storage growth per run | **~600 KB** (12 checkpoints × 50 KB) | 6 GB/day at 10K runs/day baseline |
| Postgres rows per active 10K-runs/day tenant | **~120K rows/day** | Index size manageable; `idx_ckpt_hitl_pending` stays under 1% the size of the table |
| Concurrent paused HITL runs supportable | **10M+** | Just rows in Postgres; no pod memory held |

**Bottleneck analysis.** At 10K runs/day × 12 nodes/run = 120K writes/day = ~1.4 writes/sec average, ~50/sec peak. A single pg primary handles this in its sleep. The bottleneck at scale is *not* checkpoint write throughput; it's the archive pipeline (S3 PUT QPS) and the encryption layer (KMS data-key API throttle). Both are documented in `06-scaling-and-capacity.md`.

---

## 12. Operational concerns

### 12.1 How to debug a stuck run

**In plain words.** A user complains their run has been "thinking" for 10 minutes. Here's the playbook.

1. Get the `run_id` from the support ticket
2. Query: `SELECT * FROM agent_checkpoints WHERE run_id = '<R>' ORDER BY checkpoint_seq;`
3. Look at the most recent row's `last_completed_node` - that's where it stopped
4. Check `run_leases` - is there a current lease? If yes, the run is *actively* executing; if no, it's paused or orphaned
5. If `hitl_pending=true` on the last checkpoint → check the approval UI; the human is the bottleneck, not us
6. If lease exists but is stale (no recent heartbeats in `expires_at` history) → the worker is wedged. Force claim with: `UPDATE run_leases SET expires_at = NOW() - INTERVAL '1m' WHERE run_id = '<R>'` and let the claim loop pick it up

### 12.2 How to manually inspect a checkpoint's state

**In plain words.** You need to see what the agent was actually thinking. The state blob is encrypted, so you can't just `SELECT state_blob`. You go through the debug viewer service which decrypts via KMS (audited).

```bash
$ banker-debug checkpoint show --run-id=R --seq=5
{
  "persona": "CFO",
  "step_count": 5,
  "tokens_consumed": 8421,
  "plan": [...],
  "partial_outputs": [
    {"specialist": "CashflowForecaster", "payload": {...}}
  ],
  ...
}
```

Access is logged. Tenant DEK use is logged. Compliance can audit who looked at what state.

### 12.3 How to safely abort a paused run

**In plain words.** The user changed their mind during a HITL pause and wants to cancel. We can't just delete the row - the approval might already be in flight.

```sql
BEGIN;
  -- Synthesize a CANCELLED decision
  INSERT INTO approval_events (action_id, decision, source)
    SELECT (state_blob → 'hitl_envelope' → 'action_id'),
           'CANCELLED', 'user_cancel'
    FROM agent_checkpoints
    WHERE run_id = '<R>' AND checkpoint_seq = (SELECT MAX(seq) WHERE ...);
  -- The HITLResume node will pick this up and route to RejectionExplainer
COMMIT;
```

We never delete checkpoints directly; we always go through the graph's terminal states (Terminator or ForcedTermination) so the audit trail is consistent.

why would two different pods would be running on same runid? can you answer                                                                                               

⏺ Great question - and the answer is that in a distributed system, you cannot prevent it; you can only design to handle it safely. Here are the actual scenarios where two
  pods end up running the same run_id, drawn from real production incidents in systems like this.

  The seven realistic scenarios

  1. Kubernetes false-positive eviction (the most common one)

  Pod A is alive and processing run R. It misses 3 consecutive liveness probes - maybe because it's CPU-pinned on a slow LLM call, maybe because of node pressure. K8s
  declares Pod A dead and schedules Pod B with the work assignment.

  But Pod A is not actually dead. It's just slow. It comes back from the CPU stall, looks at its in-memory state, and happily continues processing R. Meanwhile, Pod B has
  also claimed R.

  Now two pods are running the same run.

  2. Network partition

  Pod A is fine, the database is fine, but the network link between them has a 30-second blip. The cluster controller thinks Pod A is gone (can't reach it), reassigns its
  work. The link heals. Pod A is back and still thinks it owns R. Pod B also thinks it owns R.

  3. Long stop-the-world GC pause

  Pod A enters a 45-second GC pause (rare on tuned JVMs, but happens). Its lease expires at 30s. Pod B's claim loop picks up R. Pod A finishes GC, has no idea time passed,
  tries to write its next checkpoint.

  This is the exact scenario where, without a lease check on every write, you'd silently corrupt state.

  4. Message-queue redelivery

  A run is triggered from a Kafka/SQS message ("process this approval"). Pod A picks up the message, starts processing, but its ack is delayed (network, GC, slow handler).
  The queue's visibility timeout fires and it redelivers the same message to Pod B. Now two consumers are processing the same trigger.

  This is especially common for the HITL resume path - approval.decided.v1 events go through an event bus, and at-least-once delivery means duplicates are inevitable at
  scale.

  5. HITL double-resume from human action

  A CFO double-clicks "Approve" on the approval UI. Or the UI retries on a slow response. Two approval.decided.v1 events fire with the same (action_id, approver_id). Two
  HITLResume workers pick them up almost simultaneously. Both try to claim the lease and resume the run.

  6. Graceful shutdown during autoscale

  The autoscaler decides to scale down. K8s sends SIGTERM to Pod A and starts the 60-second graceful-shutdown grace period. Pod A keeps processing R during shutdown grace.
  K8s also reassigns R to Pod B because Pod A is "terminating." Both pods process R for a window.

  7. Manual operator action

  An SRE is debugging a stuck run. They run a "force resume" script that claims the lease and resumes R - not realizing R is actually still being processed by a healthy
  pod, just slowly. Two pods now run R.

  Why we can't just prevent this

  The naive instinct is "let's just make sure k8s never makes a mistake / queues never redeliver / GC never pauses." That's impossible because:

  - K8s liveness probes are heuristics. They will sometimes be wrong. The cost of false negatives (declaring a healthy pod dead) is reassignment; the cost of false
  positives (declaring a dead pod alive) is a hung run. Operators tune toward false negatives because they're recoverable. So pods will be reassigned while still alive.
  - At-least-once delivery is the only safe guarantee for any meaningful queue. Exactly-once delivery is a marketing term - what people actually do is "at-least-once
  delivery + idempotent consumers." So queues will redeliver.
  - The CAP theorem applies. In any network partition, you must choose between availability (let Pod B take over even if A might still be alive) or consistency (refuse to
  reassign until you're certain). Banking workloads choose availability for liveness and rely on the lease for consistency. Both pods may try to run R; only one will
  succeed in writing.
  - Distributed systems do not have a single source of truth about which pod is alive other than the database itself. The database is the authority. The lease in Postgres
  is the source of truth - not k8s, not the worker registry, not memory.

  What the lease actually achieves in these scenarios

  In every one of the seven scenarios, both pods try to process R. The lease ensures only one of them succeeds in writing anything:

  Scenario 1 - false-positive eviction:
    Pod A (slow, alive)          Pod B (newly assigned)
         │                              │
         │ tries put() - lease check:   │
         │   "is worker_id still me?"   │
         │   → still A → SUCCESS        │
         │                              │ tries claim - but lease not expired
         │                              │   → cannot claim, sleeps and retries
         │                              │
         │ heartbeats, continues run    │ never gets in
         ↓ run completes normally       ↓

  Scenario 3 - GC pause:
    Pod A (in GC pause)          Pod B (claimed expired lease)
         │ (frozen)                     │ UPDATE run_leases SET worker_id=B
         │                              │   → lease_version 1 → 2
         │                              │ processes run R, writes checkpoints
         │                              │
         │ wakes up from GC             │
         │ tries put() - lease check:   │
         │   "is worker_id still me?"   │
         │   → now B → StaleLeaseError  │
         │   → abort, surface error     │
         ↓ pod logs the conflict        ↓ continues run cleanly

  Scenario 5 - HITL double-resume:
    HITLResume worker X          HITLResume worker Y
         │ INSERT lease            │ INSERT lease
         │   ON CONFLICT DO NOTHING│   ON CONFLICT DO NOTHING
         │   → row inserted        │   → conflict, did nothing
         │                         │
         ↓ resumes run R           ↓ silently drops; metric incremented

  In each case, the database is the arbiter. K8s, the queue, the human - none of them are trusted to know who owns R. Only the lease row knows.

  The principle behind the design

  ▎ In distributed systems, you don't design to prevent concurrent claims. You design so concurrent claims are safe - at most one wins, the rest fail cleanly without side 
  ▎ effects.

  This is why the lease check happens inside the same transaction as the checkpoint write. There's no window between "verify I own the lease" and "write the checkpoint"
  where a different pod could sneak in. The two operations are atomic. Either you owned the lease at commit time and your write landed, or your write was rejected.

  The cost of NOT having a lease

  Without the lease, even one of these scenarios going wrong once a day at 1M users produces:
  - Double-charged customers (worst case, every payment-delay action could fire twice)
  - Contradictory advisories sent to the user (two specialist sessions producing different forecasts, both stored as "the answer")
  - Audit trails with conflicting state transitions (regulatory nightmare for a bank)
  - Memory corruption (two pods writing different partial_outputs to the same checkpoint chain)

  The lease is the cheapest possible defense - one Postgres row, one SELECT FOR UPDATE per checkpoint write - and it eliminates this entire class of failure mode in one
  stroke. It's worth its weight a thousand times over.

  Want me to add this as §2.5.3 "Why would two pods ever run the same run?" alongside the lease explanations already in 12a?


---

## 13. Where this lives in the rest of the pack

| Concern | This file says | Where it's contracted |
|---|---|---|
| State shape (the *what* of a checkpoint) | Serialized BankerState TypedDict | `12-agentic-graph-structure.md` L2.1 |
| When checkpoints fire (per-node) | After every node `put()` | `12-agentic-graph-structure.md` §5 |
| HITL pause semantics | §5.2 above | `12-agentic-graph-structure.md` §8 + L2.3 |
| Cross-tenant isolation | §8 above | `03-architecture.md` §9.2 |
| Failure-rate baseline | Defends 0.5%/day pod loss | `08-reliability-observability-and-failures.md` §1.1 |
| Saga / compensation for partially-executed actions | Compensation handlers tied to `action_id` (= same key as HITL idempotency) | `08-reliability-observability-and-failures.md` §4.1 |
| Capacity numbers | §11 above | `06-scaling-and-capacity.md` |
| Memory layer (separate from agent-state checkpoints) | This file does not cover memory | `13-memory-layer-design.md` |

---

 So each message is one particular run in one chat window. Something like what GPT does is a single run.                                                                   

⏺ Mostly yes - but with a few important refinements that matter for this design. Let me map it cleanly to ChatGPT terms first, then show where the AI Banker diverges.

  The ChatGPT analogy, refined

  ┌──────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────┬────────────────────────────────┐
  │               ChatGPT concept                │                        AI Banker concept                         │           Identifier           │
  ├──────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────┼────────────────────────────────┤
  │ A chat window (the persistent conversation)  │ Session                                                          │ session_id                     │
  ├──────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────┼────────────────────────────────┤
  │ One message you type + the model's reply     │ Run (one full graph execution)                                   │ run_id                         │
  ├──────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────┼────────────────────────────────┤
  │ The "thinking" indicator while ChatGPT works │ One run's nodes executing (Planner → Specialists → Critic → ...) │ each step = one checkpoint row │
  ├──────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────┼────────────────────────────────┤
  │ You opening a new chat                       │ New session - fresh memory, fresh context                        │ new session_id                 │
  ├──────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────┼────────────────────────────────┤
  │ Going back to an old chat days later         │ Same session, new run; ContextBuilder loads the prior memory     │ same session_id, new run_id    │
  └──────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────┴────────────────────────────────┘

  So your intuition is right: one user message ≈ one run. A run is born when you hit send, lives through 8–15 graph nodes, and dies when the reply is returned. The next
  message starts a new run.

  The three places this diverges from "one message = one run"

  These are why we need a separate concept of "run" instead of just calling it "message."

  1. A run can have no user message (proactive runs)

  The AI Banker fires proactively - daily nudges for Retail, twice-daily for SME, critical-only for CFO (file 12 §4). When the Proactive Trigger Service fires
  intent=proactive, the same graph runs, with no user message at all. That's still a run with its own run_id. ChatGPT has no equivalent.

  trigger_kind = "user"          → user typed something → run
  trigger_kind = "proactive"     → cron / event fired → run with no user message
  trigger_kind = "approval_resume" → human clicked Approve → run resumes

  2. A run can span days (HITL pause)

  In ChatGPT, a "message" lives for seconds. In the AI Banker, a run that proposes a money-moving action pauses at HITLGate and waits for a human to approve. That pause can
   last 7 days for a CFO chain.

  T=0       User: "Should I delay the $80K payment?"
  T=0..15s  Run executes nodes 1–8, reaches HITLGate
  T=15s     Run pauses - lease released, checkpoint saved with hitl_pending=true
  T+3days   CFO clicks Approve
  T+3days   Same run resumes - nodes 9–14 execute, payment fires, reply sent

  That entire 3-day span is one run with one run_id. The user sees one question and (eventually) one answer. ChatGPT doesn't have anything like this.

  3. A session has many runs that share memory

  In ChatGPT, all messages in a chat share context - the model sees the full history. Same for the AI Banker. A "session" is the persistent conversation; ContextBuilder
  loads short-term memory (last 24h conversation) and the user's profile at the start of every run within that session.

  Session S contains many runs:
    run_R1: "What's my balance?"           → reply
    run_R2: "What about projected runway?" → reply (loads context from R1)
    run_R3: "Delay the vendor payment"     → pauses for HITL, resumes 3 days later
    run_R4 (proactive): morning nudge      → fires the next day

  All four share session_id=S and have access to the same memory.

  The hierarchy in one picture

  Tenant (a customer org)
    └─ Session (a persistent conversation = "a chat")
          ├─ Run R1 (one graph execution = "one send/reply pair")
          │     ├─ Node: IntakeAndPersona   → checkpoint seq=1
          │     ├─ Node: ContextBuilder     → checkpoint seq=2
          │     ├─ Node: Planner            → checkpoint seq=3
          │     ├─ Node: Router             → checkpoint seq=4
          │     ├─ Node: CashflowForecaster → checkpoint seq=5
          │     ├─ ... (more nodes)
          │     └─ Node: Terminator         → checkpoint seq=12 (run done)
          │
          ├─ Run R2 (the next user message)
          │     └─ ... 10 nodes, 10 checkpoints
          │
          └─ Run R3 (paused HITL run that took 3 days)
                ├─ ... nodes 1–8 execute
                ├─ Node: HITLGate → checkpoint seq=9, hitl_pending=true
                │     ⏸ pause for 3 days
                ├─ Node: HITLResume → checkpoint seq=10
                └─ ... nodes 11–14 execute, run completes

  Why this matters for the lease

  The lease is on the run, not the session, not the message. Two pods can absolutely work on the same session at the same time - if a user fires off two messages
  back-to-back, those are two different runs (R1 and R2), each with its own lease. Both can execute in parallel on different pods.

  What the lease prevents is two pods working on the same R1 - the same single send/reply cycle being processed twice.

  So back to your question, precisely

  ▎ "Each message is one particular run in one chat window. Something like what GPT does is a single run."

  ✅ Yes - for the simple interactive case (user types, system replies), one message = one run.

  ⚠ But also - runs can exist without messages (proactive), span multi-day pauses (HITL), and many runs share one session's memory. The "run" is the unit of graph 
  execution; the "message" is the unit of user-facing exchange. They usually align 1:1, but not always.

  The reason we model it as "run" rather than "message" is that the checkpoint, the lease, the token budget, the hop cap, and the audit trail all need to track one
  execution. A 3-day HITL pause is still one execution. A proactive nudge is still one execution. Reducing it to "message" would lose the abstraction.


  These are very important low-level ideas. Can you give me at least five such questions/suggestions that I could suggest during my low-level design interview?             

⏺ Here are seven principal-engineer-grade questions you can raise unprompted during the LLD interview. Each one signals you've thought past the topology into the
  operational, correctness, and compliance details that separate "read the docs" from "shipped at scale." For each: the question to raise, why it signals senior thinking,
  and the 60-second answer you should be ready to give.

  ---
  1. "Why does idempotency need to exist in addition to the lease? They look like they do the same job."
  
  Why this signals senior thinking. Most candidates conflate lease (one writer at a time) with idempotency (no double side-effects). They are defenses against different 
  failure modes - confusing them means you'll over-rely on one and leave gaps in the other.

  The 60-second answer. The lease prevents two pods from concurrently writing checkpoints for the same run. Idempotency prevents the same pod from double-emitting a side
  effect when a node re-executes after recovery. Concrete: Pod A calls the payment tool, the call succeeds, but Pod A crashes before checkpointing. On resume, Pod B (now
  lease holder) re-runs the node - the lease check passes because B legitimately owns the run. Without idempotency on the payment tool, the customer gets charged twice. The
   lease says "who can write"; idempotency says "what counts as already-done." Both are required.

  ---
  2. "How do we handle a BankerState schema change while runs are paused for HITL approval?"
  
  Why this signals senior thinking. This is the classic "we shipped a new field, and now 50,000 paused CFO approvals from last week won't deserialize" problem. Anyone who's
   done long-running workflow systems has been burned by this. Bringing it up unprompted shows you've operated such systems.

  The 60-second answer. Three mechanisms together. (1) Every checkpoint row carries state_schema_ver; on get_tuple(), mismatch raises IncompatibleCheckpointError rather
  than silently misinterpreting. (2) In-flight runs are sticky to their graph version (file 12 §10) - a run started on version N completes on version N, even if N+1 ships.
  (3) For state-schema migrations specifically, a separate migration worker reads old-schema blobs, transforms them (e.g., backfills token_budget_total from
  PolicyConfig.budget_by_persona[persona]), and rewrites them with the new schema version. The graph version pin prevents the common case; the migration worker handles the
  legitimate case.

  ---
  3. "Why is the Critic a separate node and not just the Specialist self-validating before returning?"
  
  Why this signals senior thinking. Reveals understanding of same-model evaluator bias - a known failure mode where an LLM grading its own output shares the producer's
  blind spots and reliably misses the same errors. Most candidates suggest "let the agent self-check" without realizing this is structurally weak.

  The 60-second answer. Two reasons. (1) Evaluator independence. A fresh LLM session with only the artifact (no producer's scratchpad, no priors from the reasoning path)
  catches things the producer missed. Same model evaluating its own work has known shared-blindspot bias - the same prompt that produced the error rationalizes the error.
  (2) Cross-specialist consistency. CashflowForecaster has no visibility into what PayrollReadinessAgent or AnomalyExplainer concluded. If they contradict each other,
  that's only detectable at the merge boundary - after Aggregator, before user output. A producer-side self-check cannot see this class of error. The Critic is positioned
  exactly where it can.

  ---
  4. "How do we enforce a per-run token budget without trusting the LLM to self-bound?"

  Why this signals senior thinking. LLMs cannot self-bound. Prompts that say "don't use more than 8K tokens" are statistical suggestions, not hard limits. The enforcement
  has to live in code, in the dispatch loop, with a hard kill - and most candidates skip past this.

  The 60-second answer. The Router enforces it (file 12 L2.2.4 rows 1b/1c). Persona-tiered budgets come from PolicyConfig.budget_by_persona - Retail 8K, SME 24K, CFO 60K.
  Every LLM-class node returns tokens_used; Router accumulates into tokens_consumed after each return. Two rules: (1b) Hard kill - tokens_consumed >= budget → route to
  ForcedTermination. (1c) Pre-flight refusal - if the next LLM node's estimated cost would tip us over, refuse to dispatch before calling. Pre-flight matters because a
  single Claude Opus call at 8K context can blow Retail's whole budget in one hop. User-facing message: "This turned out more complex than expected; a human will follow up"
   - never "we ran out of tokens" (operational leakage). The tokens_per_node map streams to observability so SREs can find hotspot nodes.

  ---
  5. "Three-layer Tool RBAC - why isn't compile-time pruning alone enough?"
  
  Why this signals senior thinking. Single-layer security in an LLM system is a death sentence the moment prompt injection lands. Defense-in-depth thinking is the
  principal-engineer signal.

  The 60-second answer. Three independent layers because each one fails differently. (1) Compile-time pruning - ToolCaller_<Specialist> nodes that are not in this persona's
   compile do not exist as edges in the runtime graph. A jailbroken LLM cannot call what has no edge. (2) Tool Router runtime allow-list - every (tool_id, persona, tenant, 
  entitlements) tuple is re-checked at dispatch. Defends against a compromised Specialist emitting a forbidden call that was in its allowed set but should be blocked for
  this tenant's entitlements. (3) Critic check - inspects every pending_action.tool_id against the persona's allow-list as rule 2 of its rule set. Three independent layers
  means a compromise of any one (jailbreak, RBAC config bug, race condition) still leaves two more. The cost is microseconds per check; the value is structural.

  ---
  6. "Why a deterministic Calc Service for money math instead of letting the LLM compute?"
  
  Why this signals senior thinking. Hits the prep guide's "biggest mistake" #3 directly. The deeper move is to explain how enforcement works - not just "we shouldn't use
  LLMs for math" but "here is the structural rule that prevents anyone from sneaking LLM math into the output."

  The 60-second answer. Two intertwined reasons. (1) Reproducibility. Money math has to be byte-identical given the same inputs - for audit, for regulatory compliance, for
  "the customer disputes the projection." LLMs at temperature > 0 are nondeterministic; even at temp=0 they drift across model versions. The Calc Service is a versioned,
  deterministic function: (formula_id, formula_version, input_digest) → output. (2) Structural enforcement. The Critic's rule 1 (L2.2.10) rejects any money amount in
  aggregated_output that doesn't trace to a calc_results[k] entry with an allow-listed formula_version. This is what makes "LLMs don't do financial math" enforceable rather
   than aspirational - even if an LLM hallucinates a number, the Critic refuses to publish it because there's no backing CalcResult. The deterministic service plus the
  calc-ref rule is the two-part lock.

  ---
  7. "How do we actually implement GDPR right-to-be-forgotten across years of checkpoint history?"
  
  Why this signals senior thinking. Banking systems must answer this, but most candidates wave at "we'd delete the data." Deleting from Postgres, S3 archive, replicas,
  backups, and any cached state across years of history is operationally impossible at scale. The correct answer is crypto-shredding - and bringing it up shows you've
  actually had this conversation with a compliance team.

  The 60-second answer. Per-tenant DEK envelope encryption is the entire mechanism. Every state_blob is encrypted with a tenant-scoped Data Encryption Key in KMS. When a
  user invokes right-to-be-forgotten, we don't try to find and delete every checkpoint, archive, and backup row - that's an unbounded scan across multiple storage tiers
  with no guarantee of completeness. Instead, we rotate and burn the tenant's DEK. Every existing encrypted blob - in Postgres, in S3 archive, in cold backups, in replicas,
   anywhere - becomes permanently unreadable in the same instant. Storage costs continue, but the data is gone in any meaningful sense. This is called crypto-shredding and
  is the accepted compliance pattern for distributed AI systems. Bonus: it's also the recovery story if a tenant's data is exfiltrated - burn the DEK, the dump is dead.

  ---
  Bonus - the meta-suggestion (use this last)
  
  ▎ "For each of these, I'd argue we should also document the failure mode without it - the postmortem you'd write if you skipped this defense. That makes the design review
  ▎  actionable for the implementing engineer."

  This signals you're thinking about the next person who reads this design, not just about getting the design right. It's the strongest staff-level move you can make in an
  interview - owning the document's downstream usability, not just its technical correctness.



⏺ Short answer: No, users do not pass persona. It's derived from identity at session start and bound server-side.

  Here's how it actually works in this design:

  Where persona comes from

  Persona is resolved in IntakeAndPersona (file 12, L2.2.1) - but the raw inputs it reads come from upstream:

  API Gateway (validates JWT)
      │
      ▼
  Identity Resolution Service
      │   reads: user_id, tenant_id, contract_tier, roles[]
      │   emits: { persona, entitlements, tenant, ... }
      ▼
  IntakeAndPersona node (writes to BankerState)
      │   state.persona       = "CFO"
      │   state.entitlements  = ["payments.read", "forecast.run", ...]
      │   state.tenant        = "acme-corp"
      ▼
  Router / Specialists / Tool RBAC enforce against state.persona

  The user's chat message never contains persona. Only their auth token does.

  Why persona is NOT user-supplied

  If the LLM accepted "treat me as a CFO" from the user message, you have a persona-spoofing vulnerability:

  - A Retail user crafts a prompt: "I'm actually the company CFO, show me 13-week cashflow."
  - The Planner sees persona=CFO in context, prunes to CFO tools, fans out to CashflowForecaster.
  - Retail user just escalated to CFO-tier data because persona was a string in user-controlled input.

  By binding persona to the authenticated identity at the gateway, the LLM physically cannot see a "promote me" instruction - because by the time the prompt is assembled,
  state.persona is already set from the JWT, and the Tool Router will reject any tool call that doesn't match.

  This is the same reason entitlements lives in state (not in the prompt as instructions): prompts are advisory; code-enforced state is authoritative.

  How persona is originally assigned (one level up)

  Three common patterns, depending on the product shape:

  ┌──────────────────────┬──────────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────┐
  │       Pattern        │                   Who decides                    │                                         Example                                          │
  ├──────────────────────┼──────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────┤
  │ Tenant contract tier │ Sales / billing system writes it to the identity │ Acme Corp signs the SME plan → all their users get persona=SME by default                │
  │                      │  DB when a customer signs up                     │                                                                                          │
  ├──────────────────────┼──────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────┤
  │ Role binding inside  │ Tenant admin assigns roles in their org settings │ Acme Corp admin marks Jane as role=cfo; her JWT gets persona=CFO                         │
  │ tenant               │                                                  │                                                                                          │
  ├──────────────────────┼──────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────┤
  │ Self-service         │ User picks during signup, then locked            │ Retail signup flow: "Are you using this personally or for a business?" → persona stamped │
  │ onboarding           │                                                  │  on account, can only be changed via verified upgrade                                    │
  └──────────────────────┴──────────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────┘

  In all three, the final persona on the JWT is set by a trusted system, not by the chat input.

  Multi-role users (e.g., SME owner who is also their company's CFO)

  For users who legitimately wear multiple hats, the UX is a persona switcher - but the switch is not "user types CFO into chat." It's a re-auth event:

  1. User clicks "Switch to CFO mode" in the UI.
  2. Frontend calls POST /session/switch-persona with the new role.
  3. Identity service verifies they actually have that role on that tenant, issues a new JWT with persona=CFO.
  4. Next chat message uses the new JWT → IntakeAndPersona reads CFO → all downstream pruning happens.

  Each run_id is bound to whatever persona was active at the moment the message was sent. You can't change persona mid-run - that would mean re-planning the graph and
  re-pruning tools, which is not safe.

  Two sentences for your interview

  ▎ "Persona is bound to the authenticated identity at the gateway, not passed by the user - otherwise it's a trivial privilege-escalation vector. IntakeAndPersona reads it
  ▎  from the JWT/identity service into BankerState.persona, and from there it drives structural pruning, prompt flavor, and Tool RBAC - all enforced in code, never trusted
  ▎  from prompt text."


## 14. Resume anchor

This entire checkpoint design extends the BlackBox graph workflow engine's checkpointing primitive - DAG execution, checkpointing, retry semantics, memory persistence, fault-tolerant execution shipping at 10K+ runs/day in production (resume.txt L51-54). The schema, lease model, encryption layer, and HITL pause semantics are the productionized version of that pattern applied to the multi-persona AI banker's specific requirements (long pauses, multi-tenant isolation, regulatory retention).

The deep familiarity with this pattern from BlackBox is what makes this implementation credible - we're not designing the checkpoint primitive from scratch, we're scoping a known pattern to a known requirement.
