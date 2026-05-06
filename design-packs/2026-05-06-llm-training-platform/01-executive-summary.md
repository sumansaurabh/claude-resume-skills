# 01 — Executive Summary

## The One-Paragraph Answer

I was a founding team member on the AI Fine-tuning IPP platform at Microsoft Azure ML, where we built a secure, multi-tenant LLM training system from scratch on Kubernetes and Azure. The platform processed 20B+ tokens annually and contributed to over $100M in revenue. The core architecture separates a **control plane** (job API, validator, scheduler adapter, state machine) from a **data plane** (GPU pods running PyTorch Distributed + DeepSpeed + vLLM, a checkpoint manager writing to Azure Blob via private endpoint, a log shipper, and an artifact publisher to MLflow). Tenant isolation is enforced at three layers: VNet peering per tenant, Kubernetes namespace per tenant with NetworkPolicy deny-all, and Managed Identity per workload. Gang scheduling via Volcano guarantees all workers in a distributed training job start atomically. Checkpoints are written incrementally to Azure Blob at configurable step intervals so retries resume rather than restart. Logs flow through Fluent Bit to Azure Monitor and Kusto. Artifacts are published to MLflow and gated behind an evaluation harness before model registration.

---

## The 60-Second Verbal Answer (for delivery in an interview)

"At Microsoft Azure ML, I was one of the founding engineers on the AI Fine-tuning IPP platform — the infrastructure layer that let enterprise customers fine-tune large language models on their own data without that data leaving their security perimeter.

The architecture has two planes. The control plane is a REST API backed by a job orchestration service: you submit a fine-tuning job, we validate your quota and dataset access, assign you an idempotency-keyed job record, enqueue it to Volcano for gang scheduling, and track status transitions from QUEUED through RUNNING to COMPLETED or FAILED. The data plane is what actually runs: your training pods get launched into a per-tenant Kubernetes namespace with a NetworkPolicy that allows NCCL traffic between workers and private-endpoint egress to your ADLS storage, but nothing else. DeepSpeed handles gradient sharding across GPUs, Ray Train handles the fault-tolerant training loop, and we checkpoint incrementally to Azure Blob so a node failure doesn't restart your job from epoch zero.

When training completes, a checkpoint manager finalizes artifacts, an evaluation harness runs BLEU and MMLU benchmarks, and if those pass, an artifact publisher registers the model in MLflow with lineage back to the training job. Logs stream through Fluent Bit to Azure Monitor. GPU utilization, NCCL throughput, and checkpoint write latency all flow to a Prometheus/DataDog stack with oncall alerting.

At scale — 15M+ jobs per month across AutoML and fine-tuning — the hard problems were gang scheduling pressure on fragmented clusters, per-tenant GPU quota enforcement to prevent starvation, and tenant isolation that satisfied Microsoft's compliance requirements without adding so much overhead that jobs took 10 minutes to start."

---

## Strongest Resume Anchors

| Signal | Claim | Impact |
|---|---|---|
| Founding team | Built the IPP platform from scratch | Blank-slate architecture decisions at scale |
| 20B tokens/year | Data-plane throughput reality | Not a toy system |
| $100M+ revenue | Platform drove enterprise AI revenue | Business framing for Principal Engineer interviews |
| Gang scheduling + bin-packing | GPU scheduler depth | Rare operational knowledge |
| VNet + Kubernetes isolation | Multi-tenant security breadth | Hard to fake without hands-on experience |
| TunDRA (QUIC/Rust) | Protocol-level depth | Differentiator vs. "I used Kubernetes" answers |
| 15M+ jobs/month (AutoML) | Job orchestration at hyperscale | Backs every capacity/scaling claim |

---

## What Makes This a Principal Engineer Answer

A senior engineer would describe the training loop. A principal engineer describes the **control plane / data plane split**, the **tenant isolation layers**, the **failure modes and recovery paths**, the **scheduling backpressure**, the **API idempotency model**, and the **business tradeoffs** behind architectural decisions. This pack covers all of those.



