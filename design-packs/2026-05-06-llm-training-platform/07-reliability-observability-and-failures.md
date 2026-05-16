# 07 - Reliability, Observability, and Failures

## Failure Taxonomy

| Failure Class | Detection Method | Immediate Action | Recovery Path | Retry? |
|---|---|---|---|---|
| **Node failure** (hardware, OOM kill) | Kubernetes pod eviction event | Terminate all workers in the gang | Restart all workers from last checkpoint | Yes, up to 3 times |
| **CUDA OOM** | Pod exits with signal 9 or CUDA OOM exception in logs | Mark job FAILED with error_code=CUDA_OOM | User must reduce batch size; no auto-retry | No (non-retryable without config change) |
| **NCCL error** (network partition, NIC failure) | NCCL timeout exception in pod stdout | Terminate all workers | Restart from last checkpoint | Yes, up to 3 times |
| **Network partition** (pod loses connectivity mid-step) | TunDRA connection timeout; heartbeat miss | CheckpointManager flushes in-flight state | All workers restart; resume from last checkpoint | Yes |
| **Data corruption** (hash mismatch on checkpoint read) | SHA-256 verify fails in CheckpointManager.restore() | Terminate job | Fall back to previous valid checkpoint; if none, restart from epoch 0 | Yes (with previous checkpoint) |
| **Bad user code** (Python exception in training script) | Pod exits with non-zero code; stack trace in logs | Mark job FAILED with error_code=USER_CODE_ERROR | No auto-retry; user must fix code | No |
| **Scheduler deadlock** (Volcano gang pending indefinitely) | Job in SCHEDULING > 30 min; no pod binding events | Alert oncall; check cluster fragmentation | Preempt low-priority jobs; trigger autoscaler | N/A (infra issue) |
| **Checkpoint write failure** (Blob quota, network timeout) | CheckpointManager.write() raises StorageError | Retry checkpoint write with exponential backoff | If 3 retries fail, alert oncall; training continues but checkpoint window extends | Yes (3 retries for checkpoint write) |
| **Artifact publish failure** | ArtifactPublisher returns error; MLflow unreachable | Retain final checkpoint; retry publish | Replay publish from checkpoint URI; eval harness re-runs | Yes (publish is idempotent) |

---

## Checkpointing Strategy

### What Is Saved

Each checkpoint serializes:
```python
{
    "step": 1200,
    "model_state": model.state_dict(),          # LoRA adapter weights (~100-500MB)
    "optimizer_state": optimizer.state_dict(),   # Adam moments (~2× model size)
    "lr_scheduler_state": scheduler.state_dict(),
    "rng_state": torch.get_rng_state(),          # reproducibility
    "cuda_rng_state": torch.cuda.get_rng_state_all(),
    "dataloader_position": dataloader.current_index,  # resume from exact data position
    "epoch": 2,
    "global_step": 1200,
}
```

For LoRA / QLoRA: checkpoint includes **only adapter weights + optimizer state**, not the full base model. This keeps checkpoint size 100-500MB rather than 40-160GB. Base model is re-loaded from ACR at restart.

### Frequency

| Job type | Checkpoint interval | Rationale |
|---|---|---|
| 7B LoRA (short job, <2h) | Every 100 steps (~10 min) | Short enough to not lose much; checkpoint ~300MB so fast |
| 13B QLoRA (4-8h) | Every 200 steps (~15 min) | Balance between overhead and recovery cost |
| 70B full fine-tune (multi-day) | Every 500 steps (~30 min) | Checkpoint ~2GB; more frequent would dominate I/O |

**Async non-blocking writes:** CheckpointManager writes to a local NVMe scratch directory first, then asynchronously uploads to Azure Blob. Training continues during the upload. This hides the ~30-60s Blob upload latency.

### Incremental Checkpoints

DeepSpeed ZeRO-3 supports incremental checkpointing: only write the optimizer shards that changed since the last checkpoint. Reduces checkpoint write size by ~60-80% for stable training runs.

### Checkpoint GC

```python
def gc(job_id: str, keep_last_n: int = 3):
    checkpoints = list_checkpoints(job_id)  # sorted by step
    to_delete = checkpoints[:-keep_last_n]
    for ckpt in to_delete:
        blob_client.delete_blob(ckpt.uri)
        delete_manifest(job_id, ckpt.step)
```

GC runs after every successful checkpoint write and after job COMPLETED. Keeps last 3 checkpoints. Final artifact checkpoint is **never GC'd** - it's promoted to the artifact store separately.

---

## Retry Logic

### Retry Policy Matrix

