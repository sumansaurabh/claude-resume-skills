# 10 - Interview Cheat Sheet

## The 30-Second Hook

> "I built the job orchestration and isolation layer for Azure ML's LLM fine-tuning platform - secure, multi-tenant, Kubernetes-based, processing 20B tokens/year. The hard part was making enterprise customers' training data stay in their network while our compute ran the job."

---

## Control Plane vs. Data Plane (say this clearly)

| Control Plane | Data Plane |
|---|---|
| REST API + Job Service | Training pods (PyTorch + DeepSpeed) |
| Job Validator + Quota Service | CheckpointManager (sidecar/library) |
| Scheduler Adapter (Volcano) | LogShipper (Fluent Bit DaemonSet) |
| Pod Launcher (K8s Operator) | ArtifactPublisher |
| Job state machine in Postgres | Model weights in Azure Blob |

**Key point:** Control plane down → no new jobs start, but running jobs complete. Data plane is operationally independent.

---

## 5-Step End-to-End Flow

1. **Submit:** `POST /jobs` with idempotency key → Job Service validates quota + dataset access → PENDING
2. **Schedule:** Scheduler Adapter creates Volcano VCJob (`minAvailable=N`) → gang schedule atomically → pods start
3. **Train:** PyTorch Distributed + DeepSpeed ZeRO-3 → LoRA/QLoRA adapter training → async checkpoint to Azure Blob every 100-200 steps
4. **Log:** Fluent Bit ships structured pod logs → Azure Monitor + Kusto
5. **Publish:** Training completes → eval harness (vLLM) runs BLEU/MMLU → MLflow artifact registration → job COMPLETED

---

## Isolation Layers (say all 3)

1. **VNet peering** - hard L3 boundary per enterprise tenant; no route between tenant subnets
2. **Kubernetes namespace** - per-tenant namespace with NetworkPolicy deny-all; only NCCL + private endpoint egress allowed
3. **Managed Identity** - per-job/per-tenant identity bound to exactly that tenant's storage container via Azure RBAC

---

## Gang Scheduling (the interviewer will ask)

- **Why:** Distributed training requires all N workers to start simultaneously; partial allocation = deadlock
- **Volcano:** `minAvailable = N` - none of the N pods are bound until all N can be scheduled atomically
- **If a worker fails:** All workers terminate, retry from last checkpoint
- **Backpressure:** Low-priority jobs preempted to make room for higher-priority gang jobs
- **Autoscaler:** AKS provisions new A100 nodes; 2 warm standby nodes per queue for fast start

---

## Checkpointing (the interviewer will ask)

- **What's saved:** model state, optimizer state, RNG state, dataloader position
- **For LoRA:** adapter weights only (~100-500MB), not the full base model
- **Frequency:** every 100-200 steps (~10-15 min); async, non-blocking
- **Storage:** Azure Blob via private endpoint + TunDRA (QUIC)
- **GC:** keep last 3; final artifact promoted separately to artifact store
- **Retry:** resumes from last checkpoint step; dataloader seeks to saved position

---

## Security One-Liners

- **"Training data never leaves the customer's Azure subscription"** - Managed Identity delegation reads ADLS; no copy to Microsoft-owned storage
- **"No secrets in env vars"** - Key Vault CSI driver mounts secrets as files
- **"No privileged containers"** - `runAsNonRoot`, dropped ALL capabilities, seccomp RuntimeDefault
- **"TunDRA = QUIC + mTLS"** - mutual certificate authentication for all compute-to-compute traffic; 50% throughput improvement over TCP+TLS

---

## Scale Numbers to Cite

| Metric | Number | Context |
|---|---|---|
| Tokens/year | 20B+ | LLM fine-tuning on IPP |
| Jobs/month | 15M+ | Broader Azure ML AutoML platform |
| Revenue contribution | $100M+ | Enterprise contracts requiring VNet isolation posture |
| Compute instances (TunDRA) | 1M+ | QUIC protocol coverage |
| Secure transfer improvement | 50% | TCP+TLS → TunDRA QUIC |
| Model dev time reduction | 90% | AutoML + platform automation |
| Global users (AutoML) | 200K+ | AI Studio + SDK |

---

## Common Traps and Crisp Answers

| Trap | Best answer |
|---|---|
| "Why not Argo?" | Our gang scheduling + VNet isolation + checkpoint-retry semantics required custom Kubernetes API integration that Argo abstracts away |
| "Why Volcano?" | Only CNCF scheduler with production-grade gang scheduling; bin-packing + multi-tenant queues built-in |
| "Retry = restart from epoch 0?" | No - always resume from last checkpoint; we checkpoint every 10-15 min to bound loss |
| "Managed Identity is enough isolation?" | MI is one of three layers (VNet, namespace, identity). By itself it's not - all three together are. |
| "50% improvement in what?" | End-to-end checkpoint upload throughput (MB/s), measured at 1M-instance scale with 15-min checkpoint interval |
| "Jobs/month vs. tokens/year inconsistency?" | Different populations: 15M/month = all AutoML; 20B tokens = LLM fine-tune only |
| "Completed = training done?" | No - COMPLETED means training + eval passed + artifact in MLflow. Substates: COMPLETING → EVALUATING → ARTIFACT_PUBLISHING → COMPLETED |

---

## The Leadership Frame (for Principal Engineer)

> "The architecture decisions I made - VNet isolation, gang scheduling, async checkpointing - directly enabled the enterprise compliance posture that was the deal requirement for regulated-industry customers. The $100M revenue contribution traces back to those technical choices."

---

## If You Have 5 Minutes Left in the Interview

Hit these in order:
1. Control plane / data plane separation
2. Tenant isolation: VNet + namespace + Managed Identity
3. Gang scheduling via Volcano, checkpoint on failure
4. TunDRA: QUIC/Rust, why not TCP+TLS
5. The $100M connection: isolation = compliance = deal requirement
