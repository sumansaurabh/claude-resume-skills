# 02 - Architecture

## Current Single-Node Architecture (Baseline)

The existing runner is one Go binary `cmd/sandboxd` per host with five layers:

| Layer | File | Responsibility |
| --- | --- | --- |
| Store | `internal/store/store.go` | SQLite WAL, single writer. Tables: `sandboxes`, `exposed_ports`, `sandbox_mounts`. The partial unique index on `host_port` is the host-port allocator's serialization primitive. |
| Service | `internal/service/service.go` | Sandbox lifecycle: `CreateSandbox`, `StartSandbox`, `StopSandbox`, `DestroySandbox`. Reconcile loop. Reservation replay at boot. |
| Runtime | `pkg/docker` behind `internal/runtime.Runtime` | Docker daemon → runc / gVisor. "microVM" today = gVisor. Local Unix socket. |
| Ingress | `pkg/caddy/client.go` | Calls localhost Caddy Admin API. HTTP subdomain mode, raw TCP from `[L4PortRangeStart, end]`, TLS-SNI. |
| Admission | `pkg/capacity/capacity.go` | In-process `map[id]Request` under a mutex. CPU + memory budget per host. Replayed from store at boot. |

API surface (`pkg/api/v1`) is plain REST behind a PAT bearer. The toolbox proxy
resolves `containerIP` from the local SQLite and dials it directly.

### What's hardcoded to "this node"

1. Store is a local file; every read assumes the row was written here.
2. Caddy is on localhost and routes to a Docker bridge IP only this host can
   reach.
3. Admitter has no view of any other node's load.
4. Toolbox proxy dials the container IP directly; no notion of "wrong node, forward."
5. Host-port allocator relies on SQLite's single-writer guarantee for race-free
   `INSERT OR IGNORE`.

These five assumptions are the surgical targets.

## Target Distributed Architecture (Three Planes)

```
                ┌─────────────────────────────────────────────┐
                │             External Clients (REST API)     │
                │             "Any node is a valid front door"│
                └────────┬───────────────┬────────────────────┘
                         │               │
                  ┌──────▼─────┐   ┌─────▼──────┐
                  │  sandboxd  │   │  sandboxd  │   ... 10K nodes
                  │   node A   │◄──┤   node B   │
                  └──────┬─────┘   └─────┬──────┘
                         │               │
       ┌─────────────────┴────┬──────────┴──────────────┐
       │                      │                          │
  ┌────▼─────┐         ┌──────▼──────┐          ┌────────▼────────┐
  │ Membership│         │  Sandbox     │          │ Placement +    │
  │ + Gossip  │         │  Metadata    │          │ Port Allocator │
  │ (SWIM)    │         │  (per-owner  │          │ (small Raft   │
  │           │         │   SQLite +   │          │  group OR      │
  │           │         │   replicated │          │  CRDT G-set)   │
  │           │         │   reads)     │          │                │
  └───────────┘         └──────────────┘          └────────────────┘
       Plane 1                Plane 2                  Plane 3
   (eventually-           (owner-authoritative,    (the only place
    consistent peer       replicas eventually-      consensus is
    list + capacity       consistent)               required)
    vector)
```

### Plane 1 - Membership and Capacity Gossip

**Substrate:** SWIM via HashiCorp `memberlist`, or libp2p PubSub. Memberlist is
battle-tested (Consul, Nomad, Serf); libp2p PubSub is the more "ecosystem mesh"
choice and gives cross-org NAT traversal for free.

**What is gossiped:**

```go
type PeerCapacity struct {
    NodeID       string   // libp2p PeerID or UUID
    Address      string   // multiaddr or host:port
    FreeCPU      float64  // millicores
    FreeMem      int64    // bytes
    FreePortsL4  int32    // count remaining in this node's port partition
    RuntimeTags  []string // ["gvisor", "runc", "firecracker"]
    Region       string   // "us-east-1" or "edge-pune-01"
    Generation   uint64   // monotonic per-node, defeats stale gossip
    UpdatedAt    int64    // Unix nanos for tie-breaking
}
```

**Why a vector, not a fitness score:** the receiver picks based on its placement
strategy; the gossiper doesn't pre-decide. Lets you change scheduling policy
without changing the wire protocol.

**Anti-broadcast:** capacity vectors are *pulled* via power-of-two-choices, not
broadcast. Each placement-deciding node samples K=2 random peers from its
membership view, picks the one with more free capacity, and forwards. This
eliminates O(N²) broadcast and is provably ~optimal load.

