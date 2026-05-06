# 08 — Tradeoffs and Alternatives

## Orchestration Layer Alternatives

| Option | Pros | Cons | Decision |
|---|---|---|---|
| **Argo Workflows** | Mature, Kubernetes-native DAG engine; strong community | Overhead for simple linear training jobs; workflow definition is YAML-heavy; no built-in GPU gang scheduling awareness | Rejected: too much workflow abstraction for what is fundamentally a single-stage job |
| **Ray** (Ray Train + Ray Job) | Excellent elastic scaling; native Python; good fault tolerance | Complex cluster management; Ray's own scheduling can conflict with Volcano's gang scheduling; debugging Ray distributed state is hard | Used Ray Train as the training loop library; did not use Ray for job orchestration |
| **Kubeflow Pipelines** | Kubernetes-native ML pipelines; good UI; Azure support | Heavy operator footprint; pipeline SDK is complex for end-users; not optimized for single-step LLM fine-tunes | Rejected: over-engineered for the IPP use case (submit job → train → publish is 3 steps, not a complex pipeline) |
| **Azure ML Pipelines SDK v2** | First-party, tight Azure ML integration; good SDK ergonomics | Control plane is managed service — reduces flexibility for custom isolation and scheduling requirements | Used for user-facing API surface; the internal scheduler/launcher was custom to support VNet isolation requirements |
| **Custom Kubernetes Operator + CRD** | Full control over scheduling, pod lifecycle, isolation; can integrate natively with Volcano | High build cost; requires deep Kubernetes expertise to maintain | Chosen: the isolation and scheduling requirements (per-tenant namespace, VNet peering, gang scheduling) were complex enough to justify a custom operator |
| **Volcano + custom job controller** | Gang scheduling, bin-packing, multi-tenant queues built-in; pluggable | Volcano is a CNCF project with its own release cadence; some bugs required upstream contributions | Chosen for scheduling layer; custom controller wraps Volcano with platform-specific admission logic |

---

## Scheduler Alternatives

| Option | Gang Scheduling | Bin-Packing | Multi-tenant Quotas | Decision |
|---|---|---|---|---|
| **Default Kubernetes scheduler** | No (requires custom plugin) | Basic (LeastAllocated/MostAllocated) | Via ResourceQuota only | Rejected: no native gang scheduling; cannot atomically bind N workers |
| **Volcano** | Yes (minAvailable) | Yes (BinPack plugin) | Yes (Queue + Capacity plugin) | Chosen: the only CNCF scheduler with production-grade gang scheduling at Azure scale |
| **Kueue** | Yes (limited, via ClusterQueue) | Partial | Yes (ClusterQueue + LocalQueue) | Not available at time of IPP design (Kueue released 2023). Would evaluate today. |
| **Yunikorn** | Yes (Gang Scheduling via task groups) | Yes | Yes (Hierarchical queues) | Evaluated; Volcano had better Azure/AKS documentation and Azure ML existing adoption |

---

## Checkpoint Storage Alternatives

| Option | Write Latency | Cost | Reliability | Decision |
|---|---|---|---|---|
| **Azure Blob (ADLS Gen2)** | 30-90s for large checkpoints; async mitigates this | Low (LRS/ZRS tiering available) | 11 9s durability | Chosen: private endpoint support for VNet isolation is critical; cost-effective at scale |
| **Azure NetApp Files (NFS)** | <1s (NFS is synchronous, fast) | 10-20× more expensive than Blob | High (replicated NFS) | Rejected: cost prohibitive; also NFS shared mount creates cross-tenant access risk if not carefully scoped |
| **RDMA-based shared storage (NVMe over Fabrics)** | Sub-millisecond | High hardware cost | Depends on hardware | Rejected: Azure doesn't expose bare-metal RDMA for checkpoint storage; overkill for checkpoint frequency |
| **In-memory distributed cache (Redis / Memcached)** | ~1ms | Expensive (DRAM vs. Blob) | Low (volatile unless persisted) | Rejected: too expensive and volatile for multi-day runs; suitable only for very frequent micro-checkpoints |

---

## Communication Protocol Alternatives

| Option | RTT Overhead | HoL Blocking | Connection Migration | Implementation |
|---|---|---|---|---|
| **gRPC over HTTP/2** | 1-2 RTT for TLS handshake | Yes (HTTP/2 has HoL at TCP layer) | No | Simple; well-supported |
| **Raw TCP + TLS 1.3** | 1 RTT for TLS 1.3 (0-RTT with session ticket) | Yes | No | Performant but no multiplexing |
| **WireGuard VPN** | Low overhead; kernel-space | N/A (full tunnel) | No | Network-level encryption, not application-level |
| **Azure Service Bus (messaging)** | 100-500ms (queue-based) | N/A | N/A | Not suitable for low-latency compute-to-compute streams |
| **QUIC (TunDRA / Rust)** | 0-RTT resume; 1 RTT new conn | No | Yes (connection ID) | Highest complexity; highest performance |

