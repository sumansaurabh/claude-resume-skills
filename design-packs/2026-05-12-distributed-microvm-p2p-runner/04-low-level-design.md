# 04 — Low-Level Design

## Module Layout

```
cmd/sandboxd/
  main.go                    # cluster bootstrap added
internal/
  store/                     # unchanged: local SQLite
  service/                   # small change: forward on non-owner ops
  runtime/                   # unchanged: gVisor/runc abstraction
  cluster/                   # NEW
    membership/              #   SWIM gossip + capacity vector
    placement/               #   Raft FSM (or CRDT) for owner pointer
    ports/                   #   per-node port partition allocator
    transport/               #   libp2p host, stream multiplexing
    ingress/                 #   owner-aware proxy forwarder
    federation/              #   bridge peer + cross-fabric admission
pkg/
  api/v1/                    # small change: proxy.go forwards
  caddy/                     # unchanged
  capacity/                  # small change: Snapshot() for gossip
  docker/                    # unchanged
```

## Core Types

### `cluster.Node`

The top-level handle. Owns sub-systems and lifecycle.

```go
type Node struct {
    self         PeerCapacity
    membership   *Membership      // SWIM
    placement    PlacementClient  // Raft client (leader-aware)
    ports        *PortPartition
    transport    *Transport       // libp2p host
    ingress      *IngressForwarder
    federation   *FederationBridge
    placementCache *PlacementCache  // local LRU + TTL
    log          *slog.Logger
}

func New(cfg Config) (*Node, error)
func (n *Node) Start(ctx context.Context) error
func (n *Node) Stop(ctx context.Context) error
```

### `cluster.Membership`

Wraps memberlist; exposes the Sample API.

```go
type Membership struct {
    list       *memberlist.Memberlist
    delegate   *memberDelegate    // implements memberlist.Delegate
    capacity   atomic.Pointer[PeerCapacity]
    peers      sync.Map           // PeerID → *peerState
    bus        *eventBus
    rng        *rand.Rand
}

type peerState struct {
    cap        PeerCapacity
    lastSeen   time.Time
    suspicion  int
}

func (m *Membership) Sample(k int, filter Predicate) []PeerCapacity
func (m *Membership) PublishCapacity(c PeerCapacity)
func (m *Membership) OnEvent(fn func(MembershipEvent))
```

`Sample` is the hot path. Implementation:

```go
func (m *Membership) Sample(k int, filter Predicate) []PeerCapacity {
    snapshot := m.snapshotPeers()  // O(N), short critical section
    eligible := filterInPlace(snapshot, filter)
    if len(eligible) <= k { return eligible }
    // Reservoir sampling — k-of-N in O(N) without allocation.
    out := make([]PeerCapacity, k)
    copy(out, eligible[:k])
    for i := k; i < len(eligible); i++ {
        j := m.rng.Intn(i + 1)
        if j < k { out[j] = eligible[i] }
    }
    return out
}
```

Snapshot is taken under read-lock; sampling itself is lock-free.

### `cluster.PlacementClient`

A leader-aware client to the Raft cluster. Voter or learner.

```go
type PlacementClient interface {
    Place(ctx context.Context, sandboxID, ownerID string, idemKey string) (PlacementEntry, error)
    Move (ctx context.Context, sandboxID, fromID, toID string, expectedVersion int64) (PlacementEntry, error)
    Release(ctx context.Context, sandboxID string, expectedVersion int64) error
    Lookup(sandboxID string) (PlacementEntry, bool)         // local cached
    LookupAuthoritative(ctx context.Context, sandboxID string) (PlacementEntry, error)  // round-trip
    Watch(ctx context.Context, fn func(PlacementEvent)) error
}
```

Local `Lookup` is a non-blocking cache read. `LookupAuthoritative` only used
when correctness demands (e.g., during owner handoff verification) — costs a
Raft `LeaderRead` (single quorum round-trip).

### `cluster.PortPartition`

Per-node port allocator. The Raft state machine assigns each node a
`[start, end)` range; the local allocator never coordinates with anyone for
allocation within its range.

```go
type PortPartition struct {
    nodeID  string
    start   uint16  // assigned by placement Raft on node join
    end     uint16
    bitmap  *roaring.Bitmap   // free ports
    mu      sync.Mutex
}

func (p *PortPartition) Allocate() (uint16, error)        // O(1) amortized
func (p *PortPartition) Release(port uint16)
func (p *PortPartition) Free() int32                       // for capacity vector
```

**Sizing the partition:** with 32K usable host ports per node and 10K nodes,
the global pool is 320M ports — well above any practical sandbox count. Each
node owns a small slice (e.g., 16K ports per node, expanded on demand via a
Raft commit).