| Failure class | Max retries | Backoff | Checkpoint behavior |
|---|---|---|---|
| Node failure | 3 | Immediate (reschedule) | Resume from last checkpoint |
| NCCL error | 3 | 2 min delay (let network stabilize) | Resume from last checkpoint |
| Network partition | 3 | 5 min delay | Resume from last checkpoint |
| Data corruption (checkpoint) | 2 | Immediate | Roll back to previous checkpoint |
| Data corruption (input data) | 0 | - | Fail permanently; alert user |
| Bad user code | 0 | - | Fail permanently; surface stack trace |
| CUDA OOM | 0 | - | Fail permanently; suggest batch size reduction in error message |
| Checkpoint write failure | 3 | Exponential: 30s, 60s, 120s | Training continues; extend checkpoint window |
| Artifact publish failure | 5 | Exponential: 1min, 2min, 4min, 8min, 16min | Idempotent; re-run from final checkpoint URI |

### Gang Scheduling and Partial Failure

When one worker in a gang fails:
1. Volcano detects the failed pod and marks the VCJob as `Failed`.
2. All remaining workers receive a SIGTERM (graceful shutdown signal).
3. Each worker's CheckpointManager detects the shutdown signal and writes an emergency checkpoint if last checkpoint was >5 min ago.
4. Job Service marks the job RETRYING, increments retry_count.
5. A new VCJob is submitted. All workers start and call `CheckpointManager.restore(-1)` to resume from the last valid checkpoint.

> **Assumption:** The platform does not use elastic training (e.g., PyTorch Elastic / torchrun `--max_nodes`) on the current stack. Gang scheduling with full restart is simpler to reason about and avoids partial-gradient correctness issues. Elastic training is a future roadmap item for very large jobs.

---

## Observability Stack

### Metrics by Layer

| Layer | Key Metrics | Alert threshold |
|---|---|---|
| **API tier** | p99 latency, error rate (4xx/5xx), 429 rate, submission rate | p99 > 2s, error rate > 1%, 429 rate > 5% |
| **Job Service** | Job creation rate, state transition latency, Postgres write p99 | State transition p99 > 500ms |
| **Scheduler** | Queue depth (pending jobs), gang scheduling wait time, preemption rate | Pending GPUs > 2× cluster size for >15 min |
| **Cluster** | GPU utilization per node, NCCL bandwidth, node count, free GPU count | GPU util < 20% on running job; free GPUs < 10% for >1h |
| **Training pod** | GPU util per rank, step time, memory pressure (GB used), NCCL all-reduce bandwidth | Step time 3σ above baseline; GPU memory > 95% |
| **Checkpoint** | Write latency p99, write success rate, storage usage per job | Write p99 > 120s; success rate < 99% |
| **Log pipeline** | Fluent Bit buffer size, ingestion lag, Azure Monitor ingestion rate | Lag > 5 min; buffer > 80% full |
| **Artifact publisher** | Publish success rate, eval pass rate, registration latency | Publish success rate < 99%; eval pass rate anomaly |

### Distributed Tracing

Every request carries a correlation ID from API entry through to artifact publish. Spans:

```
[api-gateway] POST /jobs                              0ms-50ms
  [job-service] validate + create job                 50ms-200ms
    [job-validator] quota_check                       50ms-100ms
    [job-validator] dataset_access_check              100ms-200ms
  [scheduler-adapter] enqueue to Volcano              200ms-350ms
  [volcano] gang schedule (async, minutes-hours)      ... (separate trace context)
  [pod-launcher] launch pods                          t+0ms to t+30s
  [training-pod] DeepSpeed training loop              t+30s to t+end
    [checkpoint-manager] write checkpoint             every N steps
    [log-shipper] Fluent Bit flush                    continuous
  [artifact-publisher] eval + register                end+0 to end+300s
```

OpenTelemetry traces collected in DataDog APM and Kusto for long-term analysis. Training-pod spans are sampled at 1% to avoid 50M spans/day from blowing up the trace store.

### Log Structure

Every log line from a training pod must include:

```json
{
  "timestamp": "2026-05-06T12:34:56.789Z",
  "level": "INFO",
  "job_id": "jb-abc123",
  "tenant_id": "t-xyz",
  "pod_name": "jb-abc123-worker-0",
  "rank": 0,
  "world_size": 32,
  "step": 1200,
  "epoch": 2,
  "message": "step=1200 loss=0.412 lr=1.8e-4 gpu_util=92% mem_gb=76.2/80 nccl_bw=185GB/s step_time_ms=420"
}
```

Structured logging enables Kusto queries like:
```kusto
TrainingLogs
| where job_id == "jb-abc123"
| summarize avg(gpu_util), avg(step_time_ms) by bin(timestamp, 5min)
```

### Oncall Dashboard

Primary oncall view (DataDog or Azure Monitor Workbook):

