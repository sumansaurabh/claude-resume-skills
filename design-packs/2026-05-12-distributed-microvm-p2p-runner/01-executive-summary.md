# 01 — Executive Summary

## The One-Paragraph Answer

Today's runner is a single Go binary (`cmd/sandboxd`) that owns five things on one
host: a SQLite store, sandbox lifecycle service, gVisor runtime via Docker, a
local Caddy ingress, and an in-process admission controller. To distribute it
without a central control plane, decompose it into **three planes** — gossip-based
**membership**, **owner-authoritative sandbox metadata** with replicated reads,
and a **placement + port** layer that is the only place consensus is needed.
Pick one of two consistency stories: Raft-for-placement (Nomad-shaped, easy to
operate, ~1 cluster of 10K nodes per Raft group), or CRDT-over-libp2p
(Sentinel/IPFS-shaped, conflict-tolerant, federates trivially across ecosystems).
Use **owner-sharded ownership** so the hot path (HTTP into a sandbox, exec, file
IO) never touches consensus, and a **libp2p-relayed ingress forwarder** so any
peer is a valid front door. Ship Raft-for-placement first, keep the data plane
shape compatible with later CRDT migration, and design federation in from day
one so two ecosystems can mesh without merging logs.

## The Spine, In Five Bullets

1. **Membership** — SWIM gossip (HashiCorp memberlist or libp2p pubsub). Each
   node advertises a capacity vector. Power-of-two-choices for placement reads.
2. **Sandbox state** — owner-authoritative. The node where the container runs
   owns mutations to that row. Other peers hold replicated reads. Owner failure
   = sandbox lost (acceptable: A1, ephemeral).
3. **Placement + port allocation** — the only consensus surface. Raft holds
   `{sandbox_id → owner_node_id, version}` and the port-pool partition map.
   Nothing else.
4. **Ingress** — every peer is a front door. Caddy stays per-host, but the
   toolbox proxy looks up the owner from the local cached placement map; if
   it's not me, forward over a libp2p stream to the owner.
5. **Federation** — two clusters bridge by joining the same gossip mesh through
   a small set of bridge peers. Each retains its own placement Raft;
   cross-ecosystem placements go via owner forwarding, not log merging.

## Why This Shape

- **The hot path is the volume.** ~1000:1 traffic-to-control ratio (A3) means
  the cost of a Raft round-trip on placement is amortized across millions of
  hot-path requests. You get linearizable placement *and* gossip-speed runtime.
- **Sandbox ephemerality lets you keep Raft tiny.** Putting `Status`,
  `ExposedPorts`, `Mounts` into Raft would explode the log. Pointers only —
  ~100 bytes per commit. 10K commits/sec on a single Raft leader is achievable.
- **Owner-sharded ownership preserves the existing single-node code.** The
  `internal/service` lifecycle, `pkg/docker` runtime, `pkg/caddy` ingress, and
  `pkg/capacity` admission stay almost untouched. New code is purely additive
  in `internal/cluster` and a forwarding shim in `pkg/api/v1/proxy.go`.
- **CRDT/libp2p is the destination, not the start.** Operationally, "who owns
  sandbox X right now" needs to be unambiguous from day one. Once conflicts are
  rare-and-understood (because each node only proposes a placement when it
  receives a create request — N-way races are uncommon), CRDT is a drop-in
  replacement for the same `{sandbox_id → owner_node_id}` map.

## Scale Envelope

| Layer | Comfortable | Strained | Breaks |
| --- | --- | --- | --- |
| Raft (placement only) | 1K nodes | 10K nodes | 50K+ nodes |
| Gossip (SWIM) | 5K nodes | 10K nodes (tuned) | 20K+ nodes (need hierarchical) |
| Owner-sharded data plane | unbounded | unbounded | bounded only by hot-path forwarding latency |
| Ingress lookups | unbounded (local cache) | unbounded | only when placement churn > cache invalidation |

10K bare-metal nodes is achievable on a *single* fabric with the design here,
provided (a) Raft holds only placement pointers, (b) capacity is sampled via
power-of-two-choices not broadcast, (c) every node caches the placement map
and tolerates one-hop forwarding on stale reads, (d) federation is in from
day one so 50K+ becomes "five 10K fabrics meshed via gossip bridges".

## What's New In The Codebase

| Package | Status | Purpose |
| --- | --- | --- |
| `internal/cluster/membership` | new | SWIM gossip, peer capacity vector, dead-node detection |
| `internal/cluster/placement` | new | Raft (or CRDT) for `{sandbox_id → owner_node_id}` |
| `internal/cluster/ports` | new | Per-node port partition allocator |
| `internal/cluster/transport` | new | libp2p host, mTLS-by-PeerID, QUIC streams |
| `internal/cluster/ingress` | new | Owner-aware forwarder; wraps `pkg/caddy` |
| `internal/store` | unchanged | Local sandbox state stays in SQLite |
| `internal/service` | small change | `CreateSandbox` consults placement; everything else owner-local |
| `pkg/api/v1/proxy.go` | small change | "If owner != me, forward over libp2p stream" |
| `pkg/capacity` | small change | Now publishes capacity vector to gossip |
| `pkg/docker`, `pkg/caddy` | unchanged | Stay per-host |

The blast radius of the rewrite is contained in `internal/cluster/*` and a small
shim in two files. The rest of the runner stays single-node-shaped.

## What This Pack Does Not Promise

- A leaderless mesh from day one. The first ship is Raft-for-placement.
- Cross-region placement intelligence. Locality-aware placement is a follow-on.
- Multi-tenant *node* isolation. Trust model is "operator owns the bare metal";
  ecosystem federation is at the protocol layer with mutually-untrusted peers.
- A scheduler. The placement decision is power-of-two-choices, not a constraint
  solver. Real scheduling (GPU shapes, anti-affinity) is a future module.
