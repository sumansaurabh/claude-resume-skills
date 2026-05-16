# 04 — Low-Level Design: code, configs, and what differs

This file is the answer to the **code-level part of the question**. Each section
trains the same model (Llama-3-style, 7-70B class) on the same data, but expresses
the parallelism with a different framework. Then we contrast: what's in user code,
what's in config, and **what NCCL collective gets called for a single optimizer
step**.

> Notation: shapes are written as `[batch, seq, hidden]`. Hidden = H, ranks = N,
> tensor-parallel size = TP, data-parallel size = DP, pipeline-parallel = PP.

## 0. The shared training entrypoint

The platform ships a single image with **one entrypoint** that branches on
`cfg.framework`. This is what made it possible (in the IPP fine-tuning world) to
keep `DeepSpeed`, `vLLM`, `Ray Train` and friends on the same runtime contract.

```python
# trainer/main.py
import argparse, os, json
import torch
import torch.distributed as dist
from .frameworks import (
    train_with_ddp,
    train_with_fsdp,
    train_with_deepspeed,
    train_with_megatron_like,   # DeepSeek-style
    train_with_ray,
)

FRAMEWORKS = {
    "ddp":        train_with_ddp,
    "fsdp":       train_with_fsdp,
    "deepspeed":  train_with_deepspeed,
    "megatron":   train_with_megatron_like,
    "ray":        train_with_ray,    # Ray Train wraps one of the above
}

def main():
    cfg = load_config(os.environ["FT_CONFIG_PATH"])
    setup_observability(cfg)         # OTEL + MLflow (rank 0)
    FRAMEWORKS[cfg.framework](cfg)
    if dist.is_initialized():
        dist.barrier()
        dist.destroy_process_group()
```

## 1. PyTorch native: `DistributedDataParallel` (DDP)

**Sharding:** none. Every GPU holds the full model. Only gradients are averaged.

**When you'd use it:** small models (<7B), classic fine-tuning, simplest possible
runtime. Almost never the right choice for modern LLM fine-tuning, but it's the
**baseline** every other framework collapses to in the limit.

```python
# frameworks/ddp.py
import torch, torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel as DDP

def train_with_ddp(cfg):
    dist.init_process_group("nccl", init_method="env://")
    local_rank = int(os.environ["LOCAL_RANK"])
    torch.cuda.set_device(local_rank)

    model = build_model(cfg).cuda()              # FULL model on every GPU
    model = DDP(model, device_ids=[local_rank])  # wraps autograd backward hook

    opt = torch.optim.AdamW(model.parameters(), lr=cfg.lr)
    loader = build_loader(cfg, distributed=True) # DistributedSampler

    for step, batch in enumerate(loader):
        out = model(**batch)
        out.loss.backward()         # NCCL all_reduce on every gradient bucket
        opt.step()
        opt.zero_grad(set_to_none=True)
        if step % cfg.ckpt_every == 0 and dist.get_rank() == 0:
            torch.save(model.module.state_dict(), f"ckpt-{step}.pt")
```

**Per step on the wire:**
- 1 × `all_reduce` per gradient bucket (~25MB default), overlapped with backward.
- Memory: `2P + 16P` bytes (P = params): params + grads in BF16 = 4P, AdamW
  optimizer state in FP32 = 12P. **Same on every GPU.**

## 2. PyTorch native: FSDP (the "DFT" in the question)

**Sharding:** parameters + grads + optimizer state, sharded across DP ranks. FSDP
is PyTorch's native version of ZeRO-3. This is what's behind `torch.distributed`
sharded training today.

