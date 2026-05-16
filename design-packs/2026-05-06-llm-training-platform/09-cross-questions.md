# 09 - Cross-Questions and Rebuttals

## Architecture and Control Plane

### Q1: Why not just use Argo Workflows instead of building your own control plane?

**Trap being set:** Testing whether you over-engineered, or whether you can justify custom infrastructure vs. buying off-the-shelf.

**Best answer:** Argo is an excellent general-purpose DAG engine, but our job semantics were specific: gang scheduling atomicity, per-tenant VNet-aware pod spec construction, and checkpoint-aware retry required deep Kubernetes API integration that Argo abstracts away. Threading those controls through Argo step templates would have been more complex than owning a focused operator. The custom operator is ~3,000 lines of Go; Argo would have required equal or more YAML configuration plus a plugin layer.

---

### Q2: Your control plane and data plane are separated - but if the control plane goes down, can jobs still run?

**Trap being set:** Testing whether your separation is real or just labeling.

**Best answer:** Yes. Training pods do not make runtime calls to the control plane. They read their configuration from Kubernetes ConfigMaps (injected at launch), write checkpoints to Azure Blob directly, and send heartbeats to the Job Service. If Job Service is down, heartbeats queue up or fail silently - the training loop does not depend on them. The only impact of a control plane outage mid-training is: (1) no new jobs can start, (2) status updates are delayed, (3) if the pod fails and needs retry, the retry cannot be dispatched. Running jobs complete normally.

---

### Q3: How do you handle a job that's been stuck in SCHEDULING for 2 hours?

**Trap being set:** Testing scheduling failure handling depth.