**Failure detection:** SWIM suspicion timeout default ~5s, declared dead at
~15s. Tunable per region. On node-dead event, the placement plane is notified to
re-elect ownership of any sandboxes it was hosting (or, with A1, simply mark
them lost).

### Plane 2 - Sandbox Metadata (Owner-Authoritative)

Each sandbox row has exactly one owner: the node where the container actually
runs. **Mutations to that sandbox's row only happen on the owner.** Reads can
be served from any peer that holds a replica.

**Local store:** the existing SQLite stays. `internal/store` is unchanged.
Each node's SQLite holds (a) sandboxes it owns, (b) replicated read-only copies
of sandboxes it has been asked about (with a TTL).

**Replication protocol:** owner publishes mutation events to a libp2p PubSub
topic `/sandboxd/v1/sandbox/{shard_id}` where `shard_id = hash(sandbox_id) %
N_SHARDS`. Subscribers in that shard apply the event idempotently to their
local SQLite. Last-writer-wins on `(owner, version)`. Non-owner writes are
rejected at the source.

**Why per-shard topics:** a single global topic at 10K nodes × ~100 events/s
sustained = 1M msg/s of fan-out. Sharded topics let you scope subscription -
each node subscribes to only the shards it cares about (sandboxes it currently
holds + a small random sample for resilience).

### Plane 3 - Placement and Port Allocation (The Only Consensus)

**This is the only place strict ordering is required.** Two viable substrates:

**Option A - Raft (recommended for v1):**

- 5 voters elected from the fleet (see [11-control-plane-vs-data-plane.md](11-control-plane-vs-data-plane.md)).
- All other nodes are non-voting learners.
- State machine is two maps:
  ```
  placement:  sandbox_id → { owner_node_id, version, created_at }
  ports:      node_id    → { partition_start, partition_end, generation }
  ```
- Commits are tiny (~80-150 bytes). Throughput easily 10K/sec on modest
  leader hardware.

**Option B - CRDT (target for v2):**

- Per-sandbox LWW register over libp2p PubSub: `(sandbox_id, owner_node_id,
  hlc_timestamp)`.
- Conflict resolution: highest HLC wins. Loser node sees a "you don't own this
  anymore" event and tears its container down.
- Port allocation: per-node port partitions assigned via gossip with a CRDT
  G-Set claim - no global allocator at all.

**Why ship Raft first:** debugging "who really owns sandbox X right now" is
~10x easier with a Raft log than with HLC traces. CRDT conflicts in placement
are rare in practice (each node only proposes when it received the create
request - N-way races require simultaneous identical create requests at K
nodes), but when they happen they are subtle and operator-hostile.

## End-To-End Request Flows

### Flow 1 - `POST /v1/sandboxes` (Create Sandbox)

```
Client → Node A (any node)
        │
        ├─ A authenticates PAT, validates request
        │
        ├─ A samples 2 peers from membership: B, C
        │   - Reads cached PeerCapacity for B and C
        │   - Picks B (more free capacity)
        │
        ├─ A sends Raft propose: PLACE(sandbox_id=S, owner=B, version=1)
        │   - Raft leader (one of 5 voters) commits
        │   - Returns commit index
        │
        ├─ A forwards CreateSandbox(S) over libp2p stream → B
        │
B receives CreateSandbox(S):
        │
        ├─ B's local admission controller (pkg/capacity) checks budget
        │   - If insufficient: returns NACK; A picks C and retries
        │
        ├─ B allocates host port from its own partition
        │
        ├─ B writes SQLite row: sandbox S with status=Created, owner=self
        │
        ├─ B publishes mutation event to PubSub /sandboxd/v1/sandbox/{shard}
        │
        ├─ B starts container via pkg/docker (gVisor)
        │
        ├─ B configures local Caddy for ingress
        │
        └─ B returns SandboxInfo to A → Client
```

Latency budget for a typical Create: A→Raft 3-8ms, A→B forward 1-3ms intra-DC,
B local work 50-200ms (container start dominates). The Raft hop is ~5% of the
total, which is the right price.

### Flow 2 - `GET /v1/sandboxes/{id}/proxy/...` (Hot path: HTTP into sandbox)

```
Client → Node A (any node)
        │
        ├─ A looks up sandbox S in local placement cache
        │   - Cache hit: owner = B (TTL 30s)
        │
        ├─ A's toolbox proxy (pkg/api/v1/proxy.go):
        │   if owner == self → dial container IP directly (current behavior)
        │   if owner != self → open libp2p stream to B, splice client conn
        │
        ├─ B receives stream → dials its local container IP → splice
        │
        └─ Bytes flow: Client ↔ A ↔ B ↔ container
```

