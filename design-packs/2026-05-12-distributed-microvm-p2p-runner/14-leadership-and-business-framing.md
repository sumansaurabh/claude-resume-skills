# 14 — Leadership and Business Framing

The "why does this exist, who is it for, and how do you make it land" view.
Useful as the back half of an interview answer or the pitch to the first
contributor.

## Why Build This

There is a gap in the OSS landscape:

- **Daytona / Codespaces / Coder** — opinionated dev-environment platforms.
  Powerful, but central control plane and service-shaped operationally.
- **Nomad** — closest existing primitive. Solid for general workloads, but
  not opinionated about microVM/sandbox isolation, and federation is per-
  region with central coordination.
- **Kubernetes** — too heavy for "ephemeral one-shot sandbox", too
  cluster-bound for "ecosystems mesh together."
- **libp2p/IPFS** — beautiful federation primitives but no notion of
  ephemeral compute.

The opportunity: a runner that is small enough for a single bare-metal
operator to run, distributed enough to scale to 10K nodes, and *meshable*
across organizational ecosystems via libp2p — so two open-source projects,
two CI providers, two universities can join the same fabric without
choosing one organization's central control plane.

## North Star

> Any device, anywhere, can run `sandboxd` and become part of a fabric.
> Any fabric can mesh with any other fabric. There is no logical center.
> Sandboxes go where capacity is, with isolation guaranteed end-to-end.

## Why Now

- **Bare-metal availability is up.** Hetzner, OVH, Latitude, and the rise of
  edge bare-metal mean the substrate is cheap and ubiquitous.
- **WASM and gVisor have matured.** Sandbox isolation that was research-grade
  five years ago is production now.
- **AI agents need ephemeral compute at high concurrency.** Code execution
  for AI is the killer use case (the BlackBox WASM sandbox plane shipped
  exactly this for 1M+ daily executions).
- **libp2p is mature.** QUIC + mTLS + NAT traversal in a single library;
  TunDRA-style per-tenant secure transport without writing it from scratch.

## Who It's For (in priority order)

1. **AI agent platforms** that need ephemeral code execution at scale and
   want to avoid centralized lock-in.
2. **CI providers** (especially OSS) that need to spin up isolated runners
   on demand.
3. **Universities and research labs** that want to share compute capacity
   across institutions without merging admin.
4. **Edge / IoT operators** running compute at thousands of physical sites
   with poor central network — gossip-based control plane fits the substrate.
5. **Cloud-skeptics** who want a non-AWS, non-GCP path to ephemeral compute
   that's federation-friendly.

## Why I Can Build This

The relevant production experience:

- **Architected a Golang WASM sandbox plane** isolating 1M+ daily zero-shot
  code executions with SOC-2 isolation requirements at BlackBox. Same
  domain, same shape of problem.
- **Led GPU scheduling, gang-scheduling, bin-packing** for multi-tenant
  Kubernetes ML infra at Microsoft AML — 15M+ jobs/month, 200K+ users.
  The placement and admission patterns are reused here.
- **Co-developed TunDRA**, a Rust QUIC-based secure protocol powering 1M+
  Compute Instances at Microsoft. Direct precedent for the libp2p+QUIC
  peer-to-peer transport story.
- **Designed the LLMOps telemetry mesh** ingesting 50M spans/day at BlackBox.
  The observability and audit posture in this design comes from operating
  that mesh.
- **Led 30+ architecture reviews** at Microsoft for AI Fine-tuning + AutoML.
  The "ship v1, plan v2 explicitly" cadence comes from those reviews.

## OSS Strategy

### v0 (Months 0-2): Single-binary distributed core

- Membership (memberlist), placement Raft, port partition, owner
  forwarding shim.
- The vertical slice: toolbox proxy can forward across two nodes.
- Default mode: 3-node `docker-compose` for dev; bootstrap config for prod.
- Audience: "this is real, here's the architecture, here's how to try it
  with three nodes on your laptop."

### v1 (Months 2-6): Production-shape

