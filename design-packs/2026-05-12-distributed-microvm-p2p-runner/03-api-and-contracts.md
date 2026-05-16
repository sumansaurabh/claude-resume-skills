# 03 - API and Contracts

## External REST API (Unchanged Surface)

The public REST surface stays compatible with the single-node API. Distribution
is invisible to clients except for two new headers and one new error code.

### Authentication

Personal Access Token (PAT) bearer in `Authorization: Bearer <token>`. PATs are
hashed at rest (`pat_hash`) and tied to a tenant + scope. Stays per-fabric for
v1; cross-federation auth is OIDC-bridge in v2.

### Resource Model

```
Sandbox
  id           string         // ULID, sortable
  tenant_id    string
  runtime      enum           // "gvisor" | "runc" | "firecracker" (future)
  image        string         // OCI ref
  cpu_millis   int32
  memory_bytes int64
  exposed_ports []ExposedPort
  mounts       []Mount
  status       enum           // "Pending" | "Created" | "Running" | "Stopped" | "Destroyed" | "Lost"
  owner_node   string         // libp2p PeerID - read-only, returned by API
  fabric_id    string         // for federation
  created_at   timestamp
  updated_at   timestamp
  version      int64          // monotonic, owner-incremented
```

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST`   | `/v1/sandboxes` | Create sandbox (idempotent via `Idempotency-Key` header) |
| `GET`    | `/v1/sandboxes/{id}` | Read sandbox (any node serves) |
| `GET`    | `/v1/sandboxes` | List sandboxes for tenant (any node serves) |
| `POST`   | `/v1/sandboxes/{id}/start` | Start (owner-only operation, transparently forwarded) |
| `POST`   | `/v1/sandboxes/{id}/stop` | Stop (forwarded if needed) |
| `DELETE` | `/v1/sandboxes/{id}` | Destroy (forwarded if needed) |
| `ANY`    | `/v1/sandboxes/{id}/proxy/*` | Toolbox proxy - HTTP into the sandbox (forwarded over libp2p if needed) |
| `GET`    | `/v1/cluster/members` | Membership view (cluster-wide) |
| `GET`    | `/v1/cluster/placement/{id}` | Authoritative placement lookup (consults Raft if cache miss) |

### Idempotency

`POST /v1/sandboxes` and lifecycle transitions accept an `Idempotency-Key`
header (UUID). Semantics:

- The first commit of `(tenant_id, idempotency_key)` to placement Raft wins;
  subsequent attempts return the *same* sandbox row, not a new one.
- Idempotency keys live for 24h in a compact CRDT-OR-Set in placement state
  (small, expires, doesn't bloat the Raft log).
- If the same key is presented with different request bodies, return
  `409 IdempotencyKeyConflict` with the original body in the response.

This matches the AML AutoML idempotency model the author worked on - same
problem, different domain.

### New Headers and Error Codes

**Response headers:**

- `X-Sandbox-Owner: <peer_id>` - informational; lets clients pin to the owner
  on subsequent calls if they want to skip the forward hop.
- `X-Placement-Version: <int64>` - the version the response was computed
  against. Lets clients detect stale reads.

**New error code:**

- `409 OwnerMoved { actual_owner, version }` - returned when a write op (start,
  stop, destroy) arrives at the wrong node *and* the receiver chooses not to
  transparently forward (e.g., proxy-forwarding disabled by op flag). Default
  is to forward; this error is a debugging aid, not a normal client signal.

## Internal P2P Protocols

These are the protocols spoken between `sandboxd` peers.

### Transport

- **libp2p** as the host abstraction (PeerID = Ed25519 public key fingerprint).
- **QUIC** as the underlying transport (mTLS via libp2p-TLS, NAT traversal
  via libp2p-relay-v2 + libp2p-hole-punch).
- This mirrors the secure-transport posture from TunDRA (QUIC + Rust at
  Microsoft, 1M+ Compute Instances) - same idea, off-the-shelf libraries.

### Protocol IDs (libp2p stream multiplexing)

```
/sandboxd/membership/1.0.0    SWIM packets via memberlist (uses its own UDP)
/sandboxd/placement/1.0.0     Raft RPCs (AppendEntries, RequestVote, InstallSnapshot)
/sandboxd/forward/1.0.0       Owner-forward RPC (Create, Start, Stop, Destroy)
/sandboxd/proxy/1.0.0         Toolbox-proxy connection splice (raw byte stream)
/sandboxd/replication/1.0.0   Pull replica of a sandbox row from the owner
```

### `/sandboxd/forward/1.0.0`

Length-prefixed protobuf RPC.

```protobuf
message ForwardRequest {
  string sandbox_id = 1;
  oneof op {
    CreateSandbox create = 2;
    StartSandbox  start  = 3;
    StopSandbox   stop   = 4;
    DestroySandbox destroy = 5;
  }
  string idempotency_key = 6;
  int64  placement_version = 7;  // sender's view; receiver checks
  string requesting_peer  = 8;
}

message ForwardResponse {
  oneof result {
    SandboxInfo ok       = 1;
    NotOwner    moved    = 2;  // includes actual owner + version
    NACK        rejected = 3;  // includes reason: NoCapacity | TenantQuota | InvalidImage
    ErrorInfo   error    = 4;  // unrecoverable
  }
}
```

**Key design points:**

- The receiver verifies `placement_version` against its local view; if stale,
  returns `NotOwner` with the current owner.
- `idempotency_key` lets the receiver de-dupe in case the sender retried.
- All forwards are at-least-once. The receiver's local SQLite dedupes by
  `(tenant_id, idempotency_key)`.

### `/sandboxd/proxy/1.0.0`

Plain byte-stream splice. Header on stream open:

```
PROXY-V1 <sandbox_id> <client_remote_addr> <inbound_port>
```

Then bidirectional bytes. Receiver dials its local container IP+port, splices
both sides. Half-close propagates correctly. Connection budget per stream is
unbounded (let the application protocol decide).

**Why not use HTTP/2 streams over libp2p:** keeps the proxy
protocol-agnostic (works for raw TCP sandbox exposure too) and avoids
double-framing.

### `/sandboxd/replication/1.0.0`

Read-only pull of a sandbox row. Used when (a) a non-owner serves a `GET
/v1/sandboxes/{id}` and the local cache is stale, (b) a node is asked to host
a re-placed sandbox and needs to know what its config was.

```protobuf
message ReplicationRequest  { string sandbox_id = 1; int64 since_version = 2; }
message ReplicationResponse { Sandbox sandbox = 1; int64 version = 2; }
```

For high-volume replication, switch to PubSub-driven CRDT log (see
`13-data-model-and-storage.md`).

## Placement Plane API (Raft State Machine)

The Raft state machine exposes one read API (`Lookup`) and three write APIs
(`Place`, `Move`, `Release`).

```go
// Read - served from any voter or learner with a watch-replicated state copy.
func Lookup(sandboxID string) (PlacementEntry, error)

// Writes - must go through the Raft leader.
func Place(sandboxID string, ownerNodeID string, placementVersion int64) error
func Move (sandboxID string, fromNodeID, toNodeID string, expectedVersion int64) error
func Release(sandboxID string, expectedVersion int64) error  // owner→nil; sandbox tombstoned
```

`PlacementEntry`:

```go
type PlacementEntry struct {
    SandboxID    string
    OwnerNodeID  string
    Version      int64
    PlacedAt     time.Time
    Reason       string  // "create", "owner_dead", "manual_move", "rebalance"
}
```

**Watch:** every node maintains a long-poll/streaming watch on the placement
state machine. New entries are pushed in batches. The local in-memory cache
applies them.

## Membership Plane API

```go
type MembershipPlane interface {
    Self() PeerCapacity
    Members() []PeerCapacity
    Sample(k int) []PeerCapacity                  // power-of-two-choices
    OnMemberJoin(func(PeerCapacity))
    OnMemberLeave(func(nodeID string, reason string))
    OnCapacityChange(func(PeerCapacity))           // throttled
    PublishCapacity(c PeerCapacity)               // called by pkg/capacity
}
```

The `Sample` method is the placement plane's primary input. Default `k=2`,
configurable. Returns peers that match runtime tags + region preference.

## Capacity Plane API

```go
// pkg/capacity becomes cluster-aware via this interface
type CapacityReporter interface {
    Reserve(sandboxID string, cpu int32, mem int64) (ok bool, err error)
    Release(sandboxID string)
    Snapshot() PeerCapacity  // serialized to gossip
}
```

The local logic (in-process map[id]Request under a mutex, replayed from store
at boot) is preserved exactly. The only addition is `Snapshot()` for the
gossip publisher.

## Ingress Plane API

```go
type IngressForwarder interface {
    // Called by the Caddy handler for any inbound sandbox-bound request.
    ForwardOrServe(ctx context.Context, sandboxID string, downstream net.Conn) error
}
```

Implementation:

```
1. Lookup placement for sandboxID in local cache.
2. If owner == self: dial container IP via existing pkg/caddy logic. Done.
3. Else: open libp2p stream to owner with /sandboxd/proxy/1.0.0.
4. Splice bidirectionally with backpressure.
5. On owner reply NotOwner: refresh cache, retry once. On second NotOwner: 502.
```

## Federation Bridge API

```go
type FederationBridge interface {
    // Subscribe to another fabric's membership topic; capacity flows in.
    Subscribe(remoteFabric FabricDescriptor) error

    // Publish a sandbox to the other fabric's address space.
    Publish(sandboxID string, audience FabricDescriptor) error

    // Filter incoming Place proposals from remote fabrics.
    SetAdmissionPolicy(policy func(remote FabricDescriptor, req CreateSandbox) bool)
}
```

`FabricDescriptor` is `{ fabric_id, root_peer_ids[], trust_anchor_pubkey }`.
Cross-fabric trust is rooted in the bridge peer's pubkey signing the
descriptor; revocation is per-fabric.

## Error Model

| HTTP | Meaning | Distributed-system cause |
| --- | --- | --- |
| 200/201 | OK | - |
| 202 | Accepted | Create accepted; placement decided; container starting (owner-async) |
| 400 | Bad request | Validation; not distributed-related |
| 401/403 | Auth | PAT invalid; tenant mismatch |
| 404 | Not found | Placement says no such sandbox; or all replicas missed and Raft confirms absence |
| 409 | Conflict | Idempotency key mismatch; or `OwnerMoved` |
| 423 | Locked | Sandbox is in `Stopping`/`Destroying`; transient, retry with backoff |
| 429 | Rate limit | Tenant quota; per-node admission rejection |
| 502 | Bad gateway | Owner unreachable after retries (owner death between cache refresh and stream open) |
| 503 | Service unavailable | Placement Raft has no leader (election in progress) |
| 504 | Gateway timeout | Owner accepted forward but didn't finish in budget |

The 502/503/504 distinction matters operationally: 502 = owner death (page);
503 = Raft election (transient, alert); 504 = slow owner (capacity issue).

## Likely LLD Follow-Ups

These are the places interviewers typically push, with pointers:

- **State machine for sandbox lifecycle in a distributed setting** →
  [12-state-machine-and-workflows.md](12-state-machine-and-workflows.md)
- **Schema diffs (SQLite + Raft + CRDT log)** →
  [13-data-model-and-storage.md](13-data-model-and-storage.md)
- **Why not gRPC instead of libp2p streams** → see
  [08-tradeoffs-and-alternatives.md](08-tradeoffs-and-alternatives.md)
- **PAT vs SPIFFE vs OIDC for cross-federation auth** → see
  [06-security-and-isolation.md](06-security-and-isolation.md)
