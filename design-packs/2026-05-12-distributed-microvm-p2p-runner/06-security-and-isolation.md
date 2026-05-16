# 06 - Security and Isolation

## Trust Model

Two layers, deliberately separated:

1. **Within a fabric** - the operator owns the bare metal, the OS, and the
   `sandboxd` binary. Nodes trust each other by default. Tenant workloads
   (sandboxes) are mutually untrusted at the runtime layer.
2. **Across fabrics** - bridge peers connect two fabrics with explicit,
   policy-gated trust. Nodes in fabric F1 do not implicitly trust nodes in F2.

This split mirrors the BlackBox sandbox plane (single trust domain for
infrastructure, mutual untrust at the workload layer for SOC-2) and Microsoft
AML's multi-tenant Kubernetes posture (nodes trusted, tenant pods isolated).

## Threat Model (STRIDE-Lite)

| Threat | Surface | Control |
| --- | --- | --- |
| **Spoofing** a peer | libp2p PeerID forgery | PeerID = Ed25519 pubkey hash; mTLS handshake binds connection to PeerID. Forgery requires private key compromise. |
| Spoofing a tenant | API request | PAT bearer + per-PAT tenant binding; `tenant_id` not client-controlled. |
| **Tampering** with placement | Raft commits | Raft AppendEntries authenticated by mTLS; FSM rejects entries from non-voters; index + term prevent replay. |
| Tampering with sandbox state | PubSub mutation event | Events signed by owner's PeerID; non-owner publishes rejected by subscribers. |
| **Repudiation** of an action | Audit | Every state transition emits a span with `actor_peer_id`, `pat_id`, `tenant_id`, `idempotency_key`. Append-only audit log per node, shipped to telemetry. |
| **Information disclosure** of cross-tenant data | Sandbox runtime | gVisor (or runc with strict seccomp/AppArmor) kernel surface restriction; per-tenant network namespace; no shared filesystem mount across tenants; ingress per-sandbox only. |
| Disclosure of secrets | Logs, traces | Span sanitizer rejects fields matching secret patterns; PATs hashed at rest; no raw PAT in logs. |
| **DoS** via placement spam | API + Raft | Per-tenant rate limit (token bucket) at API; per-PAT idempotency-key bucket; admission rejects before Raft. |
| DoS via gossip flooding | Membership | memberlist message size cap; rate limit per-source UDP packets; mTLS for libp2p means random-IP attackers can't join gossip. |
| **EoP** within a sandbox | Container escape | gVisor as default runtime (user-space kernel reimplementation); seccomp + capability drop; rootless container; no host network share. |
| EoP across nodes | Forward RPC | Forwarder validates `tenant_id` matches the PAT that initiated the original request - receiving node re-checks, doesn't trust the sender. |

## Identity and Authentication

### Peer-to-peer (cluster internal)

- Every node has an Ed25519 keypair (PeerID = SHA-256 of public key).
- libp2p TLS handshake binds the QUIC connection to the PeerID - no separate
  CA needed for intra-fabric traffic.
- A fabric-wide membership policy gates which PeerIDs may join. Three modes:
  1. **Open** (OSS dev): any peer with a valid handshake joins.
  2. **Allowlist**: a signed peer-list distributed via initial bootstrap config.
  3. **CA-signed**: PeerID certs signed by a fabric root key. PKI-style.

Mode 3 is the SOC-2 / production mode. Mode 1 is for local dev.

### Cross-fabric (federation)

- Each fabric publishes a `FabricDescriptor` signed by its trust anchor:
  `{ fabric_id, root_peer_ids, trust_anchor_pubkey, federation_policy }`.
- Bridge peers exchange descriptors out of band (config file, registry, or
  a discovery protocol like a registry contract).
- Cross-fabric placement and ingress requests carry the originating fabric's
  signed `FabricToken` (short-lived JWT or libp2p capability token).
- Each fabric's admission policy (a Go function) decides whether to accept
  the request.

This is the same model SPIFFE/SPIRE uses (workload identity by spiffe-ID
URI), simplified for the libp2p case.

### Client-to-fabric (external API)

- PAT bearer is the v1 mechanism. Per-PAT scope: `tenant_id`, allowed
  endpoints, allowed runtime tags.
- v2: OIDC trust to the fabric's identity provider. PATs become a fallback
  for service accounts and headless flows.
- Per-PAT rate limiting at every node (each node has the PAT-hash table from
  a small replicated config plane).

## Sandbox Isolation

Same defense-in-depth model the BlackBox WASM sandbox plane used, adapted to
gVisor (the runtime today). Layered controls:

| Layer | Control | Why |
| --- | --- | --- |
| Process | gVisor user-space kernel (`runsc`) | Drops Linux syscall surface from ~350 to ~70 reachable; eliminates most container-escape CVE classes |
| Capabilities | All dropped except minimal set | Default deny |
| Seccomp | Allowlist filter | Belt-and-suspenders even with gVisor |
| Filesystem | Per-sandbox writable layer; read-only base image | Tenant data segregation |
| Network | Per-sandbox network namespace; veth to bridge; egress firewall | No tenant→tenant traffic; no metadata-service exposure (cloud) |
| Resource | cgroup CPU + memory hard limits; PID limit; ulimit | Prevent fork bombs, OOM-kill blast radius |
| Wall-clock | Service-enforced max runtime | Prevent runaway long-running |
| Output | Stdout/stderr ring buffer with size cap | Prevent disk fill |
| Egress | Optional: per-tenant egress proxy with allowlist | Compliance / data-exfil prevention |

