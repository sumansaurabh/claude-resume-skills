# 08 — Tradeoffs and Alternatives

The user's question explicitly asks how DeepSpeed, FSDP/PyTorch Distributed, Ray
Train, vLLM, and DeepSeek-style infra differ. This file is the **decision matrix**.

## The fundamental tradeoff axis

There is one axis that explains 90% of the framework choice:

> **How much of the parallelism complexity do you want in your model code vs your config?**

```
  more in model code  ───────────────────────────────────►  more in config / framework
  Megatron / DeepSeek ────  Megatron-Core ────  FSDP ────  DeepSpeed ────  Ray Train
  (manual TP/PP layers)                       (auto wrap)   (JSON config)   (orchestration)
```

The further left you go, the more flexible — you can do MoE, FP8, custom pipeline
schedules. The further right, the easier — you can start a 70B fine-tune in 50
lines of Python.

## Decision matrix

| Question | Use this |
|---|---|
| Model < 7B, simple SFT | DDP or single-node FSDP |
| 7B-13B, want fastest setup | FSDP with `transformer_auto_wrap_policy` |
| 70B class, want simple config | DeepSpeed ZeRO-3 + optional CPU offload |
| 70B class, want best memory efficiency | FSDP with selective AC + flash-attn |
| Beyond what fits on one node even sharded | DeepSpeed Z3 + NVMe offload OR Megatron TP+PP |
| MoE model (Mixtral, DeepSeek) | Megatron-Core with EP, OR DeepSpeed-MoE |
| FP8 training | Transformer Engine + (Megatron OR FSDP-MP) |
| Want hyperparameter sweep on top | Ray Tune wrapping Ray Train wrapping FSDP/DS |
| Want best fault tolerance for spot instances | Ray Train + frequent checkpointing |
| Need lowest inference latency | vLLM (not a training option) |

## Detailed comparison: DeepSpeed vs FSDP vs Megatron

The three are often presented as alternatives but they're not exactly: FSDP
is in-tree PyTorch, DeepSpeed is a Microsoft-originated library, Megatron-Core
is NVIDIA-originated. Picking between FSDP and DeepSpeed is **mostly a developer
ergonomics decision today**; picking Megatron is a **model-size and parallelism
decision**.

| Dimension | DeepSpeed | FSDP | Megatron-LM / Core |
|---|---|---|---|
| Origin | Microsoft Research | PyTorch (Meta) | NVIDIA |
| ZeRO-3 sharding | ✓ | ✓ (FSDP1, FSDP2) | ✓ (via distributed optimizer) |
| CPU offload of optimizer | ✓ (mature) | ✓ (via `CPUOffload`) | ✓ |
| NVMe offload (ZeRO-Infinity) | ✓ | ✗ | ✗ |
| Tensor parallel | ✓ (limited, via DeepSpeed Inference) | ✗ (use device mesh + `parallelize_module` in DTensor) | ✓ (first-class) |
| Pipeline parallel | ✓ (`PipelineModule`) | ✗ | ✓ (best-in-class) |
| Sequence parallel | partial | ✗ (via DTensor) | ✓ |
| MoE | ✓ | ✗ | ✓ (via Megatron-Core MoE) |
| FP8 | partial | ✗ | ✓ (with TE) |
| Config style | JSON | Python | Python + parallel-groups |
| Maturity for 70B SFT | Excellent | Excellent | Overkill |
| Maturity for 100B+ pretraining | Good | Catching up via DTensor | Gold standard |
| Bus factor / community | Reduced velocity post-2024 | Active (in-tree) | Active (NVIDIA invested) |

### Code-volume comparison for "fine-tune Llama-3-70B"

| Framework | Lines of user code | Lines of config |
|---|---|---|
| DDP | not feasible at 70B | n/a |
| FSDP | ~30 | inline kwargs |
| DeepSpeed Z3 | ~10 | ~50 lines JSON |
| Megatron-Core | ~200 | parallel-group setup |
| Ray Train + FSDP | ~40 | ScalingConfig |

The DeepSpeed line count is shortest, but **the design decisions just moved into
the JSON** — that JSON is the system, not boilerplate.

## DeepSeek vs everything else

DeepSeek (V2, V3) is the published instance of "what large MoE training infra
looks like in 2024-2026". It is built on Megatron-style 3D parallelism with
specific additions:

