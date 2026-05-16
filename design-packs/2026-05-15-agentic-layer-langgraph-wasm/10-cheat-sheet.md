# 10 - Cheat Sheet

Concise talking points for live delivery. Designed to be skimmable five
minutes before the interview.

## Headline framing

> "At BlackBox, I led architecture for an enterprise agentic AI platform.
> The agentic layer is a LangGraph-orchestrated ReAct runtime in Python,
> backed by a stateless worker fleet on Kubernetes, calling a Golang WASM
> sandbox plane for code execution and a multi-model router across Claude,
> GPT, and Grok. We handled 10K+ runs/day, 1B+ tokens/month, and 50M
> spans/day in the telemetry mesh for deterministic replay."

## The four-line architecture

1. **Gateway** issues a `Run`, durably persists it, returns an SSE stream.
2. **Stateless agent worker** hydrates a LangGraph from Postgres
   checkpoint and runs one node at a time.
3. **Tool calls** travel as signed gRPC envelopes to the sandbox or
   model router; results are cached by content hash.
4. **Every span** lands in ClickHouse for replay and SOC-2 evidence.

## Slack-clone walk-through, one breath

User types *"design a website like Slack"* → Gateway writes `Run` row →
Dispatcher leases to a worker → Worker calls **Planner** (Claude, long
context) → **Critic-of-plan** scores the plan → **Scaffolder** dispatches
`sandbox.run(create-next-app)` → for each of 8 milestones the **Coder**
loops with the sandbox (write files, `tsc`, `vitest`) → **Milestone
critic** scores against acceptance criteria + UI screenshot vision check
→ **Finalizer** packages artifact and signs it → SSE `done` event hits
the UI with preview URL. Wall-clock: 6–11 min. Cost: ~$1.20–$1.80/run.

## Six numbers to drop into answers

- **10K+** agent runs / day
- **1M+** sandbox executions / day
- **1B+** tokens / month
- **50M** spans / day, **2.5 TB / month** trace data
- **60%** MTTR reduction from deterministic replay
- **6+** engineers led

## The five forks I made consciously

| Fork | Choice | One-line why |
| - | - | - |
| Orchestrator | LangGraph + custom executor | Keep graph IR + checkpointer hook, replace runtime |
| Sandbox | WASM over Firecracker / Docker | Density + deny-by-default isolation + brokered egress |
| Agent loop | Plan-then-ReAct | Plan-level transparency + milestone-scoped containment |
| Router | Multi-model | Capability arbitrage + provider failover |
| Checkpoint | Postgres rows + S3 blobs | Hot reads, cheap blobs, content-addressed dedup |

## Words I want to use

- **Stateless worker, externalized state** - the durability trick.
- **Signed envelope, content-addressed idempotency** - the safety trick.
- **Plan + ReAct, milestone-scoped** - the loop trick.
- **Capability-aware routing, prompt cache reuse** - the cost trick.
- **Hash, replay, divergence** - the debugging trick.

## Words I'll avoid

- "LangGraph handles that" - it doesn't; we wrap it.
- "We just retry" - never. Retries are scoped by `side_effect_class`.
- "Bulletproof", "100% isolation" - defense in depth, not absolutes.

## The hardest pushback to prepare for

> "How do you make this reproducible when LLMs are non-deterministic?"

Answer: **replay reproducibility** via cached observations and prompt
hashes. Not re-run reproducibility. Read `09-cross-questions.md` Q5 if you
want the full version.

## If you have 30 seconds

> "Agent runs are graphs of typed nodes with Postgres-backed checkpoints.
> Workers are stateless. Tool calls go through a policy gate to a Golang
> WASM sandbox via signed gRPC envelopes. Model calls go through a
> multi-model router. Everything emits OpenTelemetry spans into
> ClickHouse, which is how we get deterministic replay and SOC-2
> evidence. The Slack-clone prompt walks through eight milestones with
> a ReAct loop bounded per milestone."

## If you have 5 minutes

Walk the sequence diagram from `02-architecture.md`, then open the
state diagram from `04-low-level-design.md`, then pick one of:

- 60% MTTR via replay,
- 1B-token/month cost controls via the router,
- WASM-sandbox-as-tool security boundary,

depending on which way the conversation is leaning. End with the trade-off
between LangGraph and Temporal - interviewers love a real trade-off.
