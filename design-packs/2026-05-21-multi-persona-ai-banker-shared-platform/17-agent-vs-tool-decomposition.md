# 17 - Agent vs Tool vs Node: Decomposition Rationale

> **Purpose.** This file is a reasoning guide, not a spec. It explains *why* every
> agent in this pack exists, what makes it earn being an agent (versus being a
> tool, a single node, or a parameter on another agent), and how to decide for
> any future capability whether to build an agent, a tool, or just a node.
>
> Read this when you find yourself asking *"should this be a subagent?"* - the
> answer is usually "no" and this file gives you the framework to know why.

---

## 1. The three categories - sharp definitions

A multi-agent runtime has three primitive building blocks. The architecture only
stays sane if you put each piece of work into the right one.

### 1.1 Tool

A **tool** is a deterministic-or-stateless call: fixed input shape → fixed
output shape, single round-trip, no internal planning.

A tool can:
- Run pure code (the Calc Service running a runway formula)
- Call an external API once (Plaid `accounts.balance`, RazorpayX `payouts.create`)
- Run a single LLM call with a fixed prompt (e.g., a one-shot classifier)

A tool **cannot**:
- Decide *which other tool to call next*
- Loop on intermediate results
- Revise a plan based on what it saw

If your "tool" needs to make a choice about what to do next, it has secretly
become an agent. Catch it early.

### 1.2 Node

A **node** is a single graph step that does one thing - typically a fixed
sequence of operations that don't require LLM reasoning to decide the next move.
Nodes are the bones of the graph; agents are nodes that happen to reason.

Nodes that aren't agents in this pack:
- `IntakeAndPersona` - load tenant, persona, entitlements; no choice to make.
- `ContextBuilder` - load memory tiers and KB chunks per a fixed policy.
- `Router` - match a predicate, dispatch. Pure switch statement.
- `Aggregator` - merge sub-states by fixed rules.
- `PersonaAdapter` - one-shot tone re-write LLM call (single prompt, no planning).
- `HITLGate` - checkpoint and pause; control-flow only.
- `Terminator` - finalize the response envelope.
- `CalcInvoker` - wraps the deterministic Calc Service; passes through.
- `ToolCaller` - wraps the Tool Router; passes through.

These are nodes. None of them earn being called an "agent" because none of them
need to plan-and-revise.

### 1.3 Agent (subagent)

An **agent** is a node that does **plan → act → observe → revise** at least once
within its execution. It picks tools based on intermediate results, may call
multiple tools (possibly in different orders for different inputs), may re-plan
when an observation contradicts its assumption, and synthesizes a result.

The bar is honest: if the work can be done with a fixed pipeline of tool calls,
it's not an agent - it's a sequence of nodes. If the choice of next tool depends
on what the previous tool returned, it's an agent.

### 1.4 The orchestrator (supervisor)

There is exactly **one** orchestrator per platform - the supervisor that runs
the LangGraph topology, dispatches to subagents, holds the durable run state,
manages HITL pauses, handles checkpointing, enforces budgets and hop caps.

Creating a second orchestrator is almost always the wrong answer. Personas, new
verticals, new regulators - none of these justify a second orchestrator. They
get expressed as parameters, policy bundles, persona-compiles, or new
subagents on the existing orchestrator. The reasoning for one shared
orchestrator is in `01-executive-summary.md` and isn't repeated here.

---

## 2. The decision framework - when to build what

Use this in order. Stop at the first one that fits.

### 2.1 Is the work deterministic computation?

If the output is a function of the input with no judgment required (math,
schema transforms, lookups, format conversion) → **tool**, not agent.

> *Example:* "Compute weeks-to-cash-zero given balance, weekly burn, expected
> inflows." This is arithmetic. It lives in the Calc Service. The LLM never
> does this - it calls a tool that does. Hallucinated arithmetic in banking
> is unrecoverable, which is why the **deterministic boundary** is a hard
> wall (`01-executive-summary.md`, `15-guardrails.md`).

### 2.2 Is the work a single, fixed-shape transform?

If the work is "take this input, do one LLM call with a fixed prompt, return
the output" with no decision about what to do next → **node**, not agent.

> *Example:* PersonaAdapter takes the aggregated advisory draft and re-tones
> it. One prompt, persona-conditional, single call, no follow-up reasoning.
> It's a node, not a subagent. Making it a subagent would add zero reasoning
> value and one extra checkpoint round-trip.