For a Firecracker upgrade path (true microVM): same layered model, but the
seccomp surface is below the VM boundary so the threat surface shrinks
further. Worth doing for high-isolation tenants. Out of scope here but the
runtime abstraction in `internal/runtime` already accommodates it.

## Multi-Tenant Isolation Across Distribution

Distribution introduces three new isolation concerns:

### Cross-tenant placement leakage

A malicious tenant could try to infer cluster state by observing placement
side-channels (e.g., create-then-destroy probes timing). Mitigations:

- Placement RPC errors do not reveal which other nodes were sampled.
- Capacity vectors gossiped publicly within the fabric carry only aggregate
  numbers (free CPU, free memory) - not per-tenant breakdown.
- `GET /v1/sandboxes` is tenant-scoped at the API - no cross-tenant list.

### Cross-tenant ingress confusion

Two tenants' sandboxes both exposed on TCP port 443 via TLS-SNI must not
cross-talk. The host port partition is per-node, so port collisions across
tenants on the same node are impossible. Cross-node: SNI routing in Caddy
plus tenant-scoped sandbox-id resolution prevents tenant A's HTTPS request
from reaching tenant B's sandbox even if a sandbox-id is guessed.

### Forwarded request authorization

A sandbox-create request forwarded from node A to node B carries the
originating PAT *hash* (not the PAT itself), the `tenant_id`, and a
short-lived signature. Node B re-checks the tenant has placement permission
on B *before* admitting - the forward isn't a trust delegation.

Failure mode prevented: A is compromised, attempts to create sandboxes on B
for a tenant that A's PAT doesn't actually serve. B catches because it
re-validates.

## Secret Handling

- Per-tenant secrets injected into sandboxes at create-time (env vars
  encrypted with the sandbox's runtime keypair, decrypted in-runtime).
- Secrets never written to SQLite in plaintext. The sandbox-row stores a
  reference to a per-fabric secret store (Vault/KMS), not the secret value.
- Secrets never traverse the placement Raft. They flow only to the owner via
  a dedicated `/sandboxd/secret/1.0.0` libp2p stream after placement is decided.

This separation matters: the placement Raft is replicated to ~5 voters and
many learners; secrets there mean compromising any voter exposes them all.

## Audit Trail

Every sandbox state transition emits an audit event:

```
{
  "ts": "...",
  "fabric_id": "...",
  "node_id": "...",
  "actor": { "peer_id": "...", "pat_id": "...", "tenant_id": "..." },
  "subject": { "sandbox_id": "...", "version": 7 },
  "action": "create | start | stop | destroy | move | replica_evict",
  "result": "ok | nack:nocapacity | error:internal",
  "request_id": "...",
  "idempotency_key": "..."
}
```

Audit events go to the same telemetry mesh as spans (see [07-...](07-reliability-observability-and-failures.md)).
For SOC-2-equivalent posture (the BlackBox bar), audit events must be
immutable-storage replicated within a defined window (e.g., shipped to S3
Object Lock within 60s) and queryable for ≥90 days.

## Federation Trust Failures

| Scenario | Mitigation |
| --- | --- |
| Compromised bridge peer in fabric F1 publishes garbage capacity vectors | Bridge peer messages signed by their PeerID; F2 admission policy throttles or de-trusts a misbehaving bridge automatically |
| Fabric F1 declares trust in F2; F2's trust anchor is rotated mid-flight | `FabricDescriptor` carries a `valid_after` / `valid_until`; rotation is via signed key-handover with overlap window |
| F1 attempts to flood F2 with cross-fabric Create requests | F2 rate-limits per `(remote_fabric_id, tenant_id)`; default budget is 0 (opt-in only) |
| F1 ingress to a sandbox on F2 reveals F2's internal placement | F2 returns only `{owner_peer_id, address}` to F1's bridge - no internal capacity info leaks |

## What's Out Of Scope (Honestly)

- Confidential computing / SGX / TDX for sandbox memory protection. Possible
  upgrade path; orthogonal to distribution.
- DDoS at the L3/L4 layer hitting the libp2p ports - assumed handled by
  upstream network gear or a cloud provider's DDoS protection.
- Side-channel attacks within a single node (Spectre-style across sandboxes
  on the same CPU). gVisor mitigates kernel-side; CPU-side is the
  hypervisor/hardware story.
- Quantum-resistant peer keys. Ed25519 is the v1 choice; NIST PQC (e.g.,
  ML-DSA) is the migration path when libp2p ships it.

## Anchors From Resume

- **WASM sandbox plane → SOC-2 compliance** (resume.txt; blackbox-experience.md
  #5): direct lineage of the layered isolation model and audit posture.
- **GitHub Advanced Security + CodeQL + threat modeling** (resume.txt,
  Microsoft section): the threat-model methodology applied here.
- **TunDRA QUIC + mTLS at 1M+ Compute Instances** (resume.txt): proves the
  peer-to-peer mTLS approach at scale.
- **Multi-tenant isolation strategies for LLM workloads** (resume.txt,
  Microsoft section): the cross-tenant placement / ingress / forward
  isolation model.