- Audit log shipping, observability defaults (Prometheus + OTel exporters).
- Restartable sandbox path with object-store snapshots.
- Locality-aware placement.
- Documented operational runbooks.
- First contributor target: someone running a single-DC fabric of 5-50 nodes.

### v2 (Months 6-12): Federation + CRDT

- Bridge peer + signed FabricDescriptor.
- CRDT placement option behind a flag (Raft remains default).
- Cross-fabric ingress.
- First federation: two friendly OSS projects each running their own
  fabric, meshed for shared capacity.

### v3+ (Year 2): Scale + ecosystem

- Sharded placement Raft for 50K+.
- Hierarchical gossip for 100K+.
- Constraint-solver placement path (GPU, anti-affinity).
- Plugin runtime drivers (Firecracker, Kata).
- Public registry of fabrics for discovery.

## How To Make It Land

- **Lead with a runnable demo.** "Three `sandboxd` containers on your
  laptop, watch a sandbox follow capacity." Demo > docs.
- **Frame against the existing tools.** Day-one README: "If you'd reach for
  Nomad, here's why this is a different shape."
- **Federation as the headline story.** v2 is the differentiator;
  market-position the project around it from day one even though v1 is
  what you ship first.
- **Ship the observability defaults.** Operators choose tools they can debug.
- **Talk at conferences with the right framing.** "Sentinel for ephemeral
  microVMs" is a sticky pitch; "another orchestrator" is not.

## Risks to OSS Adoption (vs. technical risks; see [15-...](15-risk-register.md))

| Risk | Mitigation |
| --- | --- |
| Kubernetes ecosystem inertia ("just use a Job") | Position as complement, not replacement; CRD mode for K8s integration in v2 |
| Operator suspicion of "another orchestrator" | Lean into the niche: ephemeral microVMs + libp2p mesh; not general workload |
| Federation never gets used because nobody operates two fabrics | Ship a public reference fabric (a community-run one) so any project can join one without operating their own |
| Bus factor (single-author OSS) | Document architecture-decision records and onboard 2-3 long-term contributors via well-scoped issues from v0 |
| Security incident kills momentum | Aggressive isolation defaults, public threat model, responsible-disclosure policy from day one |

## What This Project Demonstrates

For a Principal Engineer profile, this side project demonstrates:

- **Distributed systems judgment** — picking the right consistency
  substrate per concern, recognizing the control/data plane split,
  shipping v1 while keeping v2 reachable.
- **Operational empathy** — choosing operability over theoretical purity
  for v1; designing for "what does the operator do at 3 AM."
- **Cross-domain synthesis** — combining lessons from Microsoft AML
  (scheduling), BlackBox (sandbox runtime), TunDRA (secure transport),
  and OSS (Nomad, libp2p, Sentinel) into a coherent design.
- **Business framing** — knowing the niche, knowing why now, knowing the
  adoption path. Not just an architecture doodle.

## What I Wouldn't Do

- **Build my own consensus algorithm.** `hashicorp/raft` exists.
- **Build my own gossip.** `memberlist` exists.
- **Build my own runtime.** gVisor / runc / Firecracker exist.
- **Build my own ingress.** Caddy stays.
- **Build my own SDK in 8 languages on day one.** Go SDK + REST is enough.

The leverage is in the cluster substrate (`internal/cluster/*`) and the
federation model. Everything else is a thin wrapper over off-the-shelf
parts. That's what makes the project shippable as a side project.

## Anchors From Resume

- **Principal Engineer @ BlackBox: WASM sandbox plane, 1M+ daily, SOC-2,
  agentic AI platform leadership** (resume.txt): the source of the runtime
  and isolation experience.
- **Microsoft Senior SWE: secure LLM training, multi-tenant K8s, 15M+
  jobs/month, 200K+ users** (resume.txt): the source of the scheduling and
  operational scale experience.
- **TunDRA Rust QUIC, 1M+ Compute Instances** (resume.txt): the source of
  the peer-to-peer transport credibility.
- **Mentored 8 engineers on secure protocol design; CodeQL + GitHub
  Advanced Security; standardized threat modeling** (resume.txt): the
  source of the security posture and review discipline.