```python
# frameworks/fsdp.py
import functools
import torch, torch.distributed as dist
from torch.distributed.fsdp import (
    FullyShardedDataParallel as FSDP,
    MixedPrecision,
    BackwardPrefetch,
    ShardingStrategy,
    CPUOffload,
)
from torch.distributed.fsdp.wrap import transformer_auto_wrap_policy
from transformers.models.llama.modeling_llama import LlamaDecoderLayer

def train_with_fsdp(cfg):
    dist.init_process_group("nccl", init_method="env://")
    torch.cuda.set_device(int(os.environ["LOCAL_RANK"]))

    # Build on meta device, materialize sharded — avoids OOM during load.
    with torch.device("meta"):
        model = build_model(cfg)
    apply_meta_to_real_init(model)

    wrap_policy = functools.partial(
        transformer_auto_wrap_policy,
        transformer_layer_cls={LlamaDecoderLayer},
    )

    model = FSDP(
        model,
        auto_wrap_policy=wrap_policy,
        sharding_strategy=ShardingStrategy.FULL_SHARD,    # ZeRO-3 equivalent
        mixed_precision=MixedPrecision(
            param_dtype=torch.bfloat16,
            reduce_dtype=torch.bfloat16,
            buffer_dtype=torch.bfloat16,
        ),
        backward_prefetch=BackwardPrefetch.BACKWARD_PRE,   # overlap all_gather w/ compute
        cpu_offload=CPUOffload(offload_params=False),
        limit_all_gathers=True,
        use_orig_params=True,                              # required for torch.compile, PEFT
        device_id=torch.cuda.current_device(),
    )

    opt = torch.optim.AdamW(model.parameters(), lr=cfg.lr, fused=True)
    loader = build_loader(cfg, distributed=True)

    for step, batch in enumerate(loader):
        out = model(**batch)
        out.loss.backward()         # all_gather on fwd, reduce_scatter on bwd
        opt.step()
        opt.zero_grad(set_to_none=True)

        if step % cfg.ckpt_every == 0:
            save_fsdp_sharded(model, opt, step, cfg.ckpt_dir)

def save_fsdp_sharded(model, opt, step, ckpt_dir):
    # Distributed Checkpoint (DCP) — sharded, parallel writes, scales O(1) in N.
    import torch.distributed.checkpoint as dcp
    state = {"model": model.state_dict(), "optim": FSDP.optim_state_dict(model, opt)}
    dcp.save(state, checkpoint_id=f"{ckpt_dir}/step-{step}")
```

**Per step on the wire:**
- For each FSDP unit (one transformer layer in this wrap policy):
  - **Forward**: `all_gather(params)` → compute → free params
  - **Backward**: `all_gather(params)` → compute grads → `reduce_scatter(grads)`
- Memory: `(2P + 16P) / N` per GPU (in the ideal case, ignoring activations).
- This is why FSDP+H100 can fit 70B in BF16 across 8 GPUs (~140GB / 8 = ~18GB
  params + grads + opt sharded, plus activations).

## 3. DeepSpeed (ZeRO-1/2/3 + offload + pipeline)

DeepSpeed is similar in theory to FSDP for ZeRO-3, but the **engine model** is
different: instead of wrapping modules and inserting hooks, DeepSpeed replaces the
optimizer and intercepts param access via its own `DeepSpeedEngine`. The big
practical wins are (a) **CPU/NVMe offload**, (b) **ZeRO-Infinity** for ridiculous
model sizes, and (c) **stable, well-tuned pipeline + ZeRO combinations**.

### 3a. The DeepSpeed config (this is where most of the design lives)

```json
// ds_config.json
{
  "train_batch_size": 1024,
  "train_micro_batch_size_per_gpu": 4,
  "gradient_accumulation_steps": 16,
  "bf16": { "enabled": true },
  "gradient_clipping": 1.0,

  "zero_optimization": {
    "stage": 3,
    "offload_optimizer": { "device": "cpu", "pin_memory": true },
    "offload_param":     { "device": "none" },
    "overlap_comm": true,
    "contiguous_gradients": true,
    "reduce_bucket_size": 5e8,
    "stage3_prefetch_bucket_size": 5e8,
    "stage3_param_persistence_threshold": 1e6,
    "stage3_max_live_parameters": 1e9,
    "stage3_max_reuse_distance": 1e9,
    "stage3_gather_16bit_weights_on_model_save": true
  },

  "activation_checkpointing": {
    "partition_activations": true,
    "cpu_checkpointing": false,
    "contiguous_memory_optimization": true
  },

  "optimizer": {
    "type": "AdamW",
    "params": { "lr": 1e-5, "betas": [0.9, 0.95], "weight_decay": 0.1 }
  },

  "scheduler": {
    "type": "WarmupDecayLR",
    "params": { "warmup_num_steps": 200, "total_num_steps": 20000, "warmup_min_lr": 0, "warmup_max_lr": 1e-5 }
  },

  "tensorboard": { "enabled": false },
  "wall_clock_breakdown": false
}
```

