# 07 — Reliability, Observability, and Failures

## Failure Taxonomy

| Class | Example | Detection time | Recovery |
| --- | --- | --- | --- |
| Single owner death | Node B power-cycles | 5-15s (SWIM) | Re-place restartable; mark Lost others |
| Owner partition (split brain candidate) | B reachable from half the fleet | 15-60s (SWIM both sides) | Minority side: B treated dead; placement re-elects. Majority side: B kept alive. On heal: B's state reconciled, conflicts logged. |
| Raft leader death | Voter leader crashes | ~3s (heartbeat timeout × 3) | Election; placement writes blocked ~1-3s; reads from learners served from cache |
| Raft quorum loss | 3 of 5 voters down | Immediate (no quorum) | Placement writes 503; reads stale-but-served from cache; alerts page operator |
| Gossip meltdown | Network event causes false-dead cascade | 30-120s | Anti-entropy push/pull repairs; suspicion timeout dampens. Operator action: increase suspicion multiplier. |
| Sandbox runtime crash | gVisor `runsc` segfault | Seconds (Docker event) | Local reconcile loop attempts restart per policy; emits Lost if unrecoverable |
| Caddy admin API hang | Local process stuck | 10s deadline on admin API call | Service marks ingress degraded; new placements skip this node |
| SQLite WAL corruption | Disk fault | Open-time check + write failure | Node self-quarantines; placement reconciler moves owned sandboxes |
| Stream multiplex deadlock | libp2p stream stuck | Per-RPC deadline | Stream reset; circuit-breaker on the (peer, proto) tuple |

## Reconciliation Strategy

The single-node design already has a reconcile loop in `internal/service`.
Distribution adds three new sources of drift:

1. **Placement says I own X, but I have no record locally.** → pull from
   replication; if not found, ask Raft authoritatively; if confirmed mine,
   create the container; if not mine anymore, discard.
2. **I have a container running for X, but placement says someone else owns it.**
   → stop and remove my container; emit event.
3. **I have a replica row for X, but it's TTL-expired.** → drop; rely on
   future GET to re-pull.

The reconciler runs every 30s, and on every membership-event or
placement-watch tick it drains the pending work first.

**Idempotency of reconciliation** is critical. Every action the reconciler
takes must be safe to run twice:

- "Start container for X" → check first; if running, no-op.
- "Configure Caddy route for X" → upsert, not append.
- "Free port range" → bitmap idempotent set/clear.

## Retries and Backoff

| Surface | Retry policy | Notes |
| --- | --- | --- |
| Forward RPC `/sandboxd/forward/1.0.0` | 3 retries with exponential backoff (50ms, 200ms, 800ms) + jitter | Honor `NotOwner` immediately by re-resolving; honor `NACK NoCapacity` by re-sampling |
| Raft Place/Move | 5 retries; on `LeaderUnknown`, wait for leader-discovery (1s) and retry | Bounded total: ~5s |
| Placement watch reconnect | Exponential backoff capped at 5s; resume from last index | Watch is the cache-warming path; never give up |
| Replica pull `/sandboxd/replication/1.0.0` | 2 retries; on third failure, ask Raft authoritatively | Avoids hot loop on a flaky owner |
| Caddy admin API | 1 retry on transient error; on hard failure, mark ingress degraded | Don't retry-storm the local Caddy |

All retries carry an `Idempotency-Key`-equivalent (the sandbox-id + version)
so duplicate attempts do not duplicate side effects.

## Circuit Breakers

Per-peer circuit breaker on outbound forwards and proxy streams:

```
state: Closed → Open (on failure rate > 25% over 50 requests)
       Open → HalfOpen (after 30s)
       HalfOpen → Closed (on next success)
```

When a peer's breaker is Open, placements skip it (membership filter) and
hot-path requests for sandboxes it owns return `503 OwnerDegraded` instead of
hanging on a dead stream. This prevents fleetwide cascade when one node is
slow.

## Observability

### The three signal types

| Signal | Cardinality budget | Storage |
| --- | --- | --- |
| Logs (structured, slog) | Low — no per-sandbox keys | Local file + ship to centralized (Loki / S3) |
| Metrics (OpenTelemetry) | Bounded — labeled by `node`, `op`, `result`, `cross_region` only | Prometheus scrape per node; remote write to long-term TSDB |
| Spans (OpenTelemetry) | High — per-request | Sampled; ClickHouse or Tempo |

This is intentionally lighter than the BlackBox 50M spans/day mesh; for the
OSS distribution, you ship sane defaults (10% sampling, head-based) and let
operators dial up.

### Span topology

Each cross-node operation emits a parent-child trace via libp2p stream
metadata propagation:

