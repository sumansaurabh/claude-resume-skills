# 05 - Scaling and Capacity

## Target Scale Envelope

| Dimension | v1 (Raft-for-placement) | v2 (CRDT, federated) |
| --- | --- | --- |
| Bare-metal nodes per fabric | 10K | 50K (sharded Raft) or 100K (CRDT) |
| Sandboxes per fabric | 1M live, 100M lifetime | 10M live, 1B lifetime |
| Sustained sandbox creates/sec | 200 | 2K (sharded placement) |
| Burst sandbox creates/sec | 5K (10s burst, batched commits) | 50K (per-shard) |
| Hot-path requests/sec (sandbox HTTP) | unbounded - owner-local | unbounded |
| Cross-fabric federation | 5 fabrics meshed | 50 fabrics meshed |

10K nodes is the design center. Nomad documents 10K+, Kubernetes ~5K
officially. This is real-system territory.

## Where The Strain Lands

| Layer | Limit at 10K nodes | Required mitigation |
| --- | --- | --- |
| Raft (placement only) | ~10K-50K commits/sec on leader's disk fsync | Fine, IF Raft only holds `{sandbox_id → owner_node_id}`. Each commit ~100B. |
| Raft membership | Quorum latency = O(voters), can't grow voters past ~7 | 5 voters, 9,995 non-voters/learners. Standard pattern. |
| Watch fan-out | Leader pushing placement-map updates to 10K followers | Streaming watches with batching (etcd v3 model); learners pull from snapshot+log on catchup. |
| Gossip (SWIM) | Tested clean to ~5K; 10K needs tuning | Bigger fanout, longer suspicion timeouts, push/pull anti-entropy interval up. Above 10K, hierarchical gossip or regional pools. |
| Capacity advertisement | All-to-all broadcast = O(N²) traffic | Don't broadcast. Power-of-two-choices: sample 2-5 random peers per placement decision. Scales infinitely. |
| Ingress lookup | 10K nodes × millions lookups/sec | Local cache on every node, watch-invalidated. One-hop forward on stale. |
| Failure churn | Few node deaths/hour ⇒ hundreds of re-placements/hour | Trivial Raft load. Real cost is ingress-route updates - handled by cache invalidation. |

## Capacity Math

### Raft load

Per sandbox lifecycle (Create + Destroy + 1 incidental Move): 3 Raft commits.

At 200 creates/sec sustained: 600 commits/sec. Add 100/sec from churn-driven
re-placement → ~700/sec. A single Raft leader on commodity NVMe sustains
10K-50K commits/sec for ~100B entries. Headroom: ~14x at 200 creates/sec, ~7x
at 1K creates/sec.

**Burst scenario:** CI provider spins up 5K sandboxes in 10s = 500 creates/sec
for 10s. Mitigation: **batch placements** - `PlaceBatch([]CreateRequest)` is
one Raft commit that places N sandboxes at once. With batches of 50, 5K
creates = 100 commits at peak. Easily absorbed.

### Watch fan-out

10K learners, each subscribed to placement events. Steady-state: 700
events/sec × 10K subscribers = 7M push events/sec.

That's prohibitive without help. Two techniques:

1. **Filtered watches** - each node only cares about sandboxes it owns + a
   sample. Subscriber-side filter at the leader cuts 7M to maybe 500K push
   events/sec across the fleet.
2. **Pull-based reconciliation for idle nodes** - nodes that haven't sent a
   request in 30s switch from streaming to periodic pull. The placement cache
   tolerates 10s of staleness because the forwarding shim handles
   `OwnerMoved` gracefully.

### Gossip overhead

memberlist defaults: gossip interval 200ms, fanout 3. Per-node outbound:
3 × 5 KB = 15 KB / 200ms = 75 KB/s. At 10K nodes, total cross-cluster
overhead ~750 MB/s. That's noticeable but not crippling on a 10G fabric.

Tuning at 10K:

| Parameter | Default | Tuned for 10K |
| --- | --- | --- |
| GossipInterval | 200ms | 500ms |
| GossipNodes (fanout) | 3 | 5 |
| ProbeInterval | 1s | 2s |
| SuspicionMult | 4 | 6 |
| PushPullInterval | 30s | 60s |

Above 10K, the failure detector starts producing false positives. Hierarchical
gossip (regional pools that gossip a summary to peer pools) is the answer;
this is ~3 weeks of work, not architectural surgery.

### Power-of-two-choices effectiveness

Theoretical result (Mitzenmacher 1996): with N nodes and N items being
placed, K-choice load balancing achieves max-load `log log N / log K + O(1)`.
For N=10K, K=2: max load is ~3-4 items above mean. K=3: ~2 items above mean.
For our workload (sandboxes have variable sizes), use K=2 with the picker
weighted by free-capacity ratio rather than count.

This means: **no global view of capacity is needed for placement to be
near-optimal at 10K nodes.** This is the single biggest scaling lever.

## Bottleneck Analysis

### Bottleneck #1: Raft leader disk

At >10K commits/sec sustained, leader disk fsync dominates. Mitigations in
order of effort:

1. **Group commit** - already standard in `hashicorp/raft`. Multiple log
   entries per fsync.
