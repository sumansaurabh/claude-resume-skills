# 14 - Challenges From Inception To Scale (Rated)

A stage-by-stage walk through the hard problems that show up when you actually
build a distributed fine-tuning data plane like AI Fine-tuning on IPP
(`resume.txt` L73-74). Each challenge is rated on three axes:

- **Severity (1-10):** how badly it bites if you get it wrong. 10 = product
  doesn't ship; 1 = paper cut.
- **Frequency (1-10):** how often the team actually hits it. 10 = daily;
  1 = once in the program's life.
- **Difficulty (1-10):** how hard it is to *correctly* solve, not just hack
  around. 10 = open research; 1 = read the manual.

A composite "**Pain**" score is `Severity × Frequency × Difficulty / 100`,
capped at 100. Anything above 50 is a top-tier priority; below 10 is a paper
cut.

The stages map to the life of the program, not the life of a single job:
inception (zero-to-one), early scale (one-to-N tenants), production hardening,
multi-region + frontier scale.

---

## Stage 1: Inception (zero-to-one, weeks 0-12)

The phase where you're trying to make *one* multi-GPU fine-tune work end-to-end
under the platform's identity, storage, and compliance constraints.

### C1.1 Picking the parallelism framework before requirements are stable

- **Severity: 8** - wrong choice means rewriting Day 1 contracts later.
- **Frequency: 1** - happens once.
- **Difficulty: 7** - matrix is wide; DeepSpeed/FSDP/Megatron/Ray each shine
  in different regimes.
- **Pain: 56**

You don't know yet whether the first paying customer wants 7B LoRA or 70B full
fine-tune. The pragmatic answer: pick **DeepSpeed first** (`resume.txt` L100-101),
keep FSDP wrapper-compatible from day one, leave Megatron as a "future profile".
The pain is real - this decision touches the entrypoint contract, the
checkpoint format, and the SDK surface.

### C1.2 Workload identity from Day 1, not as a retrofit

- **Severity: 10** - retrofitting identity into a system that has long-lived
  secrets baked in is a multi-quarter rewrite.
- **Frequency: 1**
- **Difficulty: 6** - the technology exists (Azure AD Workload Identity,
  federated tokens); the discipline to use only that is the hard part.
- **Pain: 60**

The temptation in week 2 is to mount a service principal secret into the pod
and move on. The cost of that shortcut becomes visible in month 9 when the
security team blocks GA. Doing it right from inception is the single highest-
leverage Day-1 decision.

### C1.3 NCCL on the actual cluster fabric

- **Severity: 9**
- **Frequency: 3** (recurs on every new SKU rollout)
- **Difficulty: 8** - NCCL tuning is a dark art; `NCCL_SOCKET_IFNAME`,
  `NCCL_IB_HCA`, IB partitions, GPU topology hints all matter.
- **Pain: 21.6**

The first multi-node run almost always hangs or runs at 5% of expected
throughput because NCCL picked the wrong interface or because the IB fabric
isn't actually configured for the partition the pod runs on. Symptom: a
20-minute hang in `init_process_group`. Fix: explicit `NCCL_*` env, IB
topology checked at pod start by a health probe.

### C1.4 Container image size and pull time

- **Severity: 6**
- **Frequency: 9** (on every cluster cold start)
- **Difficulty: 4**
- **Pain: 21.6**

A PyTorch + CUDA + DeepSpeed + Transformers + vLLM image is comfortably 30-80 GB.
At cold start of an 8-node job, that is 8 simultaneous 30 GB pulls from ACR,
which throttles. Mitigations: pre-pull DaemonSet, P2P pull (Dragonfly), layer
de-dup with multi-stage builds. None of these are hard individually; the pain
is the cumulative ops overhead.

### C1.5 Reading customer data without copying it

- **Severity: 10** - compliance gate; product can't ship to enterprise without it.
- **Frequency: 1** (per architecture)
- **Difficulty: 7** - blob private endpoints, identity scoping, ABFS driver
  semantics, throttling all interact.
- **Pain: 70**

Customers will not paste their training data into Microsoft-owned storage.
You have to read it from their account, through their private endpoint, using
their tenant's scoped identity, without ever materializing a copy. The work is
not exotic but every link in the chain has a way to silently fall back to a
public path or a long-lived credential. This is one of the most expensive Day-1
problems to get right.

