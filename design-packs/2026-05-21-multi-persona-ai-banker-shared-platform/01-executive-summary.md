# 01 — Executive Summary

## The One-Paragraph Answer

The Multi-Persona AI Banker is a **single shared agentic platform**, not three
independent agents. Retail (coach), SME (operational cashflow), and CFO
(governance-heavy treasury) share the same supervisor + specialist subagent
runtime, the same memory tiers, the same tool router, and the same governance
plane. Personas are a *parameter*: persona tag drives context injection, tool
RBAC, proactive cadence, tone, and approval workflow — nothing else forks.
Financial math (balances, runway, payroll readiness, FX exposure) lives in a
**deterministic Calculation Service** behind the tool router; the LLM never
arithmetic. Money-moving actions are **risk-tiered** — low-risk auto, medium-risk
queued for review, high-risk approval workflow with audit and recoverability.
The platform is event-driven for proactivity (salary credits, budget breaches,
treasury imbalances) with priority, cooldowns, and fatigue prevention.
Observability is per-step trace + deterministic replay, drawing on the
50M-spans/day LLMOps mesh I built at BlackBox.

## Why This Shape and Not Three Agents

| Decision | Why a shared platform wins | Why a per-persona agent loses |
|---|---|---|
| Orchestrator | Same supervisor + subagent topology; the persona controls *which* subagents activate and with what tools, not which orchestrator runs. | Three orchestrators triples ops cost, telemetry surface, and prompt drift; new persona = new codebase. |
| Memory | One memory schema with persona/tenant scoping; cross-persona insight (CFO learning from SME-owner usage patterns) is possible. | Three memory stores fork the schema, force redundant ingestion, block cross-persona learning. |
| Tools | One tool registry, persona-scoped RBAC enforced at the router. | Three tool registries means a banking API integration is built 3×. |
| Governance | One policy engine, one audit log, one approval workflow. | Compliance posture forks; auditors hate seeing three control surfaces. |
| Models | One model router selects across providers with persona-aware capability hints. | Three pinned providers fragments cost control at 1B+ tokens/month. |

## The Five Things The Interviewer Wants to Hear

1. **Deterministic vs probabilistic boundary is the load-bearing architectural
   decision.** LLMs do reasoning, summarization, prioritization, and the
   conversational surface. Calculations go through a separate deterministic
   service. This is non-negotiable in financial services.

2. **Persona-aware context injection is a parameter, not a fork.** The
   ContextManager loads persona profile + tier + entitlements + recent state and
   injects it as structured context. The supervisor and subagents are persona-
   agnostic at the code level.

3. **Human-in-the-loop is mandatory at the medium and high risk tiers**, with a
   policy engine deciding the tier from action class × amount × counterparty
   risk × tenant policy. Every sensitive action is auditable and recoverable.

4. **Proactive intelligence is event-driven**, with prioritization, per-user
   cooldowns, persona-specific fatigue limits, and a guaranteed audit trail —
   not a cron job dumping notifications.

5. **Observability and deterministic replay are first-class**, not afterthoughts.
   At 1B+ tokens/month and 50M spans/day (drawing on the BlackBox LLMOps mesh),
   you cannot debug an agentic financial system without per-step traces, tool-
   call history, retrieved context, and replayable runs.

## High-Level Architecture (one-screen)