## Some Standard definitions
**NCCL** stands for **NVIDIA Collective Communications Library**.

In your fine-tuning architecture, NCCL is the low-level GPU communication library used when training is distributed across multiple GPUs or multiple nodes.

Simple meaning:

```text
NCCL = the networking/communication layer that lets GPUs talk to each other fast during training
```

When you fine-tune a large model, one GPU is usually not enough. So the model/training workload is split across many GPUs:

```text
GPU 1   GPU 2   GPU 3   GPU 4
  |       |       |       |
  +-------+-------+-------+
          NCCL
```

NCCL handles operations like:

| Operation                | Meaning                                          |
| ------------------------ | ------------------------------------------------ |
| AllReduce                | Combine gradients from all GPUs                  |
| Broadcast                | Send model weights/config from one GPU to others |
| ReduceScatter            | Split reduced gradient results across GPUs       |
| AllGather                | Gather tensor shards from all GPUs               |
| Point-to-point send/recv | Direct GPU-to-GPU communication                  |

### Why NCCL matters in LLM fine-tuning

During distributed training, each GPU processes a different slice of data. After backpropagation, every GPU has gradients. Those gradients need to be synchronized so all GPUs update the model consistently.

Example:

```text
GPU 1 computes gradient A
GPU 2 computes gradient B
GPU 3 computes gradient C
GPU 4 computes gradient D

NCCL AllReduce combines them:

Final gradient = A + B + C + D

Then every GPU receives the same final gradient.
```

Without this synchronization, each GPU would train a slightly different model, and training would break.

### Where it sits in the stack

```text
PyTorch Distributed / DeepSpeed / Ray Train
        |
        v
NCCL
        |
        v
CUDA / GPU driver / RDMA / InfiniBand / TCP
        |
        v
NVIDIA GPUs across nodes
```

PyTorch or DeepSpeed calls NCCL internally. As an infra/platform engineer, you usually do not write NCCL code directly, but you must understand its behavior because it affects training reliability and performance.

### Why Kubernetes needs to allow NCCL traffic

This line from your answer:

> “NetworkPolicy that allows NCCL traffic between workers”

means distributed training pods must be allowed to communicate with each other.

For example:

```text
trainer-worker-0 <--> trainer-worker-1
trainer-worker-0 <--> trainer-worker-2
trainer-worker-1 <--> trainer-worker-3
```

If your Kubernetes `NetworkPolicy` blocks pod-to-pod traffic, NCCL cannot synchronize gradients, and training may hang or fail.

### Common NCCL failure modes

| Problem                          | What happens                                      |
| -------------------------------- | ------------------------------------------------- |
| Pod-to-pod network blocked       | Training hangs during initialization              |
| One worker crashes               | AllReduce waits forever or job fails              |
| Different CUDA/NCCL versions     | Runtime compatibility errors                      |
| Bad GPU topology                 | Slow training due to poor GPU communication paths |
| InfiniBand/RDMA misconfiguration | NCCL falls back to slower TCP                     |
| Firewall/NetworkPolicy issue     | Workers cannot form process group                 |
| Fragmented scheduling            | Workers land on poor nodes and throughput drops   |

### Interview-ready answer

You can say:

> “NCCL is NVIDIA’s collective communication library used by PyTorch Distributed and DeepSpeed to synchronize tensors across GPUs. In LLM fine-tuning, it handles operations like AllReduce, AllGather, and ReduceScatter so gradients and tensor shards stay consistent across workers. From the platform side, we had to make sure Kubernetes scheduling, pod networking, NetworkPolicy, CUDA/NCCL versions, and RDMA or TCP paths were correctly configured, otherwise training would hang or suffer poor throughput.”

### Very simple version

```text
NCCL is what lets many GPUs behave like one distributed training machine.
```

Without NCCL, multi-GPU LLM training would be much slower and much harder to coordinate.


## Glossary for the Uninitiated
1. NCCL: NVIDIA Collective Communications Library.

