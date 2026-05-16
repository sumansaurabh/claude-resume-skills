# 09 - Cross-Questions (Interviewer Pushback)

Compact list of likely follow-ups, with short, defensible answers.

## On the framework choice

**Q1: If FSDP does ZeRO-3 natively now, why does DeepSpeed still exist?**

DeepSpeed still has three differentiators: NVMe offload (ZeRO-Infinity), mature
MoE support, and built-in pipeline parallel. For pure ZeRO-3 SFT, FSDP is now
fine; for offload-heavy, MoE, or pipeline jobs, DeepSpeed is still the cleaner
path. Also, JSON-driven configs are easier to expose through an SDK than Python
constructor args - that matters when the platform abstracts the framework from
end users.

**Q2: Why expose multiple frameworks instead of standardizing on one?**

Because customer needs span 5× orders of magnitude in model size and 100× in
budget. A platform that forces 7B-LoRA users to pay the DeepSpeed init tax loses
them; a platform that gives 70B users only FSDP loses them when they need offload.
The cost of exposing two or three profiles is much lower than the cost of one
wrong profile.

**Q3: How does FSDP differ from DDP in the backward pass?**

DDP: full grads on each rank, all-reduce per bucket. FSDP: grads are sharded -
each rank computes its local grad partition and `reduce_scatter` sends each shard
to its owner. The owner runs the optimizer step on its shard only. Net comm
volume is the same, but memory is divided by world size.

## On scheduling and infra

**Q4: What happens if gang scheduling fails to place the full job?**

Volcano puts the PodGroup in `Pending`. If `min_member` isn't satisfied within
the queue's timeout, the request is requeued; existing pods do not start. The
critical property: **no pod starts unless all start**, because partial NCCL
rendezvous is a deadlock. The price is queue latency, which is acceptable.

**Q5: Why not just use Kubernetes priority classes instead of gang?**

Priority handles preemption order but doesn't handle atomic start. A high-priority
distributed job that gets 30 of 32 pods scheduled is in a deadlock - the other 2
GPUs are held elsewhere, the 30 running pods are wasting GPU time. Gang scheduling
ensures the 30 don't start until the other 2 are available.

## On performance

**Q6: We're at 30% MFU on 70B. Where do we look first?**

In order: (1) dataloader wait (most common - fix with parquet + prefetch),
(2) NCCL collectives (look for one slow rank → IB/cabling), (3) optimizer step
(use FusedAdam / 8-bit), (4) activation memory pressure forcing tiny batches
(turn on activation checkpointing more aggressively), (5) kernel launch overhead
(`torch.compile` if model fits the compile graph). Order matters: I/O issues
will mimic comm issues until you instrument the dataloader.

**Q7: When would you choose to enable CPU offload?**

When the user's GPU budget can't hold optimizer state and they're willing to
trade step time for fit. Offload typically slows training 1.3-2×. Use it as the
last resort before refusing the job; prefer reducing batch / increasing world
size first.

**Q8: How does activation checkpointing trade off?**

Recompute activations during backward instead of saving them. Saves ~30-70% of
activation memory at a ~25-30% step-time cost. Almost always worth it for large
models - without it, you can't fit big enough microbatch.

## On checkpoint and artifact handling

**Q9: How do you avoid GBs of checkpoint traffic colliding with NCCL traffic?**

Write checkpoints to **node-local NVMe** first, asynchronously rclone to blob.
NVMe writes don't share the IB fabric. The rclone runs on a CPU thread and rate-
limits itself to leave 80% of egress for training comm.

**Q10: How does the model registry prevent a bad checkpoint from being deployed?**

The registry entry is *gated* on three things: (a) trained checkpoint signed by
the trainer driver (signature includes job_id + base_model_sha), (b) eval scores
above tenant-defined thresholds, (c) for production tier, a human approval click.
A serving plane refuses to load a registry entry that lacks these.

**Q11: What if MLflow goes down mid-run?**

Trainer's MLflow client buffers metrics in-memory (bounded queue). If MLflow
recovers within a few minutes, the buffer flushes; if not, we lose metric
*history* but the *training and artifacts* are unaffected because checkpoint
writes don't go through MLflow. Critical principle: **MLflow is a tracking
dependency, not a training dependency**.

