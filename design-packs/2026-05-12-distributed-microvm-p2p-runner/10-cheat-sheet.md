# 10 - Cheat Sheet

The 30-second-to-3-minute talking points. Use to anchor the conversation
when you're walking the whiteboard or under interview time pressure.

## The 30-Second Pitch

> Today the runner is one Go binary per host with SQLite, gVisor, and Caddy.
> To distribute it without a central control plane, decompose into three
> planes: SWIM gossip for membership and capacity, owner-authoritative
> sandbox state, and a tiny Raft for placement and port allocation. The
> hot path - HTTP into a sandbox - never touches consensus. Every peer is
> a valid front door via libp2p stream forwarding to the owner. Federation
> is gossip-bridges between fabrics, no log merging. v1 ships Raft for
> placement (Nomad-shaped, operable, debuggable); v2 swaps in CRDT
> placement once conflict patterns are known.

## The Three Planes

| Plane | Substrate | Holds |
| --- | --- | --- |
| Membership | SWIM (memberlist) | peer list, capacity vectors |
| Sandbox state | Owner-local SQLite + lazy-pull replicas | full sandbox row |
| Placement + ports | Raft (5 voters, ~9,995 learners) | `sandbox_id → owner` and `node_id → port_range` |

## The Five "Hardcoded To This Node" Targets

The five things in the current code that assume single-host:

1. SQLite reads assume the row was written here.
2. Caddy on localhost routes to a Docker bridge IP only this host can reach.
3. Admitter has no view of other nodes.
4. Toolbox proxy dials container IP directly.
5. Host-port allocator relies on SQLite single-writer.

The distributed design fixes them in this order:

| # | Fix |
| --- | --- |
| 4 | Toolbox proxy: owner-aware forward over libp2p stream |
| 3 | Admitter publishes capacity to gossip |
| 5 | Per-node port partition from Raft |
| 1 | SQLite stays per-node; placement tells you which node |
| 2 | Caddy stays per-node; libp2p forwarder bridges |

## Talking Points On Scale

- **10K nodes is the design center.** Nomad documents 10K+; Kubernetes ~5K.
  Real-system territory.
- **Power-of-two-choices is the secret sauce.** Sample 2 random peers'
  capacity, pick the better. Provably ~optimal at 10K with O(1) coordination.
- **Raft holds pointers, not state.** ~100 bytes per sandbox. 10K commits/sec
  on a leader. Sandbox state lives on owner.
- **Hot-path requests never touch consensus.** All Raft load is on the rare
  control path.
- **Federation > sharding** above 10K. Two 5K fabrics meshed via gossip
  bridges is operationally simpler than one 10K cluster.

## Talking Points On Tradeoffs

- **"No central control plane"** in v1 is honest: there's a small embedded
  Raft group. Logical center, not physical. The promise is operability
  first, true leaderless second.
- **CRDT placement is v2.** Same data plane, swap the substrate. Conflicts
  are rare (each create proposed at one node) but operator-hostile to
  debug - earn the experience first.
- **gVisor today, Firecracker future.** Runtime is orthogonal to clustering;
  `internal/runtime` is a driver interface.
- **PAT today, OIDC + SPIFFE-style cross-fabric tomorrow.** Auth complexity
  earned per use case.

## Talking Points On Why This Is Principal-Engineer Work

- **Ephemerality unlocks the design.** Putting `Status` in Raft would tank
  it. Recognizing that sandboxes are ephemeral (so owner-loss = sandbox-loss
  is OK) is the load-bearing call.
- **Owner-sharded ownership preserves the existing single-node code.**
  `internal/service`, `pkg/docker`, `pkg/caddy`, `pkg/capacity` stay nearly
  untouched. The new code is contained in `internal/cluster/*` and a small
  shim in `pkg/api/v1/proxy.go`.
- **Federation designed in from day one.** Retrofitting federation onto a
  single Raft group is brutal. Designing the bridge-peer + signed-descriptor
  model up front means "ecosystems talking to each other" is a config
  change, not a rearchitecture.
- **Vertical slice first.** The toolbox proxy forwarder exercises
  membership, placement cache, libp2p streams, and end-to-end correctness in
  one PR - without changing how sandboxes are *created*. Right-sized
  first deliverable.

## Resume Anchors To Cite Out Loud

| Anchor | Where it lands in this design |
| --- | --- |
| WASM sandbox plane @ 1M+ daily executions, SOC-2 (BlackBox) | Runtime layer, isolation model, audit posture |
| GPU scheduling, gang-scheduling, bin-packing, 15M+ jobs/month (Microsoft AML) | Placement constraints, multi-tenant ergonomics |
| TunDRA Rust QUIC @ 1M+ Compute Instances (Microsoft) | Peer-to-peer secure transport / libp2p+QUIC choice |
| Durable DAG workflow engine (BlackBox) | Owner failover semantics, reconcile loop |
| 50M spans/day LLMOps telemetry mesh (BlackBox) | Observability model, deterministic replay light |

## Three Numbers To Memorize

- **5 voters, ≤10K learners** - Raft topology at 10K scale.
- **Power-of-two-choices** - `K=2` random samples for placement; provably ~optimal.
- **~100 bytes per Raft commit** - keeps placement Raft well under leader fsync limits.

## The Question I'd Ask Back If The Interviewer Pushed

> "Are you optimizing for an OSS that operators can ship in week one, or
> a research-grade leaderless mesh? Because the answer to that determines
> whether v1 has the placement Raft or not. I picked v1 = ship; v2 = mesh."

That single sentence anchors the whole conversation around the right axis
(operability vs. theoretical purity) and shows you know where the
tension is.