**Re-assignment on node death:** the dead node's partition is *not* reclaimed
immediately (sandboxes are tombstoned by sandbox-id, not by host port). New
nodes get unused partitions. After a long-tail GC pass, dead partitions can
be reclaimed.

### `cluster.Transport`

libp2p host and stream multiplexer. Implements protocol handlers.

```go
type Transport struct {
    host      host.Host         // libp2p
    handlers  map[string]StreamHandler
    dialPool  *dialCache        // reuse open streams to peers
    metrics   *transportMetrics
}

type StreamHandler func(ctx context.Context, stream network.Stream) error

func (t *Transport) Register(protoID string, h StreamHandler)
func (t *Transport) Open(ctx context.Context, peer peer.ID, protoID string) (network.Stream, error)
```

Stream pooling matters for the proxy hot path. A naive "open new stream per
HTTP request" is fine until you're at 100K req/sec; then connection setup
amortization is real. Use libp2p's built-in stream multiplexing on a small
pool of QUIC connections per peer pair.

### `cluster.IngressForwarder`

The new entry point in `pkg/api/v1/proxy.go`.

```go
type IngressForwarder struct {
    self        peer.ID
    placement   PlacementClient
    transport   *Transport
    localDial   func(sandboxID string) (net.Conn, error)  // current pkg/caddy logic
    metrics     *ingressMetrics
}

func (f *IngressForwarder) Handle(ctx context.Context, sandboxID string, downstream net.Conn) error {
    entry, ok := f.placement.Lookup(sandboxID)
    if !ok {
        // Cache miss: try authoritative read, but bound the latency.
        ctx2, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
        defer cancel()
        var err error
        entry, err = f.placement.LookupAuthoritative(ctx2, sandboxID)
        if err != nil {
            return errSandboxNotFound
        }
    }
    if entry.OwnerNodeID == f.self.String() {
        upstream, err := f.localDial(sandboxID)
        if err != nil { return err }
        return splice(downstream, upstream)
    }
    return f.forwardToOwner(ctx, sandboxID, entry, downstream)
}

func (f *IngressForwarder) forwardToOwner(ctx context.Context, sandboxID string, entry PlacementEntry, downstream net.Conn) error {
    stream, err := f.transport.Open(ctx, peer.ID(entry.OwnerNodeID), "/sandboxd/proxy/1.0.0")
    if err != nil { return err }
    defer stream.Close()
    if err := writeProxyHeader(stream, sandboxID, downstream.RemoteAddr().String()); err != nil { return err }
    return spliceWithDeadline(downstream, stream, 30*time.Second)
}
```

Splicing uses `io.Copy` in two goroutines with proper half-close handling.
On Linux you can switch to `splice(2)` for zero-copy when both sides are TCP
sockets — measurable win for high-throughput sandboxes.

### `service.CreateSandbox` (modified)

```go
func (s *Service) CreateSandbox(ctx context.Context, req CreateRequest) (*Sandbox, error) {
    // 1. Validate + idempotency check (local SQLite first, cheap).
    if existing := s.findByIdem(req.TenantID, req.IdempotencyKey); existing != nil {
        return existing, nil
    }

    // 2. Decide owner via membership.Sample(2).
    candidates := s.cluster.Membership.Sample(2, runtimeFilter(req.Runtime))
    if len(candidates) == 0 { return nil, errNoEligibleNodes }
    target := pickByFreeCapacity(candidates, req)

    // 3. Reserve placement in Raft.
    entry, err := s.cluster.Placement.Place(ctx, sandboxID, target.NodeID, req.IdempotencyKey)
    if err != nil { return nil, err }

    // 4. If target == self: continue locally (current code path).
    if entry.OwnerNodeID == s.self {
        return s.createLocal(ctx, req, entry)
    }

    // 5. Forward to owner.
    sb, err := s.forwardCreate(ctx, target, req, entry)
    if err != nil {
        // Owner NACK with NoCapacity → release placement, retry on the other candidate.
        if isNoCapacity(err) && len(candidates) > 1 {
            other := otherCandidate(candidates, target)
            _ = s.cluster.Placement.Move(ctx, sandboxID, target.NodeID, other.NodeID, entry.Version)
            return s.forwardCreate(ctx, other, req, entry)
        }
        return nil, err
    }
    return sb, nil
}
```

`createLocal` is the existing single-node `CreateSandbox`. Reuse without
modification.

### `service.Reconcile` (modified)

The current reconcile loop fixes drift between SQLite and the runtime
(orphaned containers, dangling Caddy routes, stale port reservations). It
adds two responsibilities:

- **Owner handoff response:** when a placement event arrives saying "you now
  own sandbox S that used to live on B", pull the row via
  `/sandboxd/replication/1.0.0`, restart the container if `Restartable`.
