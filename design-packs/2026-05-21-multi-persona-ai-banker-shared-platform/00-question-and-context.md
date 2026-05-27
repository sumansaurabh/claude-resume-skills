# 00 - Question and Context

## Original Question

> System Design Round (R2) - Staff Engineer, AI Banker Infrastructure.
>
> Design a **Multi-Persona AI Banker**: a shared AI platform that serves Retail, SME,
> and CFO personas with persona-aware specialization rather than three independent
> agents. Persona differences should mainly affect permissions, context, tone,
> workflows, and proactive behavior - not duplicate the orchestrator, memory, tools,
> or governance layers.
>
> Core components in scope: API gateway + auth, identity resolution, shared agent
> orchestrator, context manager (persona-aware), tool router, policy engine,
> memory layer (session / long-term-user / financial-historical / organizational),
> notification orchestrator, audit & monitoring. Address deterministic-vs-LLM logic
> for financial math, proactive intelligence with cooldowns and fatigue prevention,
> human-in-the-loop for medium/high-risk actions, failure modes (hallucination,
> persona misresolution, notification fatigue, tool misuse, permission leakage),
> event-driven scalability, and a rollout strategy starting with Retail.

**Key principle (interviewer's expectation):** *Shared infrastructure with persona
specialization - not independent agents.*

## What This Round Is Testing

- Ambiguity handling and staff-level ownership thinking - not low-level coding rigor.
- AI systems thinking: when to be deterministic, when probabilistic, where the
  boundary is enforced, and how the agent topology maps onto regulated workflows.
- Scalability and safety: multi-tenant isolation, human-in-the-loop, guardrails,
  observability - applied to *money-moving* actions, not generic chatbot tasks.
- Architecture trade-offs: build-vs-buy, monolith-vs-split, sync-vs-async, agent
  graph topology, model routing, memory stratification.

## Reference Problems Used to Frame the Pack

Two reference folders were provided. They sit under
`/Users/sumansaurabh/Documents/slcie/problems/` and are *not* solved here - they
shape what the platform's persona-specialized lanes need to support.

| Folder | Persona | State | What it shows |
|---|---|---|---|
| `spending_coach_agent/` | Retail | Reference implementation present | Budget-aware nudges, anomaly detection on transactions, `null`-category handling, tool-set abstraction (`send_nudge` / `flag_anomaly` / `suggest_savings` / `no_action`) with confidence scoring. The platform's Retail lane subsumes this. |
| `cash_flow_risk_detector/` | SME | Open problem statement only - **deliberately not solved here** | Weekly cashflow trend + obligations → structured risk assessment (`risk_level`, `weeks_to_crunch`, `trigger`, `recommended_action`, `confidence`). The interviewer is watching for: inflection detection, forward projection, deterministic math on certain inputs, calculation vs reasoning split. The platform's SME lane subsumes this. |

The CFO persona is implied by the prep guide (governance-heavy treasury, FX, multi-
approver workflows) - no reference folder was provided, so its scope is sketched
from the prep guide and resume anchors.

## Scope Decomposition

### In-scope
- Shared agent orchestrator running a LangGraph-based supervisor + specialist
  subagent topology, identical infrastructure across personas.
- Persona resolution at request entry, persona-tagged context injection, and
  RBAC-enforced tool routing.
- Deterministic Calculation Service for balance, runway, payroll readiness, FX
  exposure, treasury position - separate process boundary from the LLM runtime.
- Layered memory: session (Redis), long-term user (Postgres + pgvector), financial-
  historical (transactional warehouse + summary projections), organizational
  context (treasury graph, vendor master, approver graph).
- Event-driven proactive intelligence with priority, cooldown, fatigue prevention.
- Human-in-the-loop with risk-tiered routing, approval workflows, audit, and
  recoverability.
- Multi-tenant isolation per entity, regulatory posture (DPDP / RBI / SOC-2).
- Observability mesh and deterministic replay for AI logic anomalies.
- Rollout plan: Retail first, SME second, CFO third - built on the same
  infrastructure from Day 1.

### Out-of-scope (deliberately)
- Building the actual cash flow risk detector code for the open problem folder.
- Mobile / web client UX implementation details.
- Bank ledger / core banking engine - assumed external, accessed by tool calls.
- Model training; we use hosted frontier models routed through a model router.
- Card issuance, KYC onboarding flows, AML batch - separate adjacent systems.

## Resume Anchors Driving This Design

These are the load-bearing anchors that justify the depth claimed in this pack.
Detailed citation lines:

1. **LangGraph/LangChain ReAct agent runtimes, DAG orchestration, tool-calling,
   durable execution, 10K+ runs/day** - `resume.txt:51-54`,
   `blackbox-experience.md` points #7–#11. This is what makes the supervisor +
   specialist subagent topology resume-grounded.
2. **Graph workflow engine: DAG execution, checkpointing, retry semantics, memory
   persistence** - `resume.txt:52-54`, `blackbox-experience.md` #12–#15. Justifies
   the durable run-state design and resume-from-mid-graph behavior.
3. **Model router across Claude/GPT/Grok with capability-aware routing and context
   optimization at 1B+ tokens/month** - `resume.txt:55-56`,
   `blackbox-experience.md` #16–#19. Underpins persona-tuned model selection and
   token budgeting per run.
4. **LLMOps telemetry mesh: 50M spans/day, 2.5TB monthly trace data, deterministic
   replay, 60% MTTR cut** - `resume.txt:58-59`, `blackbox-experience.md` #20.
   Underpins the observability and replay design.
5. **WASM sandbox plane isolating 1M+ daily code executions, SOC-2 compliance** -
   `resume.txt:49-50`, `blackbox-experience.md` #3–#5. Underpins the isolated
   tool-execution boundary for risky financial actions.
6. **Microsoft secure multi-tenant ML infra, AutoML at 15M+ jobs/month with state
   machines, 200K+ users** - `resume.txt:88-92`, `microsoft-experience.md` #7–#15.
   Justifies the orchestration state-machine choices, idempotency, and quota model.
7. **TunDRA QUIC-based secure protocol in Rust on 1M+ compute instances** -
   `resume.txt:97-98`. Supporting anchor for high-throughput secure transport
   between control plane and runtime.

## Assumptions Made Explicit

- **Scale assumption:** the platform targets ~10M monthly active end-users across
  personas at maturity: ~7M Retail, ~2.5M SME owners/operators, ~500K CFO/treasury
  users - assumption, not on resume; numbers consistent with a national-scale
  digital banking play.
- **Latency assumption:** sync chat response p99 ≤ 3.5 s end-to-end; proactive
  notification p99 ≤ 60 s from trigger event; HITL approval poll p99 ≤ 200 ms.
- **Compliance posture:** DPDP (India), RBI guidelines for AI in financial
  services, SOC-2 Type 2, GDPR for diaspora users. Specific regulator alignment
  is staff-level acknowledgement; legal sign-off is out of scope.
- **Model availability:** frontier model SLAs assume 99.5% provider availability
  per model; the model router masks single-provider outage via fallbacks.
- **Currency / geography:** primary INR + USD; design extensible to multi-
  currency (FX engine is a deterministic service, not LLM-derived).
- **Tool authority:** initial launch keeps all money-moving actions HITL-gated
  for medium/high-risk tiers; pure read-only and pure-advisory actions can be
  automated end-to-end after the first 90 days of error-rate data.

## Strong Phrases to Use in the Interview

These phrases come from the prep guide and align with how the architecture is
described in this pack:

- *Persona-aware context injection.*
- *Deterministic vs probabilistic boundary.*
- *Shared orchestration layer.*
- *Policy-driven execution.*
- *Human-in-the-loop workflows.*
- *Memory stratification.*
- *Event-driven proactivity.*
- *Confidence-scored actions.*

## How To Read This Pack

`02-design-estimates.md` frames the problem (use case, personas, build-vs-buy,
capacity, requirements). `03-architecture.md` is the system map and load-balancer
chain. `04-` and `05-` cover external APIs and internal LLD. `06-` through `09-`
cover scale, security, reliability, and tradeoffs. `10-` and `11-` are interview-
ready cross-questions and a cheat-sheet.

Agentic deep-dives:

- `12-agentic-graph-structure.md` - the LangGraph topology, node taxonomy, and
  per-node state for the shared supervisor + specialist subagents.
- `13-memory-layer-design.md` - the 15-point memory subsystem deep-dive.
- `14-ingestion-pipeline.md` - the write-path for the knowledge base (regulatory
  rulebook, contracts, historical transactions, OCR'd documents).
- `15-guardrails.md` - the behavioral/content safety stack across input,
  planning, tool calls, and output.

`16-challenges-by-stage.md` is the stage-scoped pain ranking produced via the
Chain-of-Thought challenge generation.

## Surviving Critic Objections

In-loop critic ran against `03-architecture.md`, `12-agentic-graph-structure.md`
(Layer 1), `13-memory-layer-design.md`, `14-ingestion-pipeline.md`, and
`15-guardrails.md`. All five files returned **PASS-WITH-NOTES** - no blocking
verdicts. The following objections survive and should be addressed in Layer 2 of
the graph and in any post-approval revision:

**From `03-architecture.md`:**
- Scale envelope inconsistency: 03 TL;DR uses "1M+ DAU" while 13 and 14 size
  for 10M users. Normalize on 10M MAU.
- Terminology drift: 03 says "four-tier memory" while 13 defines five memory
  classes (the fifth being Procedural/Skill).

**From `12-agentic-graph-structure.md`:**
- `RejectionExplainer` appears in the §3 mermaid (post-HITL-rejection) but is
  not enumerated in §2.3 Specialist roster nor in 13/15 node lists.
- `HITLResume` is referenced as a node in §3 and as a state-writer in §5 but is
  absent from §2.1 node type taxonomy.
- `IntakeAndPersona` and `ContextBuilder` are graph nodes used by 12 and 13 but
  are not classified under any node-type taxonomy in §2.1 or §2.3.
- Parallel-fork topology described in §7 (proactive weekly check-ins, 3
  concurrent specialists) is not rendered in §3 mermaid; Layer 2 must add the
  visual fork/join.

**From `13-memory-layer-design.md`:**
- Embedding-model contract conflict with 14: 13 §6 allows
  `text-embedding-3-large` (3072 dim) as per-tenant alternate; 14 §3 declares
  the model "EXACTLY" `bge-large-en-v1.5` with a shared single-model GPU pool.
  One file must concede; recommended fix is to drop the alternate in 13 and let
  14 own the contract.
- `CalcInvoker` (load-bearing in 12 §2.1) is absent from 13's overview diagram
  even though deterministic-math output is consumed by specialists that read
  memory.
- Vector-pool sizing (~1.5 TB) does not account for the 3072-dim alternate, nor
  for the 7.2B transaction vectors that 14 places in pgvector.

**From `14-ingestion-pipeline.md`:**
- Per-tenant alternate embedding model is not acknowledged; either drop the
  alternate in 13 or add a dual-pool exception in 14.
- **Major sizing gap**: 14 §13 totals ~9.2B vectors / ~49 TB raw (12 TB int8
  quantized) including 7.2B transactions; 13 §13 sizes the memory vector pool
  at ~1.2 TB resident with no transactions in it. Either both files share a
  pgvector cluster (in which case 13's hardware sizing under-counts by ~20×) or
  they don't (in which case 03 must show two pgvector clusters). Choose
  explicitly.

**From `15-guardrails.md`:**
- `InputGuardrails` and `OutputGuardrails` are first-class nodes in 15's
  overview diagram but do not appear in 12 §3 mermaid. The injection-point
  contract is asserted in prose but not visualized in the parent graph. Either
  add these nodes to 12, or have 15 explicitly note they are sub-checks inside
  IntakeAndPersona / Terminator.
- `ToolCallValidator`'s role overlaps with 12 §9's "Tool Router double-validates";
  reconcile whether it's the same node, a sub-node, or a wrapper.
- Risk-tier thresholds use different currencies and incompatible values across
  files (03 in AED - 5K Retail / 500K CFO; 15 in USD - 10K High). Consolidate
  into a single PolicyConfig table both files point to.
- 400 ms per-hop latency budget is over-subscribed when guardrails (~260 ms
  steady-state per 15 §10) + memory retrieval (50–80 ms per 13 §12) + LLM call +
  tool call are summed for a single hop that does input check + memory + tool +
  output check.

These objections are surfaced so the next reviewer, the `/critical-agent` gate,
and any downstream implementer can pick them up without re-deriving them.