### 3b. The Python is short — almost all design is in the config

```python
# frameworks/deepspeed.py
import deepspeed, torch

def train_with_deepspeed(cfg):
    model = build_model(cfg)        # no .cuda() — DeepSpeed places it
    engine, optimizer, _, scheduler = deepspeed.initialize(
        model=model,
        model_parameters=model.parameters(),
        config=cfg.deepspeed_config_path,
    )
    loader = build_loader(cfg, distributed=True,
                          batch_size=engine.train_micro_batch_size_per_gpu())

    for step, batch in enumerate(loader):
        batch = {k: v.to(engine.local_rank) for k, v in batch.items()}
        out = engine(**batch)
        engine.backward(out.loss)         # ZeRO-3 sharded backward + grad reduce
        engine.step()                     # optimizer step on sharded shards

        if engine.global_steps % cfg.ckpt_every == 0:
            # ZeRO-aware save: writes rank-local shards + a coordinated index.
            engine.save_checkpoint(cfg.ckpt_dir, tag=f"step-{engine.global_steps}")
```

### 3c. Key differences from FSDP at the wire level

| Aspect | FSDP | DeepSpeed ZeRO-3 |
|---|---|---|
| Forward all-gather granularity | Per FSDP unit (auto_wrap_policy) | Per **bucket** of params (`stage3_prefetch_bucket_size`) |
| Offload | CPU offload of params is awkward | **First-class CPU + NVMe offload** |
| Pipeline + ZeRO | Manual | Built-in `PipelineModule` + ZeRO-1 combo |
| Checkpoint | DCP sharded | ZeRO sharded; can be consolidated to a single FP16/BF16 file at save time |
| Config surface | Python wrapper args | JSON file (`ds_config.json`) |
| MoE | No native support | Native MoE via `deepspeed.moe` |

### 3d. ZeRO stage cheat sheet

| Stage | What is sharded | Memory factor (vs DDP) | NCCL pattern |
|---|---|---|---|
| 0 | Nothing — same as DDP | 1× | all_reduce grads |
| 1 | Optimizer state | ~4× saving (AdamW) | all_reduce grads, sharded optimizer step |
| 2 | + Gradients | ~8× | reduce_scatter grads |
| 3 | + Parameters | ~N× (ideal) | all_gather params + reduce_scatter grads |

## 4. Megatron-LM / DeepSeek-style 3D parallelism

ZeRO/FSDP scale **data parallelism** intelligently. They do not scale **a single
layer**. Once one transformer layer's weights don't fit on one GPU, you need
**tensor parallel (TP)** and **pipeline parallel (PP)**. Once you have MoE, you
also need **expert parallel (EP)**. This is the Megatron-LM / NVIDIA NeMo /
DeepSeek regime.

### 4a. The parallelism axes (the actual "5D" picture)

```
World = DP × TP × PP × EP × SP (sequence parallel)
        |
        |--- DP: same logical model, different data shards    (ZeRO/FSDP plug in here)
        |--- TP: a single linear is split column/row-wise across GPUs (intra-node)
        |--- PP: layers 0..k on group A, k..2k on group B, ...
        |--- EP: in MoE, different experts on different GPUs
        |--- SP: sequence axis split for MLP (memory savings on long contexts)
```

For a 70B dense model on 64 H100s: `DP=8, TP=8, PP=1` is typical. For DeepSeek-V3
(671B total, 37B active per token): `DP=large, TP=1, PP=16, EP=64` is more like
it (rough public-shape numbers).

### 4b. Tensor Parallel inside a layer