**Best answer:** We have a watchdog that checks Volcano queue depth every 5 minutes. If a gang job has been in SCHEDULING > 30 minutes, it fires an alert. Common causes: cluster fragmentation (not enough contiguous GPU slots), quota exhaustion (tenant's burst limit hit), or node pool not scaled up. The watchdog first checks autoscaler activity - if nodes are being provisioned, we extend the timeout. If the cluster is fragmented, we preempt the lowest-priority running jobs in the same queue to compact the cluster. If it's quota, we alert the customer and surface the reason via the job status `estimated_wait_time` field.

---

## Gang Scheduling

### Q4: If half the workers in a gang-scheduled job fail, do you restart all workers or use elastic training?

**Trap being set:** Testing whether you understand the correctness implications of partial restarts.

**Best answer:** We restart all workers. Volcano gang scheduling is all-or-nothing: if any worker in the `minAvailable` set fails, Volcano marks the entire VCJob failed, and our operator dispatches a full retry. We don't use elastic training (torchrun with `--max_nodes` range) on this stack because partial-gradient correctness becomes much harder to reason about - if 3 of 4 workers apply a gradient and 1 doesn't, the model state diverges. The cost of full restart is mitigated by checkpointing: a retry resumes from the last checkpoint, typically losing at most 10-15 minutes of compute.

---

### Q5: With Volcano gang scheduling, what happens if the cluster can schedule 3 of 4 workers immediately but the 4th worker's node won't be ready for 10 minutes?

**Trap being set:** Testing whether you understand that gang scheduling without deadlock prevention can block other jobs.

**Best answer:** Volcano's `minAvailable = 4` means it will not bind any of the 4 workers until all 4 can be scheduled simultaneously. The 3 pending pods sit in the scheduler queue without occupying GPU resources until the 4th slot is available. This prevents the "partial allocation" deadlock where 3 workers hold GPUs and the 4th can never start because other jobs hold the remaining GPUs. The downside is that the cluster autoscaler needs to provision the new node before any GPU is allocated - we mitigate this by pre-warming 2 standby A100 nodes per queue so the wait is typically <3 minutes.

---

## Idempotency and Duplicate Jobs

### Q6: What happens if the client retries a POST /jobs and the server crashes after writing to the DB but before returning 202?

**Trap being set:** Testing distributed systems fundamentals - exactly-once semantics.

**Best answer:** The client retries with the same `Idempotency-Key` header. On retry, the Job Service does a `SELECT WHERE idempotency_key = ?` before any write. If the row already exists (the first write succeeded before the crash), we return the existing job record with status PENDING. If the row doesn't exist (the crash happened before the write committed), we create a new job. The idempotency key is a client-generated UUID, stored as a UNIQUE constraint in Postgres, so concurrent retries also can't create duplicates. The client gets a deterministic response for any number of retries.

---

### Q7: Your idempotency key is client-generated. What if two different tenants happen to use the same key?

**Trap being set:** Testing whether idempotency scope is correct.

**Best answer:** The idempotency key is scoped to `(tenant_id, idempotency_key)` - both columns form the unique constraint, not just the key alone. A key collision across tenants is impossible by design. Within a tenant, the client owns the key namespace, so they control uniqueness. We also document in the SDK that idempotency keys should be UUIDs to minimize collision risk.

---

## Checkpointing

### Q8: What if the checkpoint write itself fails - does the job fail?

**Trap being set:** Testing whether you conflate checkpoint failure with job failure.

**Best answer:** No. A checkpoint write failure is not a job-ending event. The CheckpointManager retries the Blob write 3 times with exponential backoff (30s, 60s, 120s). If all 3 retries fail, the platform fires an alert to oncall and logs a warning in the job's telemetry, but training continues. The cost is a wider recovery window: the next successful checkpoint may be further back than the configured interval. We track `last_successful_checkpoint_step` separately from `last_attempted_checkpoint_step` so oncall can see the gap. A persistent Blob failure (e.g., storage quota exceeded) does eventually become a job failure, but only after we've alerted and the customer has had time to remediate.

---

### Q9: If training takes 48 hours and you checkpoint every 15 minutes, how many checkpoints are in storage at any given time?

**Trap being set:** Testing storage cost awareness.

**Best answer:** Without GC, a 48-hour job at 15-minute intervals would generate 192 checkpoints. For a 7B LoRA job (300MB per checkpoint), that's ~58GB - manageable but unnecessary. We keep only the last 3 checkpoints: the GC runs after every successful write, deleting all but the newest 3. So at any point, storage holds 3 × 300MB = ~900MB for this job. The final artifact checkpoint is excluded from GC and promoted separately to the artifact store. For 70B QLoRA (2GB per checkpoint), this is 6GB at any time per job - still reasonable.

---

## VNet Isolation

### Q10: Why VNet peering per tenant instead of just Kubernetes NetworkPolicy in a shared VNet?

**Trap being set:** Testing your security depth - do you know where NetworkPolicy's limits are?

**Best answer:** NetworkPolicy is software-enforced in the kernel's iptables or eBPF layer. It's effective but has two weaknesses for enterprise compliance: (1) a kernel vulnerability or a misconfigured calico/cilium rule can bypass it - cross-tenant traffic becomes possible without any external alert, and (2) enterprise customers with FedRAMP or HIPAA compliance requirements often need evidence of physical or logical network separation, not just software enforcement. VNet peering creates a hard L3 boundary: there is literally no route between tenant A's subnet and tenant B's subnet unless we explicitly add one. That's auditable and passes security review. The cost is higher operational complexity and Azure networking fees, but that's the right tradeoff for regulated-industry customers.

---

### Q11: VNet peering creates a management overhead of one peering per tenant. At 1,000 tenants, is that operationally feasible?

**Trap being set:** Testing whether you've thought about scale implications.

**Best answer:** Azure VNet peering supports up to 500 peerings per VNet in the platform hub. For IPP (which was a controlled early access program), the tenant count was well within that. At general availability scale, the architecture shifts to a hub-and-spoke with Azure Virtual WAN or a network virtualization overlay (like Azure CNI Powered by Cilium). For non-enterprise tenants, we fall back to a shared VNet with namespace-level NetworkPolicy isolation - the VNet-per-tenant model is reserved for enterprise customers with strict compliance requirements and correspondingly higher-tier contracts.

---

## Data Access Security

### Q12: If training pods use Managed Identity to access customer data, what prevents one tenant's pod from accessing another tenant's storage?

**Trap being set:** Testing whether "Managed Identity" is a magic word or a real control.

**Best answer:** Each tenant's Managed Identity is bound to Azure RBAC roles scoped to that tenant's specific storage account and container - not to the storage service broadly. Identity A literally cannot request a token that authorizes access to Storage Account B; Azure AD will reject the request because Identity A has no role assignment on Account B. This is enforced at the Azure AD plane, not just the application layer. The Managed Identity bindings are set up during tenant onboarding and are audited quarterly via Azure Policy. Pods inherit their identity from the AKS workload identity annotation, which the Pod Launcher sets per-job - so a compromised pod can only escalate as far as its assigned Managed Identity allows, which is exactly one tenant's storage.

---

## Scaling and Cost

### Q13: At 20B tokens per year, how much GPU time does that consume? Is that cost-efficient?

**Trap being set:** Testing whether you can reason about scale economics, not just system design.

**Best answer:** At roughly 150-200B tokens per GPU-hour for 7B QLoRA on an A100, 20B tokens/year requires about 100,000-130,000 A100 GPU-hours per year. At Azure's ~$3/GPU-hour for A100 reserved, that's roughly $300K-$400K/year in raw GPU cost for the fine-tuning workloads. With spot instances (70% discount on preemptible workloads), that drops to ~$100-150K/year. The $100M+ revenue contribution makes this highly cost-efficient. The real cost optimization lever was LoRA vs. full fine-tuning: a 70B full fine-tune needs 8-16 A100s for days; QLoRA cuts that to 4 A100s for hours.

---

### Q14: How would you handle a customer who submits 1,000 jobs simultaneously?

**Trap being set:** Testing admission control and backpressure design.

**Best answer:** The API tier enforces a per-workspace submission rate limit (token bucket: 10 jobs/second, burst to 100). A burst of 1,000 submissions gets 429'd after the first 100. The SDK retries with exponential backoff, spreading the load. Jobs that get admitted go into the Volcano queue; they don't all start immediately - the scheduler picks them up as GPU capacity becomes available. Each tenant also has a max-concurrent-running-jobs limit (e.g., 20 jobs). Even if 1,000 jobs are enqueued, only 20 run at once; the rest wait in the queue. This provides natural backpressure. The queue is durable (Azure Service Bus), so no submissions are lost - they just wait their turn.

---

## Observability

### Q15: How would you debug a job that's been in SCHEDULING status for 2 hours?

**Trap being set:** Testing operational depth.

**Best answer:** First, check Volcano queue status: is the VCJob actually pending or did it fail silently? `kubectl describe vcjob jb-abc123 -n tenant-xyz`. Look at the `Status.Conditions` - common causes are `unschedulable: insufficient nvidia.com/gpu` (cluster fragmentation) or `pod-evicted` (node preemption during scheduling). Second, check cluster capacity: total free GPUs vs. what the job needs. If the cluster is fragmented, check node-level GPU allocation. Third, check tenant quota: did another job consume the burst quota since this one was submitted? Fourth, check autoscaler: is it trying to provision nodes and failing (spot availability, quota limit)? Fifth, check if there's a scheduling deadlock: two large jobs waiting for each other's GPUs. Volcano's preemption policy should handle this - if not, manually preempt the lower-priority job.

---

## TunDRA and QUIC

### Q16: You said QUIC gave 50% improvement in secure data transfer. 50% improvement in what metric exactly?

**Trap being set:** Testing precision - "50% improvement" is a red flag without a denominator.

**Best answer:** The 50% improvement was in end-to-end checkpoint upload throughput: measured as megabytes-per-second from training pod to Azure Blob, from first byte sent to last byte acknowledged, including TLS/QUIC handshake overhead. The baseline was TCP + TLS 1.3 with a single connection. QUIC's 0-RTT resume eliminated the handshake cost for subsequent uploads (the dominant case - each checkpoint uses the same connection session), and multi-stream QUIC parallelized the upload of multiple checkpoint shards concurrently without TCP head-of-line blocking. The comparison was on a simulated 1M-instance cluster with checkpoint uploads every 15 minutes - the aggregate throughput improvement across the fleet was significant. I'd be transparent that "50% improvement" in a press context is the best-case measurement; typical improvement in steady-state was 20-30%.

---

### Q17: Why build TunDRA in Rust instead of using an existing Go or C++ QUIC library?

**Trap being set:** Testing whether the Rust choice was principled or just a technology trend.

**Best answer:** Two reasons. First, QUIC implementations available in 2021-2022 in Go (quic-go) and C++ (chromium QUIC, mvfst) had limitations in configurability for data center use cases - specifically, pluggable congestion control and custom flow control for high-bandwidth checkpoint streams. A Rust implementation using the `quinn` crate gave us the control we needed. Second, and more importantly, Rust's memory safety eliminated a class of security vulnerabilities (buffer overflows, use-after-free) that are unacceptable in a security-critical component running on 1M+ compute instances. A memory safety bug in a network protocol implementation at that scale is catastrophic.

---

## Leadership and Tradeoffs

### Q18: You had 4 competing priorities: GPU utilization, job latency, security, and SDK usability. How did you decide which to work on?

**Trap being set:** Testing Principal Engineer prioritization judgment.

**Best answer:** The prioritization framework was: security is a gate, not a slider - we didn't trade it against other dimensions. Within the remaining three, we used business impact as the primary lever. Latency (job start time) was the most customer-visible metric - a job that takes 30 minutes to start feels broken even if it runs perfectly. GPU utilization directly affected cost, which affected our ability to price competitively. SDK usability determined adoption breadth. We typically worked in 6-week cycles: one cycle on latency (gang scheduling improvements), one on utilization (bin-packing, autoscaler tuning), one on SDK (reducing lines of code needed to submit a job). Security work ran in parallel as part of every cycle, gated by threat model reviews before each release.

---

### Q19: How did you drive $100M+ in revenue from infrastructure work?

**Trap being set:** Testing whether you can connect technical work to business outcomes.

**Best answer:** The connection was through platform adoption. The AI Fine-tuning IPP platform enabled enterprise customers to fine-tune GPT-4 and Llama variants on their proprietary data without that data leaving their Azure tenant. The VNet isolation and compliance posture were the key differentiators - customers in regulated industries (healthcare, finance, government) would not use a public multi-tenant service for this workload. The platform made the deal. The $100M figure comes from the enterprise contracts that required IPP-tier fine-tuning capabilities as a deal term, attributed back to the platform engineering work. My specific contribution was the architecture and implementation of the isolation layer and the gang scheduling system, which were the technical requirements driving those deals.

---

## Failure Scenarios

### Q20: The checkpoint storage (Azure Blob) is down. What happens to all running jobs?

**Trap being set:** Testing cascading failure reasoning.

**Best answer:** Running jobs continue training - the training loop doesn't block on checkpoint writes if async checkpointing is enabled. The CheckpointManager retries failed writes with exponential backoff (30s, 60s, 120s). While Blob is down, the platform accumulates in-memory state and queued writes on the local NVMe scratch disk. Jobs fire checkpoint-write-failure alerts after the third retry. If Blob is down for >30 minutes, we alert oncall and pause new job admissions (no point starting new jobs if they can't checkpoint). If a node fails while Blob is down, the job cannot recover - it has lost state since the last successful checkpoint. This is the primary blast radius: jobs that fail during a Blob outage lose up to `outage_duration` of progress. Mitigation: Blob is a 99.99% availability SLA service; our HA architecture uses ZRS (Zone-Redundant Storage) which survives zone failures.

