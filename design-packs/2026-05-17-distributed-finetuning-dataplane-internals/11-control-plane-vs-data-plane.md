# 11 — Control Plane vs Data Plane

The user's question explicitly draws the line: *"I understand how the job goes
to the data plane — but what is the architecture of the data plane itself?"*
This file makes the boundary precise.

## The rule

> The **control plane** decides what should run and where. The **data plane** runs
> it. The control plane's failure must not stop a running job. The data plane's
> failure must not corrupt the control plane.

## Boundary line

```
            CONTROL PLANE                     │           DATA PLANE
─────────────────────────────────────────────┼─────────────────────────────────────────
  Job API + Validator                         │
  Quota + Idempotency                         │
  AutoML Workflow / State Machine             │
  Volcano / PyTorchJob CRD Controller         │
  Gang Scheduler                              │
  Pod placement (bin-packing)                 │
  Network policy creator                      │
  Storage mount creator                       │  (handoff: PodGroup READY)
                                              │ ─────────────────────────────────►
                                              │   Kubelet starts pods
                                              │   Init container syncs data
                                              │   Trainer process boots
                                              │   NCCL rendezvous
                                              │   FSDP / DeepSpeed wrap model
                                              │   Forward / backward / step loop
                                              │   Checkpoint + log + publish
                                              │   Trainer exits cleanly
                                              │ ◄─────────────────────────────────
                                              │   (handoff: artifact pushed to registry)
  Registry index update                       │
  Workflow advances job to PUBLISHED          │
  Customer notification                       │
  Quota refund / charge                       │
```

## What lives where

| Concern | Control plane | Data plane |
|---|---|---|
| API + auth + tenancy | ✓ | — |
| Quota enforcement | ✓ | — (consumes already-granted) |
| Idempotency on submission | ✓ | — |
| GPU scheduling | ✓ (Volcano) | — |
| Image pull | ✓ (kubelet, but coordinated) | ✓ (per-pod actual pull) |
| Workload identity issuance | ✓ (AAD) | ✓ (consumes) |
| Network policy materialization | ✓ | — (enforced by CNI) |
| Storage mount provisioning | ✓ (CSI driver init) | ✓ (consumes mount) |
| NCCL rendezvous | — | ✓ |
| Model loading + sharding | — | ✓ |
| Training loop | — | ✓ |
| Checkpoint writing | — | ✓ |
| Artifact publishing to MLflow | — | ✓ |
| Registry entry creation | — (data plane writes; control plane indexes) | ✓ (writes the entry) |
| Job state transitions | ✓ | — (emits events to a queue) |
| Retries on failure | ✓ (decides to retry) | ✓ (resumes from checkpoint on restart) |
| Eviction / preemption | ✓ (decides) | ✓ (handles preemption signal) |
| Billing / quota debit | ✓ | — |
| OTEL / log ingestion | — (it's a separate platform) | ✓ (emits) |

## Why this separation matters operationally

1. **Outage independence.** If the AutoML control plane has a regional outage,
   running jobs continue. They write checkpoints and emit logs to per-tenant
   stores; when control plane comes back, it observes the running pods and the
   delta queue and catches up. Without this separation, every control-plane
   degradation would be a training disaster.

2. **Blast radius.** A data-plane bug (say, a checkpoint serialization regression)
   affects one job at a time and can be rolled back per-image. A control-plane
   bug (say, a quota miscount) can affect every tenant globally. So they have
   different deployment cadences and gating.

3. **Security.** The control plane never has tenant credentials. It hands out
   short-lived federated identities. A control-plane compromise cannot exfiltrate
   tenant data because it doesn't carry the keys.

4. **Scale curves are different.** Control plane is a request-per-second system
   (~6 RPS for 15M jobs/month). Data plane is a tokens-per-second system (153K
   tok/s on one big job). They are scaled, profiled, and capacity-planned
   independently.

## The narrow contract between them

The control plane gives the data plane:

- A `JobSpec` (model, dataset, hyperparams, profile, tenant_id, run_id).
- A pod manifest with: image tag, workload identity binding, mount paths,
  network policy, resource requests.
- A `PodGroup` that's gang-scheduled.

The data plane gives the control plane:

- Heartbeats (via sidecar or status subresource).
- A final exit status + exit_reason.json.
- A registry entry (or absence thereof, with reason).
- Metric snapshots (loss curve, eval scores) for the UI to render.

That's it. No cross-talk during training. No synchronous calls from data plane
back to control plane on the hot path.

## How this maps to the resume

- **Founding member of AI Fine-tuning on IPP** (`resume.txt` L73) — the IPP
  abstraction is itself a control-plane / data-plane separation: jobs land on
  shared compute, the platform owns the data-plane runtime, customers own the
  spec.
- **AutoML supports 15M+ jobs/month** (`resume.txt` L91) — that volume is only
  feasible because the control plane is not in the training hot path.
- **Co-developed TunDRA, secure protocol for 1M+ compute instances** (`resume.txt`
  L97-98) — TunDRA is the transport that connects the control plane to the data
  plane's nodes; the protocol's QUIC choice is specifically because the link is
  high-throughput, intermittent, and security-critical.
