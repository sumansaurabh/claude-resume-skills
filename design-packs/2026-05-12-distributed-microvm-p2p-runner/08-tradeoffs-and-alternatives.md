# 08 - Tradeoffs and Alternatives

The big architectural choices, what was rejected, and why.

## A. Consistency Substrate

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **Raft for placement only (Nomad-shaped)** | Linearizable; easy to operate; clear "who owns X"; debuggable; well-understood failure modes | Tiny but real central control plane; federates badly across ecosystems | **Chosen for v1** |
| Raft for everything (etcd-as-store) | Simple consistency story | Log explodes when sandbox state lives in Raft; 10K nodes ⇒ 1K nodes effective | Rejected - load doesn't fit |
| Pure CRDT over libp2p (Sentinel-shaped) | Truly leaderless; trivially federates; matches stated north star | Conflict resolution is operator-hostile; "who owns X right now" needs HLC reasoning; debugging is hard; ports need a separate mechanism | **Target for v2** - not yet |
| Single-leader gossip (Serf-style) | Simple; fast | No quorum guarantees; placement conflicts on partition | Rejected - too weak |
| Paxos / EPaxos | Theoretically optimal; multi-leader | No mature Go library; team-knowledge cost | Rejected - Raft wins |
| ZooKeeper / Chubby external dependency | Battle-tested | New operational burden; another HA system to run | Rejected - embed Raft, don't add a service |

**Why Raft for placement only is the right v1:** the placement payload is
~100 bytes, commits are rare, and the read path doesn't touch consensus. You
get linearizable placement at gossip-speed runtime. This is exactly the
Nomad pattern, exactly TiKV's PD, exactly CockroachDB's meta range. Proven.

## B. Membership / Failure Detection

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **HashiCorp memberlist (SWIM)** | Battle-tested; great at 5K, tunable to 10K; Go-native | UDP-only; needs separate mechanism for capacity vector | **Chosen** |
| libp2p PubSub for membership | Single transport; NAT traversal | Less mature for failure detection at scale; gossipsub overhead | Considered for v2 federation |
| Centralized membership (heartbeat to Raft) | Strong consistency on liveness | All N nodes pinging Raft - terrible at 10K | Rejected |
| Hierarchical / regional gossip | Required at 50K | Premature for v1 | Future work above 10K |

## C. Port Allocation

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **Per-node port partition assigned by Raft** | No global allocator; O(1) local allocation; simple to reason about | Some waste (each node holds unused ports); needs re-assignment for elastic node join/leave | **Chosen** |
| One Raft group just for ports | Strongly consistent | Same control-plane concern as before; chatty | Rejected - partition is enough |
| CRDT G-Counter + optimistic claim | Leaderless; matches CRDT goal | Conflict-recover code is tricky on the host-port mutex path | v2 candidate |
| Dynamic port via OS allocation | No coordination at all | Caddy still needs to know the port; round-trip adds Create latency | Rejected - race on Caddy update |

## D. Cross-Node RPC Transport

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **libp2p streams over QUIC + mTLS** | NAT traversal, federation-ready, mTLS-by-PeerID for free, multiplexed | New dependency; learning curve; QUIC libs Go-side maturing | **Chosen** - directly mirrors TunDRA stack |
| gRPC over TCP+TLS | Battle-tested; mature tooling | No native NAT traversal; mTLS PKI to operate; harder federation | Rejected - federation friction |
| Raw TCP + custom framing | Minimal | Reinventing security and multiplexing | Rejected |
| HTTP/2 + JSON-RPC | Simplest | Worst latency; double-framing through proxy | Rejected |

## E. Sandbox Replica Strategy

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **Owner-authoritative + lazy replica pull on read** | Low overhead; reads still distributed | Brief 404 window after a Create before replicas catch up | **Chosen** |
| Eager replication to all peers | Always-fresh reads | O(N) bandwidth; awful at 10K | Rejected |
| Replicate to K=3 random peers per shard | Good read availability; bounded cost | Adds owner-handoff complexity if all 3 die | Considered for "Restartable" sandboxes |
| No replication; always read from owner | Simplest | Read availability tied to owner liveness | Rejected - too weak |

## F. Ingress Strategy

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **Per-node Caddy + libp2p stream forward** | True P2P; every peer is a front door; no central ingress | Extra network hop for non-owner ingress | **Chosen** as default |
| Anycast L4 LB front | Simple; fast | Central plane just at L4; defeats the libp2p framing | Available as deployment option |
| Per-tenant DNS to owner | Optimal latency | DNS write/TTL pain; complicates Move | Optional optimization |
| Service mesh sidecar (Envoy) per node | Featureful | Heavyweight; another binary | Rejected for OSS default |