---

## Stage 2: Early scale (1 to ~50 tenants, months 3-9)

The phase where the architecture survives but the operational behavior breaks
the moment more than one tenant uses it concurrently.

### C2.1 Gang scheduling under quota fragmentation

- **Severity: 9** - jobs that never start are worse than jobs that fail.
- **Frequency: 8** - happens whenever GPU supply is constrained.
- **Difficulty: 8** - scheduling is NP-hard in general; bin-packing with
  topology constraints is hard in practice.
- **Pain: 57.6**

Anchor: `resume.txt` L88-89, gang scheduling and bin-packing. The first time
two tenants each ask for 16 GPUs on a cluster with 24 free GPUs, you discover
that simple FCFS gang gives one tenant the cluster and starves the other. The
fix is hierarchical: tenant-level fair share + job-level priority + bin-packing
with NVLink/IB topology awareness. Volcano gives you the primitives; the
policies are yours.

### C2.2 Per-tenant MLflow tracking server

- **Severity: 7**
- **Frequency: 7**
- **Difficulty: 3**
- **Pain: 14.7**

The first MLflow you deploy is shared. The first 50 tenants together can
serialize-write through the tracking server's PG database and the artifact
root's blob container. Symptoms: 30-second metric writes, sporadic 5xx.
Fix: shard MLflow by tenant; rank-0-only writes; metric cadence floor (don't
log every step at 153K tok/s).

### C2.3 Checkpoint write collides with training comm

- **Severity: 8**
- **Frequency: 9**
- **Difficulty: 5**
- **Pain: 36**

If you write checkpoints synchronously to blob from every rank, the training
loop pauses for 30-120 seconds every N steps. At 70B that is a meaningful
fraction of step budget. Async writes to node-local NVMe with rclone trickling
to blob in the background is the fix. The painful part is the partial-write
recovery semantics (the `_SUCCESS` contract).

### C2.4 Dataloader-bound runs hidden as comm-bound

- **Severity: 6**
- **Frequency: 9**
- **Difficulty: 6**
- **Pain: 32.4**

The user-reported symptom is always "GPUs aren't busy". Half the time it is a
slow rank on NCCL; the other half it is a slow dataloader that makes NCCL look
slow because the slowest rank gates the collective. Without per-rank
dataloader-wait histograms you cannot tell the two apart. This is why the
`ft.dataloader.wait_ms` metric in `03-api-and-contracts.md` exists.

### C2.5 The "user code does network egress" surprise

- **Severity: 9**
- **Frequency: 3**
- **Difficulty: 4**
- **Pain: 10.8**

A bring-your-own training script that calls `wandb.init()` or `pip install`
or hits the public Hub during the run. By the time the user complains the
job is dead in a NetworkPolicy block. Fix: clear documentation, a "no egress"
linter pass at job admission, and a friendlier error in the trainer driver
when an outbound call is blocked.

---

## Stage 3: Production hardening (months 6-18)

The phase where the product works and the engineering problem becomes
reliability, observability, and the unglamorous edges.

### C3.1 Long-tail NCCL stalls

- **Severity: 10** - one stuck rank kills the whole world.
- **Frequency: 6**
- **Difficulty: 9** - root cause is sometimes IB cabling, sometimes a noisy
  neighbor's MIG slice, sometimes a GPU XID error that hasn't surfaced yet.
- **Pain: 54**

A 64-GPU job that runs for 10 hours and then hangs forever on an all-reduce.
You need: NCCL watchdog timeouts shorter than the default, per-rank collective
duration histograms, automatic node-health probes that catch IB and XID errors
proactively, and a job-supervisor that decides "kill and retry" instead of
"wait forever". This is the single biggest source of pages at scale.

### C3.2 Idempotent retries that actually replay deterministically

- **Severity: 9**
- **Frequency: 7**
- **Difficulty: 8**
- **Pain: 50.4**

Resuming from a checkpoint and getting "almost the same" loss curve is easy.
Getting **bitwise** the same curve so customers can trust the run requires
RNG state restoration, sampler cursor restoration, optimizer state full-
fidelity restore, and either deterministic kernels or a documented "expect
small divergence after resume" contract. Most platforms ship the latter and
ignore the cost in customer trust.

