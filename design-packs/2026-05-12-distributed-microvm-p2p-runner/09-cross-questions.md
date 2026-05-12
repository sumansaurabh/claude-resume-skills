# 09 — Cross Questions

The skeptical interviewer set. Each question is the one a senior reviewer
would actually ask, with the strongest available rebuttal.

## On The Architecture

**Q1. You call this "no central control plane" but you have a 5-node Raft
group for placement. That's a control plane.**

Yes. The honest answer: v1 has an embedded, HA control plane that holds
~100 bytes per sandbox. It's not central in the "single point of failure"
sense and it's not central in the "external service" sense — voters are
elected from the fleet — but it is logically central. The libp2p framing is
satisfied at three levels: cross-fabric federation does not merge logs; the
data plane is fully sharded; and the v2 design replaces the placement Raft
with CRDT once conflict patterns are well-understood. Shipping CRDT first
without operational experience would mean spending year one debugging HLC
edge cases instead of building the runtime.

**Q2. Why not just use etcd?**

Two reasons. First, etcd's data model encourages putting everything in there
— at 10K sandboxes' worth of `Status`, `ExposedPorts`, `Mounts`, the etcd
data set goes from 1 MB to 10 GB and write throughput collapses. The
discipline of "Raft holds only the pointer" is easier to enforce in a
purpose-built FSM than in a generic KV. Second, etcd is a separate process
to operate. Embedded `hashicorp/raft` keeps the runner a single binary, which
matters for OSS adoption.

**Q3. Power-of-two-choices is fine for uniform workloads. What about GPU
sandboxes with anti-affinity constraints?**

Power-of-two breaks down once placement has hard constraints. The answer is
two paths in the placement plane: a fast path (current) for unconstrained
sandboxes and a constraint path for GPU/affinity workloads. The constraint
path consults a small registry of "available shapes per node" gossiped
hourly, runs a local SAT solver on K=10 candidates, and falls back to
queuing if no candidate fits. This mirrors the AML scheduler experience
(Volcano + custom plugins for GPU shape) — gang-scheduling is a known cost
that doesn't go away just because the rest of the system is gossip-based.

**Q4. You assume sandbox ephemerality. What if a tenant runs a sandbox for
30 days and the owner dies on day 28?**

For long-lived sandboxes, mark them `Restartable` at create-time. The owner
periodically snapshots state to a tenant-configured object store (S3-compat).
On owner death, placement re-elects, the new owner pulls the snapshot,
restarts. RPO is the snapshot interval (5-60s, tenant-configurable). RTO is
~30s (failover detection + container restart + state pull). This is paid
storage cost, opt-in, and explicitly orthogonal to the ephemeral default.

**Q5. The toolbox proxy now adds a libp2p-stream hop on every cross-node
request. What's the latency hit?**

Intra-DC, 1-3ms. Cross-region, 30-80ms. For latency-sensitive sandboxes,
two mitigations: (a) locality-aware placement (sample only same-region peers
first), (b) per-tenant DNS-pinning to the owner so the SDK reaches the owner
directly. The default (forward-on-mismatch) is correct; the optimizations
are tunable per workload. For batch/CI workloads (the bulk of microVM
sandbox use), the hop is invisible.

## On Consistency

**Q6. With CRDT placement (v2), how do you handle two nodes simultaneously
deciding to place the same sandbox-id?**

Sandbox IDs are ULIDs assigned by the receiving node, so two simultaneous
creates of the *same* sandbox-id from two API entry points is impossible
unless an idempotency key is replayed at two nodes within a few hundred ms.
In that case, the CRDT LWW register resolves on HLC: the loser node receives
"you don't own this; here's the actual owner" and tears its container down.
Side effects (port allocation, Caddy route) are reversible because the
placement event is observed *before* the container starts in the
optimistic-concurrency variant. The cost is one wasted container start in a
race; for sandbox creates running at 200/sec, this is acceptable.

**Q7. What happens to placement during a Raft network partition?**

