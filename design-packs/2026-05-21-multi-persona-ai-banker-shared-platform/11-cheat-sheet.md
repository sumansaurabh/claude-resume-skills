# Cheat Sheet — Multi-Persona AI Banker on Shared Platform

Two-minute pre-interview read. Delivery aids, not architecture.

---

## 1. The 60-second opening — say this before drawing anything

"I'd build this as a **shared agentic platform with persona-aware specialization**, not three independent agents. The platform separates a **deterministic calc plane** from a **probabilistic LLM plane** — money math goes to versioned services, reasoning and language go to a model-routed LLM mesh. A **LangGraph supervisor** routes each request to a persona specialist subgraph: Retail, SME, or CFO. The system is **event-driven and proactive** — agents react to ingestion-pipeline events, not just user prompts. Every above-threshold action passes through **HITL approval** with policy-driven risk tiering. Everything is **multi-tenant from day one**: per-tenant memory namespaces, per-persona policy bundles, per-tenant cells for power users. And the whole thing is observable end-to-end with deterministic replay, because in banking you must be able to answer 'why did the agent do that' months later."

That's the opening. Don't draw yet.

---

## 2. The 6-component pitch — whiteboard in this order

Number them as you draw. Talk while drawing each.

1. **Edge + Gateway**: persona resolver, JWT-bound `PersonaContext`, rate limiter, tenant routing. *Drop:* "Persona resolution happens once, at the edge, and never again — that's an auditability requirement."
2. **Shared Orchestrator (LangGraph supervisor + specialists)**: durable execution, Postgres checkpointer, idempotent tool calls. *Drop:* "This is the same runtime shape we ran at BlackBox at 10K+ agent runs/day."
3. **Context Manager + Memory** (4 tiers: session/episodic/semantic/profile): parallel fan-out, 120ms p99, namespaced by `(tenant, persona, subject)`.
4. **Tool Router + Calc Service**: deterministic capability map, WASM sandbox for risky tools, versioned calc library for all bank math.
5. **Policy + HITL + Audit**: declarative policy bundles (git-versioned), risk-tiered HITL queues, single audit table for the regulator.
6. **Notification + Observability**: event-driven proactivity, fatigue-aware throttling, OTel trace mesh with deterministic replay.

If you draw these six in 90 seconds you've already passed the architecture bar.

---

## 3. The 3 hardest questions and the 2-sentence answer

**Q: Why not three separate agents?**
A: Triples ops cost, triples telemetry surface, fragments compliance posture, and blocks cross-persona learning. Persona is a parameter at the orchestrator, not a fork of the orchestrator.

**Q: Why a deterministic Calc Service?**
A: Hallucinated financial math is unrecoverable and unauditable. Math goes to a versioned, signed-off service; the LLM does reasoning and the conversational surface, and is forbidden to introduce new numbers.

**Q: How do you handle HITL at scale?**
A: Risk-tiered — low-risk auto-execute with confidence gate, medium-risk single approver with 5-minute SLO, high-risk approver chain with explicit user-facing latency. Latency is the feature for high-risk, not the bug.

---

## 4. Strong phrases to drop

These eight phrases signal "I've thought about this domain":

- "Persona-aware context injection"
- "Deterministic vs probabilistic boundary"
- "Shared orchestration layer with persona specialization"
- "Policy-driven execution"
- "Human-in-the-loop workflows with risk-tiered routing"
- "Memory stratification across session, episodic, semantic, and profile tiers"
- "Event-driven proactivity, not just reactive Q&A"
- "Confidence-scored actions with deterministic gates"

---

## 5. Resume anchors to drop naturally

Five one-line plugs. Land at least three.

- "At BlackBox I ran 10K+ agent runs/day on LangGraph with durable execution and checkpointing." (resume.txt:51-54)
- "Our model router at BlackBox routed across Claude, GPT, and Grok at 1B+ tokens/month with capability-aware routing." (resume.txt:55-56)
- "We built a 50M spans/day OTel mesh with deterministic replay and cut MTTR by 60%." (resume.txt:58-59)
- "We ran 1M+ daily code executions in a WASM sandbox plane for SOC-2." (resume.txt:49-50)
- "Microsoft AutoML I co-architected handled 15M+ jobs per month with a state-machine orchestrator and isolation strategies across tenants." (resume.txt:88-92)

