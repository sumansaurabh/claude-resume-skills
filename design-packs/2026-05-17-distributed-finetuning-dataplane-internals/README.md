# Distributed Fine-Tuning Data Plane Internals

Pack covering the **inside** of the fine-tuning data plane — what happens after the control
plane has placed a job on a GPU pod. The control plane (gang scheduling, quotas, VNet
isolation, idempotency, artifact registry) is treated as a given here; the focus is on
how the *worker processes themselves* load the model, shard parameters, run the optimizer
step, checkpoint, publish artifacts, and ship logs.

Anchored to the **Microsoft AI Fine-tuning on IPP** experience: `resume.txt` lines 73-74
and 100-101 (DeepSpeed, PyTorch Distributed, vLLM, Ray Train, QLoRA, PEFT, MLflow), and
the secure multi-tenant GPU scheduling work on Kubernetes/VNet.

## File map

| File | Purpose |
|---|---|
| `00-question-and-context.md` | Original question, scope, assumptions, and resume anchors. |
| `01-executive-summary.md` | One-page "tell me what you'd say in 5 minutes" version. |
| `02-architecture.md` | End-to-end data-plane architecture diagram and component map. |
| `03-api-and-contracts.md` | Trainer worker contracts: rendezvous, NCCL, checkpoint, log shipping. |
| `04-low-level-design.md` | **The big one.** Concrete Python code for FSDP, DeepSpeed ZeRO-3, Ray Train, vLLM, DeepSeek-style 3D parallelism. |
| `05-scaling-and-capacity.md` | Tokens/sec model, memory math, NCCL collectives, bottleneck taxonomy. |
| `06-security-and-isolation.md` | Workload identity, secrets, image trust, NCCL on private fabric. |
| `07-reliability-observability-and-failures.md` | Failure taxonomy, checkpoint strategy, MLflow + OTEL log/metric/trace topology. |
| `08-tradeoffs-and-alternatives.md` | DeepSpeed vs FSDP vs Megatron vs DeepSeek vs Ray Train decision matrix. |
| `09-cross-questions.md` | Interviewer pushback and concise rebuttals. |
| `10-cheat-sheet.md` | Talking points compressed for live delivery. |
| `11-control-plane-vs-data-plane.md` | Strict line between what the scheduler does vs what the worker does. |
| `12-state-machine-and-workflows.md` | Worker state machine: rendezvous → train loop → checkpoint → publish. |
| `13-data-model-and-storage.md` | Tensor sharding layouts, checkpoint formats (Safetensors, DCP, ZeRO shards). |

## How to use

- For interview delivery, read `10-cheat-sheet.md` first, then memorize the diagrams
  in `02-architecture.md` and the code snippets in `04-low-level-design.md`.
- For code-level depth, `04-low-level-design.md` is the heaviest file: it shows the
  *exact* config differences between FSDP, DeepSpeed, Ray Train, vLLM, and a
  DeepSeek-style training stack.
- For "what would you do differently" pressure, `08-tradeoffs-and-alternatives.md` is
  the answer.
