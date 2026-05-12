# Distributed microVM P2P Runner — Design Pack

A principal-engineer design pack for converting a single-node microVM/sandbox runner
(Go binary, SQLite-backed, local Caddy ingress, gVisor runtime) into a leaderless,
peer-to-peer fabric of bare-metal nodes that can scale to ~10K hosts and federate
across organizational ecosystems — without a central control plane.

The system is a personal open-source project. It draws on the author's production
experience operating a Golang WASM/gVisor sandbox plane at 1M+ daily executions,
multi-tenant GPU scheduling at Microsoft AML (15M+ jobs/month), and a Rust QUIC
secure transport (TunDRA) running across 1M+ compute instances.

## File Map

| File | Purpose |
| --- | --- |
| `manifest.json` | Pack metadata, archetype, hash, grounding |
| `00-question-and-context.md` | Original question, scope, assumptions, resume anchors |
| `01-executive-summary.md` | One-screen "principal engineer answer" |
| `02-architecture.md` | End-to-end topology, three-plane decomposition, request flows |
| `03-api-and-contracts.md` | External REST API, internal P2P protocols, idempotency, error model |
| `04-low-level-design.md` | Module/package layout, types, state machines, schemas |
| `05-scaling-and-capacity.md` | 10K-node scaling math, bottlenecks, federation escape hatch |
| `06-security-and-isolation.md` | Threat model, mTLS, peer auth, sandbox isolation, multi-tenant trust |
| `07-reliability-observability-and-failures.md` | Failure taxonomy, recovery, metrics, traces, replay |
| `08-tradeoffs-and-alternatives.md` | Raft-for-placement vs CRDT vs central plane vs federated mesh |
| `09-cross-questions.md` | Skeptical interviewer pushback + crisp rebuttals |
| `10-cheat-sheet.md` | 30-second talking points |
| `11-control-plane-vs-data-plane.md` | What's in each plane and why |
| `12-state-machine-and-workflows.md` | Sandbox + ownership state machines, failover workflow |
| `13-data-model-and-storage.md` | Local SQLite shape, CRDT log shape, Raft log shape |
| `14-leadership-and-business-framing.md` | Why build this, ecosystem story, OSS strategy |
| `15-risk-register.md` | Top operational and design risks with mitigations |

## How To Read This Pack

- Start with `01-executive-summary.md` for the punchline.
- `02-architecture.md` and `11-control-plane-vs-data-plane.md` are the spine.
- `05-scaling-and-capacity.md` answers "can I really run this at 10K nodes?"
- `09-cross-questions.md` is the rehearsal set for an interview or design review.

## Grounding Confidence

High. Three strong resume anchors directly support the design:
the BlackBox sandbox plane (runtime, isolation, scale), Microsoft AML
scheduling (multi-tenant placement, bin-packing, quotas), and TunDRA
QUIC (secure node-to-node transport). Where the design extrapolates
beyond shipped systems (libp2p mesh, CRDT placement), assumptions are
labeled in-line.
