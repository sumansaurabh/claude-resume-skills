# 13 - Data Model and Storage

The three data substrates and exactly what lives in each.

## Substrate 1 - Per-Node SQLite (current, extended)

Owner-authoritative sandbox state. Replicas hold read-only snapshots with TTL.

### `sandboxes` table (extended)

```sql
CREATE TABLE sandboxes (
    id                 TEXT PRIMARY KEY,           -- ULID
    tenant_id          TEXT NOT NULL,
    runtime            TEXT NOT NULL,              -- 'gvisor' | 'runc' | 'firecracker'
    image              TEXT NOT NULL,
    cmd                TEXT,
    env_json           TEXT NOT NULL DEFAULT '[]',
    cpu_millis         INTEGER NOT NULL,
    memory_bytes       INTEGER NOT NULL,
    status             TEXT NOT NULL,              -- Pending|Created|Running|Stopped|Destroyed|Lost|Migrating
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    -- Distribution additions:
    owner_node_id      TEXT NOT NULL DEFAULT '',
    placement_version  INTEGER NOT NULL DEFAULT 0,
    replica_of_owner   TEXT,                        -- nullable; if set, this row is a read replica
    replica_ttl_at     INTEGER,                     -- Unix seconds, nullable
    restartable        INTEGER NOT NULL DEFAULT 0,  -- bool
    snapshot_uri       TEXT,                        -- last snapshot for Restartable
    fabric_id          TEXT NOT NULL DEFAULT 'local'
);

CREATE INDEX idx_sandboxes_owner   ON sandboxes(owner_node_id) WHERE replica_of_owner IS NULL;
CREATE INDEX idx_sandboxes_replica ON sandboxes(replica_ttl_at) WHERE replica_of_owner IS NOT NULL;
CREATE INDEX idx_sandboxes_tenant  ON sandboxes(tenant_id, status);
```

Owner rows: `replica_of_owner IS NULL`.
Replica rows: `replica_of_owner = <peer_id>`, `replica_ttl_at` set.

### `exposed_ports` (unchanged)

```sql
CREATE TABLE exposed_ports (
    sandbox_id  TEXT NOT NULL,
    container_port INTEGER NOT NULL,
    host_port      INTEGER NOT NULL,
    protocol       TEXT NOT NULL,
    mode           TEXT NOT NULL,  -- 'http_subdomain' | 'l4_tcp' | 'tls_sni'
    PRIMARY KEY (sandbox_id, container_port, protocol),
    FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_exposed_ports_host_port
    ON exposed_ports(host_port)
    WHERE host_port > 0;   -- partial index, the per-node allocator's serialization primitive
```

The host-port partial unique index remains as the per-node allocator
serialization primitive. Cross-node uniqueness is guaranteed by the
per-node port partition (Substrate 3).

### `sandbox_mounts` (unchanged)

```sql
CREATE TABLE sandbox_mounts (
    sandbox_id  TEXT NOT NULL,
    mount_path  TEXT NOT NULL,
    source      TEXT NOT NULL,
    read_only   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (sandbox_id, mount_path),
    FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id) ON DELETE CASCADE
);
```

### `idempotency_local`

Small per-node cache of `(tenant_id, idem_key) → sandbox_id` for the last
24h. The authoritative idempotency store is in placement Raft, but every
node also caches recent decisions to short-circuit repeats.

```sql
CREATE TABLE idempotency_local (
    tenant_id      TEXT NOT NULL,
    idem_key       TEXT NOT NULL,
    sandbox_id     TEXT NOT NULL,
    request_hash   BLOB NOT NULL,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, idem_key)
);

CREATE INDEX idx_idem_created ON idempotency_local(created_at);
```

### `audit_local`

Append-only audit log; shipped to immutable storage; truncated locally
after ship-confirm.

```sql
CREATE TABLE audit_local (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    actor_json  TEXT NOT NULL,
    action      TEXT NOT NULL,
    subject_json TEXT NOT NULL,
    result      TEXT NOT NULL,
    request_id  TEXT,
    idem_key    TEXT
);
```

`seq` is the per-node monotonic sequence used by the shipper to detect gaps.

## Substrate 2 - Placement Raft FSM (in-memory, snapshot to disk)

### State

```go
type FSM struct {
    placement map[string]PlacementEntry  // sandbox_id → entry
    ports     map[string]PortRange       // node_id → port range
    idem      *TTLMap                    // (tenant|key) → sandbox_id, 24h TTL
    fabricID  string
    version   uint64                     // FSM-level monotonic
}

type PlacementEntry struct {
    SandboxID    string
    OwnerNodeID  string
    Version      int64       // monotonic per sandbox
    PlacedAt     int64       // Unix nanos
    Reason       string      // 'create' | 'move:owner_dead' | 'move:rebalance' | 'release'
    Restartable  bool
    SnapshotURI  string      // optional, for Restartable
}

type PortRange struct {
    NodeID    string
    Start     uint16
    End       uint16
    Generation uint64        // bump on reassignment
    AssignedAt int64
}
```

### Commands

```go
type Command struct {
    Op     OpType  // Place | Move | Release | AssignPortRange | ExpirePortRange | RegisterIdem
    Args   []byte  // protobuf-encoded
}
```

### Snapshot format