---

### Q21: What's the difference between a job and a run in your system?

**Trap being set:** Checking whether your data model is well-defined.

**Best answer:** A job is the user-facing unit: it has an idempotency key, a set of hyperparameters, a dataset URI, a compute target. It persists regardless of retries. A run is an execution attempt: one job can have multiple runs if it fails and retries. Run 1 might fail at step 500 due to a node failure; Run 2 picks up from step 500 (the last checkpoint) and completes. The job remains in RUNNING/RETRYING status throughout. From the user's perspective, they track the job. From the infrastructure's perspective, we track runs - each run has its own VCJob, pod set, and execution trace. MLflow uses this model too: a job maps to an MLflow experiment, each run maps to an MLflow run within that experiment.

---

### Q22: What does 'COMPLETED' mean - training done, evaluation passed, or artifact published?

**Trap being set:** Testing whether your terminal states are well-defined and what SLOs they cover.

**Best answer:** COMPLETED means all three: training loop finished, evaluation passed the BLEU/MMLU threshold, and the model artifact is registered in MLflow. The substates before COMPLETED are COMPLETING (training done, eval not started), EVALUATING (eval running), and ARTIFACT_PUBLISHING (artifact being written and registered). We chose to make COMPLETED the final gate rather than just "training done" because customers use COMPLETED as the signal to trigger downstream deployment - if we said COMPLETED at training-done but eval hadn't run, downstream systems might deploy a low-quality model. The tradeoff is that COMPLETED can take 20-30 minutes longer than training completion, but that's the right product behavior.

