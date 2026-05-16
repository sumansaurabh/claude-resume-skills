# 01 - Executive Summary

## The shape of the system in one paragraph

The BlackBox agentic layer is a **LangGraph-orchestrated ReAct runtime** running
in Python on a Kubernetes fleet, sitting between the product UI and two heavy
backends: a **Golang WASM sandbox plane** for code execution / build / preview /
test, and a **model router** that fans out to Claude, GPT, and Grok with
capability-aware routing. Every agent run is modeled as a **directed acyclic
graph of typed nodes** (planner → scaffolder → coder → critic → finalizer) with
**Postgres-backed checkpointing** so a run can crash mid-step and resume
deterministically. The user's prompt - for example *"design a website like
Slack"* - enters through a thin API, is durably persisted as a `Run`, dispatched
to a stateless worker that hydrates the graph from the checkpoint, and streams
results back over Server-Sent Events as nodes complete. The platform handles
**10K+ agent runs/day**, **1B+ tokens/month** through the router, and
**50M spans/day** in the LLMOps telemetry mesh used for deterministic replay
and SOC-2 evidence.

## Five-bullet pitch

- **LangGraph as the orchestrator, not the orchestration framework.** I use
  LangGraph for the graph compiler, state typing, and checkpointer hooks, but
  the **executor**, **tool registry**, **policy gate**, and **resumability
  semantics** are my own. LangGraph alone doesn't give you tenant-scoped
  quotas, signed tool envelopes, or a 50M-span/day trace pipeline.
- **The WASM sandbox is a tool, not the runtime.** The agent reasons in Python;
  it *calls* the sandbox to scaffold a Next.js project, install dependencies,
  run `tsc`, run `vitest`, and capture a screenshot. Every tool call is a
  signed gRPC envelope to the Golang sandbox plane with a per-call CPU /
  memory / wallclock / egress budget.
- **Durable execution = checkpoint after every node, idempotency on every tool
  call.** The `RunState` is persisted to Postgres after each node transition;
  large blobs (file trees, artifacts, screenshots) go to S3-compatible storage
  keyed by content hash. A worker dying mid-run is recovered by another worker
  picking the checkpoint and resuming from the next pending node.
- **Multi-model router with capability-aware routing.** The router scores each
  inbound `ModelCall` against the available models on context length, structured
  output support, tool-use schema fidelity, latency p50/p95, cost per token,
  and recent error rate. Claude handles long-context planning, GPT handles
  structured outputs and code, Grok handles cost-sensitive bulk tasks.
- **Replay is a first-class primitive.** Every LLM call, tool call, and routing
  decision is captured as an OpenTelemetry span with the prompt hash, model,
  seed, temperature, tool envelope, and observation. The trace store is
  ClickHouse; a replay job can reconstruct any past run by feeding cached
  observations back into a re-instantiated graph - that's how MTTR dropped 60%.

## End-to-end walkthrough - *"design a website like Slack"*

| Step | Component | What happens |
| - | - | - |
| 1 | **API Gateway** (FastAPI) | `POST /v1/runs` validates the prompt, attaches `tenant_id` + `project_id`, issues `run_id`, writes the initial `Run` row, returns a `stream_url` |
| 2 | **Dispatcher** | Picks an idle agent worker via consistent-hash on `run_id`, ships the run; an SSE channel opens to the client |
| 3 | **Graph Loader** | Worker hydrates the LangGraph compiled state machine for archetype `webapp-scaffold` |
| 4 | **Planner node** | Calls router → Claude (long context). Produces a typed `Plan`: *Next.js + Tailwind + Postgres + WebSocket, with channels, DMs, threads, presence; 8 milestone steps* |
| 5 | **Critic-of-Plan node** | Second model pass scores the plan; if score < 7, send back to planner with structured feedback |
| 6 | **Scaffolder node** | Emits a tool call `sandbox.exec(create_project, template="nextjs-ts")` over gRPC into the Golang sandbox plane |
| 7 | **WASM sandbox** | Spins a per-run workspace, runs `npx create-next-app` inside a WASM-isolated runner, streams stdout/stderr as spans; emits a file-tree manifest |
| 8 | **Coder loop (ReAct)** | For each milestone the loop: model produces patch → `sandbox.write_files()` → `sandbox.run("pnpm tsc")` → if error, observation is fed back, loop continues; bounded by `max_iterations` and `token_budget` |
| 9 | **Critic node** | After each milestone, runs `pnpm vitest` + `sandbox.preview()` → captures a screenshot → vision-capable model scores UI vs Slack reference |
| 10 | **Memory write** | Decisions, file-tree deltas, and key trade-offs persisted to working memory (Postgres) and semantic memory (vector store) for future runs in the same project |
| 11 | **Finalizer node** | Packages artifact (signed tarball + preview URL), updates `Run.status = succeeded`, emits final `Result` span |
| 12 | **Streaming** | Throughout, every node transition + tool call + token chunk streams to the client over SSE; client renders the live "thinking + file tree + preview" UI |

Total: ~6–11 minutes wall-clock for a Slack-clone scaffold, ~120K–400K tokens,
30–80 sandbox calls. Resumable at every node boundary.

## What I'm proudest of

1. **Decoupling the agent loop from the sandbox.** The agent worker is stateless
   Python; the sandbox plane is stateless Golang. Both can be redeployed
   independently. The bridge is a versioned gRPC contract with capability
   negotiation - adding a new tool (`sandbox.browser_test`) is a one-day change.
2. **Deterministic replay despite non-determinism.** By hashing prompts and
   caching tool observations against the hash, I can rerun a failed agent
   trace through a new model with one config flip. This is what unlocks
   the 60% MTTR reduction.
3. **A policy gate that's actually used.** Every tool call passes through a
   policy node that checks tenant scope, cost remaining, and an allowlist of
   side-effecting operations. The gate is data-driven (rules live in Postgres),
   so SOC-2 controls show up as audit rows, not as Python `if` statements
   buried in agent code.

## The trade-offs an interviewer should hear me name explicitly

- **LangGraph couples graph definition with Python runtime.** That's fine at
  10K runs/day; at 100K I would have factored the graph IR out into a
  language-agnostic protobuf and made the worker a thin executor.
- **WASM doesn't give you a real network stack.** That's a security feature
  for AI-generated code, but it forces the sandbox plane to expose curated
  HTTP egress through a brokered proxy. The tradeoff is real.
- **Multi-model routing creates capability drift.** GPT and Claude don't
  produce identical structured outputs even with the same schema. We pinned
  output adapters per model rather than pretending they're interchangeable.
