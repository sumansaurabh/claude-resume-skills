# 05 - Scaling and Capacity

The fine-tuning data plane has three different scaling regimes; getting them
confused is the most common source of bad capacity decisions.

## The three regimes

| Regime | Bottleneck | Knob |
|---|---|---|
| **GPU-bound** | tensor cores saturate; `gpu_util ≈ 100%`, MFU > 40% | model size, dtype, kernels |
| **Comm-bound** | NCCL all-reduce / all-gather dominates step time | parallelism layout, IB topology, bucket size |
| **I/O-bound** | dataloader waits visible in OTEL | data sharding, prefetch, format (parquet vs jsonl), storage tier |

You diagnose which regime you're in by looking at the per-step breakdown in OTEL
spans: `forward + backward / step_total` for GPU-bound, `nccl_op / step_total` for
comm-bound, `dataloader_wait_ms / step_total` for I/O-bound.

## Token-throughput math (the back-of-envelope every Principal interview wants)

Per-step compute for a transformer is approximately:

```
FLOPs/step ≈ 6 * P * tokens_in_step
```

where P = active params, factor 6 covers forward (2) + backward (4) for dense
attention. On an H100 in BF16, peak ≈ 1979 TFLOPS; achievable for well-tuned
training is ~50-60% MFU = ~1000 TFLOPS sustained.

For a 70B dense model at batch 1024 × seq 4096 = 4.2M tokens/step:

```
FLOPs/step = 6 * 70e9 * 4.2e6 ≈ 1.76e18
On 64 H100s @ 1000 TFLOPS each:  step_time = 1.76e18 / (64 * 1e15) ≈ 27.5 s
tokens/sec = 4.2e6 / 27.5 ≈ 153K tokens/sec
```

The resume claims **20B+ tokens annually** for the fine-tuning platform
(`resume.txt` L74). At 153K tok/s, that's 130K seconds = 36 hours of *one* big
job to burn the year's quota. In reality, the year is spread across thousands of
smaller jobs (mostly LoRA + medium-full), which is why most platform engineering
goes into **scheduling small jobs efficiently**, not into one heroic 64-GPU run.

## Memory math (the other thing they always ask)

For a model with P params trained with AdamW in mixed precision:

| Component | Bytes per param | Notes |
|---|---|---|
| FP32 master weights (DeepSpeed/Megatron) | 4 | Some frameworks skip - keep BF16 master |
| BF16 weights (compute copy) | 2 | |
| BF16 grads | 2 | |
| FP32 Adam m, v | 8 | Two states |
| Activations | variable | Function of seq, hidden, layers, batch; dominated by attention |

Without sharding: ~16 P bytes minimum. For 70B that's 1.12 TB. An 8×80GB H100 has
640 GB. So **70B cannot fit even on a full DGX without sharding** - this is why
FSDP/ZeRO is non-optional past ~7B.

With FSDP / ZeRO-3 over N GPUs: each holds ~16P/N bytes of state + activations
+ comm buffers. The practical ceiling per GPU is ~60 GB usable; activations
typically take 10-30 GB depending on seq len and grad-checkpoint config.

**Quick sanity check**: 70B / FSDP / 64 H100s → 17.5 GB params/grad/opt + activations
+ buffers comfortably under 60 GB. Confirmed plausible.

## Communication math

NCCL all-reduce time on a ring topology:

```
T_allreduce ≈ 2 * (N-1) / N * M / B
```

M = message bytes, B = per-link bandwidth, N = ranks. NVLink intra-node ~900 GB/s
bidirectional, IB NDR ~50 GB/s. So inter-node is ~18× slower than intra-node -
which is why **topology-aware NCCL trees and TP staying intra-node** are the
critical layout choices.

For 70B grads in BF16 (140 GB) on 64 GPUs:

```
T_allreduce ≈ 2 * 63/64 * 140 GB / 50 GB/s ≈ 5.5 s  (worst-case ring across IB)
```

That's the per-step lower bound on communication. If `step_time = 27.5s` from
above, all-reduce is ~20% of step - viable. Tools that lower this:

- **Gradient bucketing** (DDP / FSDP) - coalesce small grads into 25-50 MB buckets
  to amortize NCCL overhead.
