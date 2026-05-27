# Retail Banker AI Agent (LangGraph + Deterministic Calculators)

A principal-engineer-grade architecture for a **personal-banking AI agent** that
behaves like a retail banker: answers balance/spend/EMI questions, flags fraud,
nudges savings, executes low-risk actions (reminders, alerts, support tickets),
and escalates everything else to a human.

The design is deliberately a **hybrid of deterministic rule engines and LLM
reasoning**, orchestrated as a **LangGraph DAG**. Every cent-touching number
comes from a deterministic tool; the LLM only explains, summarizes, and
personalizes.

## Why this shape

A retail banker answer that says "you spent ₹18,000 more than usual" is two
things in one sentence:

1. **A number** (must be exact, reproducible, auditable, defensible to RBI / a
   customer dispute).
2. **A narrative** (must feel human, contextual, kind, and actionable).

Numbers belong to deterministic Python; narrative belongs to an LLM. The
LangGraph DAG is the seam that lets them collaborate without either
contaminating the other.

## File map

| File | Purpose |
|---|---|
| [00-question-and-context.md](00-question-and-context.md) | Original prompt, scope, assumptions, resume anchors |
| [01-executive-summary.md](01-executive-summary.md) | One-screen pitch of the design |
| [02-design-estimates.md](02-design-estimates.md) | Personas, build-vs-buy, capacity, NFRs |
| [03-architecture.md](03-architecture.md) | LangGraph DAG, component map, agent-to-agent calls, tool calls |
| [04-api-and-contracts.md](04-api-and-contracts.md) | Public API + tool JSON schemas |
| [05-low-level-design.md](05-low-level-design.md) | Module layout, class responsibilities, state schema |
| [06-scaling-and-capacity.md](06-scaling-and-capacity.md) | Throughput, token budget, cost model |
| [07-security-and-isolation.md](07-security-and-isolation.md) | PII, tenant isolation, threat model, compliance |
| [08-reliability-observability-and-failures.md](08-reliability-observability-and-failures.md) | Checkpoint, retry, replay, traces |
| [09-tradeoffs-and-alternatives.md](09-tradeoffs-and-alternatives.md) | LangGraph vs alternatives, rejected designs |
| [10-cross-questions.md](10-cross-questions.md) | Interviewer pushback + rebuttals |
| [11-cheat-sheet.md](11-cheat-sheet.md) | 60-second delivery script |
| [15-challenges-by-stage.md](15-challenges-by-stage.md) | Stage-rated challenges (inception → frontier) |

## Resume anchors

- **LangGraph ReAct runtime with DAG orchestration, durable execution, 10K+ agent runs/day** - `resume.txt` L51-54.
- **Model router across Claude/GPT/Grok, 1B+ tokens/month** - `resume.txt` L55-56.
- **LLMOps telemetry mesh, 50M spans/day, deterministic replay, 60% MTTR cut** - `resume.txt` L58-59.
- **Rule-engine / deterministic-system thinking from ShareChat ad-targeting and CTR over 40M DAU** - `resume.txt` L109-114.

## How to read this pack in an interview

1. Open [01-executive-summary.md](01-executive-summary.md) to anchor the framing.
2. Walk the interviewer through the LangGraph DAG in
   [03-architecture.md](03-architecture.md), naming each node and the tool
   calls it makes.
3. Pivot to [05-low-level-design.md](05-low-level-design.md) when asked "show
   me code"; the state object and tool registry are the load-bearing pieces.
4. Use [09-tradeoffs-and-alternatives.md](09-tradeoffs-and-alternatives.md) and
   [10-cross-questions.md](10-cross-questions.md) to handle pushback.