**Why QUIC for TunDRA:** The 1M+ compute instances send frequent short-lived streams (checkpoint uploads, heartbeats, status updates). The 0-RTT resume means reconnecting after a pod restart (common in preemptible workloads) costs 0 extra round trips instead of 2. The 50% improvement in secure data transfer throughput came primarily from eliminating TCP HoL blocking on checkpoint multi-stream uploads.

---

## Training Framework Alternatives

| Option | Best For | GPU Memory Efficiency | Infra Complexity | Decision |
|---|---|---|---|---|
| **PyTorch DDP** | Small models (<7B), single-node or simple multi-node | Low (full model replica per GPU) | Low | Used for small LoRA jobs; simple to debug |
| **DeepSpeed ZeRO-3** | Large models (13B-70B), multi-node, memory-constrained | Highest (shards params + gradients + optimizer state) | Medium | Chosen for large fine-tunes: enables 70B QLoRA on 16× A100 80GB |
| **Ray Train** | Fault-tolerant distributed loops, elastic scaling | Medium (wraps PyTorch) | Medium | Used as the fault-tolerance wrapper around DeepSpeed |
| **Horovod** | Classic data-parallel, MPI-based | Low | High (MPI dependency) | Rejected: MPI is complex to run in Kubernetes; poor integration with Volcano |
| **Megatron-LM** | Massive pre-training (175B+), tensor parallelism | Very high | Very high | Rejected for fine-tuning: over-engineered for adapter-based methods; requires custom model sharding code |

---

## Three Biggest Technical Bets

### 1. Per-tenant VNet Peering Instead of Shared VNet + NetworkPolicy

**The bet:** Pay the extra complexity of VNet peering for isolation, rather than relying on Kubernetes NetworkPolicy in a shared VNet.

**Alternative:** Single AKS cluster, all tenants in same VNet, NetworkPolicy as the isolation layer.

**Why we chose it:** Enterprise customers with strict data sovereignty requirements (Fortune 500, regulated industries) would not accept their training pods running in the same L3 network as other customers. NetworkPolicy is software-enforced; a misconfiguration or a kernel bypass vulnerability could expose cross-tenant traffic. Hard network separation was necessary for enterprise sales.

**Cost:** Higher operational complexity (managing VNet peering per tenant), higher Azure networking cost, more complex pod scheduling (nodes must be in the right subnet).

### 2. Custom Kubernetes Operator Over Argo/Kubeflow

**The bet:** Build a custom operator with domain-specific job semantics instead of adopting a general-purpose workflow engine.

**Alternative:** Argo Workflows with a custom step template per job type.

**Why we chose it:** The platform's job semantics (gang scheduling atomicity, per-tenant namespace isolation, VNet-aware pod spec construction, checkpoint-aware retry) required deep integration with Kubernetes APIs that Argo abstracts away. Exposing those primitives through Argo templates would have been more complex than owning the operator directly.

**Cost:** Higher initial build cost; ongoing operator maintenance; knowledge transfer overhead when engineers rotated.

### 3. LoRA/QLoRA-First Instead of Full Fine-Tuning

**The bet:** Design the platform primarily for adapter-based fine-tuning (LoRA, QLoRA, PEFT) rather than full model fine-tuning.

**Alternative:** Support full fine-tuning as the primary path; adapters as secondary.

**Why we chose it:** At Azure ML scale (20B tokens/year, many customers), full fine-tuning of 70B+ models would have required 2-4× more GPU memory and 10-20× more compute per job. LoRA reduces checkpoint size from 140GB to 500MB, making storage costs manageable. 90% of enterprise fine-tuning use cases (domain adaptation, tone/style, instruction following) don't need full fine-tuning.

**Cost:** Adapter-based fine-tuning has quality limits for some use cases. Platform had to maintain an escape hatch for full fine-tuning for customers who needed it (with appropriate compute quotas and higher pricing).

---

## What I'd Design Differently With Hindsight

**The synchronous checkpoint write path.**

The initial CheckpointManager implementation wrote checkpoints synchronously: training paused, checkpoint serialized to disk, uploaded to Blob, manifest updated, training resumed. For 7B LoRA jobs (300MB checkpoint), this added 30-60 seconds every 100 steps — measurable training overhead.

The async path (serialize to NVMe in background, upload while training continues) was added as a v2 feature, but it required careful correctness reasoning: if the pod fails between the local NVMe write and the Blob upload, the checkpoint manifest may be stale. The fix required a two-phase commit: write to NVMe, update a local "pending upload" log, upload to Blob, then update the manifest. The logic was correct but subtle.

**If designing from scratch today:** async checkpoint with two-phase commit from day one. The correctness complexity is the same; avoiding the synchronous path saves 5-10% of total training time.