```
client.create_sandbox  (root)
└─ api.create_sandbox             (Node A)
   ├─ placement.place              (A → Raft leader)
   └─ forward.create               (A → Node B, libp2p stream)
      ├─ admission.reserve          (B)
      ├─ runtime.create             (B)
      └─ ingress.configure          (B, local Caddy)
```

Cross-stream context is propagated via a single header on the libp2p stream
prologue (W3C traceparent format).

### Key metrics

**Saturation:**

- `placement_raft_commits_per_sec`
- `placement_watch_lag_seconds`
- `gossip_messages_per_sec`
- `forward_streams_open`
- `port_partition_free_ratio`

**Latency (histograms):**

- `api_request_duration_seconds{op, owner_local}` — split owner-local vs forwarded
- `forward_overhead_seconds{cross_region}`
- `raft_commit_latency_seconds`
- `proxy_first_byte_seconds`

**Errors:**

- `forwards_total{result=ok|notowner|nack|error}`
- `placement_lookup_total{cache_result=hit|miss|stale}`
- `circuit_breaker_state{peer,state}`

**Business:**

- `sandboxes_active{tenant,runtime}`
- `sandbox_create_total{tenant,result}`
- `sandbox_lifetime_seconds` (histogram)

### Deterministic replay (light version)

The BlackBox sandbox plane shipped deterministic replay for 50M spans/day at
~2.5TB/month. The OSS runner doesn't need that bar by default, but should
keep the door open:

- All control-path operations (Create, Move, Destroy, owner-handoff) emit
  structured events into the audit log.
- Audit log includes the full request body hash, the placement decision
  inputs (sampled peers + their capacity vectors at time of decision), and
  the Raft commit index.
- "Why did sandbox X land on node B?" is reconstructible from a single
  audit query: shows the candidates, their capacities, the picker output.

This is enough to debug 95% of placement weirdness without a full event-source
log of every state transition.

### Dashboards (the four we'd ship)

1. **Cluster health**: node count, churn rate, gossip lag, Raft leader
   stability, port-partition free ratio.
2. **Placement throughput**: commits/sec, watch lag, batch sizes, NACK rate
   by reason.
3. **Hot path**: forward overhead, owner-local vs forwarded ratio, cross-region
   forwards, proxy stream errors.
4. **Tenant view**: per-tenant active sandboxes, create rate, error rate,
   quota usage.

## Testing Strategy

**Single-node tests:** existing tests stay green.

**Multi-node integration:**

- A `clustertest` harness spins up N in-process sandboxd nodes wired to a
  shared in-memory libp2p network; runs scenarios:
  - happy path create/destroy across N=3, 5, 10 nodes
  - owner death mid-Create
  - Raft leader death during a placement burst
  - network partition (asymmetric)
  - membership churn under sustained load

**Chaos tests:** `chaos.sh` script harness for real bare-metal:
- random kill -9 on owner nodes
- iptables-based partitions
- artificial gossip packet loss

**Load tests:** `vegeta` driving the API at known rates; assert P99 latency
budgets per scenario.

**Federation tests:** two `clustertest` harnesses bridged; verify cross-fabric
ingress, placement gating, and trust failures.

## SLOs (suggested defaults)

| SLO | Target | Window |
| --- | --- | --- |
| `POST /v1/sandboxes` success rate | 99.9% | 30 days |
| `POST /v1/sandboxes` p95 latency (owner-local create) | < 250ms | 30 days |
| Hot-path proxy success rate (excl. tenant errors) | 99.95% | 30 days |
| Hot-path proxy p99 added latency (forward overhead) | < 5ms intra-DC, < 50ms cross-region | 30 days |
| Placement Raft availability | 99.99% | 30 days |
| Mean owner-failover detection-to-recovery | < 30s | 30 days |

## What Failure Modes Are Considered Acceptable

The trust posture and ephemerality assumption (A1) accepts:

- Owner death = sandbox lost (unless declared Restartable).
- Brief Raft elections cause ~3s of placement-write unavailability.
- Cross-region forwards add measurable latency for users; locality-aware
  placement is the optimization, not a correctness requirement.

This is a deliberate tradeoff. The alternative (full sandbox state in Raft,
high-availability sandbox replicas) is a 10x complexity multiplier for a
runner whose primary use case is "ephemeral code execution."

## Anchors From Resume

- **LLMOps telemetry mesh, 50M spans/day, deterministic replay, MTTR -60%**
  (resume.txt; blackbox-experience.md #20): the three-signals model and
  audit-driven replay design directly transfer.
- **Reconcile loop / fault-tolerant execution across distributed environments**
  (resume.txt, blackbox section #15): the idempotent reconciler pattern.
- **30+ architecture reviews for AI Fine-tuning and AutoML, security and infra
  alignment** (resume.txt): SLO + observability tradeoff posture.
