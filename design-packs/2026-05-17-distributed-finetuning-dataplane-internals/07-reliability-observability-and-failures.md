# 07 — Reliability, Observability, and Failures

At **15M+ jobs/month** (`resume.txt` L91-92), even a 0.1% failure rate is 15K
broken runs/month. Reliability inside the data plane is mostly about making
**resumption** cheap and **failure attribution** unambiguous.

## Failure taxonomy

| Class | Symptom | First responder | Recovery |
|---|---|---|---|
| **GPU XID error** | NVML XID 79/13/63 logged; CUDA error context lost | Driver / sidecar | Drain node, restart job on different node |
| **CUDA OOM** | `torch.cuda.OutOfMemoryError` | Trainer | Lower batch / increase ZeRO stage / offload; if user-induced, fail-fast |
| **NCCL timeout** | `ProcessGroupNCCL Watchdog` exception; `WORK_TIMEOUT` | Trainer | One straggler — investigate node health; restart from checkpoint |
| **Node loss** | Pod NotReady > grace | Volcano | Reschedule job from checkpoint |
| **NaN loss** | Loss = NaN, gradients are inf | Trainer | If transient: rewind 1 step (DS supports this); persistent → fail-fast |
| **Dataloader fail** | `RuntimeError` from worker; pid exit | Trainer | Auto-retry with workers=0; if persistent → user-input error |
| **Network straggler** | One rank's all-reduce 10× tail | Trainer + cluster monitor | Reroute; in worst case taint the node |
| **Checkpoint write fail** | `IOError` to blob | Checkpoint manager | Retry with backoff; alternate write to local NVMe first |
| **MLflow tracking unavailable** | HTTP 5xx | MLflow client | Buffer in-pod queue; do not block training |
| **Workload identity token expired** | 401 from blob mid-load | Storage client | Token refresh; retry with new token |
| **Spot eviction** | Kubelet drains pod with 30s notice | Sidecar (preemption handler) | Emergency checkpoint; signal control plane |

## Checkpoint strategy

The economic constraint: **the cost of a checkpoint write must be < cost of
re-training that interval**.

Variables:
- step time: `T_step` (e.g., 30s)
- ckpt every N steps: `T_ckpt_interval = N * T_step`
- ckpt write time: `T_ckpt_write`
- expected job failure interval: `T_mtbf`

Sensible heuristic: pick N so that `T_ckpt_interval ≈ T_mtbf / 10` (expect 10
checkpoints per failure on average) and ensure `T_ckpt_write < 5% * T_ckpt_interval`.

```python
# checkpoint_manager.py
class CheckpointManager:
    def __init__(self, ckpt_dir, every_n_steps, max_keep=3, async_write=True):
        self.dir = ckpt_dir
        self.every = every_n_steps
        self.max_keep = max_keep
        self.async_write = async_write
        self._pending = None    # asyncio task or Future

    def maybe_save(self, model, opt, sched, step):
        if step % self.every != 0: return

        # Wait for previous async write to finish before starting new one;
        # if it's not done, *skip* this checkpoint rather than queuing infinite.
        if self._pending and not self._pending.done():
            log.warning("Previous ckpt still writing; skipping step %d", step)
            return

        path = f"{self.dir}/step-{step}"
        os.makedirs(path, exist_ok=True)
        state = collect_state(model, opt, sched, step)

        if self.async_write:
            self._pending = asyncio.create_task(self._write(state, path))
        else:
            self._write_sync(state, path)
        self._prune()

    async def _write(self, state, path):
        # 1. Write to NVMe scratch first (fast)
        await dcp_save_async(state, f"{path}.scratch")
        # 2. rclone to blob in parallel
        await rclone_to_blob(f"{path}.scratch", f"{path}")
        # 3. Atomic _SUCCESS marker
        await write_marker(f"{path}/_SUCCESS")

    def _prune(self):
        completed = sorted(glob(f"{self.dir}/step-*/_SUCCESS"))
        for old in completed[:-self.max_keep]:
            shutil.rmtree(os.path.dirname(old))
```

Important properties:

