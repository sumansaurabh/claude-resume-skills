# 05 — Scaling and Capacity

## Throughput Model

**Starting facts from resume:**
- 20B tokens/year processed across all fine-tuning workloads
- 15M+ jobs/month on AutoML (broader platform, includes fine-tuning + classical ML)

> **Assumption:** Fine-tuning workloads account for ~20-30% of total job volume. The 20B tokens/year figure applies specifically to LLM fine-tuning on IPP.

### Back-of-Envelope: GPU-Hours at 20B Tokens/Year

| Model Size | Method | Tokens/Job (typical) | Jobs/Year | GPU-Hours/Job | Total GPU-Hours/Year |
|---|---|---|---|---|---|
| 7B | LoRA (QLoRA) | 500M | ~8,000 | ~4 hr × 8 GPU = 32 GPU-h | ~256,000 |
| 13B | LoRA | 1B | ~4,000 | ~12 hr × 8 GPU = 96 GPU-h | ~384,000 |
| 70B | QLoRA | 2B | ~2,000 | ~24 hr × 16 GPU = 384 GPU-h | ~768,000 |

> **Assumption:** A100 80GB GPUs. Throughput ~150-200B tokens/GPU-hour for QLoRA, ~50-80B for full fine-tune.

At 20B tokens/year with a weighted average of ~500M tokens/job, that's approximately **40,000 fine-tuning jobs/year** or **~110 jobs/day**.

At 15M jobs/month on the broader platform, that's **~500,000 jobs/day** — the bulk are short AutoML jobs (minutes), not long LLM fine-tunes (hours to days).

---

## Bottleneck Analysis

| Layer | Bottleneck | Symptom | Mitigation |
|---|---|---|---|
| **API tier** | Rate limiting per tenant | 429s on burst submission | Token bucket per tenant, exponential backoff advice in SDK |
| **Job queue (ASB)** | Message ordering / in-flight limit | Delayed job creation event processing | Partitioned queues by tenant_id; increase max concurrent receivers |
| **Scheduler (Volcano)** | Gang scheduling deadlock on fragmented cluster | Jobs stuck in SCHEDULING for >30 min | Preemption of low-priority jobs; backfill algorithm for small jobs |
| **GPU cluster** | Not enough A100 nodes available | Queue depth growing; SCHEDULING wait >60 min | Cluster autoscaler with warm spare nodes; multi-cluster spillover |
| **Data pipeline** | DataLoader throughput < GPU compute speed | GPU util 30-60%, CPU pinned at 100% | Increase num_workers, prefetch to local NVMe, streaming via ADLS SDK |
| **Checkpoint storage** | Checkpoint write latency spikes | Training stall every N steps; step time variance | Async non-blocking checkpoint writes; local NVMe cache before upload |
| **Log pipeline** | Log ingestion lag | Delayed oncall alerts; missing logs for failed jobs | Fluent Bit buffer with local disk fallback; Azure Monitor ingestion quota increase |
| **Artifact registry** | MLflow metadata DB contention | Slow model registration | Postgres connection pooling (pgBouncer); async registration queue |
| **Network (NCCL)** | All-reduce bandwidth saturation | High step time, low GPU compute throughput | InfiniBand / RDMA for inter-node gradient sync; NCCL topology awareness |

---

## Gang Scheduling Pressure

Gang scheduling (Volcano `minAvailable = N`) requires **all N workers** to be schedulable atomically. This creates pressure when the cluster is fragmented.

**Fragmentation scenario:** Cluster has 40 free GPUs across 10 nodes (4 GPUs/node) but a 64-GPU job needs 8 full A100 nodes. No scheduling possible even though 40 GPUs are free.

**Strategies used:**
1. **Backfill scheduling**: small jobs fill gaps while large jobs wait. Volcano supports this via queue priority classes.
2. **Preemption**: low-priority jobs can be preempted to make room for higher-priority gang jobs. Preempted jobs checkpoint first if checkpoint interval allows.
3. **Cluster autoscaler**: AKS adds new nodes within 3-5 minutes. Volcano jobs remain PENDING until nodes are ready.
4. **Multi-queue fairness**: each tenant has a dedicated Volcano queue with guaranteed minimum GPU share and burst ceiling. Prevents one tenant's large job from monopolizing cluster.

**Queue depth metric:** Track `volcano_queue_pending_jobs` and `volcano_queue_pending_gpus` per queue. Alert when pending GPUs > 2× cluster capacity for >15 minutes.

---

## GPU Quota System