Drop one when discussing each: LangGraph (1), model router (2), observability (3), sandbox / SOC-2 (4), multi-tenant scaling and isolation (5).

---

## 6. Things to acknowledge but not over-engineer

When the interviewer mentions these, say "assumed external, out of scope for this design" and move on. Don't burn time:

- **KYC and AML batch** — assumed external, integrated via event stream.
- **Card issuance and core banking** — external system of record, we read via APIs.
- **Payments rails (NEFT/RTGS/UPI)** — external; we call as idempotent side effects.
- **Identity provider** — external OIDC; we consume JWT claims.
- **CRM and ticketing** — out of scope; we emit events.

Saying these explicitly demonstrates scope discipline. Trying to design them demonstrates lack of it.

---

## 7. What to write on the whiteboard — priority order

**First (must draw):**
1. The six numbered boxes (edge gateway, orchestrator, context+memory, tool router+calc, policy+HITL+audit, notification+observability).
2. Arrows for the happy-path: request → gateway → orchestrator → context manager → LLM → tool router → calc/sandbox → policy/HITL → notification → audit.
3. The deterministic vs probabilistic line — draw it dotted between the LLM and the calc service. Label it.

**Second (if asked or time permits):**
4. The event bus on the side — ingestion events flowing into the orchestrator for proactive runs.
5. The 4-tier memory stack inside the Context Manager box.
6. The HITL queue with risk-tier swim-lanes.

**Third (only if asked deeply):**
7. The model router with three provider endpoints and the circuit breaker.
8. The audit + replay flow — `agent_audit` joined to LLM spans joined to `calc_invocations`.
9. The per-tenant cell for power-user CFO customer-zero.

---

## 8. The closing 60-second summary — say this

"To summarize: this is **one platform, three personas**, not three platforms. The win is in (a) sharing the orchestration substrate and observability mesh so we get one MTTR curve instead of three, (b) keeping the **deterministic gates non-negotiable** so regulators see one audit story for money decisions, (c) layering **persona specialization** through versioned policy bundles and per-persona context shaping rather than per-persona code forks, and (d) **HITL as a feature, not a bug** — risk-tiered, SLO-tracked, and never the bottleneck for the 80% auto-path. I'd ship Retail first with six concrete exit gates, then SME, then CFO, and the same platform serves all three with persona-aware specialization. The architecture is justified by what I've shipped: LangGraph durable execution at 10K+ runs/day, a model router at 1B+ tokens/month across Claude/GPT/Grok, a 50M spans/day observability mesh that cut MTTR 60%, a WASM sandbox running 1M+ daily executions for SOC-2, and Microsoft AutoML running 15M+ jobs/month on shared multi-tenant infrastructure. Same patterns, banking domain."

End there. Don't add more.

---

## Quick reference — numbers to have ready

| Metric | Value | Source |
|---|---|---|
| Memory retrieval p99 budget | 120ms | this design |
| HITL medium-risk SLO | 5 min | this design |
| HITL high-risk escalation | T+5min → T+1hr → T+4hr → T+24hr | this design |
| Context budget split | 20/20/30/30 (sys/profile/memories/tools) | this design |
| LLM cache target hit rate | 60-70% on prefix | this design |
| Hallucination-on-numbers gate | <0.05% on audit sample | rollout gate |
| LangGraph runs/day baseline | 10K+ | BlackBox (51-54) |
| Tokens/month baseline | 1B+ | BlackBox (55-56) |
| Spans/day baseline | 50M | BlackBox (58-59) |
| Sandbox executions/day | 1M+ | BlackBox (49-50) |
| AutoML jobs/month | 15M+ | Microsoft (91-92) |

---

## If they push you into a corner

- **"That's hand-wavy."** → Give a table name. "`agent_audit` joined to `calc_invocations` on `run_id`."
- **"How do you know this will work?"** → Anchor to BlackBox or Microsoft scale numbers.
- **"What would you cut if you had half the time?"** → CFO persona ships last; event-driven proactivity is a phase-2 feature; start synchronous-only.
- **"What's the riskiest part?"** → Numeric fidelity from LLM outputs and policy-bundle authorship — these are still partly human-trust dependent.
- **"What would you do differently if you'd built this before?"** → Earlier eval harness, per-tenant from day one not day 90, and treat the policy bundle as a product not a config file.