### 2.3 Does the work require choosing the next call based on what the previous call returned?

If yes → **agent**, not node.

If no → it's either a tool (if deterministic) or a node (if it's a single
fixed-shape transform). Don't build an agent for work that doesn't reason.

> *Example:* CashflowForecaster decides whether to pull invoice data based on
> whether the bank-data projection has high variance. The "do I also pull
> invoices?" decision is reasoning over intermediate results. That makes it
> an agent.

### 2.4 If you've decided it's an agent - is the reasoning skill reusable across audiences?

If yes (same skill serves Retail, SME, CFO with parameter tweaks) →
**capability subagent** (decomposition axis = capability).

If no (the skill genuinely only makes sense for one audience) → check again,
because this is rare. Most "persona-specific" reasoning turns out to be the
same reasoning with a different audience parameter. If you're sure, it's a
persona-scoped subagent - but the burden of proof is on you to defend why.

> *Why the burden of proof is on you:* persona-decomposition forces
> duplication of every capability across personas. CashflowForecaster needs to
> live in RetailAgent (for runway), SMEAgent (for payroll cushion), and
> CFOAgent (for treasury position) - three implementations, three eval suites,
> three sets of prompt drift. See §6 for the full anti-pattern.

### 2.5 If the reasoning genuinely varies by audience, is it tone or is it logic?

Tone differences → **PersonaAdapter** (single node, persona-conditional prompt).

Threshold / RBAC / cadence differences → **PolicyConfig parameter** loaded by
IntakeAndPersona, consumed by existing agents.

Logic differences (the actual *reasoning chain* is different per persona) → only
*now* might you consider a persona-scoped agent. In this pack, there is no
single specialist where the reasoning chain genuinely differs per persona - every
case turned out to be tone + threshold + RBAC. That's why no persona-scoped
agents exist.

---

## 3. The decision tree, visualized

```
                       Is the output a function
                       of the input (math, lookup,
                       format transform)?
                                 │
                       ┌─────────┴─────────┐
                      YES                  NO
                       │                   │
                    TOOL              Does choosing the
                  (Calc Service,      next step depend on
                   Plaid call, etc.)  what the previous
                                      step returned?
                                            │
                                  ┌─────────┴─────────┐
                                 NO                  YES
                                  │                   │
                            Is it a single       Is the reasoning
                            LLM transform?       skill reusable
                                  │              across audiences?
                          ┌───────┴──────┐              │
                         YES            NO    ┌─────────┴─────────┐
                          │             │    YES                  NO
                       NODE         (multiple   │                   │
                  (PersonaAdapter,  fixed steps  │            (truly persona-
                   Aggregator,      → sequence   │             specific logic)
                   IntakeAndPersona)of nodes)    │                   │
                                            CAPABILITY        Defend why it
                                            SUBAGENT          isn't tone +
                                          (CashflowForecaster, threshold +
                                           TreasuryAdvisor,    RBAC. Almost
                                           AnomalyExplainer,   never the case.
                                           etc.)
```

---

## 4. Walking every agent in this pack - why it exists

For each specialist, the rationale is structured as:

- **What it does** - one-paragraph description
- **Why it earns being an agent** - the plan-act-observe loop it runs
- **What tools it calls** - the deterministic primitives it composes
- **Why it's not just a tool** - the reasoning that can't live in a tool
- **Why it's not just a node** - the iteration that can't live in a fixed pipeline
- **Why it's not persona-forked** - the same skill serving multiple audiences
- **The collapse case** - under what change would it become a tool or node

### 4.1 CashflowForecaster

**What it does.** Projects cash position over a horizon (1–26 weeks). Returns
expected trajectory, confidence interval, and the line items driving the
projection.

**Why it earns being an agent.** The reasoning chain is genuinely iterative.
The agent pulls bank balance → notices an AR-aging concern from invoice data →
decides to re-run the projection with a delayed-payment assumption → notices
the seasonal pattern from historical data → adjusts the trend model → asks
Calc for best/expected/worst scenarios → synthesizes the confidence interval
from the scenario spread → decides which line items to surface as drivers.
Steps 2, 3, 4, 7 are choices made on intermediate results. A fixed pipeline
cannot do this because the *right next call* depends on what the AR data
looked like.