```
Per-tenant quota structure:
  tenant_id: t-xyz
  guaranteed:   32 GPUs    # always available, enforced by Volcano queue minCapacity
  burst_limit:  96 GPUs    # can use up to this during off-peak hours
  max_job_size: 64 GPUs    # single job cannot request more than this

Global pool:
  total_capacity: 512 A100 GPUs (64 nodes × 8 GPU)
  reserved_system: 32 GPUs (operators, monitoring, system workloads)
  schedulable: 480 GPUs
```

**Quota enforcement flow:**
1. Job Validator calls Quota Service at submission time with `(tenant_id, gpu_count)`.
2. Quota Service checks current usage from Volcano queue status.
3. If `current_usage + requested > burst_limit` → reject with 429, `retry_after: 3600`.
4. If `current_usage + requested > guaranteed` but within burst → admit with `priority=low`.
5. If within guaranteed → admit with `priority=standard`.

**Starvation prevention:** Small jobs (1-8 GPU) always get a dedicated preemptible "nano" queue with 48 GPU reservation. Large fine-tuning jobs cannot block this queue.

---

## Bin-Packing Strategy

Volcano uses **best-fit bin-packing** by default: fill the fullest nodes first to maximize empty node count (allows autoscaler to scale down idle nodes).

**Tradeoff vs. spread scheduling:**
| Strategy | GPU Utilization | NCCL Performance | Autoscaler Savings | We chose? |
|---|---|---|---|---|
| Bin-packing (default) | High (few idle nodes) | Lower (cross-node bandwidth) | High | Yes for small jobs |
| Spread (anti-affinity) | Lower | Higher (same-rack bandwidth) | Low | Yes for large multi-node jobs |

> **Assumption:** Node affinity rules request same-rack / same-availability-zone placement for jobs with >4 nodes to minimize NCCL latency. This is a standard Azure VMSS placement group configuration.

**Fragmentation mitigation:** Periodic defrag scan: if cluster fragmentation ratio > 40% and autoscaler can't help, trigger coordinated checkpoint + preemption of lowest-priority jobs to compact the cluster.

---

## Data Pipeline Scaling

Training data lives in customer ADLS Gen2, accessed via Managed Identity and private endpoint from inside the training pod.

**DataLoader throughput budget:**
- A100 GPU training throughput: ~150-200GB model-state processed per GPU-hour
- Effective token throughput per A100: ~150B tokens/hour for 7B QLoRA
- Required data ingestion rate: ~4-5 GB/min per GPU (assuming avg 4 bytes/token for tokenized sequences)

**ADLS Gen2 throughput:** up to 5 Gbps per container with private endpoint. A single 8-GPU A100 node needs ~35 GB/min = ~5 Gbps. Near the limit — use streaming with prefetch.

**Mitigations:**
1. `num_workers=8` in DataLoader — async prefetch hides I/O latency
2. Local NVMe scratch disk for prefetch cache (Azure ND A100 nodes have 1.8TB NVMe)
3. Sharded dataset across multiple ADLS containers when single-container throughput saturates
4. Streaming datasets (HuggingFace `datasets` streaming mode) avoid full download

---

## Checkpoint Storage Scaling

| Frequency | Storage per job (7B LoRA) | Storage per job (70B QLoRA) | Total/month at 15M jobs |
|---|---|---|---|
| Every 100 steps | ~3GB × 10 checkpoints = 30GB | ~40GB × 10 = 400GB | Impractical at 15M jobs |
| Every epoch | ~3GB × 3 epochs = 9GB | ~40GB × 3 = 120GB | ~135TB/month (fine-tune workloads only) |
| Final only | ~3GB | ~40GB | ~45TB/month |

**Strategy:** Keep last 3 checkpoints + final artifact. GC runs after job COMPLETED or after 30-day retention window.

**Incremental checkpointing:** DeepSpeed's `save_checkpoint` with ZeRO stage 3 can write only the changed optimizer shards. For LoRA adapters, checkpoint size is ~100-500MB (adapter weights only, not full base model). This makes frequent checkpointing affordable.

---

## Log Pipeline Scaling

At 15M jobs/month (500K jobs/day):
- Average job duration: 2 hours → 1M pod-hours/day
- Log rate: ~10 lines/second/pod → 10M lines/second at peak
- After enrichment: ~500 bytes/line → 5 GB/s raw

**Tiered approach:**
1. **Hot tier (24h):** Azure Monitor Logs — full resolution, oncall queries
2. **Warm tier (30d):** Kusto cluster — analytics, debugging, billing attribution
3. **Cold tier (1y):** Azure Blob cold tier — compliance archival, sampled at 10%

Fluent Bit batches 10,000 lines or 5 seconds before flushing to Azure Monitor. Local disk buffer absorbs spikes.