```
header: { fsm_version, fabric_id, snapshot_index, snapshot_term }
section 1: placement entries (sorted by sandbox_id, length-prefixed proto)
section 2: port ranges (sorted by node_id)
section 3: idem entries (sorted by (tenant, key); only un-expired)
checksum: sha256 over header + sections
```

### Compaction

`hashicorp/raft` snapshot triggers: log size > 50MB OR commit count > 10K.
Snapshot interval default 10 minutes. Snapshots retained 7 days.

### Sizing

| Item | Size per | At 1M sandboxes | At 10M sandboxes |
| --- | --- | --- | --- |
| PlacementEntry | ~120 bytes | 120 MB | 1.2 GB |
| PortRange | ~50 bytes × 10K nodes | 500 KB | 500 KB |
| Idem entry | ~80 bytes (24h × 200/sec ~17M peak) | 1.4 GB | 1.4 GB |

Total in-memory FSM: 100s of MB to ~3 GB at the upper end. Acceptable on a
voter with 16 GB RAM. Above that, shard the placement Raft.

## Substrate 3 - libp2p PubSub Topics (Eventually Consistent Replication)

Used for eventually-consistent replica sync of sandbox state.

### Topics

```
/sandboxd/v1/sandbox/{shard_id}        - sandbox mutation events
/sandboxd/v1/capacity                  - capacity vectors (membership delegate)
/sandboxd/v1/audit                     - optional audit fan-out for telemetry
```

`shard_id` = `hash(sandbox_id) % N_SHARDS`. Default `N_SHARDS = 64`.

### Message format (`/sandboxd/v1/sandbox/{shard}`)

```protobuf
message SandboxMutation {
    string sandbox_id      = 1;
    int64  version         = 2;     // owner-incremented
    string owner_peer_id   = 3;
    Sandbox payload        = 4;     // full row
    bytes  signature       = 5;     // owner signs the canonical encoding
    int64  hlc_timestamp   = 6;     // hybrid logical clock
}
```

Subscribers verify the signature against the placement-recorded owner. LWW
on `(version, hlc_timestamp)` for conflict resolution.

### Subscription strategy

A node subscribes to:

- All shards containing sandboxes it owns (~few shards, by hash distribution).
- A small random sample of other shards (default 3) for resilience.
- Shards a tenant has explicitly pinned (for multi-tenant proximity).

This bounds per-node subscription bandwidth while preserving "any node can
serve any GET" property.

## Substrate 4 - Object Store (Optional, For Restartable Sandboxes)

For `restartable=true` sandboxes, the owner periodically writes a
checkpoint snapshot to a tenant-configured object store (S3-compat).

### Layout

```
s3://{tenant_bucket}/sandboxd/{fabric}/{sandbox_id}/
    checkpoint-v{N}.tar.zst        - gVisor checkpoint + writable layer
    checkpoint-v{N}.meta.json      - { sandbox_row_snapshot, hlc_ts }
    LATEST                         - pointer to v{N}
```

Snapshot interval is tenant-configurable, default 60s. Snapshots older than
24h are GC'd. On owner failover, new owner pulls `LATEST`, restores, resumes.

This integrates the BlackBox DAG checkpointing pattern (durable resumable
agents, blackbox-experience.md #12-#15) - same checkpoint-and-resume model
applied to sandbox VMs.

## Substrate 5 - Local Capacity Cache (in-process, gossiped)

Each node holds an in-memory map of peer capacity vectors:

```go
type capacityCache struct {
    mu    sync.RWMutex
    peers map[peer.ID]*PeerCapacityState
}

type PeerCapacityState struct {
    Capacity    PeerCapacity
    LastUpdate  time.Time
    Generation  uint64
    Suspect     bool       // SWIM suspicion
}
```

Updated on every gossiped capacity message. Used by `Sample()` for
power-of-two-choices.

## Cross-Substrate Invariants

| Invariant | Substrate(s) | How enforced |
| --- | --- | --- |
| Exactly one owner per sandbox | Raft FSM | Raft serializes Place/Move/Release |
| No two nodes share a port range | Raft FSM | AssignPortRange is a Raft commit |
| No cross-tenant sandbox-id collision | SQLite + Raft idem | ULIDs from owner; idem-key dedupe in Raft |
| Replica eventual consistency | PubSub + SQLite TTL | LWW + TTL eviction |
| Audit completeness | SQLite + audit log shipper | Per-node monotonic seq + immutable store sequence verification |

## Migration From Single-Node To Distributed

A running single-node deployment migrates by:

1. Upgrading binary (Raft FSM starts empty, single voter).
2. Running migration: `sandboxd cluster init --bootstrap-from-store`. This
   walks local SQLite and inserts a `Place(S, owner=self, version=1)` for
   every active sandbox.
3. Adding peer nodes via standard join.

Net downtime: zero (the local sandboxes keep running; only the
control-plane behavior changes after init).

## Anchors From Resume

- **SQLite-backed local store with WAL semantics**: matches the per-host
  state of the BlackBox sandbox plane.
- **Checkpointing in DAG workflow engine** (blackbox-experience.md #12):
  same model as the Restartable snapshot path.
- **Multi-tenant infrastructure with isolation strategies** (resume.txt,
  Microsoft section): the tenant-id partitioning and per-tenant audit/quota
  storage model.
