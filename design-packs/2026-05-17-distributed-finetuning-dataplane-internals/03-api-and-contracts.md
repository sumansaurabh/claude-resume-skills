# 03 - Internal Contracts of the Data Plane

This file is about the **wire-level contracts inside the data plane**: the env that
the launcher hands the worker, the rendezvous protocol, the NCCL collective ABI, the
checkpoint format, the MLflow/OTEL contracts, and the model-registry handoff. These
are the boundaries that anything in `04-low-level-design.md` plugs into.

## 1. Launcher → Worker environment contract

Every worker process is started with this minimum environment, regardless of which
framework is wrapping the model:

| Variable | Set by | Purpose |
|---|---|---|
| `RANK` | torchrun / deepspeed / Ray | Global rank (0..WORLD_SIZE-1) |
| `LOCAL_RANK` | launcher | GPU index on this node |
| `WORLD_SIZE` | launcher | Total processes |
| `LOCAL_WORLD_SIZE` | launcher | Processes on this node (=#GPUs) |
| `MASTER_ADDR` | launcher (from PodGroup) | Rank-0 pod hostname |
| `MASTER_PORT` | launcher | Rendezvous TCP port (default 29500) |
| `NCCL_SOCKET_IFNAME` | platform | Pin NCCL to the IB interface (e.g. `ib0`) |
| `NCCL_IB_HCA` | platform | InfiniBand HCA list |
| `NCCL_DEBUG` | platform | `INFO` for debug runs, `WARN` for prod |
| `TORCH_DISTRIBUTED_DEBUG` | platform | `DETAIL` while debugging stalls |
| `MLFLOW_TRACKING_URI` | platform | Tenant-scoped tracking server |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | platform | Local OTEL collector sidecar |
| `AZURE_CLIENT_ID` / federated token path | Workload identity | Tenant-scoped Azure AD identity |

This contract is **framework-agnostic on purpose**. The same image can be launched
by `torchrun`, `deepspeed`, or Ray Train - only the launcher binary differs.

## 2. Rendezvous protocol

PyTorch supports several rendezvous backends. In production at scale the choices
narrow to:

### 2a. C10d static (default for `torchrun --rdzv-backend=c10d`)

Rank 0 runs a `TCPStore` on `MASTER_ADDR:MASTER_PORT`. Other ranks `connect()` and
do a `barrier()`. Simple, fast, no external dependency. **Fragile** if rank 0
crashes during init - the whole rendezvous dies. Sufficient when gang scheduling
guarantees all replicas come up together.

### 2b. etcd-v2 (`--rdzv-backend=etcd-v2`)

Useful for elastic / fault-tolerant training where ranks can come and go. Adds
an etcd dependency, which is heavier than it sounds because etcd then needs its
own HA story. In a gang-scheduled world, this is overkill.

### 2c. Ray rendezvous (Ray Train only)

Ray's GCS (Global Control Store) acts as the rendezvous. Ray Train builds the
NCCL process group on top, so the contract above (`RANK`, `WORLD_SIZE` etc.) is
*also* what Ray Train hands you inside the user fn - that's why a DeepSpeed or
FSDP wrapper works unchanged under Ray.

### Code: framework-agnostic init

```python
import os
import torch.distributed as dist

def init_dist():
    dist.init_process_group(
        backend="nccl",
        init_method="env://",          # consumes MASTER_ADDR/MASTER_PORT/RANK/WORLD_SIZE
        timeout=datetime.timedelta(minutes=30),  # MUST be long enough for slow data loads
    )
    torch.cuda.set_device(int(os.environ["LOCAL_RANK"]))
```

The 30-minute init timeout is not paranoia - at 70B+ params, weight loading from
remote storage can take 5-10 minutes per node and the slowest rank gates the
barrier.

## 3. NCCL collectives - what actually moves on the wire

| Collective | Used by | Bytes on wire | When |
|---|---|---|---|
| `all_reduce` | DDP, gradient sync in DeepSpeed Z1 | 2 × params (ring) | After backward |
| `reduce_scatter` | FSDP, ZeRO-2/3 | params / N | After backward |
| `all_gather` | FSDP (pre-forward), ZeRO-3 | params / N | Before forward (per layer) |
| `broadcast` | Initial weight load on rank 0 → others (if not loading per-rank) | params | Once at start |
| `all_to_all` | Tensor parallel, MoE Expert Parallel (DeepSeek) | varies | Per MoE / TP layer |
| `barrier` | Checkpoint coordination | trivial | Around ckpt write |

The latency tail of any of these is the **slowest rank**. If one node's IB link is
saturated, every NCCL op stalls. Observability has to expose **per-collective
duration per rank**, not just averages.

## 4. Checkpoint format contract

Different frameworks write different shapes. To stay portable, we standardize the
**published artifact** on **Safetensors + sharded** with an `index.json`:

```
checkpoints/run-abc/step-10000/
├── config.json
├── tokenizer.json
├── model.safetensors.index.json      # {"weight_map": {"model.layers.0.q_proj.weight": "model-00001-of-00012.safetensors", ...}}
├── model-00001-of-00012.safetensors
├── model-00002-of-00012.safetensors
├── ...
├── optimizer.pt                       # per-rank or sharded (DCP), depends on framework
├── scheduler.pt
├── rng_state.pt
├── trainer_state.json                 # {global_step, epoch, best_metric, ...}
└── _SUCCESS                           # written last; readers gate on this
```

`_SUCCESS` is the **atomicity contract**. Readers (resume, eval, registry) must not
read a checkpoint without this file. Without it, a half-written checkpoint after
a crash becomes a silent corruption.

Framework-native intermediate formats (DeepSpeed ZeRO shards, DCP sharded
checkpoints) are kept for **fast resume** but converted to the Safetensors form
above when **publishing**.

## 5. MLflow contract

```python
# Rank 0 only:
with mlflow.start_run(run_name=cfg.run_name) as run:
    mlflow.log_params(cfg.flatten())
    mlflow.set_tags({
        "framework": "deepspeed",
        "base_model_sha": cfg.base_model_sha,
        "training_data_uri": cfg.data_uri,    # for lineage
        "tenant_id": cfg.tenant_id,
    })
    # during training:
    mlflow.log_metric("loss", loss, step=step)
    mlflow.log_metric("tokens_per_sec", tps, step=step)
    # at end:
    mlflow.log_artifacts("checkpoints/run-abc/step-final", artifact_path="model")
    mlflow.transformers.log_model(...)  # optional: structured model log
```

Non-rank-0 processes **do not** call MLflow. This is critical: if every rank logs,
you get N duplicate runs and your tracking server falls over at 15M+ jobs.

## 6. OTEL contract

```python
tracer = trace.get_tracer("ft.worker")

with tracer.start_as_current_span("step", attributes={"step": step, "rank": rank}):
    with tracer.start_as_current_span("forward"):
        out = model(batch)
        loss = out.loss
    with tracer.start_as_current_span("backward"):
        loss.backward()
    with tracer.start_as_current_span("optimizer_step"):
        optimizer.step()
```

Metrics shipped on a periodic timer (not per-step - too noisy):

| Metric | Type | Notes |
|---|---|---|
| `ft.step.tokens` | counter | summed across ranks via Prometheus aggregation in collector |
| `ft.gpu.util` | gauge | from `pynvml` or DCGM exporter |
| `ft.gpu.mem` | gauge | reserved + allocated |
| `ft.nccl.allreduce.duration` | histogram | tagged by op name |
| `ft.dataloader.wait_ms` | histogram | catches data-bound runs |
| `ft.loss` | gauge | rank 0 only, replaces MLflow at higher cadence |

The dataloader-wait histogram is the single most useful debugging metric - if it's
non-zero, you're not training, you're waiting on I/O.

## 7. Model registry handoff

The registry is the **only** sanctioned path to inference. The contract:

```json
{
  "name": "tenant-7-gpt-4o-finetune-2026-05-17",
  "version": 12,
  "uri": "abfss://tenant-7@ft.dfs.core.windows.net/runs/abc/step-final/",
  "format": "safetensors-sharded-v1",
  "base_model_sha": "sha256:...",
  "training_data_uri": "abfss://tenant-7@.../train.jsonl",
  "training_data_sha": "sha256:...",
  "config_uri": "...config.json",
  "evals": {
    "bleu": 41.2,
    "mmlu": 0.612,
    "custom_redteam": "passed"
  },
  "approver": null,
  "approver_signature": null,
  "status": "PENDING_REVIEW"
}
```

A registry entry is **immutable** once published. Rolling back a deploy means
pointing the serving plane at a previous registry version, not editing the row.

## 8. Failure-mode contracts

Three contracts that the rest of the platform depends on:

1. **Idempotency**: re-running a job with the same `(tenant_id, run_id)` resumes
   from the latest `_SUCCESS` checkpoint, never starts from scratch silently.
2. **Crash visibility**: the trainer writes a final `exit_reason.json` to the
   checkpoint dir on any caught exception (OOM, NCCL fail, NaN loss). The
   sidecar uploads it even if the trainer process is dead.
3. **No leak across tenants**: a worker pod can only mount its tenant's storage
   (via workload identity scoped to that tenant's container), can only log to
   its tenant's MLflow namespace, and can only write to its tenant's registry.
   These are not soft conventions - they are enforced by the token, not by code.
