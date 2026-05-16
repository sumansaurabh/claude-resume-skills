# 11 - Control Plane vs Data Plane

The single most important architectural axis in this design. What lives
where, and why.

## The Split

```
┌─────────────────────────────────────────────────────────────┐
│                       CONTROL PLANE                          │
│                                                              │
│  Placement Raft (5 voters, learners on every other node)     │
│   - sandbox_id → owner_node_id, placement_version            │
│   - node_id → port_partition                                 │
│   - tenant_id × idem_key → sandbox_id (TTL'd)                │
│                                                              │
│  Membership / Gossip (every node)                            │
│   - peer list                                                │
│   - capacity vector (cpu, mem, free ports, runtime tags)     │
│   - liveness                                                 │
│                                                              │
│  Audit log shipper                                           │
│   - control-path events to immutable store                   │
└──────────────────────────────────────────────────────────────┘

                              ▲ ▼
                       (rare control ops:
                        Create, Move, Destroy,
                        owner failover)

┌──────────────────────────────────────────────────────────────┐
│                        DATA PLANE                             │
│                                                              │
│  Per-node SQLite (sandbox state - owner-authoritative)        │
│  Per-node Caddy (ingress)                                     │
│  Per-node Docker / runtime (gVisor)                           │
│  Per-node admission controller (capacity)                     │
│  libp2p stream forwarder (cross-node hot path)                │
│                                                              │
│  Hot path: every HTTP/exec/byte into a sandbox                │
└──────────────────────────────────────────────────────────────┘
```

## Why This Split Matters

The classic distributed-systems advice: **make the control plane consistent
and the data plane fast.**

In this design:

- **Control plane** is replicated, linearizable, and rare-touch. ~100 bytes
  per Raft commit, ~700 commits/sec at design load. Total cost negligible.
- **Data plane** is owner-local, lock-free, and hot. Every byte through a
  sandbox is owner-local; cross-node forward is one libp2p stream hop.

The runtime cost ratio (control:data) is typically 1:1000. Spending 5ms on
Raft for a sandbox Create is fine; the same sandbox might serve 10K
requests over its lifetime, none of which touch Raft.

## What's In The Control Plane (Strictly)

Control plane = state where strict ordering matters.

| Item | Why control plane |
| --- | --- |
| `sandbox_id → owner_node_id` | Two nodes must not both think they own X |
| `node_id → port_partition` | Two nodes must not be assigned overlapping port ranges |
| `idempotency_key → sandbox_id` (TTL'd) | Two simultaneous creates with same key must collapse |
| Audit events | Must not be lost or reordered |
| Membership liveness | Eventually consistent is enough - gossip, not Raft |
| Capacity vectors | Eventually consistent - power-of-two-choices is robust to staleness |

The last two are control-plane *information* but live in gossip, not Raft.
They tolerate inconsistency because the placement decision either succeeds
(forwarded to a node with capacity) or fails fast (NACK + retry on another
candidate).

## What's In The Data Plane

Data plane = state where local ordering is enough; cross-node coordination
would be wasted.

| Item | Why data plane |
| --- | --- |
| Sandbox runtime config (image, cmd, env, mounts) | Owner decides; only the owner's runtime needs it |
| Sandbox runtime status (Pending / Running / Stopped) | Owner is the source of truth; replicas are reads-only-and-stale-OK |
| Container processes | Strictly local |
| Local Caddy routes | Strictly local; ingress to owner-local sandboxes |
| Local port allocations within partition | Owner-only; partition guarantee already from control plane |
| Stdout/stderr buffers | Owner-local; streamed to clients via the proxy |
| Reconcile loop | Owner-local correctness fix-up |

## Boundary: When A Data-Plane Operation Touches The Control Plane

Three places only:

1. **Create sandbox** - control plane decides owner; data plane runs the container.
2. **Owner death (re-place)** - gossip detects, control plane re-elects, data plane on new owner reconciles.
3. **Manual move (rebalance)** - control plane authorizes; data planes on source and destination coordinate handoff.

Everything else is data plane.

## Why This Maps To Existing Code Cleanly

The current code already separates concerns this way, just without the
distributed substrate:

- `internal/store` - local data plane (SQLite).
- `internal/service` - local data plane (lifecycle on local containers).
- `pkg/docker`, `pkg/caddy`, `pkg/capacity` - local data plane.
- The implicit "this node is the placement authority" assumption is the
  control plane today.

The distributed design introduces an *explicit* control plane
(`internal/cluster/placement`) and the data plane stays put. The data plane
gains one new capability (cross-node forwarding via
`internal/cluster/ingress`) that consults the control plane (placement
lookup) to know where to send traffic.

## The Pattern Everywhere Else In Distributed Systems

| System | Control plane | Data plane |
| --- | --- | --- |
| Nomad | Server cluster (Raft) decides allocations | Clients run them autonomously |
| Kubernetes | API server + etcd + scheduler | Kubelets run pods locally |
| TiKV | PD (Placement Driver, Raft) decides region placement | TiKV nodes own region data |
| CockroachDB | Meta range (Raft) holds range-to-node map | Range Raft groups own data |
| HDFS | NameNode metadata | DataNode blocks |
| Cassandra | Gossip + token ring | Per-node SSTables |

This design is in well-trodden territory. The differentiator is the libp2p
mesh framing and federation model on top of the same well-understood spine.

## When You Get The Split Wrong

- **Putting sandbox `Status` in Raft:** log explodes; 10K-node ceiling
  becomes 1K. Classic control-plane bloat.
- **Putting placement in gossip:** conflicts on simultaneous create requests;
  operators can't answer "who owns X."
- **Doing forwarding without consulting control plane:** stale forwards
  → 502s.
- **Replicating capacity to all peers (broadcast):** O(N²) network; collapses
  at 10K. Power-of-two pull avoids this.
- **Separate process for control plane:** another HA system to operate;
  defeats the single-binary OSS posture.

The design here gets each of these right, deliberately.

## Anchors From Resume

- **Multi-tenant ML infra across Kubernetes and Azure with GPU scheduling**
  (resume.txt, Microsoft section): direct exposure to the K8s control/data
  split at scale.
- **TunDRA QUIC at 1M+ Compute Instances** (resume.txt): the runtime data
  plane was independent of the control surface; same pattern.