Minority side cannot commit. Sandboxes already running keep running (data
plane is owner-local). Hot-path forwarding from minority-side nodes still
works for sandboxes whose owners are on the same minority side. Minority-side
clients trying to *create* new sandboxes get 503 until the partition heals
or until the minority side is reconfigured. Stale placement reads on the
minority side remain served from cache; the cache TTL bounds correctness
(default 30s); on heal, the watch resumes from the last index.

**Q8. Idempotency keys live for 24h in the placement Raft. Won't that bloat
the log?**

Idempotency keys are stored in a separate compact CRDT-OR-Set tied to a
TTL'd entry, not in the main placement map. Each entry is ~64 bytes
(key + sandbox-id + expiry). At 200 creates/sec sustained, that's 17M
entries × 64B = 1 GB at peak. Snapshot+compaction every hour drops the
in-memory live set to current-window-only (~700 MB). Acceptable. If it isn't,
shard the idem map.

## On Federation

**Q9. If two ecosystems mesh, what stops an attacker on one fabric from
draining capacity on the other?**

Bridge-peer level rate limiting per `(remote_fabric_id, tenant_id)`. Default
admission policy is opt-in: cross-fabric placements are *zero* unless
explicitly allowed. Even when allowed, the receiving fabric's admission can
throttle, charge to a federation budget, or mark the remote fabric
suspicious. Misbehaving bridges are detected by anomaly scoring (sudden
capacity-vector drift, mismatched signatures) and de-trusted by the
admission policy. This is policy enforcement, not protocol enforcement —
exactly like cross-org Kubernetes federation.

**Q10. What happens when a fabric's trust anchor is compromised?**

Each `FabricDescriptor` is signed by a long-lived trust anchor. Rotation
uses a key-handover with overlap window: the new anchor publishes a
descriptor signed by the old, and the new anchor re-signs the descriptor
with itself. After the overlap window, the old anchor is revoked. If
compromised: emit a revocation event signed by an offline emergency key,
which all federated fabrics honor by dropping inbound trust until a new
anchor is established. The emergency key is the operator's responsibility,
not the protocol's.

## On Operations

**Q11. How do you rolling-upgrade 10K nodes without downtime?**

The runner is a single binary. Upgrade strategy: (a) Raft voters last;
(b) drain a node by marking its capacity as 0 in gossip (no new placements)
and waiting for owned sandboxes to drain or be moved; (c) restart binary;
(d) rejoin gossip + Raft. Wire protocols version-pinned: `/sandboxd/forward/1.0.0`
and `/sandboxd/forward/1.1.0` co-exist; the receiver picks the highest both
sides support. No global flag day. Raft FSM compatibility: v1 → v2 must be
backward-compatible for at least one major version.

**Q12. What's your backup story for placement Raft?**

Snapshots every 10 minutes, retained 7 days, shipped to operator-configured
object store. Restore is "spin up new voters from snapshot, replay log
suffix, elect leader." Sandbox state is owner-local, so a placement Raft
restore restores ownership; sandboxes themselves are either still running on
their owners or have been Lost (and acceptable to recreate).

**Q13. How does an operator add or remove a node?**

Add: start `sandboxd` with bootstrap config pointing to a known peer; node
joins gossip, requests learner status from Raft, gets a port partition. ~10s.
Remove (graceful): drain via capacity=0, wait for owned sandboxes to drain
or move, leave gossip with `LEAVE` packet, deregister from Raft. ~5 minutes
for a busy node. Remove (hard): SWIM detects death, placement re-elects.
~30s.

**Q14. How do you debug "this sandbox is unreachable from the API" at 3 AM?**

Three checks in order:
1. `GET /v1/cluster/placement/{id}` — what does authoritative placement say?
2. `GET /v1/cluster/members?node={owner}` — is the owner alive in gossip?
3. SSH to the owner; check local sandboxd status, container status, Caddy
   admin API.

