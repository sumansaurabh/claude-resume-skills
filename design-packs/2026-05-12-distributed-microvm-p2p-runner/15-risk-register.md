# 15 - Risk Register

The technical and operational risks, ranked by likelihood × impact, with
mitigations and trip-wires.

## Top Risks (Ranked)

### R1 - Placement Raft Becomes The Bottleneck Under Burst

- **Likelihood:** Medium
- **Impact:** High (Create latency degrades; 503s)
- **Mechanism:** A CI provider or AI agent platform issues 10K+
  Create requests in a few seconds. Single Raft leader fsync becomes the
  serialization point.
- **Mitigation:**
  1. Batched placements: `PlaceBatch([]CreateRequest)` is one Raft commit.
  2. Sharded placement Raft (4-16 groups by `hash(sandbox_id)`).
  3. Per-tenant API rate limit blunts the spike before Raft.
- **Trip-wire:** `placement_raft_commit_p99_ms > 100ms for 5min`.
- **Recovery:** Enable batching mode; if persistent, add Raft shards.

### R2 - Gossip Cluster Loses Cohesion Above ~10K Nodes

- **Likelihood:** Medium (at high-end fleets)
- **Impact:** High (false-dead cascades; placement chaos)
- **Mechanism:** SWIM is well-tested to ~5K. At 10K, suspicion timeouts
  start producing false positives under network noise; cascading failure
  detection events thrash the placement plane.
- **Mitigation:**
  1. Tune SWIM at 10K: longer suspicion, larger fanout, slower probe.
  2. Hierarchical gossip above 10K (regional pools that gossip a summary).
  3. Federate above 10K - split into smaller fabrics meshed by bridges.
- **Trip-wire:** `gossip_false_positive_rate > 5% for 1h`.
- **Recovery:** Bump suspicion multiplier; federate cluster.

### R3 - Cross-Region Forward Latency Breaks SLOs

- **Likelihood:** High (in any geo-distributed deploy)
- **Impact:** Medium (user-visible latency)
- **Mechanism:** Sandbox owner is in a different region from the inbound
  client; every request adds ~80ms cross-region.
- **Mitigation:**
  1. Locality-aware placement (prefer same-region peers in `Sample()`).
  2. Per-tenant DNS pinning to owner for stable sandboxes.
  3. SDK learns owner from first response and pins.
- **Trip-wire:** `forward_overhead_p99_ms > 50ms in same fabric for 10min`.
- **Recovery:** Enable locality preference; document for operators.

### R4 - Owner Death Loses Ephemeral Sandboxes (Acceptable, But Misunderstood)