**What tools it calls.** `bank.balance`, `accounting.invoices_outstanding`,
`accounting.recurring_bills`, `accounting.historical_inflows`, `payroll.next_run`,
`Calc.project_cashflow`, `Calc.scenario_band`.

**Why it's not just a tool.** A tool can compute a single projection given
clean inputs. It cannot decide what counts as a clean input, when to discount
an AR invoice as unlikely-to-clear, or which of three valid projection models
fits this user's data shape. These are judgments.

**Why it's not just a node.** A fixed pipeline (always pull bank + invoices +
recurring → always run flat projection) would either work poorly for users
without invoices (Retail) or under-use the data for users with rich
integrations (CFO). The right pipeline shape depends on the data shape, which
is only known after the first tool call.

**Why it's not persona-forked.** Retail asks "what's my runway?", SME asks
"will I make payroll?", CFO asks "what's my entity-level cash position?". The
*data sources* differ (Retail has no invoices), but the *reasoning skill* is
identical: pull available cash signals, model trajectory, identify drivers,
report with calibrated confidence. The Planner picks which tools the agent
has access to based on persona; the agent's reasoning is the same.

**The collapse case.** If we ever decided that all forecasting is
flat-extrapolation only and the user can't ask follow-up scenario questions,
CashflowForecaster collapses to a tool. That'd be a much weaker product.

### 4.2 SpendingCoach

**What it does.** Reviews recent spending, identifies categories that crossed
budget or pattern thresholds, decides whether to nudge, drafts the nudge with
calibrated specificity.

**Why it earns being an agent (with hedge).** The chain is: classify recent
transactions by category → check each against the budget envelope → cross-
reference with the user's history (is this a one-time event or pattern?) →
check fatigue cooldown (has the user been nudged about this category in the
last N days?) → pick a nudge tier (silent / educational / actionable) → draft
the message with citations. Multi-step, with branching on intermediate
results. Borderline - could be one fat prompt with all the rules - but the
iteration is real once you add the fatigue check and the pattern-vs-event
classification.

**What tools it calls.** `bank.recent_transactions`, `memory.user_categories`,
`memory.recent_nudges`, `Calc.budget_envelope`, `policy.nudge_eligibility`.

**Why it's not just a tool.** "Send a nudge if budget exceeded" is the
five-line version. The real reasoning is the fatigue check, the
pattern-vs-event call, and the specificity calibration ("you spent 12K on
food this month" vs "your weekend takeout is up 40% vs your 90-day baseline").
None of those land cleanly in a single tool.

**Why it's not just a node.** Same reason - the right next call (fatigue
check, history lookup) depends on what the budget check returned.

**Why it's not persona-forked.** SpendingCoach is currently Retail-only by
compile (CFO doesn't get coached on spending). But the *skill* - classify,
threshold, calibrate nudge, draft - would be identical if we ever launched a
"Junior Banker" persona. We'd extend the persona compile, not duplicate the
agent.

**The collapse case.** If we drop fatigue management and the pattern check,
SpendingCoach collapses to a tool that takes transactions and returns a nudge.
We'd lose meaningful product quality.

### 4.3 TreasuryAdvisor

**What it does.** Advises on multi-entity treasury position: cash sweeps, FX
exposure, MMF allocation, intercompany positions. CFO-only by compile.

**Why it earns being an agent.** Treasury reasoning is structurally
multi-step: pull positions across entities → assess FX exposure relative to
target hedge ratio → consider sweep timing (idle cash earning sub-optimally?)
→ check MMF allocation drift → cross-reference with upcoming obligations
(payroll, tax, debt service) → recommend actions with HITL-staged proposals.
Each step's relevance depends on prior findings (a CFO with no FX exposure
skips the FX branch entirely).

**What tools it calls.** `treasury.positions_by_entity`, `treasury.fx_exposure`,
`treasury.mmf_positions`, `bank.intercompany_balances`, `Calc.optimal_sweep`,
`Calc.fx_hedge_ratio`, `accounting.upcoming_obligations`.

**Why it's not just a tool.** No single tool composes multi-entity sweep
recommendations against FX exposure against upcoming obligations. That's
synthesis across heterogeneous signals - agent work.

**Why it's not just a node.** Same - branch-depends-on-result.

**Why it's not persona-forked.** It's only compiled for CFO. But the reason
isn't that "this is CFO logic" - it's that Retail and SME don't have
multi-entity treasury, so the tools wouldn't return anything. If we ever
launched "SME Treasury Lite" (single-entity sweeps), the same agent would
serve it with a parameter.

