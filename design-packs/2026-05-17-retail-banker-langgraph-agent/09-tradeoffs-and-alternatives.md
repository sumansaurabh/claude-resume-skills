# 09 - Tradeoffs and Alternatives

## The five load-bearing design choices, and what we rejected

| Decision | Picked | Rejected | Why |
|---|---|---|---|
| Orchestration | **LangGraph DAG** | LangChain single-agent ReAct | LangChain at scale is opaque, hard to checkpoint, and tool use is unbounded. Same lesson learned at BlackBox (`resume.txt` L51-52). |
| Compute split | **Deterministic Python + LLM narrator** | LLM-only ("ask Claude with banking tools") | LLM-only can't guarantee numerical correctness. A ₹100 mistake in a balance answer is a regulator-facing problem, not a UX one. |
| Tool dispatch | **Typed registry, allowlist per node** | Free-form tool use | Free-form tool use lets a jailbroken LLM call write tools. Allowlist makes "bad tool call" a runtime error, not a policy bug. |
| Output | **Pydantic structured `Explanation`** | Free-text response | Free-text means UI parses prose; UI breaks on phrasing change; auditability collapses. Structured output is contract. |
| Memory | **Three-tier (working, episodic, long-term)** | Single vector store of "everything the user said" | Single vector store leaks across sessions, can't be schema-validated, hard to delete (DPDP). Tier separation gives clean retention + redaction. |

## Alternative orchestrators - why not them?

| Alternative | What it is | Why not (in this context) |
|---|---|---|
| **LangChain** (no graph) | Single agent with tool calling | No native checkpointing; hard to enforce bounded sub-agents; observability poor at scale. |
| **CrewAI** | Multi-agent "crew" abstraction | Agent-to-agent messages add an extra LLM call per hop; cost-prohibitive at 25M turns/day; less explicit than DAG. |
| **AutoGen** | Conversational multi-agent | Conversation transcripts grow unbounded; not built for low-latency conversational UX. |
| **Temporal / Cadence** | Durable workflow engine | *Excellent* primitive, but no first-class LLM/tool concept; we'd reinvent LangGraph on top. Real choice for a *back-office* agent (overnight batch reconciliations); overkill for conversational. |
| **Custom state machine + asyncio** | Hand-rolled | Maintenance burden of a runtime + checkpointer + replay; LangGraph already solves the boring parts. |
| **AWS Step Functions / Azure Durable Functions** | Hosted durable workflows | Vendor lock; latency overhead per step (~50ms each = 500ms over a 10-node DAG, killing the p95); pricing per state transition is hostile at this scale. |

We picked LangGraph because it is the smallest set of primitives that
give us DAG + checkpointing + typed state, while letting us own the
parts that matter (router, sub-agents, eval).

## Deterministic-vs-LLM split - challenges and answers

| Challenge | Answer |
|---|---|
| "Why not let the LLM do the math? Frontier models are good at arithmetic now." | They are *usually* good. "Usually" is unacceptable when the customer sees ₹. Even a 0.1% error rate means 25k wrong-number turns/day. |
| "Why not function-call the calculator from the LLM and skip the orchestrator?" | Because the *decision* of which calculator to call is the auditable part. Putting it in the LLM means a model regression silently changes what we compute. The router node makes that decision deterministic and reviewable. |
| "Reflection sounds like a hack. Why not just prompt-engineer harder?" | Reflection is a deterministic comparator, not another LLM call. The LLM can hallucinate a number; the comparator can't. |
| "Two LLM calls per turn (sub-agent + explainer) doubles your cost." | Tiered routing (Haiku for cheap paths, Sonnet for explainer) plus prompt caching keeps blended cost at ~$0.009/turn. Worth it for correctness. |

## Memory architecture - alternatives

| Approach | Verdict |
|---|---|
| Single vector store of everything | ✗ leaks, untyped, hard to delete |
| Per-conversation memory only | ✗ user gets ground-hog day every session |
| Per-conversation + long-term fact store | ✓ picked |
| Embedding-everything + RAG on every turn | ✗ expensive, noisy, retrieval drift |
| Schema'd `user_facts` + tight retrieval | ✓ picked; embeddings only on `summary` fields |

The schema'd `user_facts` table is essentially a rule-engine for the
LLM: "these are the typed facts you know about the user; do not infer
more." This is the same discipline as ShareChat's 22-attribute user
segmentation for ad targeting (`resume.txt` L112-114) - typed
attributes beat untyped embeddings when the downstream is a regulated
decision.

## Sub-agent shape - why bounded ReAct?

Three alternatives considered:

1. **No sub-agents** (single LLM step). Loses recoverability; one bad
   tool call wastes the whole turn.
2. **Unbounded ReAct.** Loses cost predictability; one runaway loop
   eats $$$.
3. **Bounded ReAct (picked).** Max iterations, tool allowlist, structured
   exit. Predictable cost ceiling, predictable latency ceiling,
   recoverable failures.

The `max_iters` ceiling is the seam where "agent" stops being magic
and starts being a normal distributed system. Same lesson from
BlackBox's durable execution work: a long-running agent that can't
bound itself is a long-running outage waiting to happen
(`blackbox-experience.md` #10-#13).

## Provider strategy

| Choice | Picked | Why |
|---|---|---|
| Single provider, single model | ✗ | Provider down = product down. |
| Single provider, multiple models | partial | Tiered routing within Anthropic is fine for cost, doesn't help availability. |
| Multi-provider with capability-aware routing | ✓ | What we ran at BlackBox at 1B tokens/month (`resume.txt` L55-56). Failover by capability class (tool-calling, structured output). |
| Self-hosted only | ✗ for MVP, ✓ for sub-agents at scale | Frontier model needed for explainer; sub-agents can move to a fine-tuned small model later. |

## Why not "just call the LLM with all the bank's data"

The temptation is real and the failure modes are five-fold:

1. **PII at egress.** Sending raw account/transaction data to a
   third-party LLM violates DPDP / RBI guidance.
2. **Cost.** 90-day transaction history per user × 10M users × every
   turn = a ~$100M/month bill.
3. **Latency.** Multi-megabyte prompts blow the 3s budget.
4. **Correctness.** Even with all the data, LLMs miscount. Not
   "sometimes" - measurably, in our golden set.
5. **Auditability.** "The model knew because it had the data" is not
   an audit answer. "The calculator computed it from these specific
   rows" is.

## When this design is wrong

Be honest about it:

- **For a Q&A-only product** (no actions, no memory, no math), this is
  over-built. A single LangChain call with RAG would ship faster.
- **For a back-office batch agent** (overnight reconciliation),
  Temporal is a better fit than LangGraph; this design optimizes for
  conversational latency.
- **For a single-tenant internal banker tool** (used by branch staff
  only), the policy/PII layers are over-spec'd. Use a stripped
  version.
- **If your bank doesn't have an LLMOps team**, the eval + replay +
  telemetry investment is too big to start with; start with a single
  intent, ship that, then grow.

Stating "wrong-fit" cases is part of the interview answer; it
demonstrates the design isn't a hammer looking for nails.