```python
# Megatron-style ColumnParallelLinear (simplified)
class ColumnParallelLinear(torch.nn.Module):
    def __init__(self, in_features, out_features, tp_group):
        super().__init__()
        self.tp_group = tp_group
        tp_size = dist.get_world_size(tp_group)
        assert out_features % tp_size == 0
        self.out_per_rank = out_features // tp_size
        self.weight = torch.nn.Parameter(
            torch.empty(self.out_per_rank, in_features, device="cuda", dtype=torch.bfloat16)
        )
    def forward(self, x):
        # x: [b, s, in_features] — replicated across TP group
        local_out = x @ self.weight.t()                       # [b, s, out_per_rank]
        # ColumnParallel keeps output sharded; the next op (RowParallel) does all_reduce
        return local_out

class RowParallelLinear(torch.nn.Module):
    def __init__(self, in_features, out_features, tp_group):
        super().__init__()
        self.tp_group = tp_group
        tp_size = dist.get_world_size(tp_group)
        assert in_features % tp_size == 0
        self.in_per_rank = in_features // tp_size
        self.weight = torch.nn.Parameter(
            torch.empty(out_features, self.in_per_rank, device="cuda", dtype=torch.bfloat16)
        )
    def forward(self, x):
        # x: [b, s, in_per_rank] — sharded along last axis
        local = x @ self.weight.t()                           # [b, s, out_features]
        dist.all_reduce(local, group=self.tp_group)           # the TP all-reduce
        return local
```

A transformer block becomes:

```
LayerNorm  → ColumnParallelLinear(QKV)  →  attn  →  RowParallelLinear(O)  →  +residual
          → ColumnParallelLinear(FC1)   →  GeLU  →  RowParallelLinear(FC2) →  +residual
```

The **all-reduce inside `RowParallelLinear` is the TP cost** — it's on the
critical path of every forward and every backward.

### 4c. Pipeline Parallel — interleaved 1F1B schedule

```python
# Pseudocode for the 1F1B (one-forward-one-backward) schedule used by Megatron + DeepSpeed
def pipeline_step(stages, micro_batches):
    # Warmup: each stage gets enough fwd in flight to fill the pipe
    in_flight = []
    for mb in micro_batches[:num_warmup]:
        send_to_next(stages.forward(mb))
        in_flight.append(mb)

    # Steady: do 1 bwd for each fwd
    for mb in micro_batches[num_warmup:]:
        send_to_next(stages.forward(mb))
        stages.backward(in_flight.pop(0))    # recv grad from next stage, run backward, send grad to prev

    # Cooldown: drain the pipe
    for mb in in_flight:
        stages.backward(mb)
```

**Bubble** = idle GPU time at warmup/cooldown. Bubble fraction ≈ `(PP-1)/M` where
M is microbatch count. This is why you crank up the microbatch count for PP runs.

### 4d. DeepSeek's specific contributions (vs vanilla Megatron)

DeepSeek-V3 is built on top of Megatron-style infra but adds:

1. **MLA (Multi-head Latent Attention)** — projects Q/K/V through a low-rank
   bottleneck. Cuts KV cache 5-10×. Code is essentially a new Attention class
   with an extra down-proj + up-proj.
2. **DeepSeekMoE** — many small experts (256) + a few "shared experts". Routing
   uses an auxiliary-loss-free strategy (a bias term, no aux loss). Code:

   ```python
   class DeepSeekMoE(torch.nn.Module):
       def __init__(self, hidden, n_routed=256, n_shared=1, n_active=8, ep_group=None):
           ...
           self.experts = torch.nn.ModuleList([Expert(hidden) for _ in range(n_routed // ep_size)])
           self.shared = Expert(hidden)
           self.gate = torch.nn.Linear(hidden, n_routed, bias=False)
           self.bias = torch.nn.Parameter(torch.zeros(n_routed))   # aux-loss-free balancing
       def forward(self, x):
           # x: [b*s, hidden]
           scores = self.gate(x) + self.bias                       # bias adjusts routing pressure
           top_idx = scores.topk(self.n_active).indices            # [b*s, n_active]
           # all-to-all: send tokens to the rank that owns their expert
           x_dispatched = all_to_all_dispatch(x, top_idx, self.ep_group)
           y_local = [self.experts[i](x_dispatched[i]) for i in range(len(self.experts))]
           # all-to-all back
           y = all_to_all_combine(y_local, top_idx, self.ep_group)
           return y + self.shared(x)
   ```