- **Replica eviction:** TTL'd replica rows are GC'd here.

## State Machines

### Raft FSM (placement + ports)

```go
type FSM struct {
    placement map[string]PlacementEntry  // sandbox_id → entry
    ports     map[string]PortRange       // node_id → range
    idem      map[string]string          // tenant_id|idem_key → sandbox_id
}

type Command struct {
    Op   OpType  // Place | Move | Release | AssignPortRange | ExpirePortRange
    Args json.RawMessage
}
```

Snapshot is a sorted-map dump (gob or proto). Apply is O(1) per command.
Watch is implemented by tagging each commit with `(index, op)` and pushing
to subscribers. Subscribers can pull from a given index for catchup.

**Why not BadgerDB-backed Raft store:** the FSM fits in memory at 10M
sandboxes (~100 bytes each = 1 GB — uncomfortable but possible). At 100M, you
shard the placement Raft into K groups by `hash(sandbox_id) % K`.

### Sandbox Lifecycle (owner-local, unchanged)

The existing state machine `Pending → Created → Running → Stopped → Destroyed`
is unchanged. Distribution adds one terminal state: `Lost` (owner died, not
restartable). See [12-state-machine-and-workflows.md](12-state-machine-and-workflows.md).

### Ownership Transitions

```
                ┌────────────────┐
                │  Unowned       │ (placement Raft has no entry)
                └───────┬────────┘
                        │ Place(S, owner=N)
                        ▼
                ┌────────────────┐
                │  Owned by N    │
                └───────┬────────┘
            ┌───────────┼───────────────┐
            │           │               │
            │ N dies    │ Move(S,N→M)   │ Release(S)
            │           │               │
            ▼           ▼               ▼
   ┌─────────────┐  ┌──────────┐  ┌──────────┐
   │ Reconcile   │  │ Owned by │  │ Tombstoned│
   │ decides:    │  │  M       │  │ (24h GC) │
   │ Lost OR     │  └──────────┘  └──────────┘
   │ re-place    │
   └─────────────┘
```

## Schemas

### Local SQLite (additions)

```sql
ALTER TABLE sandboxes ADD COLUMN owner_node_id TEXT NOT NULL DEFAULT '';
ALTER TABLE sandboxes ADD COLUMN placement_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sandboxes ADD COLUMN replica_of_owner TEXT;            -- nullable
ALTER TABLE sandboxes ADD COLUMN replica_ttl_at INTEGER;           -- Unix seconds, nullable

CREATE INDEX idx_sandboxes_replica_ttl ON sandboxes(replica_ttl_at)
    WHERE replica_of_owner IS NOT NULL;

CREATE TABLE idempotency_local (
    tenant_id      TEXT NOT NULL,
    idem_key       TEXT NOT NULL,
    sandbox_id     TEXT NOT NULL,
    request_hash   BLOB NOT NULL,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, idem_key)
);
```

The host-port unique index stays for correctness within the node's partition.

### Raft FSM Snapshot

```go
type Snapshot struct {
    Index      uint64
    Term       uint64
    Placement  []PlacementEntry  // sorted by sandbox_id
    Ports      []PortRange       // sorted by node_id
    Idem       []IdemEntry       // sorted by (tenant_id, idem_key)
}
```

## Concurrency Model

| Hot path | Lock | Notes |
| --- | --- | --- |
| `placementCache.Lookup` | RWMutex (read) | Cache stored as `sync.Map`-like; reads are wait-free |
| `Membership.Sample` | RLock + lock-free reservoir | Snapshot under RLock, sample after release |
| `IngressForwarder.Handle` | None | Per-request allocations only |
| `service.CreateSandbox` | none global; per-sandbox via `singleflight` | Idempotency-key collisions deduped via `singleflight.Group` |
| `PortPartition.Allocate` | Mutex | Bitmap mutation; ~100ns |

The original SQLite single-writer semantics are preserved per node; the
distributed system never expects cross-node SQLite writes.

## Observability Hooks

Every hot-path entry instruments three signals:

- **Span**: `cluster.ingress.handle`, `cluster.placement.lookup`,
  `cluster.transport.open`, `service.create_sandbox`. Parent-child links across
  cross-node forwards via libp2p stream metadata.
- **Counter**: `forwards_total{from,to,result}`,
  `placement_lookups_total{cache_result}`, `raft_commits_total{op,result}`.
- **Histogram**: `ingress_latency_seconds{path}`,
  `forward_overhead_seconds{cross_region}`, `raft_commit_latency_seconds`.

This is intentionally lighter than the BlackBox 50M spans/day mesh — single-host
cardinality and a sharded ClickHouse pattern is the upgrade path if someone
runs the OSS at scale. See [07-reliability-observability-and-failures.md](07-reliability-observability-and-failures.md).