**The collapse case.** No realistic collapse. Treasury reasoning is
intrinsically multi-step.

### 4.4 PayrollReadinessAgent

**What it does.** Answers "can I make payroll on date X?" with a confidence
band and a list of risks.

**Why it earns being an agent.** Pull payroll obligation (amount, date) →
pull bank balance and reserves → pull expected inflows by date → for each
inflow, assess timing confidence (overdue invoice? historical on-time rate?) →
run Calc.payroll_coverage with weighted-inflow scenarios → identify the
specific risk drivers → recommend either "you're fine," "you're tight,
here's why," or "you need to act - here's what." The right inflows to
re-weight depend on what the AR data shows.

**What tools it calls.** `payroll.next_run`, `bank.balance`,
`accounting.invoices_outstanding`, `accounting.ar_aging`,
`Calc.payroll_coverage`, `Calc.scenario_band`.

**Why it's not just a tool.** A tool can answer "balance >= payroll?" - a
toy. The real question requires assessing inflow timing risk, which is a
reasoning step over historical AR behavior.

**Why it's not just a node.** Same as above.

**Why it's not persona-forked.** SME and CFO both ask this. The reasoning is
identical; the only difference is CFO might be asking about a sub-entity (one
extra parameter for entity_id).

**The collapse case.** If we drop AR-timing risk assessment, this becomes a
tool. We'd ship a product that lies confidently - bad.

### 4.5 AnomalyExplainer

**What it does.** A transaction (or pattern) is flagged as unusual. Explain
what happened in plain language, with attribution and recommended next step.

**Why it earns being an agent.** Pull the flagged transaction's full context
→ classify the anomaly type (new merchant? unusual amount? unusual time? rapid
sequence?) → for each candidate type, run the right cross-reference: new
merchant → check merchant database + user's historical merchants; unusual
amount → check user's spend distribution for the category; rapid sequence →
check fraud signals → decide between "benign - here's why," "worth
confirming," "likely fraud - recommend action." The cross-reference to run
depends on the anomaly classification.

**What tools it calls.** `bank.transaction_details`, `merchant.lookup`,
`memory.user_merchant_history`, `memory.user_spend_distribution`,
`fraud.signals`, `Calc.deviation_score`.

**Why it's not just a tool.** A tool returns "this transaction is 3.2 sigma
from the mean." The agent decides whether that's a sigma worth talking about,
why it happened, and what to suggest.

**Why it's not just a node.** Branch-depends-on-result, again.

**Why it's not persona-forked.** Anomaly explanation logic doesn't change by
persona. CFO gets it in different tone via PersonaAdapter; the reasoning is
the same.

**The collapse case.** If we only ever say "this transaction is unusual,"
this collapses to a tool. We'd ship a product that flags without explaining -
useless.

### 4.6 InvoiceARAgent

**What it does.** Manages accounts-receivable workflows for SME: identify
overdue invoices, prioritize collections, draft follow-ups.

**Why it earns being an agent.** Pull AR aging → for each overdue invoice,
pull the customer's payment history → assess relationship sensitivity (key
customer? small one-time?) → pick follow-up tier (gentle reminder /
escalation / collections referral) → draft message in customer-appropriate
tone → check HITL gate for high-value collections. The right action per
invoice depends on the per-customer history.

**What tools it calls.** `accounting.invoices_outstanding`,
`accounting.customer_payment_history`, `crm.customer_profile`,
`messaging.draft_follow_up`, `policy.collection_thresholds`.

**Why it's not just a tool.** A tool lists overdue invoices. The reasoning
about *which to chase and how* lives above the tool.

**Why it's not just a node.** Per-invoice branching.

**Why it's not persona-forked.** SME-only by compile, same logic-applies-once
reasoning as TreasuryAdvisor.

**The collapse case.** If we only ever sent generic dunning emails on a
schedule, this collapses to a tool + cron.

### 4.7 RetrievalAgent

**What it does.** Plans retrieval across memory tiers + KB chunks given a
query: decides which collections to hit, how to rewrite the query, how to
rerank, and when to abandon retrieval as low-value.