3. **FP8 training** with online scale tracking (DeepSeek-V3 paper §3): forward
   activations in FP8 e4m3, gradients in FP8 e5m2, weights master copy in BF16,
   per-block scaling factors. Implemented in a fork of Transformer Engine.
4. **DualPipe** — pipeline schedule that overlaps compute with the all-to-all
   from the MoE layers. The key innovation is that during the bubble of one
   microbatch you run the all-to-all comm of another microbatch.

The key shift: vanilla DeepSpeed/FSDP minimizes **all-reduce** time; DeepSeek-class
infra minimizes **all-to-all** time, because MoE training is bottlenecked there.

### 4e. Minimal Megatron config (NeMo / Megatron-LM)

```python
from megatron.core.parallel_state import initialize_model_parallel

def train_with_megatron_like(cfg):
    dist.init_process_group("nccl", init_method="env://")
    initialize_model_parallel(
        tensor_model_parallel_size=cfg.tp,
        pipeline_model_parallel_size=cfg.pp,
        expert_model_parallel_size=cfg.ep,    # NeMo/MCore
    )

    model = build_model_with_tp_pp(cfg)       # Layers built with ColumnParallel/RowParallel
    optimizer = build_distributed_optimizer(model, cfg)   # ZeRO-1 on top of TP/PP

    for step, batch in enumerate(loader):
        loss = pipeline_train_step(model, optimizer, batch, schedule="1F1B")
        if step % cfg.ckpt_every == 0:
            save_distributed_checkpoint(model, optimizer, step)
```

## 5. Ray Train — orchestration around the above

Ray Train **is not a sharding library**. It's a job manager that places PyTorch
processes on Ray actors and hands them the env they need. Inside the worker, you
still use DDP, FSDP, or DeepSpeed.

```python
# frameworks/ray.py
from ray.train.torch import TorchTrainer, TorchConfig
from ray.train import ScalingConfig, RunConfig, Checkpoint, CheckpointConfig

def train_fn_per_worker(config):
    # This function is what Ray Train executes on every worker process.
    # RANK, WORLD_SIZE, MASTER_ADDR are populated by Ray Train.
    if config["framework"] == "fsdp":
        train_with_fsdp(config)
    elif config["framework"] == "deepspeed":
        train_with_deepspeed(config)
    else:
        train_with_ddp(config)

def train_with_ray(cfg):
    trainer = TorchTrainer(
        train_loop_per_worker=train_fn_per_worker,
        train_loop_config=cfg.as_dict(),
        scaling_config=ScalingConfig(
            num_workers=cfg.world_size,      # number of GPU workers
            use_gpu=True,
            resources_per_worker={"GPU": 1, "CPU": 8},
            placement_strategy="PACK",
        ),
        torch_config=TorchConfig(backend="nccl"),
        run_config=RunConfig(
            storage_path=cfg.ray_storage_path,
            checkpoint_config=CheckpointConfig(
                num_to_keep=3,
                checkpoint_score_attribute="eval_loss",
                checkpoint_score_order="min",
            ),
        ),
    )
    trainer.fit()
```

**What Ray Train adds on top of `torchrun`:**

1. **Heterogeneous clusters** — easy to mix GPU/CPU actors, autoscaling,
   spot instances.