### C3.3 Checkpoint storage cost spiral

- **Severity: 7**
- **Frequency: 8**
- **Difficulty: 3**
- **Pain: 16.8**

A 70B job keeps 10 checkpoints, each 560 GB, in premium blob, for 200 tenants.
That is $1M+/yr of storage. The fix is policy: keep last K, the eval-best,
and the final one; lifecycle the rest to cool tier or delete. Implementation
is trivial; the customer conversation about retention is not.

### C3.4 Log volume eats the observability budget

- **Severity: 6**
- **Frequency: 10**
- **Difficulty: 4**
- **Pain: 24**

NCCL `INFO` logging is verbose. Per-step traces explode at 153K tok/s. The
team has to decide what to sample, what to aggregate at the collector vs
on the worker, and how to keep the per-tenant query latency under 5 s on
recent data. Kusto/Geneva handles the ingest; the sampling discipline is
the unsexy work.

### C3.5 Cross-region disaster recovery

- **Severity: 7**
- **Frequency: 2**
- **Difficulty: 7**
- **Pain: 9.8**

If region East goes down mid-run, can the customer resume in region West?
The honest answer is usually "not automatically" because checkpoints, MLflow
runs, and registry entries are region-pinned. Async cross-region replication
of the checkpoint root + the registry index gets you to a manual cutover.
True automatic failover is a deep, deep project that nobody actually needs.

---

## Stage 4: Multi-tenant scale (months 12-30)

The phase where the platform is real and the next 10x of tenants exposes
multi-tenancy bugs that did not show up at 50.

### C4.1 Noisy neighbor on shared storage

- **Severity: 8**
- **Frequency: 7**
- **Difficulty: 6**
- **Pain: 33.6**

Even with per-tenant storage accounts, shared subscription-level limits
(transactions per second, egress bandwidth per region) can mean one tenant's
data-loading saturates the link. Per-tenant storage accounts plus per-tenant
egress budgets in the dataloader are necessary. Visibility is harder than
the fix: you need to attribute bandwidth use back to a job before you can
throttle it.

### C4.2 Image signing and SBOM enforcement across teams

- **Severity: 9** - regulatory.
- **Frequency: 3**
- **Difficulty: 5**
- **Pain: 13.5**

Anchor: `resume.txt` L93-94 (CodeQL and GitHub Advanced Security).
Every internal team that contributes an image (eval harness, vLLM serving,
data movers) needs to follow the same signing + SBOM pipeline. The technical
work is small; the cross-team discipline is what makes this a months-long
program.

### C4.3 Quota fairness across tenant tiers

- **Severity: 8**
- **Frequency: 9**
- **Difficulty: 7**
- **Pain: 50.4**

Free-tier tenants spam small jobs, paid tenants run rare big ones. Naive
fair-share starves the paid tenants when the queue is full of free tenants;
priority alone lets one paid tenant monopolize the cluster. The right answer
is a tiered DRF (dominant resource fairness) variant with priority floors
and ceilings. Designing it is one quarter; *tuning* it is forever.

### C4.4 Bring-your-own training script auditability

- **Severity: 9**
- **Frequency: 4**
- **Difficulty: 6**
- **Pain: 21.6**

A customer's BYO script that emits 50,000 unstructured log lines per step is
both a cost and a forensic nightmare. The platform has to expose a structured-
emit channel and politely refuse to be the customer's pdb.

### C4.5 SDK and AI Studio surface staying simple

- **Severity: 7**
- **Frequency: 9**
- **Difficulty: 7**
- **Pain: 44.1**

Anchor: `resume.txt` L91-92 (200K+ users, 90% reduction in development time).
Every new framework profile and every new compliance knob wants to leak into
the SDK. Holding that line - the user submits a `JobSpec`, not a framework
choice - takes constant pushback. The Principal Engineer's job at this stage
is mostly saying "no, hide that".

---

## Stage 5: Frontier scale and MoE (months 18+)

The phase where the next ambition is supporting DeepSeek-class workloads
and 1K+ GPU jobs.

### C5.1 All-to-all bandwidth in MoE training