If A's cache is stale (S has been re-placed to D since), B replies with
`NotOwner(actual=D, version=2)`. A updates its cache and redials D. One extra
hop in the stale case, no Raft round-trip.

### Flow 3 - Owner Failure and Re-Placement

```
Membership plane (SWIM) detects node B dead (suspicion → confirmed: ~15s)
        │
        ├─ Membership emits NodeDead(B) event
        │
        ├─ Placement reconciler (any node, idempotent):
        │   - Lists sandboxes where owner=B
        │   - For each, decides: re-place or mark lost?
        │     - If sandbox is "Stateless ephemeral" (default): mark Lost, emit event
        │     - If sandbox is "Restartable" (snapshot exists in object store): propose new owner
        │
        ├─ Raft commits: PLACE(S, owner=C, version=N+1)
        │
        └─ C receives notification, restarts sandbox if applicable
```

Because Raft serializes the re-placement, there's no risk of two nodes both
picking up the same sandbox.

## Ingress in a P2P World

External traffic for sandbox S must reach node B (the owner). Three real paths:

| Path | Pros | Cons | When |
| --- | --- | --- | --- |
| Anycast / L4 LB front (HAProxy/Envoy) | Simple, fast | Central plane, defeats the libp2p story | Single-DC deployments where you accept the LB |
| Per-node Caddy + libp2p stream forward | True P2P, every peer is a front door | One extra network hop, latency penalty cross-region | Default for the OSS distribution |
| Per-tenant DNS to owner node | No forwarding, near-optimal latency | Requires DNS write on every Create + Move; DNS TTL pain | Optional optimization for stable long-running sandboxes |

The default is path 2: every peer accepts ingress on its Caddy, looks up the
owner from the cached placement map, and tunnels the connection over libp2p
to the owner. The owner unwraps and dials its local Docker bridge IP.

This is the **Sentinel-shaped** design: there is no "right" front door; every
peer is equally valid. The network just routes.

## Federation Across Ecosystems

Two independent fabrics (say, Org X and Org Y) want to mesh - Org X clients
should be able to reach sandboxes running on Org Y nodes, with ownership and
placement semantics intact.

**The wrong way:** merge their Raft groups. This means picking one log to
dissolve and replaying on the other. Operationally a nightmare.

**The right way:** **gossip bridge peers.** Each fabric exposes a small set
(say, 3) of bridge peers that subscribe to the *other* fabric's membership
topic. Capacity vectors and placement events flow across the bridge.
Cross-fabric placements work via owner forwarding - Org X cannot place into
Org Y without Org Y's consent (each fabric's placement Raft remains
authoritative for its own nodes).

**What this enables:**

- Spillover: Org X is at 90% capacity, automatically forwards Create requests
  to Org Y nodes that opted in.
- Public sandboxes: Org Y publishes a sandbox accessible to any peer in the
  mesh; routing happens via the same owner-forwarding shim.
- Untrusted-peer mode: Org X never auto-places onto Org Y's nodes; Org X
  *clients* can still reach Org Y sandboxes that Y has explicitly published.

This is the libp2p-mesh story: trivial federation, zero log merging.

## Mapping To The Existing Codebase

| Existing component | Change |
| --- | --- |
| `cmd/sandboxd` | Adds cluster bootstrap (membership join, libp2p host start) |
| `internal/store/store.go` | Unchanged. Still local SQLite. New columns: `replica_of_owner` (nullable), `replica_ttl`. |
| `internal/service/service.go` | `CreateSandbox`: consults placement plane, may forward. `StartSandbox`/`Stop`/`Destroy`: only on owner. Reconcile loop: also handles re-placement events. |
| `pkg/docker` | Unchanged. |
| `pkg/caddy/client.go` | Unchanged for owner-local sandboxes. Forwarder uses libp2p instead of direct Docker bridge dial when needed. |
| `pkg/capacity/capacity.go` | Now publishes capacity vector to gossip on every change. |
| `pkg/api/v1/proxy.go` | New: owner lookup → if me, dial; if not, forward over libp2p stream. |
| `internal/cluster/*` | New: membership, placement, ports, transport, ingress. |

The **vertical slice to prototype first** is the toolbox proxy forwarder. It
exercises membership, the placement cache, libp2p streams, and end-to-end
hot-path correctness in one PR - without changing how sandboxes get *created*.
That stays single-node until the next slice.
