# 00 - Question and Context

## Original prompt (verbatim, condensed)

Design a **Retail Customer Banker AI agent**: a personal-finance assistant +
banking support layer that answers questions like:

- "Why did my balance drop this week?"
- "Can I afford this EMI?"
- "Am I overspending on food?"
- "Is this transaction suspicious?"
- "How much can I save this month?"
- "Remind me before credit card due date."
- "Should I move idle money to FD?"

The user-supplied flow is:

```
User question
  → Retail persona router
  → Fetch transactions / balances / goals
  → Deterministic calculators
  → Risk / budget / savings agent
  → LLM explanation
  → Optional action: reminder, alert, support ticket
```

The split between **deterministic** and **LLM** is explicit:

| Deterministic | LLM |
|---|---|
| balance calc, spend total, EMI affordability, fraud rule checks, due-date checks | explain spending behavior, summarize insights, ask follow-up, personalize tone |

The required deliverable is an architecture using **LangGraph**, with a clear
**LLD**, showing **how DAG agent components talk to each other**, **what tool
calls each agent makes**, and a **diagram**.

The user also lists the qualities they want this design to showcase:

- **Technical:** modular Python, clean interfaces, unit testing, rule-engine
  thinking, deterministic evaluation, JSON/schema-driven workflows.
- **AI systems:** ReAct reasoning, tool invocation, structured outputs,
  multi-step reasoning, reflection/self-correction.
- **Operational:** explainability, auditability, failure handling, retry/recovery,
  observability.

## Scope (in)

- LangGraph DAG with named nodes, typed edges, and a single `BankerState`.
- Tool registry with JSON-schema-typed inputs/outputs.
- Persona router that classifies the question and shapes the DAG path.
- Deterministic calculator library (balance, spend, EMI, fraud, due dates).
- Sub-agents for risk, budget, savings — each one ReAct-style with a *bounded*
  tool surface.
- LLM explainer with structured output schema (`Explanation` Pydantic model).
- Optional action node with policy gate, idempotency, and HITL for high-risk
  actions.
- Memory: short-term (graph state), long-term (user goals/profile), episodic
  (conversation history), all PII-scoped per tenant.
- Reliability: per-node checkpointing, retries, deterministic replay.
- Observability: per-step OTel spans, prompt/response capture, eval harness.

## Scope (out)

- Wire transfers, account opening, KYC onboarding — explicitly handed off to
  human support or core banking flows.
- Trading / brokerage advice beyond "basic investment education" with
  regulator-aligned disclaimers.
- Underwriting decisions (the agent can *check* eligibility rules but never
  *issues* credit).

## Assumptions

| # | Assumption | Why it matters |
|---|---|---|
| A1 | Bank already exposes a Core Banking API (accounts, transactions, cards, deposits) with mTLS + OAuth. | The agent is a *layer above* core banking, not a replacement. |
| A2 | Per-user tenant boundary is the customer ID; agent never queries cross-customer. | Required for DPDP / RBI data residency and SOC-2-style isolation. |
| A3 | LLM provider is **untrusted by default**: prompts and tool outputs are sanitized of full account numbers / PAN before egress. | Limits provider-side data exposure. |
| A4 | Hindi + English are MVP languages; tone adapts per locale. | India retail bank context implied by ₹ symbol and EMI. |
| A5 | The "agent" is a workflow runtime, not a single LLM call. Most user questions fan out 2-6 tool calls. | Sets the perf budget (sub-3s p95 conversational, sub-15s p95 deep-analysis). |

## Resume anchors used

| Anchor | Source | How it grounds this design |
|---|---|---|
| LangGraph/LangChain ReAct runtime, DAG orchestration, 10K+ agent runs/day | `resume.txt` L51-54 | Justifies LangGraph as the orchestration spine. |
| Durable execution, checkpointing, retry semantics, memory persistence | `resume.txt` L52-54, `blackbox-experience.md` #12-#15 | Reliability section is not theoretical. |
| Model router across Claude/GPT/Grok with capability-aware routing, 1B+ tokens/month | `resume.txt` L55-56, `blackbox-experience.md` #16-#19 | Cost + provider-failover sections. |
| LLMOps telemetry mesh, 50M spans/day, deterministic replay, 60% MTTR cut | `resume.txt` L58-59, `blackbox-experience.md` #20 | Observability + replay sections. |
| Rule-engine + deterministic systems at ShareChat, 40M DAU ad targeting | `resume.txt` L109-114 | Rule-engine design of the fraud + budget + EMI calculators. |
| Real-time streaming analytics at IQLECT Ampere | `resume.txt` L130-131 | Transaction-feed ingestion model. |

## Grounding confidence

**High** for the agentic-runtime, model-routing, memory, and telemetry portions
(direct BlackBox experience). **Medium** for the banking-domain rules (fraud,
EMI, FD) — these are anchored in industry-standard practice, with explicit
assumption labels where I extrapolate.
