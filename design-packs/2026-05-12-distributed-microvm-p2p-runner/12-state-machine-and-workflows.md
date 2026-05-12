# 12 — State Machine and Workflows

The two state machines that matter and the cross-node workflows that exercise
them.

## SM-1: Sandbox Lifecycle (owner-local)

The single-node lifecycle is unchanged by distribution; the only addition
is the terminal `Lost` state caused by owner death.

```
                 ┌────────┐
                 │Pending │  (placement decided; create RPC in flight)
                 └───┬────┘
                     │ admission ok, image pulled
                     ▼
                 ┌────────┐
                 │Created │  (container exists, not yet started)
                 └───┬────┘
                     │ start
                     ▼
                 ┌────────┐
                 │Running │ ──┐
                 └───┬────┘   │ stop
                     │        ▼
                     │   ┌────────┐
                     │   │Stopped │
                     │   └───┬────┘
                     │       │ destroy
                     │       ▼
                     │   ┌──────────┐
                     │   │Destroyed │ (terminal, GC'd)
                     │   └──────────┘
                     │
                     │ owner dies AND not Restartable
                     ▼
                 ┌────────┐
                 │ Lost   │ (terminal; placement Released)
                 └────────┘
```

**Distribution-only additions:**

- Pending → Created may involve a forward RPC if the API entrypoint is not
  the owner; the actual container creation still happens on the owner.
- Lost is reachable from any non-terminal state on owner death.

**Restartable variant:**

For sandboxes marked `Restartable=true`, owner death causes:

```
Running (on owner B)  → owner dies →  Migrating  →  Created (on new owner C)  →  Running (on C)
                                          │
                                          └─ pull snapshot from object store
```

Migrating is bounded by RTO (~30s by default). If snapshot pull or restart
fails, transitions to Lost.

## SM-2: Ownership

Independent of sandbox lifecycle. Lives in the placement Raft FSM.

```
       Place(S, owner=N)
             │
             ▼
        ┌──────────────┐
        │ Owned by N   │
        │ version=v    │
        └──────┬───────┘
               │
   ┌───────────┼─────────────────┐
   │           │                 │
   │ N dies    │ Move(S,N→M)     │ Release(S)
   │           │ (manual rebal)  │ (sandbox destroyed)
   ▼           ▼                 ▼
┌─────────────┐  ┌────────────┐  ┌──────────────┐
│ Reconcile   │  │ Owned by M │  │ Tombstoned   │
│ decides     │  │ version=v+1│  │ (24h GC)     │
└──────┬──────┘  └────────────┘  └──────────────┘
       │
       ├── Restartable → Place(S, owner=C, version=v+1) → "Owned by C"
       │
       └── Not Restartable → Release(S) → Tombstoned
```

`version` is monotonic per sandbox, owner-incremented by Raft commit.
Forwarders carry the version they saw; receivers reject stale forwards.

## Cross-Node Workflow 1: Create

```
┌──────┐         ┌──────┐         ┌──────┐         ┌──────┐
│Client│         │Node A│         │ Raft │         │Node B│
└──┬───┘         └──┬───┘         └──┬───┘         └──┬───┘
   │ POST /sb       │                │                │
   │───────────────▶│                │                │
   │                │ sample(2)      │                │
   │                │ → [B, C]       │                │
   │                │                │                │
   │                │ Place(S,owner=B,idem=K)         │
   │                │───────────────▶│                │
   │                │                │ commit         │
   │                │   PlacementEntry│                │
   │                │◀───────────────│                │
   │                │                │                │
   │                │  forward.Create(S, ...)         │
   │                │────────────────────────────────▶│
   │                │                │   admit       │
   │                │                │   alloc port  │
   │                │                │   write SQLite│
   │                │                │   start gVisor│
   │                │                │   config Caddy│
   │                │                │   pubsub event│
   │                │       SandboxInfo                │
   │                │◀────────────────────────────────│
   │   201 Created   │                │                │
   │◀───────────────│                │                │
```

**Failure: B NACKs with NoCapacity.** A's logic:

```
1. Receive NACK NoCapacity from B.
2. Pick C (the second sample) as new target.
3. Move(S, from=B, to=C, expectedVersion=v) on Raft.
4. forward.Create to C.
5. If C also NACKs: re-sample 2 fresh peers; retry up to 3 times total.
6. If all retries fail: Release(S); return 503 NoCapacity to client.
```

## Cross-Node Workflow 2: Hot-Path Proxy (HTTP into sandbox)

```
┌──────┐      ┌──────────┐                   ┌──────┐
│Client│      │Node A    │                   │Node B│
└──┬───┘      │(any node)│                   │(owner│
   │          └────┬─────┘                   │of S) │
   │  GET /v1/sb/S/proxy/...                 └──┬───┘
   │──────────────▶│                            │
   │               │ placement.Lookup(S) [cache]│
   │               │ → owner=B, ver=7            │
   │               │                             │
   │               │ open libp2p stream         │
   │               │ /sandboxd/proxy/1.0.0       │
   │               │────────────────────────────▶│
   │               │ PROXY-V1 S client_addr     │
   │               │────────────────────────────▶│
   │               │                            │ dial container IP:port
   │               │     splice bidirectionally  │
   │               │◀───────────────────────────▶│
   │               │                            │
   │     bytes     │                            │
   │◀──────────────▶│                           │
```

