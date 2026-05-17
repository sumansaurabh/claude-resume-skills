# 01 - Executive Summary

## The one-paragraph version

The Retail Banker is a **LangGraph DAG** of small, single-responsibility nodes.
A **router node** classifies the user question into one of ~10 intents, which
selects the **DAG path**. **Fetch nodes** pull deterministic data (balances,
transactions, goals) via **typed tool calls** against the Core Banking API.
**Calculator nodes** run pure Python (`balance_drop`, `spend_by_category`,
`emi_affordability`, `fraud_rules`, `due_date_check`) — every number an
interviewer can re-compute by hand. **Sub-agents** (Risk, Budget, Savings) are
**bounded ReAct loops** that may call additional tools, but only within their
tool allowlist. An **Explainer** LLM node takes the structured findings and
produces a **schema-validated** `Explanation` object. An optional **Action**
node, behind a **policy gate**, performs the actual side effect (set reminder,
raise dispute ticket, propose FD sweep) with **idempotency keys** and **HITL**
for anything that moves money.

The LLM never touches a number it could get wrong. It only narrates numbers the
deterministic plane has already computed.

## The 7 design moves that matter

1. **Hybrid plane.** Deterministic Python computes; LLM narrates. Numbers are
   auditable; narration is humane.
2. **LangGraph DAG, not a chat loop.** Each node is independently testable,
   checkpointable, and replayable. ReAct happens *inside* a sub-agent, not at
   the top.
3. **Tool calls are typed contracts.** Every tool has a Pydantic input schema,
   a Pydantic output schema, and a JSON-schema export for the LLM's
   `function_calling` API.
4. **Bounded sub-agents.** Risk/Budget/Savings agents have an allowlist of
   tools and a max iteration cap. They cannot escape their lane.
5. **Structured-output everywhere.** The Explainer returns
   `Explanation { headline, drivers[], recommendation, confidence, citations[] }`,
   not free text. UI parses the object, never regexes prose.
6. **Policy gate before action.** No write ever happens without (a) explicit
   user intent, (b) deterministic eligibility check, (c) HITL approval for
   money-moving actions.
7. **Replayable traces.** Every run emits an OTel trace with prompts,
   tool inputs/outputs, model IDs, and seeds — so any "the agent said
   something weird" report becomes a deterministic replay, not an
   investigation.

## What this looks like at the interview level

> "I'd model it as a LangGraph DAG with a router, fetch nodes, deterministic
> calculator nodes, three bounded sub-agents — risk, budget, savings — and an
> explainer node that emits a Pydantic-validated `Explanation`. Numbers come
> from pure-Python calculators; narration comes from the LLM. Side effects sit
> behind a policy gate with HITL. Reliability is `LangGraph`'s checkpointer +
> idempotency keys on tool calls. Observability is per-node OTel spans with
> prompt+tool capture for deterministic replay — the same pattern we ran at
> BlackBox for 50M spans/day." (`resume.txt` L51-59)

## What this design refuses to do

- **Refuses to let the LLM compute money.** All ₹ amounts come from
  calculators.
- **Refuses to let an agent execute a money-moving action without a human.**
  Reminders, alerts, support tickets are auto; FD sweep, dispute filing, EMI
  prepayment are HITL.
- **Refuses unbounded ReAct.** Every sub-agent has `max_iterations` and a
  tool allowlist; an infinite loop is a bug, not a feature.
- **Refuses to ship raw PII to the model.** Account numbers and PAN are
  tokenized before prompt construction; the LLM sees `acct_***1234`.