1. **`_SUCCESS` written last.** Resume code skips any checkpoint without it.
2. **Async write** — training does not pause. If a checkpoint is still writing
   when the next interval hits, the next one is skipped (don't queue forever).
3. **NVMe staging** — blob writes can be slow and bursty; staging on NVMe
   smooths it out and lets training continue while bytes rsync to blob.
4. **Pruning** — keep last K + special-case the eval-best one.

## Idempotent resume

```python
def resume_or_fresh(cfg):
    successes = sorted(glob(f"{cfg.ckpt_dir}/step-*/_SUCCESS"))
    if not successes:
        return CheckpointState(start_step=0, fresh=True)

    latest_path = os.path.dirname(successes[-1])
    state = load_distributed_checkpoint(latest_path)

    # Verify base-model SHA matches what we're about to train. If the user
    # changed the base model mid-run, we must NOT silently warm-start from
    # a checkpoint of the old base.
    if state["base_model_sha"] != cfg.base_model_sha:
        raise FatalConfigError("base model changed; cannot resume")

    return state
```

The base-model SHA check is the most important guardrail — it catches user
errors that would otherwise corrupt the run silently.

## Observability stack

Two channels, three signals:

```
   per-rank emission                 collectors                durable + queryable
┌────────────────────┐
│ python logger      │ stdout ───►  fluent-bit DaemonSet ─►  Kusto log table (per-tenant)
│                    │                                       (1 hour SLA on tail)
│ OTEL SDK           │ OTLP gRPC ──► OTEL collector sidecar ─► OTEL collector cluster ─► Kusto metrics + traces
│   - traces         │                                       (10 sec SLA)
│   - metrics        │                                       
│   - logs (struct)  │                                       
│                    │                                       
│ MLflow client      │ HTTP ──────► MLflow tracking server ─► artifact store (blob), DB (PG)
│   (rank 0)         │                                       (5 sec SLA on metric)
└────────────────────┘
```

### What gets emitted where

| Signal | Where | Cadence | Use |
|---|---|---|---|
| `loss`, `lr`, `tokens_per_sec` | MLflow + OTEL gauge | Every N steps (e.g., 50) | Run tracking + alerting |
| `gpu_util`, `gpu_mem_used`, `nccl_op_latency_p99` | OTEL metric | Every 10s | Cluster health + debugging |
| Span: `step`, `forward`, `backward`, `optimizer_step` | OTEL trace | Sampled (1%) | Investigation |
| Stdout: framework warnings, NCCL info | logger | Always | Forensics |
| Final artifacts: weights, config, eval | MLflow artifacts | End of run | Registry handoff |

### What does NOT get emitted

- Training data content. **Ever.** No `print(batch)` allowed in driver code; if
  the user code does it, fluent-bit filters known PII patterns (best-effort,
  not security).
- Federated tokens, AAD tokens, MLflow tokens. Filter at the fluent-bit layer
  and at the OTEL exporter.
- Per-step trace at high cadence — OTEL volume explodes. Sample 1% of steps,
  always capture first 10 + last 10 + any step where loss > 2 × median.

## Health sidecar

Optional but very useful at scale. Runs in the same pod, watches:

```python
# sidecar/health.py
while True:
    util = pynvml.nvmlDeviceGetUtilizationRates(handle).gpu
    mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
    xid_errors = read_xid_log()
    last_loss_age = age_of_last_loss_metric()

    # Health rules:
    if last_loss_age > 5 * step_time:
        emit_alarm("step_stall")
    if util < 5 and trainer_running():
        emit_alarm("gpu_idle_while_running")
    if xid_errors:
        emit_alarm("gpu_hw_error", details=xid_errors)
    if mem.used / mem.total > 0.97 and not torch_oom_handled:
        emit_alarm("near_oom")

    push_to_control_plane({...})
    time.sleep(10)
```

The sidecar emits alarms to the control plane's job-health channel; if a job is
truly stuck, the control plane can preempt it instead of letting a wedged trainer
hold expensive GPUs.

## Failure-to-recovery flow (a worked example)

Scenario: **64-GPU 70B FSDP run, one node loses its IB link at step 8K.**

1. `t=0`: Rank 23 (on the dead node) has `nccl_allreduce` start timing out.
2. `t=30s`: NCCL watchdog fires; all 64 ranks raise `ProcessGroupNCCL` exceptions.
   The trainer's `try/except` catches it.
3. `t=30s`: Catcher writes `exit_reason.json` `{ kind: "nccl_timeout", rank: 23 }`,
   triggers emergency checkpoint of in-memory state to NVMe (best-effort,
   may not complete).
4. `t=30s`: All 64 pods exit with status 1.
5. `t=45s`: PyTorchJob controller marks the Job `Failed`, propagates to AutoML
   job state machine.
6. `t=60s`: Control plane decides to retry. New PodGroup submitted, **excluding
   the unhealthy node** (cordoned by NodeProblemDetector after the IB failure).
7. `t=2m`: New pods scheduled. Worker rank 0's resume code finds the last
   `_SUCCESS` at step 8K (the one written 5 minutes before, not the failed
   emergency one).
8. `t=4m`: NCCL rendezvous on the new world, FSDP loads from DCP shards.
9. `t=5m`: Training resumes at step 8K with **identical RNG state, identical
   optimizer state, identical data shard cursor**. Loss curve continues.

Total cost: ~5 minutes of recompute, no data corruption, no manual intervention.

## SLO-style targets the data plane commits to

| SLO | Target | How measured |
|---|---|---|
| Time-to-first-step from pod-ready | < 30 s (small), < 5 min (70B class) | OTEL span `pod_ready → first_loss_emitted` |
| Checkpoint write doesn't stall training | < 2% step-time overhead | `step_time_with_ckpt / step_time_without` |
| Job recovery from any single-node failure | < 10 min, no manual touch | `failure_detected → next_loss_emitted` |
| Metric-to-MLflow lag | p99 < 5 s | client-side timestamp vs server-side ingestion |
| Artifact publish at end of run | < 5 min from final step | OTEL span `final_step → registry_entry_created` |
