# 13 - Data Model and Storage

What lives where, in what format, and how it moves through the data plane. The
user's question explicitly asks how artifacts are published and logs tracked -
this file is the bytes-on-disk view.

## Storage tiers

| Tier | Backing | Purpose | Latency | Cost |
|---|---|---|---|---|
| `gpu-mem` | HBM3 on H100 | Active tensors during forward/backward | ns | $$$$$ |
| `gpu-dram` | DRAM on same node | CPU offload of optimizer (DeepSpeed) | μs | $$$ |
| `node-nvme` | Local NVMe SSD | Checkpoint scratch, dataset cache, NVMe offload | ms | $$ |
| `region-hot-blob` | Premium block blob in same region | Active checkpoint, recent artifacts | tens of ms | $$ |
| `region-cool-blob` | Standard hot/cool blob | Long-term artifacts, registered models | hundreds of ms | $ |
| `archive` | Archive blob | Compliance retention | hours | ¢ |

Movement: each step "down" the tier in case of failure / promotion; each step
"up" in case of read on training-data + base-model paths.

## Data-plane data flow

```
                       node-local
   region-hot-blob ───►  NVMe cache ───►  GPU HBM
   (training data)        (read-through)       │
                                                ▼
                                       trainer process
                                                │
                                                ▼
   region-hot-blob  ◄───  NVMe scratch  ◄── checkpoint write
       (rclone async)        (DCP shards)

   region-hot-blob (MLflow artifact root)  ◄── mlflow.log_artifact (rank 0)
   region-hot-blob (registry index store)  ◄── publishing step
   OTEL collector ─► Kusto (queryable)     ◄── OTEL exporter (all ranks)
   fluent-bit DaemonSet ─► Kusto log table ◄── stdout (all ranks)
```

## Object models

### Training run

```json
{
  "run_id": "run-abc-123",
  "job_id": "job-7-ftn-xyz",
  "tenant_id": "tenant-7",
  "framework": "deepspeed",
  "profile": "large-full",
  "base_model": {
    "name": "llama-3-70b-base",
    "sha": "sha256:..."
  },
  "data": {
    "train_uri": "abfss://tenant-7@.../train.jsonl",
    "train_sha": "sha256:...",
    "n_examples": 124000
  },
  "hyperparams": { "lr": 1e-5, "warmup": 200, "max_steps": 20000, "micro_batch": 4, "grad_accum": 16 },
  "world": { "n_nodes": 8, "gpus_per_node": 8 },
  "started_at": "2026-05-17T08:00:00Z",
  "ended_at": null,
  "status": "RUNNING",
  "metrics_uri": "mlflow://exp-12/run-abc-123",
  "logs_uri": "kusto://...?cluster=...&db=...&runId=run-abc-123",
  "ckpt_root": "abfss://tenant-7@.../job-7-ftn-xyz/",
  "latest_success_step": 12000
}
```

### Checkpoint object

```
abfss://tenant-7@ft.dfs.core.windows.net/job-7-ftn-xyz/step-12000/
├── _SUCCESS              # zero-byte marker; presence == valid ckpt
├── manifest.json         # what's inside, total bytes, sha hashes
├── trainer_state.json    # step, epoch, best_metric, sampler cursor
├── rng_state.pt          # python + numpy + torch + cuda RNG state
├── scheduler.pt          # LR scheduler state
├── optimizer/            # DCP-sharded or DS-sharded optimizer state
│   ├── __0_0.distcp
│   ├── __1_0.distcp
│   └── ...
├── model/                # framework-native or safetensors-sharded
│   ├── model-00001-of-00012.safetensors
│   ├── model-00002-of-00012.safetensors
│   └── model.safetensors.index.json
└── config.json           # model config (HF-compatible)
```

### Model registry entry

```json
{
  "name": "tenant-7/finetuned-llama3-70b",
  "version": 12,
  "uri": "abfss://tenant-7@.../job-7-ftn-xyz/step-final/",
  "format": "safetensors-sharded-v1",
  "shards": [
    {"file": "model-00001-of-00012.safetensors", "sha256": "..."},
    ...
  ],
  "base_model_sha": "sha256:...",
  "training_run_id": "run-abc-123",
  "training_data_sha": "sha256:...",
  "config_uri": ".../config.json",
  "tokenizer_uri": ".../tokenizer.json",
  "evals": {
    "bleu":    {"value": 41.2, "data_uri": "..."},
    "mmlu":    {"value": 0.612, "harness_version": "0.4.1"},
    "redteam": {"verdict": "passed", "report_uri": "..."}
  },
  "signed_by": "trainer-driver-v3.2.1",
  "signature": "...",
  "status": "PENDING_REVIEW",
  "approver": null,
  "approved_at": null,
  "created_at": "2026-05-17T13:42:11Z"
}
```

