# 00 — Question and Context

## Original Prompt

> Understand the architecture of my current microVM runner and tell me how to make
> this distributed — like a Sentinel where multiple devices can connect together and
> form a consensus. I do **not** want a central control plane like Daytona, more
> libp2p so that multiple ecosystems can start talking to each other.
>
> Follow-up 1: What kind of architecture is this where only the placements are
> determined through Raft consensus, but everything else stays on the bare-metal
> server that owns the sandbox? Is it scalable or just complicated?
>
> Follow-up 2: With this architecture, can I connect to 10,000 bare-metal servers?

## What The Pack Answers

1. A precise read of the current single-node runner (Go binary, SQLite, gVisor,
   per-host Caddy, in-process admission).
2. The minimum set of architectural changes to turn it into a peer-to-peer fabric.
3. A three-plane decomposition: membership/gossip, sandbox metadata, placement +
   ports.
4. Two viable consistency stories — Raft-for-placement (Nomad-shaped) and
   CRDT-over-libp2p (Sentinel/IPFS-shaped) — with explicit tradeoffs.
5. A 10K-node scaling analysis: where each layer breaks and what to do about it.
6. A federation model so independent ecosystems can mesh into one fabric without
   merging logs.

## Scope

In scope:

- Distributed sandbox runtime architecture
- Membership, placement, port allocation, ingress, owner failover
- Public REST API + internal P2P protocols
- 10K-node scale envelope and federation escape hatch
- Threat model for the *runner itself* (peer auth, mTLS, multi-tenant trust)

Out of scope (explicitly):

- Replacing gVisor with Firecracker — orthogonal, mentioned only where the runtime
  choice changes the design.
- Scheduling with GPU/accelerator constraints — covered by reference to the
  Microsoft AML gang-scheduling/bin-packing experience but not designed here.
- A workflow/agent layer on top of the runner.

## Assumptions

| # | Assumption | Why I'm making it |
| - | --- | --- |
| A1 | Sandboxes are ephemeral. Owner failure = sandbox lost is acceptable. | Matches the BlackBox WASM sandbox plane semantics for one-shot zero-shot code execution. |
| A2 | Sandbox creates are bursty but not constantly burst. Sustained 50-200 creates/sec is the design point; brief 5K/sec spikes are tolerated. | Matches CI-style and AI-agent-style call patterns. |
| A3 | Hot path traffic (HTTP into a running sandbox, exec, file IO) dominates volume by ~1000:1 vs control operations. | Follows from how the BlackBox sandbox plane was used. |
| A4 | An operator running this fabric trusts the bare-metal hosts (HW root of trust, OS-level disk). Multi-tenant *workload* isolation is by sandbox runtime; multi-tenant *node* isolation is out of scope. | Same trust model as the production WASM sandbox plane and Nomad clients. |
| A5 | Federation peers (nodes from a different ecosystem) are mutually-untrusted at the application level but agree on the wire protocol. | Required by the libp2p framing. |
| A6 | The author is willing to accept "tiny embedded HA control plane" if the alternative is shipping CRDT debugging for 6 months. | Matches the "ship something" posture of an OSS side project. |

## Resume Anchors Used

| Anchor | Where | How it grounds the design |
| --- | --- | --- |
| Golang WASM sandbox plane, 1M+ daily zero-shot code executions, SOC-2 isolation | resume.txt; blackbox-experience.md #3-#5 | Direct: same domain, same shape of system. Sets the runtime/isolation/scale credibility. |
| GPU scheduling, gang scheduling, bin-packing, multi-tenant isolation, 15M+ jobs/month, 200K+ users via AutoML | resume.txt | Direct: placement, admission, quotas, multi-tenant ergonomics — all reused here. |
| TunDRA — Rust QUIC secure protocol, 1M+ Compute Instances | resume.txt | Direct: secure peer-to-peer transport with NAT traversal characteristics maps straight to libp2p+QUIC + mTLS. |
| Durable DAG workflow engine, checkpointing, retry, fault-tolerant execution across distributed environments | resume.txt; blackbox-experience.md #12-#15 | Supports owner-failover semantics and sandbox lifecycle reconciliation. |
| LLMOps telemetry mesh, 50M spans/day, deterministic replay | resume.txt | Supports the observability section: spans for sandbox lifecycle + cross-node forwarding traces. |
| Skills: Kubernetes, Volcano, Nomad | resume.txt | Direct: Nomad is the closest production analogue; Volcano is the gang-scheduling reference. |

## Confidence

**High.** The single-node architecture description in the prompt is internally
consistent and matches public open-source patterns; the distributed design here is
a synthesis of well-known prior art (Nomad, Service Fabric, TiKV PD, libp2p,
Sentinel, IPFS) applied to that codebase. The author's resume directly supports
sandbox runtime, placement, secure transport, and observability — the four spine
topics. Federation and CRDT-placement are the most extrapolated parts and are
labeled inline.