**Why it earns being an agent.** Naive RAG is a node - embed query, search,
return top-K. RetrievalAgent does more: classify the query intent → decide
whether memory (user history) or KB (regulatory/contract corpus) or both →
rewrite the query for each (HyDE-style expansion for KB; canonicalization for
memory) → run searches → rerank with cross-encoder → if top-1 score is below
threshold, retry with a different query rewrite or expand scope. The retry
decision is reasoning over intermediate results.

**What tools it calls.** `memory.search`, `kb.search`, `rerank.cross_encoder`,
`query.rewrite`.

**Why it's not just a tool.** Tools embed and search. They don't decide
*what* to search or *how* to recover from a low-confidence result.

**Why it's not just a node.** Single-shot RAG is a node and would be cheaper.
The agent earns its weight when the query is genuinely ambiguous or when the
first retrieval misses - common enough in financial advisory contexts that
the iteration pays for itself.

**Why it's not persona-forked.** Identical reasoning for all personas; only
the *scope* of accessible memory tiers and KB collections differs per persona
(RBAC parameter).

**The collapse case.** If we accept single-shot RAG quality, this collapses
to a node. We'd ship worse retrieval, especially for complex CFO queries.

### 4.8 ProactiveAuthor

**What it does.** A trigger event fired (salary credited / budget breached /
FX moved beyond threshold). Decide whether to notify, with what message, on
what channel, with what urgency.

**Why it earns being an agent.** Pull the trigger context → check
eligibility (cooldown, fatigue, opt-in) → check competing pending nudges
(should this one supersede another?) → check user's recent context (don't
nudge about budget if user just had a conversation about it 5 minutes ago) →
draft the message with persona-tone → pick channel based on urgency and user
preference → schedule. The cooldown/fatigue/competing-nudges checks branch on
state.

**What tools it calls.** `trigger.context`, `memory.recent_nudges`,
`memory.recent_conversations`, `policy.nudge_rules`, `messaging.draft_nudge`,
`channel.preferences`.

**Why it's not just a tool.** "Send a notification" is a tool. "Decide
whether to send, what to send, on what channel, with what tone, given the
user's state" is reasoning.

**Why it's not just a node.** Iteration on competing-nudges and
fatigue-vs-urgency.

**Why it's not persona-forked.** Same author, persona-conditional cadence
and tone come from PolicyConfig + PersonaAdapter.

**The collapse case.** If we drop fatigue/competing-nudges/context-aware
suppression and just notify on every trigger, this is a tool. We'd be
notification spam, which is the *exact* failure mode the prep guide flags as
fatal.

### 4.9 AdvisoryComposer

**What it does.** Synthesizes outputs from one or more specialists into a
coherent advisory response. The lightest of the specialists.

**Why it earns being an agent (the weakest case).** Single-shot synthesis
would be a node. AdvisoryComposer earns agent status because it does light
planning: decide structure based on intent (Q&A / advisory / proactive
nudge / approval request) → decide which specialist outputs to lead with →
decide how much to hedge based on aggregated confidence → draft → check that
all monetary claims trace to Calc outputs (provenance) → revise if not. The
provenance check + revise step is the reasoning loop.

**What tools it calls.** None directly - it composes over `partial_outputs`
and `calc_results` already in state.

**Why it's not just a tool.** Composition over heterogeneous specialist
outputs with a provenance check is not a fixed transform.

**Why it's not just a node.** The provenance-check-and-revise loop is the
reasoning. Without it, this is a node.

**Why it's not persona-forked.** Composition logic is persona-invariant;
tone comes downstream from PersonaAdapter.

**The collapse case.** Drop the provenance check; this becomes a node. We'd
ship advisories with un-grounded numbers - the deterministic boundary fails
silently, the prep guide's #1 sin.

### 4.10 ApprovalCoordinator

**What it does.** Workflow agent. Takes an approved-action proposal,
constructs the saga (`08-reliability... §4.1`), determines the approver
sequence (single / multi / quorum), dispatches HITL requests, monitors
responses, advances the saga step-by-step.

**Why it earns being an agent (workflow-class).** The reasoning is in
deciding the saga shape: for a single-approver SME action, it's one HITL
ticket; for a multi-approver CFO action, it's quorum logic; if any saga
step's forward fails, the agent decides whether to retry the forward, run
compensations, or escalate. This isn't capability reasoning (it doesn't
forecast cashflow); it's workflow reasoning. Still earns agent status
because the next step depends on the prior step's result.

