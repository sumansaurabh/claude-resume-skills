# 10 - Interview Cheat Sheet

Compressed talking points for a 30-45 minute principal interview that lands on
this topic. Memorize the diagram, the one-sentence-per-framework table, and the
"if asked X say Y" cards.

## The opening 90 seconds

> "The data plane starts the moment a job is gang-scheduled. From that point on,
> a fixed contract runs in every worker process: NCCL rendezvous, shard the
> model, train loop with periodic checkpointing, publish artifact to MLflow and
> the model registry. The frameworks - DDP, FSDP, DeepSpeed, Ray Train, Megatron
> - differ only in **how the model is sharded** and **where the configuration
> lives**. vLLM is not in this comparison - it's the inference engine that runs
> alongside for eval and serving."

Draw three boxes: **Launcher → Rendezvous → NCCL** on one line; underneath, the
**five-step worker** (init dist, load model, wrap, train loop, publish). Off to
the side: **MLflow, OTEL, Registry**.

## The "one sentence per framework" table (memorize)

| Framework | One-liner |
|---|---|
| **DDP** | Full model on every GPU; only gradients all-reduced. Baseline. |
| **FSDP** | PyTorch's native ZeRO-3: shards params + grads + opt state inside wrapped modules. |
| **DeepSpeed Z3** | Same idea as FSDP but with NVMe offload and JSON config; mature for 70B class. |
| **Megatron / DeepSeek** | Manual TP + PP + EP - required when one layer's weights exceed one GPU. |
| **Ray Train** | Orchestration layer above the others; doesn't shard models itself. |
| **vLLM** | Inference engine with PagedAttention + continuous batching; not a trainer. |

## Memory math card

- Per-param cost without sharding: ~**16 bytes** (BF16 params 2 + grads 2 + Adam m,v in FP32 = 12).
- For 70B: ~**1.1 TB** total state. **Does not fit** on any single node → sharding is non-optional.
- With FSDP / ZeRO-3 on N GPUs: ~**16P/N** bytes per GPU.

## Communication card

- DDP: `all_reduce(grads)` per bucket.
- FSDP: `all_gather(params)` per layer pre-forward; `reduce_scatter(grads)` post-backward.
- DeepSpeed Z3: same as FSDP, different bookkeeping.
- Megatron TP: `all_reduce` per `RowParallelLinear` (intra-layer, hot path).
- MoE (DeepSeek): `all_to_all` per MoE layer. **Different bottleneck regime.**

## The DeepSeek angle (memorize for the specific question)

> "DeepSeek is not a new framework - it's a Megatron-style 3D-parallel codebase
> with four additions that matter: MLA attention (5-10× smaller KV cache), many
> small experts with aux-loss-free routing, FP8 training with online scaling, and
> DualPipe to overlap MoE all-to-all with compute. The fundamental shift is from
> all-reduce-bound (dense) to all-to-all-bound (MoE)."

## Artifacts and logs (memorize the diagram)

```
rank 0 only → MLflow client → MLflow tracking server + artifact root (blob)
all ranks   → OTEL SDK → OTEL collector → Kusto (traces/metrics)
all ranks   → stdout → fluent-bit → Kusto (logs)
checkpoint  → NVMe scratch → async rclone → durable blob → _SUCCESS marker
end of run  → signed manifest → Model Registry (gated by eval thresholds)
```

The four important facts:
1. `_SUCCESS` is written last; readers gate on it.
2. Only rank 0 writes to MLflow.
3. Checkpoints stage on NVMe to avoid colliding with NCCL.
4. Registry entry is immutable + signed + eval-gated.

## "If asked X, say Y" cards

| If asked | Say |
|---|---|
| "Why DeepSpeed at all today?" | NVMe offload, mature MoE, mature pipeline, JSON config is easier to expose through an SDK. |
| "FSDP vs ZeRO-3" | Same theory, different engineering surface. Pick FSDP for upstream PyTorch alignment; DeepSpeed if you need offload or MoE. |
| "Why gang scheduling?" | NCCL needs all ranks to start atomically. Partial scheduling is a deadlock. |
| "30% MFU, where to look?" | Dataloader wait first, then slowest-rank NCCL, then optimizer step, then activation memory. |
| "Spot instances?" | Ray Train + aggressive checkpointing; emergency-checkpoint hook on preemption signal. |
| "vLLM in fine-tuning?" | Eval sidecar + post-training serving - not a trainer. |
| "DeepSeek vs DeepSpeed?" | DeepSeek-class infra is MoE-first and all-to-all-bound; DeepSpeed/FSDP is dense-first and all-reduce-bound. Different problem regime. |
| "How does Microsoft scale this?" | Profile system (tiny-lora, medium-full, large-full, frontier) - same SDK surface, different stack per profile. |

## Resume anchors to drop into conversation

- "I was a founding member of AI Fine-tuning on IPP" → use as opener.
- "We processed 20B+ tokens annually" → scale credibility.
- "15M+ AutoML jobs/month, 200K+ users" → orchestration scale.
- "Gang scheduling and bin-packing on Kubernetes" → infra credibility.
- "Co-developed TunDRA QUIC protocol, 1M+ compute instances" → infrastructure depth.

## Things to AVOID saying

- "We used DeepSpeed because it's better" - it's not better generally; it's better in specific regimes.
- "vLLM does training" - category error.
- "DeepSeek built their own framework" - they built on Megatron, added MLA/MoE/FP8 recipes.
- "All-reduce is the only NCCL op that matters" - FSDP and ZeRO-3 are `all_gather` + `reduce_scatter`, not `all_reduce`.
- "MLflow goes down → training stops" - MLflow is tracking, not training.

## Last 90 seconds

> "If I rebuilt this today: standardize on FSDP2 + DTensor for the dense case,
> keep DeepSpeed for the offload-heavy and MoE cases, formalize the Safetensors
> sharded checkpoint as the cross-framework contract so every framework adapts
> to it. Keep MLflow for tracking, keep the registry as the only path to serving.
> Bake more of the data-plane health into a standardized sidecar so failure
> detection isn't framework-specific. That last one is the highest-leverage
> infrastructure investment at this scale."
