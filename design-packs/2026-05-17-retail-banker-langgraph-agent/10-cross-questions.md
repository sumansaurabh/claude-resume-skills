# 10 - Cross-Questions

The interviewer pushback most likely to surface, with crisp answers.

## On the agentic shape

**Q1. "Why LangGraph and not just LangChain or plain function-calling?"**
LangGraph gives me three things the others don't have natively: a
checkpointed `BankerState` (so a worker crash mid-turn is recoverable);
explicit graph edges (so the next node is auditable, not "whatever the
LLM decided"); and a clean separation between deterministic and LLM
nodes. At BlackBox we ran this same shape for 10K+ agent runs/day
(`resume.txt` L51-54). LangChain alone gives me a chat loop;
function-calling alone gives me one LLM step.

**Q2. "What does a 'sub-agent' actually mean here? Isn't ReAct enough at
the top level?"**
A sub-agent is a *bounded* ReAct loop with a tool allowlist and a max
iteration cap, scoped to one domain (risk / budget / savings). Putting
ReAct at the top makes every tool reachable from every prompt and the
graph becomes a chat loop. Putting bounded ReAct inside one node makes
the *outer* DAG predictable while the *inner* loop is still flexible
where it has to be.

**Q3. "Three sub-agents feels arbitrary. Why not one or ten?"**
The split is functional, not aesthetic: risk uses different tools
(fraud rules, geo, device) than budget (txn aggregation, goals) than
savings (FD catalog, liquidity forecast). The allowlists don't
overlap. One agent collapses the allowlists; ten over-fragments and
forces cross-agent calls. Three is the smallest set that keeps each
agent single-purpose.

**Q4. "What stops the LLM from inventing a tool call to one it isn't
allowed to use?"**
The dispatcher validates `tool_call.name ∈ allowlist[node]` before
executing. Disallowed call raises `PolicyViolation`, gets logged, and
the loop is retried with the constraint reinforced in the prompt; if
it persists, the node degrades. The allowlist is **enforced in the
runtime**, not requested in the prompt.

## On numerical correctness

**Q5. "What if the calculator is wrong? You've just shifted the risk."**
Calculators are pure functions, unit-tested with hypothesis, and
schema-validated. Bugs are findable, reproducible, and fixable in one
PR. LLM math errors are stochastic, irreproducible, and unfixable
without retraining or prompt voodoo. I'd rather own a calculator bug
than chase an LLM bug.

**Q6. "How do you keep the LLM from quoting a different number than the
calculator?"**
Two layers. First, the prompt template injects calculator outputs as a
JSON block tagged `<facts>...</facts>` and the system prompt instructs
the model to only cite numbers inside that block. Second, the
**reflection node** extracts numbers from the draft narrative and
compares them to `state.calc.*`; drift > 1% forces a retry with the
canonical number injected as a hard constraint. The comparator is
deterministic.

**Q7. "What about phrasing like 'roughly ₹18k'? Is that drift?"**
The reflection comparator tolerates rounding to two significant
figures when the prompt template marks the slot as `approx`. For
slots marked `exact` (balances, EMI amount), it doesn't.

## On safety and policy

**Q8. "Why is there no LLM in the policy decision? Won't that miss
context?"**
Policy decisions need to be reviewable by legal and compliance, who
do not read prompts. OPA / Cedar policies are text artifacts in
version control. The LLM can *suggest* an action; the policy engine
*decides* whether to execute it.

**Q9. "Why HITL for FD booking? Customers want to self-serve."**
Two reasons. (a) Mis-classified intent ("I was just asking what an
FD is, not asking you to book one") has expensive consequences. (b)
A money-moving action needs a deterministic identity check (2FA),
which the agent surface doesn't natively have. We do *not* HITL the
suggestion; we HITL the *commit*. Customers self-serve by confirming
in the standard payment flow, not by the agent executing.

**Q10. "Prompt injection inside a merchant memo: walk me through what
happens."**
Three lines of defense. (a) All tool data lands in the prompt inside
explicit `<tool_data>` tags with system-prompt instructions that
tool data is never instructions. (b) Tool calls are allowlisted at
the runtime, so even if the model is persuaded to call
`fd.book(amount=999999)`, that tool isn't in the allowlist for any
sub-agent. (c) Money-moving actions go through the policy engine and
HITL; a successful injection at most produces a draft suggestion the
human must approve.

## On scale and cost

**Q11. "$7M/month is a lot. Justify it."**
That's ~$0.009/turn at 25M turns/day, vs ~₹150 (~$1.80) for a branch
banker interaction and ~₹15 (~$0.18) for an IVR menu. The agent
displaces ~$30M/month of contact-center cost and unlocks contextual
distribution for FD/MF/loan products. The ROI is bounded by how much
contact-center deflection we can prove, which we measure via session
outcomes.

**Q12. "Why not fine-tune your own model and stop paying frontier
prices?"**
We will, for sub-agents. The explainer needs to stay on a frontier
model longer because narration quality drives CSAT and is the
hardest piece to evaluate offline. We start with frontier, capture
the data, and migrate the cheaper paths first. Same migration arc
as the BlackBox model router (`resume.txt` L55-56).

**Q13. "Your peak is 900 turns/sec. The router LLM is 150ms. That's
135 concurrent LLM calls just for routing. Does that hold?"**
At provider concurrency limits, yes - Anthropic's enterprise tier
supports it; we keep a per-provider semaphore plus per-route headroom.
Beyond that, we pin a quantized Haiku-class for routing in our own
VPC; routing is a classification task and a small model handles it.
Cost and concurrency both improve.

**Q14. "What if Core Banking is slow on the 1st of the month?"**
`context_fetch` runs in parallel with circuit breakers. If balances
return but txns don't, we degrade to "I have your balance but not
your transactions right now - try again in a few minutes." We also
pre-warm balance cache for the top-decile users 30 min before
salary-credit windows we predict from history.

## On observability and replay

**Q15. "What does 'deterministic replay' mean when LLMs are
nondeterministic?"**
It means the *inputs* are pinned: original state, original tool
envelopes (input + output), original model versions, original
policy bundle hash. Two replay modes: Fixture (reuses captured tool
outputs - auditable, deterministic) and Live (re-executes tools -
catches drift). Same dual-mode pattern we ran at BlackBox for AI
logic anomalies; cut MTTR by 60% (`resume.txt` L58-59).

**Q16. "Frontier models drift. A replay from six months ago will say
something different. Doesn't that break the audit?"**
The audit compares **decisions**, not literal tokens. The
`Explanation` schema gives us a structured decision (headline,
drivers, recommendation, confidence) that's comparable across model
versions. Drift in phrasing is fine; drift in decision is a
regression and is the alert.

**Q17. "How do you debug a customer complaint about a single answer
the agent gave three weeks ago?"**
SQL query on `customer_id + timestamp` → `turn_id` → load full trace
→ inspect per-node state diff → identify the offending node → reproduce
via Fixture replay → confirm fix removes the bug. Target MTTR < 60
minutes.

## On the product itself

**Q18. "Most banks already have an IVR and an in-app FAQ. Why is this
materially better?"**
Three differences. (a) Multi-step reasoning: "can I afford this EMI"
requires fetch + calculate + explain, which IVR can't do. (b)
Personalization: the agent knows the user's spend history, goals,
and tone. (c) Action: the agent can *do* something (set reminder,
file ticket) rather than route to another menu.

**Q19. "Why Hindi + English? Why not all 22 official languages MVP?"**
Coverage isn't free: each language needs a tone calibration,
adversarial set, and ongoing eval set. We ship Hindi + English MVP
because they cover ~60% of the bank's customer base, then expand by
calibrated language pair based on telemetry.

**Q20. "How do you measure that this works?"**
- CSAT per intent.
- Containment rate (turns resolved without escalation).
- Numerical-correctness audit (random sample re-verified by
  ground-truth calculator).
- HITL approval latency.
- Cost per resolved turn.
- Eval-set regression vs the last deploy.

## On leadership and rollout

**Q21. "How do you bring this live without one bad answer becoming a
front-page story?"**
- Phase 1: shadow mode - agent runs but doesn't ship answers; we
  compare to human banker outputs.
- Phase 2: 1% canary on low-risk intents (balance lookup, FAQ).
- Phase 3: expand intents one at a time, each gated by a stable
  CSAT and numerical-correctness threshold.
- Phase 4: actions enabled, HITL-only at first, automated only after
  a 30-day clean record per action type.
- Throughout: weekly red-team probe + adversarial eval.

**Q22. "How big is the team to build and run this?"**
6-8 engineers for the platform (runtime, tools, observability), 2 for
LLMOps (eval, replay, model routing), 2 product / linguist for tone
and intents, 1 security partner, 1 compliance partner. This is the
same shape as the BlackBox agentic platform team I led
(`resume.txt` L51-52, `blackbox-experience.md` #6) - different
domain, same skeleton.