```
                       ┌─────────────────────────────┐
                       │   Client (Web / Mobile)     │
                       └──────────────┬──────────────┘
                                      │ HTTPS
                       ┌──────────────▼──────────────┐
                       │  Edge: NLB → ALB → WAF      │
                       │  Auth + Rate Limit + mTLS   │
                       └──────────────┬──────────────┘
                                      │
                ┌─────────────────────▼─────────────────────┐
                │   API Gateway   (FastAPI / Gin)           │
                │   - Identity Resolution                   │
                │   - Persona Resolver                      │
                │   - Tenant Scope                          │
                └─────────────────────┬─────────────────────┘
                                      │
                ┌─────────────────────▼─────────────────────┐
                │   Shared Agent Orchestrator (LangGraph)   │
                │   Supervisor → Specialists → Aggregator   │
                │   Durable execution + checkpoint store    │
                └──┬──────────────────┬──────────────────┬──┘
                   │                  │                  │
        ┌──────────▼─┐   ┌────────────▼────────┐   ┌─────▼──────────┐
        │ Context Mgr│   │  Tool Router        │   │ Policy Engine  │
        │ persona +  │   │  (RBAC, capability, │   │ risk tiers +   │
        │ memory     │   │  rate limits)       │   │ HITL gates     │
        │ retrieval  │   │                     │   │                │
        └──────┬─────┘   └─────────┬───────────┘   └────────┬───────┘
               │                   │                        │
   ┌───────────▼──────┐   ┌────────▼─────────┐   ┌──────────▼───────┐
   │ Memory Layer     │   │ Tools            │   │ Approval Service │
   │ - Session (Redis)│   │ - Calc Service*  │   │ - Workflow       │
   │ - LongTerm User  │   │ - Bank API       │   │ - Notifications  │
   │ - Financial Hist │   │ - Accounting     │   │ - Audit Log      │
   │ - Org Context    │   │ - Payroll/Treas. │   │                  │
   │ (Postgres +      │   │ - Payment Rails  │   │                  │
   │  pgvector +      │   │ (each in WASM-   │   │                  │
   │  warehouse)      │   │  isolated worker)│   │                  │
   └──────────────────┘   └──────────────────┘   └──────────────────┘
                                      │
                       ┌──────────────▼──────────────┐
                       │ Model Router (Claude/GPT/   │
                       │ Grok) — capability-aware    │
                       └─────────────────────────────┘
                                      │
                       ┌──────────────▼──────────────┐
                       │ Observability Mesh          │
                       │ OTel + ClickHouse + replay  │
                       └─────────────────────────────┘

*Calc Service runs the deterministic financial math — the LLM never does arithmetic.
```

## The Rollout Story (one paragraph)

Ship **Retail first** because the blast radius of a wrong nudge is small (one user,
one notification, no money moved). Use Retail to harden the deterministic
boundary, observability, and HITL plumbing — these are exactly the things SME
and CFO depend on but cannot tolerate failures in. **SME** layers on cashflow
forecasting, vendor/AR/AP tools, and team-of-one approval. **CFO** layers on
multi-approver governance workflows, treasury operations, FX exposure, and
sub-entity organizational context. Every persona reuses the same orchestrator,
memory, tool router, and policy engine. New tools and new policies are added —
new orchestrators are *not*.

## The Strongest Resume Anchors For This Answer

- LangGraph/LangChain ReAct + DAG + durable execution + 10K+ runs/day
  (`resume.txt:51-54`).
- Model router across Claude/GPT/Grok at 1B+ tokens/month
  (`resume.txt:55-56`).
- LLMOps telemetry mesh: 50M spans/day, deterministic replay, 60% MTTR cut
  (`resume.txt:58-59`).
- WASM sandbox plane isolating 1M+ daily executions for SOC-2
  (`resume.txt:49-50`).
- Microsoft AutoML state-machine orchestration at 15M+ jobs/month
  (`resume.txt:91-92`).

## What I Would Defend Hard

- **Calculation Service is a hard wall, not a soft convention.** Even if it
  costs latency, financial math never runs in an LLM. Hallucinated arithmetic
  in banking is unrecoverable.
- **Persona is metadata, not a fork.** I would push back hard against any
  proposal to maintain three orchestrators; the prep guide says this is the
  biggest mistake candidates make and I agree on first principles.
- **HITL for medium/high risk is not optional.** The auditability and
  recoverability surface is what unlocks regulator and enterprise adoption.
- **Observability is first-class infra.** Without per-step traces and
  deterministic replay, debugging a real financial-advice anomaly turns into
  guesswork — exactly the problem the BlackBox LLMOps mesh was built to solve.

## What I Would Concede in Tradeoffs

- **Cold-start latency** for a brand-new user with no memory is worse than a
  no-memory chatbot. Acceptable: first session warmth comes from persona-
  default templates + cheap onboarding context, not from forcing a synchronous
  bulk-ingest at signup.
- **CFO approval flows add real latency** to high-risk actions. Acceptable:
  CFO users *want* approval friction; speed is not the goal for governance
  workflows.
- **Cross-persona memory sharing is intentionally narrow.** An SME owner who
  is also a Retail customer of the same bank does not get auto-shared memory
  unless they opt in — the privacy regression is not worth the convenience.