---

### Q23: Why use vLLM for evaluation? Isn't vLLM primarily for inference?

**Trap being set:** Testing whether you understand the tools you listed on your resume.

**Best answer:** Correct - vLLM is an inference engine, not a training framework. We use vLLM in the evaluation harness specifically because evaluation is inference: we load the fine-tuned model and run it against a benchmark dataset (MMLU, BLEU test sets) to generate outputs, then score them. vLLM's PagedAttention and continuous batching make this evaluation significantly faster than using Hugging Face `generate()` - for a 1,000-sample MMLU benchmark on a 7B model, vLLM reduces eval time from ~20 minutes to ~3-4 minutes. This matters because eval is on the critical path to artifact publishing. vLLM also handles the adapter merging (LoRA adapter + base model) at load time, simplifying the eval pipeline.

---

### Q24: Your system processes 20B+ tokens annually with 15M+ jobs per month. Those numbers seem inconsistent - 15M jobs at 20B tokens implies only 1,333 tokens per job. Is something off?

**Trap being set:** Testing numerical consistency and honesty.

**Best answer:** Good catch - they are different populations. The 20B tokens/year is specifically for LLM fine-tuning workloads on the IPP platform. The 15M jobs/month is the broader Azure ML AutoML platform, which includes classical ML jobs (training sklearn models, feature engineering), experiment tracking, hyperparameter search, and more. Most AutoML jobs process no LLM tokens at all - they're table data, time series, image classification. The two metrics cannot be divided against each other. Fine-tuning jobs are a small fraction of total job count but consume the vast majority of compute (GPU-hours).

---

### Q25: If your CheckpointManager is a sidecar, how does it access the model state from the main training container?

**Trap being set:** Testing sidecar architecture understanding.

**Best answer:** The CheckpointManager in sidecar form communicates with the main training container via a shared volume (emptyDir mounted to both containers) or via a local Unix socket / localhost gRPC call. The training code calls `checkpoint_manager.write(model_state, ...)` which serializes the state to the shared volume path; the sidecar picks it up and uploads asynchronously. In practice, the checkpoint manager code is often a library running in-process (same Python process as the training loop), not a true sidecar - the sidecar model was used for log shipping (Fluent Bit) where the concern is the DaemonSet architecture, not per-pod. I used "sidecar" loosely; the checkpoint component is better described as an in-process library with async upload threads.

---

## Three Gotcha Questions

### Q26: "What's the difference between a job and a run in your system?"

Already answered above in Q21.

---

### Q27: "How do you handle a customer who submits 1,000 jobs simultaneously?"

Already answered above in Q14.

---

### Q28: "What does 'completed' mean - training done, evaluation passed, or artifact published?"

Already answered above in Q22.
