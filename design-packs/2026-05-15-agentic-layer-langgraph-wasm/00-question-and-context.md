# 00 - Question, Context, and Resume Anchors

## Original question

> I designed the no-code AI solution in Cloud Agent. Design the entire agentic
> layer which was built on LangGraph with the utilisation of WASM sandboxes.
> Include the details from the first hand when a user enters
> *"design a website like Slack"*.

## Scope

In scope for this pack:

- The **agentic layer** sitting between the product UI and the WASM sandbox
  plane / model providers.
- LangGraph graph topology: planner → router → tool nodes → critic → finalizer.
- The **WASM sandbox** as a tool plane (code execution, build, preview, test).
- The **model router** across Claude / GPT / Grok with capability-aware routing.
- **Durable execution** of the ReAct loop with checkpointing and resumability.
- **Memory** (working, episodic, semantic) and context optimization.
- The end-to-end **walk-through** for the prompt *"design a website like Slack"*.
- **Telemetry, replay, and SOC-2-aligned audit** at the agent layer.

Out of scope:

- Internal implementation of the WASM runtime itself (covered in the
  `2026-05-06-wasm-sandbox-platform` and `2026-05-07-wasm-sandbox-security-isolation`
  packs). This pack treats the sandbox as a black-box tool with a defined contract.
- Frontend UX of the BlackBox product surface.
- Pricing model and billing.

## Assumptions (explicitly labeled, not claimed from resume)

| # | Assumption | Why I make it |
| - | - | - |
| A1 | Agent runs are scoped to a **Project** owned by a **Tenant** | Standard SaaS multi-tenant model, consistent with SOC-2 evidence boundary |
| A2 | Each agent run gets a **dedicated workspace** mounted into sandboxes | Required for stateful build/preview flows like Slack-clone scaffolding |
| A3 | LangGraph is used as a **library**, not as LangGraph Cloud | Resume says "LangGraph/LangChain-based"; runtime was custom-deployed |
| A4 | Tool calls travel over **gRPC** between Python agent workers and Golang sandbox plane | Resume cites Golang-backed sandbox plane; Python is the LangGraph host |
| A5 | Checkpointing backend is **Postgres + S3-compatible blob** (state row + large blobs) | Common LangGraph durability pattern at this scale |
| A6 | Telemetry is **OpenTelemetry → ClickHouse** | Resume names ClickHouse + OpenTelemetry for 50M spans/day |
| A7 | Sandbox concurrency unit is a **WASM instance pinned to a node**, not a long-running VM | Cold-start economics for 1M+ executions/day |

## Strong resume anchors (≥ 2 per major claim)

| Claim made in this pack | Anchor 1 | Anchor 2 |
| - | - | - |
| Agentic layer is LangGraph/LangChain ReAct with DAG orchestration | resume.txt L51–52: *"LangGraph/LangChain-based reAct agent runtimes with DAG orchestration, tool-calling, and durable execution"* | blackbox-experience.md #7, #8 |
| Long-running, resumable agents with checkpointing + retries | resume.txt L53–54: *"DAG execution, checkpointing, retry semantics... long-running, resumable agents"* | blackbox-experience.md #12, #13, #15 |
| Memory persistence | resume.txt L54: *"memory persistence and fault-tolerant execution"* | blackbox-experience.md #14, #21 |
| WASM sandbox as the code-execution tool | resume.txt L49: *"Golang-backed WASM sandbox plane, isolating 1M+ daily zero-shot code executions"* | blackbox-experience.md #3, #4, #5 |
| Multi-model router (Claude / GPT / Grok) with capability routing | resume.txt L55–56: *"model router orchestration (Claude, GPT, Grok) with capability-aware routing"* | blackbox-experience.md #16, #17 |
| 1B+ tokens / month + context optimization | resume.txt L56: *"consuming 1B+ tokens per month"* | blackbox-experience.md #18, #19 |
| Telemetry mesh for deterministic replay | resume.txt L58–59: *"50M spans/day... 2.5TB+ of monthly trace data for deterministic replay"* | blackbox-experience.md #20 |
| Scale: 10K+ agent runs/day | resume.txt L52 | blackbox-experience.md #11 |

## Grounding confidence

**High.** Five direct resume sentences and 20 supporting points in
`blackbox-experience.md` cover every major component. The specific shape of the
graph (planner / scaffolder / coder / critic / finalizer) is presented as a
**design proposal** consistent with those anchors, not as a verbatim claim of
the internal BlackBox graph names.

## What the interviewer is really probing

This question is a layered trap. The naive answer is "LangGraph runs the agent,
sandbox executes code, done." The Principal-level answer must cover:

1. **Why LangGraph at all** vs Temporal, vs raw queue + state machine, vs LangChain
   AgentExecutor - and where LangGraph stops scaling.
2. **The control-plane / data-plane split** - orchestrator state vs sandbox bytes.
3. **Durable execution semantics** when LLM calls are nondeterministic and tool
   calls have side effects.
4. **Multi-tenant security** when AI-generated code runs in a shared cluster.
5. **Cost** - 1B tokens/month is real money; context budgeting is not optional.
6. **Replay** - how a non-deterministic agent run is reconstructed for debugging
   and SOC-2 evidence.

Each of those is given its own file in this pack.