**Failure: cache stale, B was moved to C.**

```
B sees: I don't own S anymore. version mismatch.
B replies on the libp2p stream: NotOwner(actual=C, version=8).
A: refresh placement cache from gossip event or LookupAuthoritative.
A: open new libp2p stream to C.
A: retry once.
If C also returns NotOwner: 502 to client.
```

## Cross-Node Workflow 3: Owner Failover

```
Time   Event
T+0    Node B crashes (kernel panic)
T+5s   SWIM probes from peers all fail; B moves to suspicion
T+15s  SWIM declares B dead; emits NodeDead(B) event
T+15s  Each node's reconciler sees event; runs locally
        - Lists sandboxes owned by B (from local placement cache)
        - For each, decides: Restartable or Lost?
T+15s  One node (the placement Raft leader by default, or any node racing)
        proposes:
        - For each sandbox owned by B: Move(S, B→C, v+1) where C is
          freshly sampled
        - Or Release(S) for non-Restartable
T+16s  Raft commits the batch
T+16s  Watch fires on every node; placement cache updated
T+16s  New owners (the C's) reconcile:
        - For Restartable: pull snapshot, create container, Caddy config
        - For non-Restartable: nothing (just take ownership of the empty
          slot, which will be GC'd)
T+30s  Median sandbox restored on new owner; SLO target met.
```

**Idempotency:** any node can race the re-placement proposal. Raft serializes;
only one Move commits per sandbox. The losing proposers see "expectedVersion
mismatch" and drop their proposal.

## Cross-Node Workflow 4: Federation Cross-Fabric Create

```
Tenant T1 in fabric F1, capacity exhausted in F1.
F1 admission policy: spillover allowed to F2 for tenant T1.

┌──────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌──────┐
│Client│    │F1 Node A│    │F1 Bridge│    │F2 Bridge│    │F2 Node│
└──┬───┘    └────┬────┘    └────┬────┘    └────┬────┘    └───┬──┘
   │ POST       │              │              │             │
   │───────────▶│              │              │             │
   │            │ sample()     │              │             │
   │            │ → all peers  │              │             │
   │            │   exhausted  │              │             │
   │            │              │              │             │
   │            │ federation: ask F1 bridge for spillover   │
   │            │─────────────▶│              │             │
   │            │              │ over libp2p  │             │
   │            │              │─────────────▶│             │
   │            │              │              │ check policy│
   │            │              │              │ sample F2   │
   │            │              │              │             │
   │            │              │              │ Place in F2 Raft
   │            │              │              │ forward.Create
   │            │              │              │────────────▶│
   │            │              │              │             │ admit, run
   │            │              │              │ SandboxInfo │
   │            │              │              │◀────────────│
   │            │              │ SandboxInfo  │             │
   │            │              │◀─────────────│             │
   │            │ SandboxInfo  │              │             │
   │            │◀─────────────│              │             │
   │ 201        │              │              │             │
   │◀───────────│              │              │             │
```

**Ingress to the F2-hosted sandbox:** the SandboxInfo returned to the client
includes a CNAME-style address that resolves to the F1 bridge first; F1
bridge forwards to F2 bridge → F2 owner. Two extra hops in the
cross-fabric case; mitigation is direct DNS to F2 bridge for stable
sandboxes.

## Reconcile Algorithm (idempotent, runs every 30s + on events)

```python
def reconcile():
    # 1. Drain pending events first
    for event in event_queue.drain():
        handle(event)

    # 2. Local SQLite vs runtime
    for sb in store.list_local():
        if sb.status == Running and not runtime.has_container(sb.id):
            # container died; restart per policy
            transition(sb, Lost)
        if sb.status in (Stopped, Destroyed) and runtime.has_container(sb.id):
            runtime.remove(sb.id)

    # 3. Local SQLite vs placement
    for sb in store.list_local():
        entry = placement.Lookup(sb.id)
        if entry is None:
            # Placement says no such sandbox; tombstone locally
            store.tombstone(sb.id)
            runtime.remove(sb.id)
            continue
        if entry.owner != self.node_id:
            # We don't own this anymore; clean up
            runtime.remove(sb.id)
            store.tombstone(sb.id)

    # 4. Placement says I own X but I don't have it
    for entry in placement.OwnedBy(self.node_id):
        if not store.has(entry.sandbox_id):
            sb = replication.Pull(entry.sandbox_id)
            if sb is None:
                placement.Release(entry.sandbox_id, entry.version)
                continue
            store.put(sb)
            if sb.runtime_should_be_running:
                runtime.start(sb)

    # 5. GC TTL'd replicas
    store.evict_expired_replicas()

    # 6. Update capacity vector
    membership.PublishCapacity(capacity.Snapshot())
```

Every step is idempotent; running it twice is the same as running it once.

## Anchors From Resume

- **Reconcile loop / fault-tolerant execution across distributed environments**
  (resume.txt, blackbox-experience.md #15): the idempotent reconciler comes
  directly from this experience.
- **DAG workflow engine, checkpointing, retry semantics** (resume.txt,
  blackbox-experience.md #12-#13): the `Restartable` snapshot/restart
  workflow uses the same checkpoint+resume model.