2. **Fault tolerance** — built-in checkpoint replay, worker replacement (if you
   use ray's checkpoint API and your code is idempotent).
3. **Hyperparameter tuning** — `ray.tune` wraps `TorchTrainer` for sweeps.
4. **Pipeline beyond training** — Ray Data for distributed dataloading, Ray Serve
   for inference, in the same cluster.

**What Ray Train does *not* add:** any new sharding scheme. The model still
ends up in FSDP/DeepSpeed/Megatron.

## 6. vLLM — what role does it play here?

vLLM is **not a training framework**. It is included in the resume's tech list
(`resume.txt` L100-101) because the fine-tuning platform uses it for:

1. **Mid-training evaluation** — load the latest checkpoint into a vLLM engine on
   a sidecar pod, generate completions on an eval set, score with BLEU/MMLU/eval
   harnesses, and log back to MLflow.
2. **Post-training serving** — once a fine-tuned model is registered, the serving
   plane spins up vLLM replicas behind a routing layer.

vLLM's secret sauce, which you should be able to talk about in the same breath
as DeepSpeed:

```python
# Inference-side: vLLM internals worth knowing
# 1. PagedAttention: KV cache stored in fixed-size *blocks* (e.g., 16 tokens each),
#    addressed by a block table. Allows non-contiguous virtual storage of K/V
#    for the same sequence and prefix sharing across requests.
# 2. Continuous batching: scheduler interleaves prefill and decode tokens from
#    different requests in the same forward pass, eliminating padding waste.
# 3. Tensor parallel: same Megatron-style TP for >70B models.

from vllm import LLM, SamplingParams
llm = LLM(
    model="abfss://tenant-7@.../runs/abc/step-final",
    tensor_parallel_size=4,           # TP across 4 GPUs
    gpu_memory_utilization=0.92,
    max_num_batched_tokens=8192,
    enable_prefix_caching=True,
)
out = llm.generate(eval_prompts, SamplingParams(temperature=0, max_tokens=512))
```

A few things to know:

- **vLLM has no autograd path.** It cannot train; trying to is a category error.
- **vLLM's TP shards are not bit-compatible with FSDP/DeepSpeed shards.** You
  convert: gather to a full checkpoint, then vLLM re-shards on load.
- **KV cache pressure is the inference equivalent of optimizer state pressure
  during training.** Same memory math (and same OOM symptoms).

## 7. Side-by-side: what changes per framework

For training a Llama-3 70B on 8 nodes × 8×H100:

| Concern | DDP | FSDP | DeepSpeed Z3 | Megatron / DeepSeek |
|---|---|---|---|---|
| Per-GPU mem (params + grad + opt) | 1× — won't fit | 1/64× — fits | 1/64× — fits, can also offload | Sharded by TP × PP |
| User code | DDP wrap, 5 lines | FSDP wrap + policy, 15 lines | `deepspeed.initialize` + JSON config | Rewrite layer classes |
| Config style | Python args | Python args | JSON | Python + Megatron parallel groups |
| MoE support | No | No | Yes (`deepspeed.moe`) | Yes, first-class |
| Pipeline support | No | No | Yes (`PipelineModule`) | Yes, gold standard (1F1B, interleaved, DualPipe) |
| Checkpoint format | `state_dict` | DCP sharded | DS sharded; gather on save | Megatron sharded |
| 70B fits on 1 node (8×80GB)? | No (140GB params alone) | Yes BF16 | Yes BF16 (+CPU offload makes 70B viable on smaller GPUs) | Overkill — not the use case |
| 671B (DeepSeek-V3) feasible? | No | Awkward | Yes with EP + offload | Yes — this is its native regime |
| Communication pattern | all_reduce only | all_gather + reduce_scatter (per FSDP unit) | all_gather + reduce_scatter (per bucket) | TP: all_reduce per layer; MoE: all_to_all; PP: send/recv |

## 8. Why the platform offered all of them

Tying back to **resume.txt L100-101** (DeepSpeed, PyTorch, vLLM, Ray Train, QLoRA,
PEFT, MLflow): the platform did not pick one — it offered **profiles**:

| Profile | Stack | Use case |
|---|---|---|
| `tiny-lora` | PEFT + DDP, single node | Customers fine-tuning < 13B with LoRA |
| `qlora-7b` | bitsandbytes 4-bit + DDP/FSDP | Cheap path: 7B QLoRA on 1× A100 |
| `medium-full` | FSDP, BF16, 1-4 nodes | Up to ~13B full fine-tune |
| `large-full` | DeepSpeed Z3 + offload, 4-16 nodes | 70B class |
| `frontier` | Megatron-Core + EP, 32+ nodes | Only available to internal teams |
| `eval-and-serve` | vLLM | Always, on the side |
| `ray-controlled` | Ray Train wraps any of the above | When using ray.tune sweeps |

This is what made the **founding work on AI Fine-tuning on IPP** scalable in
practice: the same `JobSpec` could land on any of these profiles based on model
size + budget + tenant tier, with the same observability, checkpoint, and artifact
contracts wrapping all of them.