**What tools it calls.** `policy.approver_routing`, `hitl.dispatch_ticket`,
`hitl.poll_decision`, `saga.execute_forward`, `saga.execute_compensation`,
`audit.write`.

**Why it's not just a tool.** Saga management with branching on per-step
results is not a tool.

**Why it's not just a node.** The execute-and-revise loop is the work.

**Why it's not persona-forked.** Approver routing and quorum rules come
from PolicyConfig per persona; the workflow logic is the same.

**The collapse case.** If we only ever did single-approver flows with no
compensation, this collapses to a node + tool. We'd lose CFO viability.

### 4.11 Critic

**What it does.** Evaluates an aggregated draft against quality rules:
factual grounding (do monetary claims trace to Calc?), policy compliance
(does it follow tone / hedging rules?), refusal correctness (did we refuse
something we shouldn't have? or vice versa?).

**Why it earns being an agent (the lightest case).** Could be a tool wrapper
around a fixed eval prompt. Earns agent status because the Critic *decides
the verdict class* (ACCEPT / REVISE / REJECT) and *picks the revision
guidance* based on which checks failed. The picking-guidance step is the
reasoning.

**Why it's not persona-forked.** Quality rules are tightened per persona
(CFO has stricter grounding) via PolicyConfig; the Critic itself is the
same.

**The collapse case.** Drop the revision guidance and just return a verdict
score; this becomes a tool. The plan-revise-replan loop in the graph
(`Critic → Planner` allowed once) collapses too.

### 4.12 Planner

**What it does.** Decomposes the user request (or trigger event) into a
plan of specialist calls.

**Why it earns being an agent (workflow-class).** Single LLM call producing
a plan - could be a node. Earns agent status because Critic can reject a
plan and Planner re-runs with revision guidance, and because Planner can
return an empty plan (refusal) when no specialist is appropriate. The
revise-on-Critic-rejection loop is the reasoning.

**Why it's not persona-forked.** The set of available specialists per
persona is a parameter (compile-time); the planning skill itself is
identical.

**The collapse case.** If Critic could only ever accept, Planner is a node.
We'd lose plan-quality recovery.

---

## 5. Walking the *non-agent* nodes - why they aren't agents

For balance, here's why each non-agent node is correctly a node.

| Node | Why it's not an agent |
|---|---|
| **IntakeAndPersona** | Fixed sequence: parse envelope, look up tenant, set persona, set budget. No branch-on-result reasoning. |
| **ContextBuilder** | Loads memory tiers and KB chunks per a fixed policy. If reasoning about *what to retrieve* is needed, it delegates to RetrievalAgent. |
| **Router** | Pure switch statement over typed state. No reasoning, just dispatch. |
| **CalcInvoker** | Wraps the Calc Service. The reasoning about *which formula to call* lives in the calling specialist, not here. |
| **ToolCaller** | Wraps the Tool Router. Same as above - reasoning lives upstream. |
| **PersonaAdapter** | Single LLM call with persona-conditional prompt. No follow-up reasoning, no tool calls. |
| **HITLGate** | Pure control flow: checkpoint, pause, emit event. No reasoning. |
| **HITLResume** | Pure control flow: receive approval event, update state, route back. No reasoning. |
| **Aggregator** | Fixed merge rules over sub-states. No reasoning. |
| **Terminator** | Builds the final response envelope. Fixed transform. |
| **RejectionExplainer** | Single LLM call to explain why an action was rejected. One prompt, no iteration. |
| **ForcedTermination** | Pure control flow: build a fallback envelope and exit. |
| **FallbackHandler** | Classifies an error as recoverable/unrecoverable and routes. Light branching but no real reasoning. |

If any of these grow a "decide what to do next based on what we just saw"
loop, they should be promoted to agents or have the new reasoning extracted
into one. Be alert for this drift - it's how nodes silently become god-nodes.

---

## 6. The four anti-patterns to avoid

### 6.1 The god-agent

Putting all of a persona's reasoning into one giant agent (`SMEAgent`,
`CFOAgent`) with a 10K+ token system prompt covering every skill that
persona needs.

**Why it fails.** Skill changes regress each other (improving spending
coaching breaks payroll readiness because they share context). No per-skill
eval. Massive per-call context cost. Can't reuse a skill across personas
without duplicating.

**The fix.** Decompose on capability. One skill = one agent. Persona is a
parameter loaded at IntakeAndPersona.

