# Resume Skill Coverage

This repo-local skill suite is designed to answer resume-grounded system design, API design, and low-level design interview questions using `resume.txt`, `microsoft-experience.md`, and any future `*-experience.md` files added to the repo.

The default output is a multi-file design pack under `design-packs/`.

| # | Use case | Primary skill | Expected pack emphasis |
|---|---|---|---|
| 1 | Walk through an end-to-end LLM training architecture from request to artifact publishing | `/analyze-my-resume` | Architecture, control flow, components |
| 2 | Design a secure multi-tenant LLM fine-tuning platform on Azure and Kubernetes | `/analyze-my-resume` | Isolation, networking, tenancy, scheduling |
| 3 | Explain control plane versus data plane for a managed ML platform | `/analyze-my-resume` | Boundaries, ownership, APIs, security |
| 4 | Explain gang scheduling for distributed GPU training | `/analyze-my-resume` | Scheduler behavior, failure handling, utilization |
| 5 | Design GPU bin-packing for mixed training and inference workloads | `/analyze-my-resume` | Capacity, fragmentation, cost optimization |
| 6 | Design fairness, quotas, and priority classes for shared GPU clusters | `/analyze-my-resume` | Multi-tenant scheduling policy |
| 7 | Explain how VNet isolation changes the design of managed ML systems | `/analyze-my-resume` | Network topology, private access, control boundaries |
| 8 | Design secure data access from customer storage without copying all data | `/analyze-my-resume` | Identity, storage access, data movement controls |
| 9 | Design checkpointing for large-model training with retry efficiency | `/analyze-my-resume` | Storage strategy, checkpoint cadence, recovery |
| 10 | Design retry handling for distributed jobs across infra and user failures | `/analyze-my-resume` | Failure taxonomy, idempotency, restart rules |
| 11 | Debug low GPU utilization in a distributed training job | `/analyze-my-resume` | Bottleneck analysis, observability, playbooks |
| 12 | Design an evaluation pipeline for fine-tuned models | `/analyze-my-resume` | Metrics, gates, model registration |
| 13 | Design a safe training-to-deployment workflow with rollback | `/analyze-my-resume` | Promotion, validation, rollback controls |
| 14 | Design an AutoML orchestration platform for very high job volume | `/analyze-my-resume` | Queueing, execution model, fleet scale |
| 15 | Design an AutoML job state machine | `/analyze-my-resume` | Lifecycle states, retries, publishing |
| 16 | Design submission, status, cancel, and artifact APIs for an ML job platform | `/analyze-my-resume` | Resource model, idempotency, pagination, errors |
| 17 | Design the low-level job orchestrator components and interfaces | `/analyze-my-resume` | Service boundaries, classes, handlers, persistence |
| 18 | Prevent duplicate execution in a retry-heavy job platform | `/analyze-my-resume` | Idempotency keys, leases, dedupe |
| 19 | Design backpressure and admission control under limited compute capacity | `/analyze-my-resume` | Queueing policy, fairness, customer impact |
| 20 | Choose storage systems and schemas for metadata, logs, metrics, artifacts, and lineage | `/analyze-my-resume` | Data model and operational tradeoffs |
| 21 | Explain how platform abstractions reduced model development time | `/analyze-my-resume` | Product leverage, DX, debuggability |
| 22 | Threat model a multi-tenant ML training platform | `/analyze-my-resume` | Assets, trust boundaries, mitigations |
| 23 | Prevent secrets leakage from jobs, logs, images, and user code | `/analyze-my-resume` | Secret scope, redaction, runtime controls |
| 24 | Design secure CI/CD for ML infra, SDKs, and serving stacks | `/analyze-my-resume` | Supply chain, code scanning, release gates |
| 25 | Explain compliance-driven security versus real security engineering | `/analyze-my-resume` | Tradeoffs, governance, durable fixes |
| 26 | Design a QUIC-based secure protocol for large compute fleets | `/analyze-my-resume` | Identity, transport, resilience, telemetry |
| 27 | Explain certificate rotation, replay protection, and flow control at scale | `/analyze-my-resume` | Protocol hardening and runtime behavior |
| 28 | Design capacity expansion from pilot scale to enterprise GPU fleet scale | `/resume-design-pack` | Phasing, quotas, cost, migration |
| 29 | Generate interviewer cross-questions for an existing design, API, or LLD answer | `/resume-cross-exam` | Skeptical follow-ups and rebuttals |
| 30 | Create a principal engineer answer pack for future company-specific system, API, or LLD questions | `/resume-design-pack` | Reusable design pack structure |

## Expected Output Style

Every full design pack should be principal-engineer level:

- Explicit assumptions and scope boundaries.
- Clear control flow and component responsibilities.
- API contracts, request and response shapes, error semantics, and idempotency rules when applicable.
- LLD coverage for key services, state machines, storage schemas, and component interfaces when applicable.
- Scaling, cost, security, reliability, and observability sections.
- Failure modes, tradeoffs, and alternative designs.
- Cross-questions and short talking points for interview delivery.

## API And LLD Expectations

For applicable questions, the pack should also spell out:

- external APIs and internal service-to-service interfaces
- authn, authz, idempotency, versioning, pagination, and error contracts
- state-machine transitions and command handlers
- persistence schema, indexes, and concurrency controls
- component responsibilities at the service, worker, scheduler, and storage layers
- tradeoffs between a clean HLD answer and the deeper LLD an interviewer may ask next