2. **Batch sandbox creates at the API layer** - accept `POST /v1/sandboxes:batch`,
   commit one Raft entry per batch.
3. **Shard the placement Raft** - one group per `hash(sandbox_id) % K`
   ranges. K=4 buys 4x; K=16 buys ~16x. Adds operational complexity.

### Bottleneck #2: Cross-fabric forwarding latency

If fabric F1 (us-east) clients constantly hit sandboxes on F2 (eu-west), the
extra hop is +80ms. At 10K hot-path req/sec, that's a measurable user-visible
hit.

Mitigations:

1. **Locality-aware placement** - extend membership filter to prefer same-region
   peers. Sample K from same region first; fall back to global if no capacity.
2. **Sticky DNS for long-lived sandboxes** - emit a CNAME `sandbox-{id}.{fabric}`
   directly to the owner node's address; falls back to forwarding if the DNS
   record is stale.
3. **Co-locate API ingress with sandbox owner** - for SDK clients, the SDK
   learns the owner from the first response and pins to it.

### Bottleneck #3: Membership churn under chaos

10K nodes ⇒ ~5-10 deaths/hour at typical bare-metal MTBF. Each death requires:
re-place ~5-50 sandboxes the dead node owned, invalidate ingress caches across
the fleet.

Re-placement: Raft can sustain it (5 nodes × 50 sandboxes × 3 commits = 750
commits/hour worst case - irrelevant).

Cache invalidation: streaming watch handles it; the issue is the "thundering
herd" of clients hitting the dead node's sandboxes simultaneously discovering
the move. Mitigation: serve `OwnerMoved` from the *gossip* layer too - when a
node is declared dead, peers proactively NACK forwards to it with the
last-known placement.

## Failure Modes At Scale

| Failure | Symptom | Detection | Recovery |
| --- | --- | --- | --- |
| Single node death | Sandboxes on node lost; ingress 502 for ~15s | SWIM | Re-place restartable; mark Lost others |
| Raft leader death | Placement writes 503 for ~3s | Raft heartbeat | Election; learners cache reads stay served |
| Network partition (one node isolated) | Isolated node's sandboxes unreachable to outside; outside views isolated as dead | SWIM both sides | Isolated node enters read-only-for-self mode; sandboxes still serve local-only |
| Network partition (5050 split brain) | Half the fleet in each side; no Raft quorum on the smaller side | Raft quorum check | Smaller side becomes read-only; placement frozen until partition heals |
| Raft log corruption | Replicated to all voters; FSM divergence | Snapshot mismatch | Restore from peer snapshot; in worst case, rebuild from gossiped sandbox state with manual intervention |
| Mass-restart (whole DC reboot) | All sandboxes lost (ephemerality assumption) | All nodes down → all up | Raft holds placement; nodes rejoin and rebuild empty; clients re-create sandboxes |

## When You Stop Trying To Scale One Cluster

Past 10K well-behaved nodes, or 50K-ish with sharded Raft, the operational
overhead of one cluster outweighs federation. Federate.

Federation properties:

- **Each fabric owns its own placement Raft.** No log merging.
- **Bridge peers** subscribe to both fabrics' membership topics. Capacity and
  placement events flow.
- **Cross-fabric placement** is opt-in: each fabric's admission policy
  decides whether to accept incoming Place proposals from a remote fabric.
- **Cross-fabric ingress** routes via the bridge: F1-client → F1-bridge-peer
  → F2-owner. Latency penalty = 1 extra hop, not pathological.

This is the **same mechanism** that "ecosystems talking to each other" needs.
Federation isn't a separate feature - it's the same gossip+forward design,
deployed across trust boundaries.

## Cost Model

For an operator running a 10K-node fabric:

| Cost driver | Per node | Fleet (10K) |
| --- | --- | --- |
| Gossip bandwidth | 75 KB/s | ~6 Gbps cluster-wide |
| Raft replication (5 voters) | n/a (mostly) | ~5 KB/s per voter incoming |
| Watch fan-out | 50 KB/s | 500 MB/s aggregate |
| libp2p streams (proxy hot path) | workload-driven | workload-driven |
| Storage | 1-10 GB SQLite | n/a (local) |
| Memory (cluster overhead) | ~500 MB | n/a |

The dominant cost is the actual workload (sandbox CPU/memory), which is
unaffected by clustering. The cluster overhead is single-digit-percent on
modern hardware.

## Anchor: Why The Author Believes These Numbers

- The BlackBox WASM sandbox plane sustained 1M+ daily zero-shot executions
  (~12/sec average, with bursty peaks well above that). The 200 creates/sec
  sustained / 5K burst design point here is ~10-20x that, but with the
  benefit of sharded ownership instead of single-process serialization.
- Microsoft AML scheduling supported 15M+ jobs/month (~5-6/sec average)
  across multi-tenant Kubernetes with gang-scheduling and bin-packing. The
  challenge there was constraint solving, not throughput; the throughput
  envelope here borrows from that operational experience.
- TunDRA QUIC at 1M+ Compute Instances proves out the secure peer-to-peer
  transport assumptions (mTLS, NAT traversal, stream multiplexing) at a
  scale comparable to the placement-cache invalidation fan-out.