1. **Top widget:** Active jobs count by status (RUNNING / SCHEDULING / RETRYING / FAILED in last 1h)
2. **GPU utilization heatmap:** per-node, last 30 min
3. **Scheduler queue depth:** pending GPUs by tenant
4. **Active alerts:** sorted by severity
5. **Recent failures:** last 20 FAILED jobs with error_code and tenant

---

## Low GPU Utilization Debugging Runbook

When GPU utilization is 30% but the cluster looks healthy:

1. **Check step time variance.** High step time with low GPU util = training loop is waiting for something. If step time is 3-5× normal, the bottleneck is likely I/O or network, not compute.

2. **Check DataLoader throughput.** Query `dmesg` or pod metrics for disk I/O. If CPU is 100% and GPU is waiting, the DataLoader `num_workers` is too low or prefetch buffer is too small.

3. **Check ADLS read latency.** If training data is streamed from ADLS over private endpoint, check Azure Monitor storage metrics for read operation latency. A spike in read latency (>200ms per read) stalls the training loop.

4. **Check NCCL all-reduce bandwidth.** For multi-node jobs, check NCCL log output for "Out-of-order recv" or "Tree/Ring BW < expected". Low NCCL bandwidth (<50% of link speed) = network congestion or misconfigured topology.

5. **Check for GPU memory pressure.** If GPU memory is >95%, the GPU may be swapping or waiting for memory copies. Try reducing batch size or gradient accumulation steps.

6. **Check for gradient sync stalls.** In DeepSpeed ZeRO-3, all-gather and reduce-scatter can stall if any worker is slower than others (straggler effect). Check per-rank step times - if one rank is consistently 2× slower, it may be on a slower node or have a network issue.

7. **Check checkpoint write I/O.** If checkpoints are synchronous and happening frequently, checkpoint write to NVMe or Blob may be blocking the training loop. Check CheckpointManager write latency metrics.

8. **Check for Python GIL contention.** In PyTorch, the GIL can cause stalls if multiple threads compete. Usually a sign of incorrect `num_workers` configuration or blocking transforms in the dataset pipeline.

9. **Check vLLM eval overlap.** If an evaluation job is co-located on the same nodes (scheduling error), it will compete for GPU memory and bandwidth with the training job. Check pod placement.

10. **Check TunDRA connection state.** If TunDRA reports connection resets or retransmits on the checkpoint upload path, the upload is blocking training more than expected. Switch to fully async checkpoint mode if not already enabled.

---

## SLOs

| SLO | Target | Measurement |
|---|---|---|
| Job start time (SUBMITTED → RUNNING) P99 | < 15 minutes | Volcano scheduling latency + pod start time |
| Job completion rate | > 99.5% (excluding user-code errors) | COMPLETED / (COMPLETED + FAILED non-user) |
| Checkpoint write success rate | > 99.9% | CheckpointManager write success / total writes |
| Artifact publish success rate | > 99.5% | Publisher success / total publish attempts |
| Log delivery latency (pod stdout → queryable) | < 5 minutes P99 | Fluent Bit → Azure Monitor ingestion lag |
| API availability | > 99.9% | Job submission API 5xx error rate < 0.1% |
| Eval gate accuracy | N/A (quality SLO, not reliability SLO) | Track BLEU/MMLU regressions per model family |

---

## Incident Response: Cascading Scheduler Failure

**Scenario:** Volcano master crashes, causing all gang scheduling to halt. Running jobs continue (data plane is independent), but no new pods can be scheduled. Scheduler queue builds up.

**Detection:**
- `volcano_queue_pending_jobs` metric shoots up
- No new RUNNING jobs in the last 10 minutes (alert)
- Kubernetes event stream shows no pod binding events

**Containment:**
1. PagerDuty alert fires, oncall joins within 5 minutes.
2. Confirm running jobs are not affected: check active pod count and NCCL bandwidth.
3. Pause new job admissions at the API gateway (circuit breaker flag in config).
4. Investigate Volcano master: check pod logs for crash reason (etcd connectivity, leader election failure, OOM).

**Recovery:**
1. If Volcano pod crashed: Kubernetes restarts it automatically (Deployment). Verify restart within 2 minutes.
2. If etcd is unhealthy: follow etcd recovery runbook (restore from snapshot, check quorum).
3. Once Volcano master is healthy, re-enable job admissions.
4. Queued jobs resume scheduling automatically (Volcano re-evaluates queue on restart).
5. If any running jobs lost workers during the outage: they will checkpoint-retry automatically.

**Post-mortem:**
- Root cause analysis within 48 hours.
- Action items: Volcano HA (active-passive), etcd backup frequency increase, synthetic canary job that detects scheduling stalls within 2 minutes.
