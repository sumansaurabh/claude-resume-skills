# 00 - Question and Context

## Original Question

> "You say you scaled secure LLM training across VNet and Kubernetes. Walk me through the end-to-end architecture: user request, job submission, scheduling, data access, training, checkpointing, logs, and artifact publishing."

---

## Scope

This is a **10/10 principal-engineer system design question** drawn directly from the resume. It tests:

- End-to-end distributed systems thinking (not just training code knowledge)
- Control plane vs. data plane reasoning
- Multi-tenant security at cloud scale
- Job orchestration and scheduling depth
- Observability and failure handling
- Leadership and business framing

---

## Assumptions

The following details are not publicly documented; they are stated as design choices grounded in resume evidence:

1. **IPP = Internal Private Preview**: a staging tier where enterprise customers ran LLM fine-tuning before general availability. This was a dedicated AKS cluster with per-tenant VNet peering.
2. **Job control plane was a custom service** (not raw Argo or Kubeflow) built on top of Kubernetes CRDs and the Volcano gang scheduler. Azure ML's own job orchestration layer was used or extended.
3. **Training data stayed in customer storage** (ADLS Gen2 or Blob) accessed via Managed Identity delegation - no bulk copy to Microsoft-owned storage.
4. **TunDRA (QUIC/Rust) was used for compute-to-compute and compute-to-storage communication**, not for gradient sync (NCCL handles that on the data plane).
5. **Checkpoints went to Azure Blob** via private endpoint; MLflow was the model registry for artifact metadata.
6. **Volcano** was used for gang scheduling; namespace-level quotas enforced per-tenant GPU budgets.
7. **vLLM** was used in the evaluation phase (not the training phase itself) - paged attention and high-throughput token generation for eval harnesses.

---

## Resume Anchors Used

| Claim | Source |
|---|---|
| Founding team member of AI Fine-tuning on IPP | Microsoft experience bullet 1 |
| Scaled secure LLM training across VNet and Kubernetes | Microsoft experience bullet 1 |
| vLLM, 20B+ tokens/year, $100M+ revenue | Microsoft experience bullet 1 |
| GPU scheduling: gang scheduling, bin-packing | Microsoft experience bullet 2 |
| Cost-aware resource allocation, isolation strategies | Microsoft experience bullet 2 |
| AutoML: 15M+ jobs/month, 200K+ users, 90% dev time reduction | Microsoft experience bullet 3 |
| TunDRA: QUIC/Rust, 1M+ Compute Instances, 50% transfer improvement | Microsoft experience bullet 6 |
| Threat modeling, CodeQL, GitHub Advanced Security | Microsoft experience bullets 4–5 |
| Technologies: PyTorch Distributed, DeepSpeed, vLLM, Ray Train, QLoRA, PEFT, MLflow, Volcano | Resume skills section |

---

## Classification

**System design** with significant **API design**, **LLD**, **security architecture**, and **reliability engineering** depth required.

Pack covers all required dimensions: architecture, API contracts, low-level design, scaling, security, reliability, tradeoffs, cross-questions, and cheat sheet.