| Innovation | Why it matters | Cost |
|---|---|---|
| **MLA attention** | 5-10× smaller KV cache → larger batch fits in memory | New attention class; pretraining-time integration |
| **Many small experts + aux-loss-free routing** | Better quality/compute tradeoff than 8-expert MoEs | Routing instability without careful tuning |
| **FP8 training** | ~2× throughput vs BF16 | Numerical stability work; per-block scaling |
| **DualPipe pipeline schedule** | Overlaps all-to-all with compute, lowers MoE bubble | Custom scheduler; not in mainline DeepSpeed/Megatron |
| **No GPUDirect-Storage dependency** | Trains on commodity Ethernet+IB rather than NVMe-DPU | Larger reliance on host-side staging |

**Why this matters for the question:** DeepSeek-style training and DeepSpeed-style
training **are not in the same product category**. DeepSpeed/FSDP/Ray Train are
general-purpose training infra; DeepSeek's stack is a **research codebase that
became production** for *a specific class* of MoE models. A fine-tuning platform
that hosts customer workloads uses DeepSpeed/FSDP. A platform that *trains* its
own frontier MoE model from scratch (DeepSeek, GPT-4-class) builds something
DeepSeek-shaped.

## vLLM vs the training frameworks

vLLM doesn't fit on the same axis at all. It's an **inference engine**, not a
trainer. Including it in the comparison is a category mistake unless we're
careful about what's actually being asked:

| Aspect | Trainer (DS/FSDP/Megatron) | vLLM |
|---|---|---|
| Forward pass | yes | yes |
| Backward pass | yes | **no** (no autograd) |
| Optimizer step | yes | n/a |
| Goal | minimize loss | minimize TTFT + maximize tok/s |
| Memory layout | params + grads + opt state | params (frozen) + KV cache (active) |
| Parallelism | DP + TP + PP + EP + SP | TP only (PP rare in inference) |
| KV cache mgmt | n/a (recomputed each step) | **PagedAttention** — central feature |
| Continuous batching | n/a | central feature |
| Where it shows up in the fine-tuning data plane | n/a | post-training eval + serving the registered model |

**Why the resume mentions vLLM in the same line as DeepSpeed:** because the
fine-tuning platform offers an end-to-end loop — train (DeepSpeed/FSDP), eval
(vLLM), publish (MLflow), serve (vLLM). The trainer and the inference engine
are co-resident in the data plane spec, hence both appear in the tech list.

## Ray Train vs the rest

Ray Train is **not** at the same layer as DeepSpeed. It is at the **layer above**.
The decision tree:

```
do you need:
  hyperparameter sweep?           → Ray Tune (which uses Ray Train)
  heterogeneous cluster orchestration? → Ray Train
  spot instance fault tolerance? → Ray Train (better than raw torchrun)
  ML pipeline including data + serve? → Ray ecosystem
  none of the above              → torchrun is simpler and faster to set up
```

Ray Train's distinctive value is **orchestration glue**, not sharding. Inside the
worker function, you're still calling FSDP or DeepSpeed.

## What we actually picked (and why) on the Microsoft platform

Anchored to `resume.txt` L100-101 (DeepSpeed, PyTorch, vLLM, Ray Train, MLflow):
the platform offered profiles, not a single choice. The defaults:

| Customer ask | Profile | Why |
|---|---|---|
| "I want to LoRA a 7B model" | PEFT + DDP / single-node FSDP | Fast setup, low cost |
| "I want to full fine-tune 13B" | FSDP, BF16, 1-2 nodes | Sweet spot for the size |
| "I want to fine-tune 70B" | DeepSpeed ZeRO-3 (+ optional offload) on 4-8 nodes | Mature, well-tested at this size |
| "I want to do experiment-sweeping over a 13B" | Ray Tune + Ray Train wrapping FSDP | One scheduler, many runs |
| "I want to evaluate the model with my custom suite" | vLLM eval sidecar | High throughput on the eval set |

The platform did **not** offer a Megatron/DeepSeek-style profile to external
customers — that level of complexity is reserved for internal teams training
frontier models. Customers got the abstractions; the gnarly knobs stayed
internal.

## Rejected alternatives

| Option | Why rejected |
|---|---|
| HuggingFace Accelerate alone | Good for prototyping; not enough control over scheduler, comm, checkpoint at platform scale |
| Slurm-only orchestration | Doesn't fit Microsoft's Kubernetes-first infra mandate; would require parallel ops |
| Custom NCCL-replacement | NCCL has the ecosystem; building our own is years of work for marginal gain. Better to wrap (TunDRA) than replace |
| Single mega-image with all frameworks | Image size ~80GB, pull time terrible. Profile-specific images solve this |
| Per-tenant Kubernetes cluster | Compelling for isolation but operational cost N× engineering org. We achieved isolation with VNet + workload identity + NetworkPolicy instead |