## Sharding layout: how a 70B model is physically laid out

For FSDP `FULL_SHARD` over 64 GPUs, a transformer layer's `q_proj` weight of
shape `[8192, 8192]` (BF16, 128 MB) is sharded as:

```
rank 0:  q_proj.weight[0:128, :]     # 2 MB
rank 1:  q_proj.weight[128:256, :]   # 2 MB
...
rank 63: q_proj.weight[8064:8192, :] # 2 MB
```

FSDP uses **flat** shards (concatenated, then sliced) for memory efficiency, so
the actual on-GPU buffer is a 1-D view, not a 2-D slice. But the conceptual
mapping is "row-wise partition of full param tensor".

For Megatron Tensor Parallel size 8, the same weight is sharded **column-wise**
on 8 GPUs of one node, and **replicated** across DP groups:

```
TP rank 0 (DP rank 0):  q_proj.weight[:, 0:1024]    # 16 MB
TP rank 1 (DP rank 0):  q_proj.weight[:, 1024:2048] # 16 MB
...
TP rank 7 (DP rank 0):  q_proj.weight[:, 7168:8192] # 16 MB
TP rank 0 (DP rank 1):  same as TP rank 0 (DP 0)    # replicated
```

The two strategies are **not bitwise compatible**. Cross-loading requires
gathering to a full param then re-sharding.

## Checkpoint format conversion

The published artifact is always `safetensors-sharded-v1`. Framework-native
checkpoints are converted at the `FINALIZING → PUBLISHING` transition:

```python
def publish_artifact(ckpt_root, target_root):
    # 1. Gather framework-sharded weights into rank-0-owned full tensors
    with FSDP.summon_full_params(model, writeback=False, rank0_only=True):
        if dist.get_rank() == 0:
            full_state_dict = model.state_dict()
            # 2. Split into shards of <= 5 GB
            shards, index = split_state_dict(full_state_dict, max_shard_gb=5)
            # 3. Write each shard as safetensors
            for shard_name, shard in shards.items():
                save_file(shard, f"{target_root}/{shard_name}")
            # 4. Write the index
            save_json(index, f"{target_root}/model.safetensors.index.json")
            # 5. Copy config + tokenizer + trainer_state
            copy_files([config, tokenizer], target_root)
            # 6. Sign + write SUCCESS
            sign_and_write_manifest(target_root)
```

`summon_full_params` is the FSDP API that all-gathers a sharded tensor to one
rank - the same primitive that runs every forward pass, used in the rare
"snapshot to disk in full form" case. For DeepSpeed: `engine.save_16bit_model()`
does the equivalent.

## Storage cost model

For 70B class:

| Item | Size | Frequency | Annual cost @ Premium Blob |
|---|---|---|---|
| One full checkpoint | ~140 GB BF16 + ~280 GB optimizer + ~140 GB grads ≈ 560 GB | Every N steps (kept: last 3) | ~$650/run |
| Published artifact (safetensors, BF16) | ~140 GB | Once per successful run | ~$220/yr |
| Training data | 10-500 GB typical | Pinned during run, may be released | varies |

The biggest cost lever: prune intermediate checkpoints aggressively. Keeping
the last 3 + the eval-best is usually enough; some platforms only keep the
final one if eval is trustworthy.

## Logs as data

Logs are not just operational - at platform scale they're also the substrate for
debugging tools, retro analytics, and ML on the platform itself.

The Kusto schema (simplified):

```
JobLogs
├── timestamp: datetime
├── tenant_id: string
├── job_id: string
├── run_id: string
├── rank: int
├── level: string  (INFO/WARN/ERROR)
├── message: string
├── span_id: string  (optional, links to OTEL trace)
└── trace_id: string (optional)

JobMetrics
├── timestamp: datetime
├── tenant_id: string
├── job_id: string
├── run_id: string
├── metric_name: string  (e.g. ft.tokens_per_sec)
├── value: real
└── rank: int (optional; null for cluster-aggregated)

JobSpans
├── trace_id, span_id, parent_span_id
├── name (e.g. step.forward)
├── start_time, duration
├── attributes: dynamic  (rank, step, model_layer, ...)
```

Two patterns this enables:

- **Cross-job correlation** (e.g. all jobs that hit a particular NCCL error on a
  particular node) - trivial Kusto query.
- **Self-service triage** in AI Studio: customers can see *their* logs and
  metrics without filing a ticket.

This is the "tracked logs" part of the user's question - concretely, Kusto with
three tables that make logs/metrics/traces joinable via `run_id` + `span_id`.
