# 00 - Question, Scope, Anchors

## Verbatim question

> tell me the architecture of distributed finetuning system. i understand how the job
> goes to distributed finetuning system or the data-plane. but what is the architecture
> of dataplane itself where models are getting loaded and finetuned. show me low level
> code as well using all DFT + DeepSpeed + vLLM. I want to understand what is the
> difference in the code configuration and how each of them solves the problem
> differently. How deepseek is solving the distributed fine tuning then Ray-Train or
> VLLM or distributed pytorch. What is the difference in architecture? Understand how
> artifacts get published and logs are getting tracked. But how training works, this is
> the architecture I am looking for.

## What the interviewer is really asking

The question is **scoped past the scheduler**. It assumes the control plane is solved
(job lands on a pod, GPUs are gang-scheduled, network policy is in place) and asks
what happens *inside* the data plane:

1. How does the worker container come up and discover its peers?
2. How is the model **sharded** across GPUs and nodes?
3. How do gradients/optimizer state move (NCCL all-reduce, all-gather, reduce-scatter)?
4. What's actually in the Python code, and how does the **config** differ between
   FSDP, DeepSpeed, Ray Train, vLLM, and a Megatron/DeepSeek-style stack?
5. How are checkpoints written and **artifacts published** (MLflow)?
6. How are **logs/metrics/traces** shipped while the cluster is GPU-busy?

`DFT` in the question is read as "distributed fine-tuning" generically. The PyTorch-
native expression of that is **FSDP (Fully Sharded Data Parallel)** / `torch.distributed`.

## Scope

| In scope | Out of scope |
|---|---|
| Worker-process internals on a GPU pod | Job submission API, quota, billing |
| Model sharding strategies (ZeRO-3, FSDP, TP, PP, EP) | UX of AI Studio / SDK |
| NCCL collectives and rendezvous | DNS/VNet topology details |
| Checkpoint formats and artifact registry | Org-wide compliance program |
| Log/metric/trace shipping under GPU pressure | Inference autoscaling (only inference engine internals) |
| Decision matrix: FSDP vs DeepSpeed vs Ray Train vs Megatron-style | Inference benchmarking |

## Working assumptions

These are stated explicitly so I can defend or relax them under pushback:

1. The training pod has **8×H100 80GB** per node (Azure ND H100 v5 class). Multi-node
   uses **NVLink + NVSwitch intra-node, InfiniBand HDR/NDR inter-node**.
2. The container image is built by the platform and includes a pinned PyTorch +
   DeepSpeed + Transformers + bitsandbytes + vLLM stack. User code is mounted, not
   the runtime.
3. Storage: customer training data lives in Azure Blob Storage / ADLS Gen2 reachable
   through a **private endpoint**; checkpoints land on a fast tier (Premium Blob or
   NVMe-backed staging) and are promoted to durable storage; artifacts publish to
   MLflow.
4. Workload identity uses **Azure AD Workload Identity for AKS**; no static creds
   in the pod. Pulls from Blob and ACR are token-mediated.
5. The platform uses **Volcano** (or KubeFlow MPIJob/PyTorchJob) for **gang
   scheduling** - all replicas start atomically or none start.
6. Observability stack is **OpenTelemetry → Kusto/Geneva** for traces/metrics and
   **MLflow** for runs/artifacts. Logs go through stdout → fluent-bit → Kusto.

## Resume anchors used

| Anchor | Source |
|---|---|
| Founding member of **AI Fine-tuning on IPP**, scaling secure LLM training across **VNet and Kubernetes**, **vLLM**, **20B+ tokens annually** | `resume.txt` L73-74 |
| Tech stack explicitly includes **DeepSpeed, PyTorch, vLLM, Ray Train, QLoRA, PEFT, Quantization, MLflow** | `resume.txt` L100-101 |
| **Gang scheduling and bin-packing** GPU work | `resume.txt` L88-89 |
| Founded fine-tuning data plane with vLLM in production | `microsoft-experience.md` #3, #6 |
| **Secure multi-tenant ML** on Kubernetes/Azure | `microsoft-experience.md` #7 |
| 15M+ AutoML jobs/month, 200K+ users (proves scale of orchestration side) | `resume.txt` L91-92 |

## Confidence

**High** on the runtime patterns (DeepSpeed/FSDP/vLLM/Ray Train) - these are public
APIs and the resume names all of them. **Medium-high** on the specific IPP wiring
(MLflow, Kusto, Volcano) - I'm using public-Azure-equivalent designs rather than
claiming Microsoft-internal implementation details. Anything I cannot back from the
resume is labeled as an assumption.

## What "good" looks like for this answer

- A reader can draw the data-plane diagram from memory after reading it.
- The interviewer can ask "what changes if we go from FSDP to ZeRO-3" and get a
  code-level answer, not a hand-wave.
- The artifact and log paths are concrete (file formats, where bytes land, when
  they're flushed) - not "we use MLflow."
- Tradeoffs land with conviction: "we used DeepSpeed because X, here's where we'd
  pick FSDP/Megatron instead."
