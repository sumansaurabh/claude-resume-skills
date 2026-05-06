# Secure LLM Training Platform on Azure + Kubernetes

**Design pack:** `design-packs/2026-05-06-llm-training-platform/`

**Interview question:**
> "You say you scaled secure LLM training across VNet and Kubernetes. Walk me through the end-to-end architecture: user request, job submission, scheduling, data access, training, checkpointing, logs, and artifact publishing."

**Resume anchor:** Microsoft OpenAI / Azure ML, Oct 2020 – Aug 2025. Founding team member of AI Fine-tuning on IPP. 20B+ tokens/year, $100M+ revenue.

---

## File Map

| File | Contents |
|---|---|
| `00-question-and-context.md` | Question scope, assumptions, resume anchors |
| `01-executive-summary.md` | One-paragraph answer + 60-second verbal delivery + strongest anchors |
| `02-architecture.md` | Component map (Mermaid), 11-step request flow, Azure services, IPP layer, TunDRA placement |
| `03-api-and-contracts.md` | REST API, request/response schemas, idempotency, error model, gRPC internal contracts |
| `04-low-level-design.md` | Service decomposition, component interfaces, Kubernetes CRD, Volcano job spec, Job table schema |
| `05-scaling-and-capacity.md` | Throughput model, bottleneck analysis, gang scheduling pressure, GPU quotas, bin-packing, cost controls |
| `06-security-and-isolation.md` | Threat model, STRIDE table, VNet architecture, Managed Identity, secrets management, TunDRA security |
| `07-reliability-observability-and-failures.md` | Failure taxonomy, checkpointing strategy, retry logic, observability stack, GPU debug runbook, SLOs |
| `08-tradeoffs-and-alternatives.md` | Rejected alternatives (Argo, Kueue, NFS, TCP), technical bets, what to redesign |
| `09-cross-questions.md` | 28 skeptical interviewer questions with crisp rebuttals across all topics |
| `10-cheat-sheet.md` | One-page verbal delivery guide, scale numbers, common traps |
| `11-control-plane-vs-data-plane.md` | Precise CP/DP definitions, component table, state flow, failure scenarios, sequence diagram |
| `12-state-machine-and-workflows.md` | Full job state machine (Mermaid), retry workflow, checkpoint-resume, artifact publishing, cancellation |
| `14-leadership-and-business-framing.md` | Business impact story, Principal Engineer behaviors, IPP founding team context, 90-second pitch, interview tips |

---

## Quick Reference: Key Numbers

| Metric | Value |
|---|---|
| Tokens processed (LLM fine-tuning) | 20B+/year |
| Jobs/month (AutoML platform) | 15M+ |
| Revenue contribution | $100M+ |
| TunDRA compute instances | 1M+ |
| Secure transfer improvement | 50% (TCP+TLS → QUIC) |
| Model dev time reduction | 90% |
| Global users | 200K+ |

---

## Architecture in One Diagram

```
User (SDK / AI Studio)
         │ POST /jobs
         ▼
┌─────────────────────────────────┐  CONTROL PLANE
│ API Gateway (Go, Gin)           │
│ Job Service + Validator         │
│ Quota Service                   │
│ Scheduler Adapter               │
│ Pod Launcher (K8s Operator)     │
│ Job state machine (Postgres)    │
└─────────────────────────────────┘
         │ Volcano VCJob CRD
         ▼
┌─────────────────────────────────┐  DATA PLANE
│ Training Pods (AKS, A100 GPUs)  │
│   PyTorch Distributed / FSDP   │
│   DeepSpeed ZeRO-3              │
│   Ray Train (fault tolerance)   │
│   CheckpointManager → Blob     │
│   Fluent Bit → Azure Monitor   │
│   TunDRA (QUIC/Rust)           │
└─────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐  PUBLISH
│ ArtifactPublisher               │
│ Eval Harness (vLLM)             │
│ MLflow Model Registry           │
└─────────────────────────────────┘
```

---

## How to Use This Pack

1. **Warm up:** Read `01-executive-summary.md` — internalize the 60-second answer
2. **Deep prep:** Read `02-architecture.md` and `11-control-plane-vs-data-plane.md` — know the diagram cold
3. **Technical depth:** Read `04-low-level-design.md`, `06-security-and-isolation.md`, `07-reliability-observability-and-failures.md`
4. **Interview pressure:** Work through `09-cross-questions.md` — answer each question aloud before reading the answer
5. **Day-of:** Review `10-cheat-sheet.md` — the one-page guide for interview morning