- **Hierarchical reduce** - intra-node reduce on NVLink, then inter-node reduce
  on IB; NCCL does this automatically with `NCCL_ALGO=Tree`.
- **Overlap with compute** - backward pre-fetch (FSDP `BackwardPrefetch.BACKWARD_PRE`)
  hides comm behind compute.

## Bottlenecks taxonomy

| Bottleneck | Symptom in OTEL | Fix |
|---|---|---|
| Slowest rank (network straggler) | `nccl_op` latency tail > 5× median on rank X | Topology check, GPU/IB health probes, taint/evict node |
| Dataloader stall | `dataloader_wait_ms` > 0 consistently | Prefetch factor, num_workers, parquet over jsonl, blob caching |
| Small batch + small model | low MFU, low gpu_util | Increase batch, grad accumulation, fuse kernels |
| Optimizer step latency | `optimizer_step` ms increasing with step | Possibly NaN-recovery or unfused optimizer; switch to FusedAdam / 8-bit |
| KV cache OOM (eval/inference) | vLLM scheduler swap rate spikes | Reduce `max_num_batched_tokens`, prefix caching |
| Checkpoint stall | training pauses every N steps for 30+ sec | Async checkpoint (DeepSpeed `nvme_offload_checkpoint`, async DCP) |

## Quotas and capacity at platform scale

Anchored to the platform numbers: **15M+ jobs/month**, **20B+ tokens annually**
(`resume.txt` L74, L91-92).

15M jobs/month ≈ 5.8 jobs/second steady-state. The data plane doesn't process
these directly - the control plane queues them - but the data plane has to be
able to *start* a job within seconds, which forces:

- **Pre-pulled container images** on every GPU node (DaemonSet warmer).
- **Pre-staged base models** on a node-local cache (read-through cache backed by
  blob).
- **Pod startup time < 30s**: PyTorchJob controllers + Volcano queues prepared
  pods that are ready to grab the next user payload.

GPU quota is multi-dimensional:

| Dimension | Why |
|---|---|
| GPU-hours per tenant per month | Cost control |
| Concurrent GPU count | Fairness - prevent a single tenant from grabbing the cluster |
| Max nodes per job | Reliability - bigger jobs fail more |
| Network bandwidth per tenant | Prevent noisy-neighbor saturating IB |

## Scaling failure modes (what breaks first)

1. **MLflow tracking server** is usually the first thing to fall over at high
   job count. Sharded by tenant; rank 0 only writes; metric cadence is gated
   (every N steps, not every step).
2. **Image registry** (ACR) - pulling a 20GB image 8 times per node simultaneously
   on a cold cluster will saturate ACR throttles. Solved by P2P pull (Dragonfly /
   spegel) or pre-pulled images.
3. **Blob throughput on training data** - at 64 GPUs reading 4MB/s each, that's
   only ~250 MB/s; well within blob limits per account, but if you're sharing
   one storage account across tenants, you hit account-level throttles fast.
   Per-tenant accounts solve this.
4. **NCCL connection limits** - `NCCL_BUFFSIZE` and number of comms scale; at
   very large worlds (>1024 GPUs) NCCL initialization itself can take minutes.
5. **Checkpoint write throughput** - coordinated writes from 64 ranks each
   pushing GB-sized shards to blob. Async writes + tiered storage (write to NVMe
   first, then rclone to blob in background) is necessary.

## Growth plan

| Phase | World size | Strategy |
|---|---|---|
| Single tenant, single job | 1-8 GPUs | DDP / FSDP, single node |
| Tenant scale-up | 8-64 GPUs | FSDP/DeepSpeed ZeRO-3 with offload |
| Org scale-up | 64-512 GPUs | DeepSpeed + pipeline OR Megatron TP+PP |
| Frontier | 1K-16K GPUs | Megatron-Core 3D parallel + MoE (DeepSeek-class) |

Each phase change requires re-tuning the **comm/compute ratio**, not just adding
boxes. A 70B run that achieves 50% MFU on 64 GPUs typically drops to 30% MFU
naively scaled to 512 GPUs - the fix is enabling TP and re-doing topology placement,
not throwing more hardware.