## On security

**Q12: Can a tenant exfiltrate data via cleverly-named MLflow tags?**

In theory yes (tag values are user-controlled). Mitigations: tag values are
size-capped, scanned for known secret patterns (regex for tokens, AWS keys,
RSA blocks), and the MLflow store is in the tenant's blob - exfiltration to
*outside* the tenant requires breaking the network policy, not MLflow.

**Q13: How do you handle a malicious training script?**

The platform offers two modes: (a) **managed**, where the script is the
platform-supplied trainer + the user only supplies config; (b) **bring-your-own**,
where the user's script runs in a stripped-env subprocess with no platform
credentials in env, only writable scratch + read-only data mount. In the BYO
mode, anything the user does inside their process is "their problem" for
correctness; for security, the network policy is the hard boundary.

**Q14: What does "VNet isolation" actually buy you in this architecture?**

It buys you (i) inability to read another tenant's data over the cluster network
even if a network policy is misconfigured, because the tenant's PE is in a
different VNet entirely; (ii) no internet egress by default - a compromised
container cannot beacon out; (iii) compliance - explicit traffic flow that
auditors can attest.

## On scale

**Q15: 15M jobs/month - where does the platform actually struggle?**

Not in the trainer - most jobs are small. The strain shows up in: container
image pull at burst (solved by P2P pull), MLflow tracking server (solved by
sharding), GPU quota fragmentation (solved by bin-packing + preemption), and
metadata DB writes (solved by partitioning).

**Q16: What's the worst-case failure if a single tenant submits a malformed 8000-GPU job?**

Quota refuses it at admission. If somehow accepted, the gang-scheduler waits
forever for capacity that doesn't exist and eventually queue-timeouts. No
other tenants are impacted - that's the whole point of quota and gang.

## On product

**Q17: How does this map to a 90% reduction in model development time?**
*(Anchor: `resume.txt` L91-92.)*

By removing four steps the user used to do manually: spinning up infra,
debugging distributed code, writing checkpoint/resume logic, integrating eval.
The platform's profile system lets the user say "fine-tune Llama-3-70B on this
data, optimize for these eval metrics" and get a working run in minutes.

**Q18: The same SDK / AI Studio surface - how do you keep the UX consistent
across all these frameworks?**

The user-facing API exposes a `JobSpec`, not a framework. Internally the spec
maps to one of the profiles (`tiny-lora`, `medium-full`, `large-full`, etc.).
The user never sees `deepspeed.initialize`. The status updates, log streams,
and artifact paths look identical regardless of the underlying framework
because the platform's wrappers normalize them.

## On the DeepSeek question specifically

**Q19: Why doesn't a managed fine-tuning platform offer DeepSeek-style FP8 / MoE
training?**

Two reasons. (1) Customer workloads are usually fine-tunes of dense models that
DeepSpeed/FSDP handles natively - adding FP8/MoE infra without customer demand
is engineering for a curve that doesn't exist. (2) MoE training is much harder
to make robust: routing instabilities, expert imbalance, all-to-all topology
sensitivity. The complexity ceiling for "managed fine-tuning service" sits
below it.

**Q20: If a customer asks for DeepSeek-V3 fine-tuning specifically, what
changes?**

We expose a pre-built `deepseek-v3-lora` profile that uses Megatron-Core with
EP, LoRA adapters on top of the MoE layers, frozen FP8 base weights. The user
sees the same `JobSpec`; underneath, it's a different image, different parallel
group layout, and a different checkpoint format. The artifact still publishes
to MLflow + registry, so the loop is identical from outside.

## Wildcard

**Q21: If you could rebuild the data plane from scratch today, what would you
do differently?**

Three things: (1) **DTensor + FSDP2 first**, not DeepSpeed - the upstream PyTorch
APIs have caught up and the operational simplicity is large; (2) **bake the
checkpoint contract harder** so framework-internal formats never leak out of the
worker - the Safetensors-sharded + `_SUCCESS` format would be enforced via an
adapter every framework has to implement; (3) **collapse the inference and
training images** into one, so the same artifact works in both contexts without
re-sharding. The 80GB image cost is solvable with hardlinks and layer dedup.