Each step has a runbook. The audit log answers "who placed this sandbox
where, and why" with the candidates considered. The forward-overhead trace
answers "where in the cross-node path did latency spike."

## On Scale

**Q15. You said 10K nodes. What's the actual gating bottleneck?**

In order: gossip cluster cohesion (~10K is the well-tuned ceiling for
flat memberlist), then placement watch fan-out (mitigated by filtered
watches and pull-based reconciliation for idle nodes). Past 10K, federate
into 5K-node fabrics rather than scaling up.

**Q16. How does the design behave under sustained 10K creates/sec?**

It doesn't. Sustained 10K creates/sec on placement Raft would saturate the
leader. Mitigations: batched placements (one Raft commit places 100
sandboxes), or sharded placement Raft (4-16 groups by sandbox-id hash).
Bursts of 10K-20K/sec for 10s are absorbed by batching; sustained needs
sharding. The design point in this pack is 200/sec sustained, 5K/sec burst —
above that, you're past v1.

**Q17. Cross-node forwarding adds latency. What if 80% of requests are
cross-node?**

Symptom of bad placement (locality wasn't a placement signal). Fix: enable
locality-aware placement so requests-from-node-A end up creating
sandboxes-on-node-A whenever capacity allows. With locality on, the cross-node
ratio drops to <10% in typical workloads. The remaining cross-node forwards
are by definition cases where the owner had capacity and the local node didn't
— moving the request is right.

## On Security

**Q18. A compromised node A forwards a Create request to B with a forged
tenant-id. What stops it?**

B re-validates the PAT hash + tenant binding on receipt. Forwards carry the
PAT *hash* and a signed bundle, not a delegation token. If A doesn't actually
have a valid PAT for that tenant, B rejects. The forward isn't trusted; it's
a request. This is the same posture as a sidecar receiving an authorized
HTTP request from a peer — re-check, don't trust.

**Q19. What stops a compromised sandbox from joining the libp2p mesh and
seeing peer traffic?**

Sandbox network namespaces don't grant access to the host's libp2p UDP
ports. The libp2p host runs in the `sandboxd` process namespace, not the
container namespace; there's no shared socket. Cross-tenant sandbox-to-
sandbox traffic is impossible by namespace separation; sandbox-to-host
traffic is blocked by the host firewall (deny-by-default; only the
sandbox's mapped ingress port is reachable, and only via Caddy).

**Q20. SOC-2 has a "logging completeness" requirement. How do you prove no
event was dropped?**

Audit log is append-only, sequenced per node by a monotonic counter, and
shipped to an immutable store (S3 Object Lock) within a defined SLA. Receiver
verifies the per-node sequence has no gaps. A gap triggers an alarm and a
forensic pull of the missing range from the source node's local audit log
(retained 7 days). End-to-end: the local audit log + the immutable
shipped store + sequence verification proves no event lost.

## Fast Rebuttals (the "interview-grenade" set)

**"This is just Nomad."** Yes, for v1. The v2 differentiator is leaderless
placement and trivial federation. Nomad doesn't federate as a libp2p mesh.

**"You'll never get to v2."** The v1 data plane is shaped so v2 is a
substrate swap, not a rewrite. If v2 never ships, v1 is still a clean
sandbox runner shaped like Nomad.

**"libp2p is overkill."** It buys mTLS-by-PeerID, NAT traversal, federation
discovery, and stream multiplexing. Reimplementing those costs more.

**"Raft is overkill — just use a coordinator service."** A coordinator
service is operationally heavier than embedded Raft and doesn't survive
the coordinator going down without HA, which means you've reinvented Raft
with worse semantics.

**"Why not Kubernetes?"** Kubernetes optimizes for long-lived stateful
workloads with strong scheduling constraints. The sandbox runner optimizes
for short-lived, fast-create, isolation-first workloads. Different design
center.

**"You'll find this is a research project."** It synthesizes Nomad,
TiKV PD, Sentinel, and IPFS. Each piece is production-validated; the
combination is novel only in target domain.