---

## Cost Controls

| Mechanism | Description | Savings lever |
|---|---|---|
| **Spot/preemptible instances** | Low-priority fine-tuning jobs run on Azure Spot VMs (70% discount). Checkpoint-on-preemption enables graceful restart. | High |
| **GPU idle detection** | If GPU util < 10% for >5 minutes on a running job, alert + auto-investigate (likely data stall or NCCL hang). | Medium |
| **Preemption for low-priority** | Standard-priority jobs can be preempted by reserved-priority jobs. Preempted jobs checkpoint first. | Medium |
| **Cost attribution** | Every pod tagged with `tenant_id`, `job_id`, `priority`. Azure Cost Management export + Kusto join for per-tenant chargeback. | Visibility |
| **Checkpoint GC** | Automatic deletion of old checkpoints after job completion. Keeps storage costs linear with active jobs, not historical jobs. | Medium |
| **Autoscaler scale-down** | AKS autoscaler removes idle nodes after 10-minute drain. Node startup budget pre-warms 2 standby A100 nodes per queue. | High |

---

## Growth Plan: 15M → 150M Jobs/Month

| Bottleneck | Breaks at | Fix |
|---|---|---|
| Single Postgres for Job Service | ~5M writes/day | Sharding by tenant_id or migration to CockroachDB / distributed Postgres |
| Single Volcano master per cluster | ~50,000 concurrent pods | Multi-cluster federation; per-region Volcano instances |
| Azure Service Bus throughput | ~100K messages/sec | Partition by tenant_id; upgrade to Premium tier with dedicated capacity |
| Quota Service in-memory state | >10,000 tenants | Move to Redis with pipeline-based atomic increment |
| Log pipeline | >50 GB/s raw | Kafka front-end for log collection; tiered Fluent Bit aggregators |
| Checkpoint storage namespace | >100M objects/container | Shard checkpoint containers by job_id prefix |

**First thing that breaks:** Job Service Postgres write throughput. Recommendation: partition jobs table by `created_at` (monthly), add read replicas for status polling, consider DynamoDB for job state at extreme scale.


## can finetuning really consume 20B tokesn pers year?

Yes — **20B tokens/year for fine-tuning can be believable**, but only if you frame it correctly.

For your resume line, the claim is:

> “AI Fine-tuning on IPP… processing 20B+ tokens annually…” 

That is plausible **as platform-scale aggregate throughput**, not as “one model training run.”

## Break it down

**20B tokens/year = ~55M tokens/day.**

That is not crazy for an enterprise ML platform.

Examples:

| Scenario                 |  Tokens/job | Jobs/year needed for 20B tokens |
| ------------------------ | ----------: | ------------------------------: |
| Small LoRA fine-tune     |   5M tokens |                 4,000 jobs/year |
| Medium fine-tune         |  50M tokens |                   400 jobs/year |
| Large customer fine-tune | 500M tokens |                    40 jobs/year |
| Very large fine-tune     |   1B tokens |                    20 jobs/year |

So yes, **20B/year is realistic** if the platform had many internal/customer fine-tuning jobs across Azure/OpenAI/AI Foundry workloads.

But one important correction: in your capacity note, it says:

> “At 20B tokens/year with a weighted average of ~500M tokens/job, that's approximately 40,000 fine-tuning jobs/year…” 

That math is wrong.

**20B / 500M = 40 jobs/year**, not 40,000.

So the claim is believable, but the supporting math needs fixing.

## Better way to explain it in an interview

Say this:

> The 20B tokens/year number was aggregate platform throughput across fine-tuning workloads, not a single training run. At platform scale, this comes from hundreds or thousands of customer and internal jobs, depending on dataset size. For example, 400 jobs with 50M tokens each already gives 20B tokens annually. My work was on the infrastructure path that made these workloads secure, schedulable, isolated, and cost-efficient across Kubernetes, VNet, GPU scheduling, and job orchestration.

That sounds much more credible.

## What not to say

Avoid saying:

> “We ran 40,000 fine-tuning jobs/year at 500M tokens each.”

That would imply:

**40,000 × 500M = 20 trillion tokens/year**, not 20B.

## Best resume wording

I would slightly tighten your resume bullet to avoid sounding inflated:

> Founding team member of AI Fine-tuning on IPP, helping scale secure LLM fine-tuning infrastructure across VNet-isolated Kubernetes environments, supporting 20B+ tokens/year across aggregate fine-tuning workloads and contributing to Azure AI platform revenue.

This keeps the number, but makes the scope clear: **aggregate platform throughput**.
