# 01 — Executive Summary

## The 60-second version

The fine-tuning data plane is **a pod (or set of pods) that, once gang-scheduled,
becomes a tightly-coupled MPI-style cluster**. Inside that cluster, every GPU runs an
identical Python entrypoint that does five things: (1) **rendezvous** with peers on
NCCL, (2) **shard** the model + optimizer + gradients using a parallelism strategy,
(3) stream training batches through a **forward / backward / optimizer-step** loop,
(4) **checkpoint** at fixed intervals into a coordinated format, and (5) **publish**
the final artifact + metrics into MLflow + the model registry. Logs and metrics are
emitted from rank 0 (and aggregated across ranks for cluster-level numbers) through
OpenTelemetry/MLflow into the org observability backend.

The four major implementations differ on **one axis: who owns the sharding**.

| Framework | What it shards | How sharding happens |
|---|---|---|
| **`torch.distributed` (DDP)** | Nothing — full model on every GPU; only gradients are averaged | All-reduce on backward |
| **PyTorch FSDP** (the native "DFT") | Parameters + grads + optimizer state, sharded inside FSDP-wrapped modules | All-gather pre-forward, reduce-scatter post-backward |
| **DeepSpeed ZeRO-1/2/3** | Optimizer state (Z1), +grads (Z2), +params (Z3); plus offload to CPU/NVMe | Engine intercepts param access via hooks; ZeRO-3 = same theory as FSDP, different bookkeeping |
| **Megatron-LM / DeepSeek-style** | Tensor parallel + Pipeline parallel + Expert parallel (3D / 5D parallelism) | Manual layer rewrite (`ColumnParallelLinear`, etc.) + pipeline schedule |
| **Ray Train** | Nothing on its own — orchestrates DDP/FSDP/DeepSpeed across a Ray cluster | Distributed actor placement + Ray's internal rendezvous; reuses the above under the hood |
| **vLLM** | Inference-only — sharding via Tensor Parallel + PagedAttention KV cache | Not a trainer at all; relevant for post-training eval and serving |

## How DeepSeek differs from the others

DeepSeek V2/V3 training is not a different "framework" so much as **a different
parallelism + precision recipe** built on Megatron-style infra:

- **MLA (Multi-head Latent Attention)** reduces KV cache size 5-10× during training.
- **DeepSeekMoE** with 256+ routed experts uses **Expert Parallelism (EP)** — experts
  are partitioned across GPUs, with all-to-all replacing all-reduce on MoE layers.
- **FP8 training** with a custom transformer-engine fork — gradients in BF16,
  params/activations in FP8, with online scaling.
- **DualPipe** pipeline parallelism that overlaps compute and all-to-all.

DeepSpeed/FSDP/Megatron handle **dense models well**; DeepSeek-class infra is
**MoE-first** and lives in a regime where all-to-all bandwidth, not all-reduce
bandwidth, dominates.

## Where artifacts and logs actually go

```
            GPU pod (rank 0 only writes)             durable + indexed
┌───────────────────────────────────────────┐    ┌──────────────────────┐
│ checkpoint dir (NVMe scratch)             │───►│ checkpoint blob       │
│   pytorch_model.bin / .safetensors        │    │ (versioned, immutable)│
│   optimizer.pt, scheduler.pt, rng.pt      │    └──────────────────────┘
│                                            │    ┌──────────────────────┐
│ MLflow client → mlflow.log_artifact()     │───►│ MLflow tracking server│
│   - run params, metrics                    │    │ + artifact root (blob)│
│   - eval reports (BLEU, MMLU)              │    └──────────────────────┘
│                                            │    ┌──────────────────────┐
│ OTEL exporter → traces + metrics           │───►│ Kusto / Geneva        │
│                                            │    │ (queryable)          │
│ stdout → fluent-bit DaemonSet              │───►│ Kusto log table       │
└────────────────────────────────────────────┘    └──────────────────────┘
                                                   ┌──────────────────────┐
                                                   │ Model Registry        │
                                                   │ (signed manifest +    │
                                                   │  pointer to blob)     │
                                                   └──────────────────────┘
```

The model registry is the **gate** to serving. A successful run writes a versioned
manifest (model URI, hashes, eval scores, training config, base model SHA, training
data lineage). Inference rollout (vLLM behind the serving plane) only honors a
registry version that has passed an eval threshold and a manual approval (for
production tiers).

## Why this matters at Microsoft scale

Per the resume: **20B+ tokens annually**, **15M+ AutoML jobs/month**. At that scale,
the data plane has three operating constraints that drive every design decision:

1. **GPUs are the budget.** Every minute of idle GPU is real money. Gang scheduling
   + warm container images + lazy weight loading exist *because* of this.
2. **Tenants must not see each other.** VNet isolation, workload identity, private
   endpoints, namespace-per-tenant — but also: NCCL traffic lives only on the
   tenant's pods, and checkpoints land only in the tenant's storage.
3. **Jobs fail constantly.** At 15M jobs/month a 0.1% failure rate is 15K failures
   per month; checkpointing + idempotent retry isn't optional, it's the runtime.

The rest of the pack is the long version of those three points.