- **Likelihood:** High (it's by design)
- **Impact:** Low-Medium (depends on tenant expectation)
- **Mechanism:** Single owner = single point of failure for an ephemeral
  sandbox. Tenants who don't read docs may expect HA.
- **Mitigation:**
  1. Document explicitly. Default response code on owner-death-during-request
     is `502 OwnerLost` with body explaining ephemerality.
  2. Restartable mode opt-in for sandboxes that need HA.
  3. SDK exposes `restartable=true` parameter clearly.
- **Trip-wire:** Tenant complaint tickets / RTO budget breaches for
  Restartable sandboxes.
- **Recovery:** Per-tenant RTO dashboards; auto-flag tenants at risk of
  expecting HA.

### R5 - Federation Trust Anchor Compromise

- **Likelihood:** Low
- **Impact:** Critical (cross-fabric trust collapses)
- **Mechanism:** A fabric's trust anchor private key is leaked or stolen.
  Cross-fabric placements and ingress could be forged.
- **Mitigation:**
  1. Trust anchor key offline-stored (HSM or air-gapped); rotated annually
     with overlap window.
  2. Emergency revocation key kept in secure escrow; out-of-band publication
     channel for revocation events.
  3. Bridge peer admission policy de-trusts a fabric on any signature
     anomaly.
- **Trip-wire:** Anomaly detector on bridge-peer signature patterns;
  manual incident process.
- **Recovery:** Publish revocation; bring up new trust anchor; re-sign
  descriptors.

### R6 - Audit Log Loss Breaks SOC-2

- **Likelihood:** Low
- **Impact:** High (compliance violation)
- **Mechanism:** Local audit log shipped to immutable store; if shipper
  fails silently and local log rotates, events are lost.
- **Mitigation:**
  1. Per-node monotonic sequence number; immutable store verifies no gaps.
  2. Local log retention ≥ 7 days regardless of ship-confirm; truncated
     only after immutable-store fsync confirmation.
  3. Shipper has its own observability; gaps page operator.
- **Trip-wire:** `audit_seq_gap_count > 0` in immutable-store verifier.
- **Recovery:** Pull missing range from local log; investigate shipper.

### R7 - gVisor Escape (Sandbox Isolation Failure)

- **Likelihood:** Low (gVisor track record is good)
- **Impact:** Critical (cross-tenant data exposure)
- **Mechanism:** A new gVisor CVE allows kernel-side escape from a
  malicious sandbox.
- **Mitigation:**
  1. Layered isolation: gVisor + seccomp + caps drop + AppArmor + cgroups.
  2. Per-tenant network namespace; no shared filesystem mounts.
  3. Egress firewall blocks cloud-metadata IPs.
  4. Plan for Firecracker upgrade for high-isolation tenants.
- **Trip-wire:** gVisor CVE feed; runtime anomaly detection (unexpected
  syscall patterns).
- **Recovery:** Hot-patch gVisor binary; quarantine affected nodes.

### R8 - libp2p Maturity Gaps Surface At Scale

- **Likelihood:** Medium
- **Impact:** Medium
- **Mechanism:** libp2p Go libraries are maturing; some edge cases (stream
  multiplexing under high concurrency, NAT traversal in specific topologies)
  may not be production-bulletproof at 10K nodes.
- **Mitigation:**
  1. Stream pooling with conservative limits.
  2. Fallback transport (gRPC over TCP+TLS) behind a feature flag.
  3. Track libp2p issues; contribute fixes back when found.
- **Trip-wire:** `libp2p_stream_error_rate > 1% for 30min`.
- **Recovery:** Disable affected protocol; fallback to direct TCP if needed.

### R9 - SQLite Becomes The Per-Node Bottleneck Under Hot Tenant

- **Likelihood:** Low (per-node load is moderate)
- **Impact:** Medium (per-node degradation, not fleetwide)
- **Mechanism:** A tenant with thousands of sandboxes on a single owner
  saturates SQLite WAL.
- **Mitigation:**
  1. Per-tenant sandbox count quota.
  2. Power-of-two-choices already spreads load.
  3. Replace SQLite with BadgerDB if persistent issue (migration is
     mechanical).
- **Trip-wire:** `sqlite_wal_checkpoint_p99_ms > 100ms`.
- **Recovery:** Move sandboxes off node; cap tenant.

### R10 - Bus Factor (Single-Author OSS Project)

- **Likelihood:** High (until contributors join)
- **Impact:** High to community
- **Mechanism:** Project becomes critical to early adopters; author
  unavailable; users stranded.
- **Mitigation:**
  1. Architecture decision records (ADRs) checked in.
  2. v0/v1 issues labeled "good first issue" to attract maintainers.
  3. Roadmap public; design docs (this pack) checked in.
  4. Core architecture intentionally synthesizes well-known parts so a
     new maintainer can ramp.
- **Trip-wire:** Open-issue count rising faster than close rate for 90 days.
- **Recovery:** Recruit maintainers; reduce scope if needed.

## Non-Risks (Common Concerns That Don't Apply Here)

- **"What if Raft loses quorum during a Create?"** API returns 503; client
  retries; no data loss because no commit happened.
- **"What if two nodes both think they're the Raft leader?"** Raft's
  invariant. Won't happen unless you misconfigure quorum size.
- **"What if a sandbox runs forever?"** Tenant quota + wall-clock max +
  per-tenant max active count. Standard.
- **"What about DDoS?"** Out of scope at L3/L4; assumed handled by upstream
  network. L7 (PAT rate limit, idem-key throttle) is in design.
- **"What if libp2p disappears?"** Forked / replaced with custom QUIC stack.
  TunDRA proved that's possible; we'd rather not.

## Risk Review Cadence

- v0/v1: every 2 weeks during active development.
- v2+: monthly + on incident.
- Trip-wires monitored continuously; firing trip-wire = automatic incident.

## Anchors From Resume

- **CodeQL + GitHub Advanced Security + threat modeling discipline at
  Microsoft** (resume.txt): the methodology behind this register.
- **30+ architecture reviews at Microsoft for AI Fine-tuning + AutoML**
  (resume.txt): the cadence and trip-wire model is taken from those
  reviews.
- **SOC-2 compliance work for the WASM sandbox plane at BlackBox**
  (resume.txt): the audit log + isolation risks (R6, R7) are the same
  ones tracked there.
