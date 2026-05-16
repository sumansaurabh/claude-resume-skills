# Agentic Layer — LangGraph + WASM Sandboxes (BlackBox No-Code AI)

End-to-end Principal Engineer pack: the agentic layer that turns a natural-language
prompt like *"design a website like Slack"* into a concrete project — code, files,
preview, and reasoning trace — using a LangGraph-based ReAct runtime on top of a
Golang WASM sandbox plane and a multi-model router (Claude / GPT / Grok).

This pack is grounded in the BlackBox Principal Engineer experience: agentic AI
platform (10K+ runs/day), Golang-backed WASM sandbox plane (1M+ executions/day),
multi-model router (1B+ tokens/month), and LLMOps telemetry mesh (50M spans/day).

## File map

| File | Purpose |
| --- | --- |
| `00-question-and-context.md` | Question, scope, assumptions, resume anchors |
| `01-executive-summary.md` | Five-minute answer for an interview |
| `02-architecture.md` | End-to-end architecture, components, request flow |
| `03-api-and-contracts.md` | Public + internal APIs, gRPC contracts, error model |
| `04-low-level-design.md` | LangGraph graph spec, node classes, tool registry, state |
| `05-scaling-and-capacity.md` | Capacity model, bottlenecks, quotas, growth plan |
| `06-security-and-isolation.md` | Threat model, sandbox boundary, secrets, multi-tenant |
| `07-reliability-observability-and-failures.md` | Failure taxonomy, retries, replay, traces |
| `08-tradeoffs-and-alternatives.md` | LangGraph vs Temporal vs custom, WASM vs Firecracker |
| `09-cross-questions.md` | Pushback questions and crisp rebuttals |
| `10-cheat-sheet.md` | Talking points for live interview delivery |
| `11-control-plane-vs-data-plane.md` | Separation, why it matters at this scale |
| `12-state-machine-and-workflows.md` | DAG/state model for the Slack-clone walkthrough |
| `13-data-model-and-storage.md` | Checkpoints, memory, artifacts, schemas |

## How to use this pack

Read `01` for the elevator pitch, then `02` + `12` together — they walk the
"design a website like Slack" prompt through every component. `04` is the file
to study before LLD-style pushback. `09` is the sparring partner.