- **Severity: 10** - if you don't solve it, MoE training is too slow to ship.
- **Frequency: 9** (every MoE step).
- **Difficulty: 10** - this is open research at the intersection of fabric
  topology, expert placement, and schedule overlap.
- **Pain: 90**

DeepSeek's DualPipe schedule and the aux-loss-free routing are *the* answer
in the published literature, and replicating them is non-trivial. For a
managed fine-tuning platform, the call is usually to *not* host MoE training
externally until you have the muscle to do it well.

### C5.2 FP8 numerical stability

- **Severity: 8**
- **Frequency: 7**
- **Difficulty: 9**
- **Pain: 50.4**

FP8 training requires per-block scaling, careful gradient clipping, and
loss-scale tracking that DeepSeek tunes per-layer. Without this, training
diverges at unpredictable steps. Even reproducing the public recipes takes
months of validation work.

### C5.3 1K+ GPU rendezvous time

- **Severity: 7**
- **Frequency: 5**
- **Difficulty: 7**
- **Pain: 24.5**

At >1024 GPUs, NCCL `init_process_group` itself takes minutes; the default
30-minute init timeout starts to feel real. The fix is hierarchical
rendezvous (process group of process groups) which is well-trodden in
Megatron but not in stock PyTorch.

### C5.4 Secure compute communication at fleet scale

- **Severity: 9**
- **Frequency: 6**
- **Difficulty: 9**
- **Pain: 48.6**

Anchor: `resume.txt` L97-98 (TunDRA, QUIC, Rust, 1M+ compute instances, 50%
improvement). Once the fleet is large enough, TCP+TLS handshake cost and HoL
blocking on long-lived connections become a real bottleneck for the data
plane's chatty surfaces (status, metric shipping, artifact pulls). Building
a QUIC-based, mTLS-authenticated transport is a multi-quarter project but
the payoff at fleet scale is large enough to justify the investment.

### C5.5 Vendor-lock vs vendor-leverage

- **Severity: 8**
- **Frequency: 2** (architectural decisions)
- **Difficulty: 7**
- **Pain: 11.2**

H100 + IB + NCCL is the safe choice. Building on TPU or AMD MI300 means
swapping NCCL for the relevant collective lib, dealing with a less mature
DeepSpeed/FSDP path, and giving up some MFU. Worth doing for negotiation
leverage, painful to deliver.

---

## Top-10 ranked by Pain score

| Rank | Stage | Challenge | Pain |
|---:|---|---|---:|
| 1 | 5 | C5.1 All-to-all bandwidth in MoE training | 90 |
| 2 | 1 | C1.5 Reading customer data without copying it | 70 |
| 3 | 1 | C1.2 Workload identity from Day 1 | 60 |
| 4 | 2 | C2.1 Gang scheduling under quota fragmentation | 57.6 |
| 5 | 1 | C1.1 Picking the parallelism framework before requirements stabilize | 56 |
| 6 | 3 | C3.1 Long-tail NCCL stalls | 54 |
| 7 | 4 | C4.3 Quota fairness across tenant tiers | 50.4 |
| 7 | 5 | C5.2 FP8 numerical stability | 50.4 |
| 7 | 3 | C3.2 Idempotent retries that replay deterministically | 50.4 |
| 10 | 5 | C5.4 Secure compute communication at fleet scale (TunDRA) | 48.6 |

## What this list tells you

Two patterns are worth calling out for interview delivery:

1. **The hardest problems are at the boundaries**, not in the middle.
   Customer-data access, identity, quota fairness, all-to-all comm - these
   are where the system meets either customers, security, or the network
   fabric. Pure inside-the-trainer problems are easier.

2. **Stage-1 mistakes compound the most.** Workload identity, the framework
   choice, and customer-data access all have Pain > 55 *and* are
   irreversible-ish. Spending an extra month on these in inception pays back
   tenfold by month 12.

3. **Frontier-scale challenges are 80% organizational, 20% technical** by the
   time the platform is mature. Whether the team has the budget and the
   appetite to build TunDRA, to invest in FP8 stability, to host MoE
   training - those are leadership calls more than engineering ones, which
   is exactly the Principal Engineer's job at that stage.