## G. Sandbox Runtime

The runtime today is gVisor (the prompt explicitly notes Firecracker is not
implemented). Distribution is orthogonal to the runtime choice. Adding
Firecracker, Kata, or runc later is a `internal/runtime` driver, not a
clustering change.

| Runtime | Isolation | Boot time | When |
| --- | --- | --- | --- |
| runc | Weakest | Fastest | Trusted code, dev workloads |
| gVisor (default) | Strong (user-space kernel) | ~1s | Untrusted code, current default |
| Firecracker | Strongest (true microVM) | ~125ms | High-isolation tenants, future |
| Kata Containers | Strong (microVM, Kubernetes-native) | ~500ms | If CRI compatibility ever matters |

## H. Federation Mechanism

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **Bridge peers + signed FabricDescriptor** | Lightweight; per-fabric autonomy preserved; opt-in cross-fabric placement | Bridge peer is a small attack surface; needs careful trust handover for key rotation | **Chosen** |
| Merge Raft groups | Strongest cross-fabric consistency | Operationally awful; one log to dissolve | Rejected - kills the libp2p story |
| Static peer pinning across fabrics (no bridge abstraction) | Simplest | No discovery, no policy gate | Rejected - doesn't scale operationally |
| External directory (DHT) for cross-fabric discovery | Decentralized | Latency tax on every cross-fabric op | Future for "fully open" fabrics |

## I. Placement Algorithm

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **Power-of-two-choices (random K=2 sample, pick better)** | O(1) coordination; provably ~optimal at 10K; matches Mitzenmacher | Not aware of constraints (anti-affinity, GPU shapes) | **Chosen** for v1 |
| Best-fit over global capacity | Optimal placement | Needs all-to-all capacity broadcast; O(N²) | Rejected |
| Round-robin | Trivially balanced under uniform load | Terrible under heterogeneous capacity | Rejected |
| Constraint solver (like Volcano, kube-scheduler) | Handles GPU shapes, anti-affinity, taints | Centralized; at-odds with leaderless framing | Future module for "scheduled" sandboxes; live alongside power-of-two |

The Microsoft AML scheduling experience (gang-scheduling, bin-packing for
GPU workloads) is the reference for the *future* constraint-solver path.
For ephemeral microVM sandboxes, power-of-two is enough.

## J. Storage For Local Sandbox State

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **SQLite (current)** | Simple; embedded; good WAL | Single-writer; no built-in replication | **Kept** - no need to change |
| BadgerDB | Faster writes; also embedded | New dependency; SQLite is fine | Rejected - needless churn |
| Postgres per node | Featureful | Operational burden of running PG on each node | Rejected - wrong for embedded |
| Raft as the local store | Consistency built-in | Owner = node; per-sandbox Raft would be wrong | Rejected (already covered) |

## K. What "No Central Control Plane" Really Means In v1

Honest framing: the v1 design has a **5-voter Raft group** for placement.
That is a small, embedded, HA control plane. It is **not** a libp2p-style
fully-leaderless mesh.

Why ship it anyway:

- **Operability** for the first 1-3 years of the OSS project. "Why does
  sandbox X live on node B" must be answerable from a single command.
- **The upgrade path is real.** The data plane is already shaped right
  (sharded ownership, owner forwards). Replacing the placement substrate
  with CRDT later does not require rewriting `internal/service`,
  `pkg/api/v1`, or any of the runtime layers.
- **Federation gives you the ecosystem story now.** Two Raft-coordinated
  fabrics still mesh trivially via gossip bridges - the libp2p ethos lives
  in cross-fabric ingress and discovery, not in placement.

The v2 path (CRDT placement) is real and intended. It's not vapor - it's
sequenced.

## L. Why Not Just Use Nomad?

Nomad is the closest production-grade equivalent to v1. Honest answer to
"why build this":

- Nomad's job model is heavier than the runner needs; a "sandbox" is more
  like a container alloc than a job.
- Nomad's federation is per-region with central coordination, not the
  libp2p mesh shape the prompt asks for.
- Personal OSS project: building it teaches the full stack and produces
  something with a different shape than the existing tools.
- The runtime layer (WASM/gVisor isolation, Caddy ingress, port partition)
  is the differentiator; the cluster substrate is the supporting cast.

If your goal were to *deploy* a sandbox runner at 10K nodes today, Nomad
+ a custom job driver would be the boring correct answer. If your goal is
to build a leaderless, ecosystem-meshable runner that one day operates
without a central log, the path here is the right one.