### 6.2 The router-as-agent

Making a subagent whose only job is to look at the request and pick another
agent.

**Why it fails.** It's a 3-line `if` statement wearing an agent costume. Adds
a graph hop, a checkpoint write, and a telemetry layer for zero reasoning
value.

**The fix.** That's what Router is. It's a node, not an agent. If you find
yourself building a router-shaped agent, you've conflated dispatch with
reasoning.

### 6.3 The tool wearing an agent costume

Wrapping a single deterministic call in an "agent" because it feels more
sophisticated.

**Why it fails.** All the cost of an agent (LLM call to do nothing, an extra
hop, more state) for none of the benefit (no plan-revise loop, no
multi-tool composition).

**The fix.** Call the tool directly. If you find yourself adding an LLM
hop to "interpret" a deterministic result before returning it, ask whether
the interpretation is actually reasoning. If not, the calling agent can
interpret in its own prompt.

### 6.4 The persona-fork mistake

Creating per-persona subagents (RetailAgent / SMEAgent / CFOAgent) because
the personas *feel* like different kinds of customer.

**Why it fails.** Every capability has to be built three times. Three eval
suites. Three places where prompt drift can land. Cross-persona requests
(SME owner asks about personal account) force agent-to-agent invocation,
which is the one communication pattern the architecture explicitly forbids.

**The fix.** Personas are audiences. Capabilities are reasoning. Decompose
on capability; parameterize on audience. The single PersonaAdapter node
handles tone re-write.

---

## 7. Tests you should run on any proposed new agent

Before you create a new subagent in this system, walk these questions and
write the answers down. If you can't answer all six convincingly, don't
create the agent.

1. **What is the reasoning skill in one sentence?**
   *("Forecasts cashflow given partial data with calibrated confidence.")*
2. **Walk me through the plan-act-observe loop.**
   *("Pull bank → if AR data available, pull → notice variance → re-run
   with adjusted assumption → ...")*
3. **What's the fixed-pipeline version, and why does it fail?**
   *("Always pull bank + invoices + recurring, always project linearly.
   Fails because Retail users have no invoices and CFOs need scenario
   bands.")*
4. **What's the single-LLM-call-with-tools version, and why does it fail?**
   *("One mega-prompt with all rules and all tools. Fails because the model
   can't plan, observe, and re-plan in one shot for non-trivial cases.")*
5. **Is this reasoning reusable across at least two personas?**
   *(If yes → capability subagent. If no → think harder; almost always yes.)*
6. **What's the collapse case - under what change would this become a tool
   or a node?**
   *(If you can't name a meaningful product loss, it probably shouldn't be
   an agent to begin with.)*

---

## 8. Quick reference card

Pin this to your monitor:

| If… | Then it's a… |
|---|---|
| Math, lookup, format transform | **Tool** |
| Single external API call | **Tool** |
| Single LLM call with fixed prompt, no follow-up | **Node** |
| Sequence of fixed steps, no branching on results | **Sequence of nodes** |
| Multi-step, choice of next step depends on prior result | **Capability subagent** |
| Same reasoning, different tone per audience | **PersonaAdapter (one node)** |
| Same reasoning, different threshold/RBAC per audience | **PolicyConfig parameter** |
| Genuinely different reasoning per audience | (Rare - prove it before forking) |
| Routes between agents based on state | **Router (node)** |
| Wraps a deterministic call with an LLM "interpretation" | **Probably a tool - drop the LLM** |
| Workflow control (HITL, saga, approval routing) | **Workflow agent** |
| Pure control flow (checkpoint, pause, exit) | **Node** |

---

## 9. The summary in one paragraph

The decomposition axis of this platform is **capability, not audience**.
Capabilities are reasoning skills with plan-act-observe loops over external
data - they earn being agents. Audiences are who's asking, and they vary on
tone, RBAC, thresholds, cadence, and budget - they're parameters. Tools are
deterministic primitives that never reason; nodes are fixed graph steps with
no internal decision-making. The orchestrator is exactly one and orchestrates
across the capability subagents. Persona is one column of metadata that
gates which capabilities are reachable and how the output is toned - never a
fork in the runtime, never a subagent boundary, never an orchestrator copy.
Get this axis right and every future addition (new capability, new persona,
new regulator, new region) is an additive change to the platform; get it
wrong and every addition multiplies the work you've already done.
