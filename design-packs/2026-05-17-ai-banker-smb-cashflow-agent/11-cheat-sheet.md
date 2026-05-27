# 11 - Cheat Sheet (Verbal Delivery Guide)

One-page rehearsal card. Read once before the room. Do not read aloud.

---

## 1. Open with framing (30s - say this verbatim)

> "I'd build the AI Banker as a multi-agent cashflow intelligence layer that sits between SMBs and their financial sources. It's the BlackBox agentic platform pattern - LangGraph DAG runtime, durable resumable execution, multi-model routing - applied to a vertical with strict correctness and audit requirements."

Then: "Before I draw, three scoping questions" - go to section 8.

---

## 2. Whiteboard recipe (60s - draw in this order)

1. **Edge**: NLB → ALB → BFF (auth, tenant resolve, rate limit)
2. **Orchestrator**: run lifecycle, idempotency, HITL gating
3. **Agent runtime**: Supervisor → fan-out to {Forecaster, AR, AP, Payroll, Tax, Lender, Anomaly}
4. **Tool gateway**: bank, accounting, payroll, tax, lender adapters (capability allow-list per node)
5. **Memory**: Postgres (graph state + ledger) + pgvector (semantic) + Redis (hot session)
6. **Telemetry**: OpenTelemetry → ClickHouse - BlackBox pattern, 50M spans/day (`resume.txt L58-59`)

---

## 3. Three load-bearing decisions - defend if pushed

- **Multi-agent supervisor, not single ReAct loop** - graph-level routing > prompt-level routing; tool authority bound to nodes, not the model.
- **Deterministic forecast + LLM explainer, not LLM-forecast** - bounded error, reproducible, auditable. LLM never moves money.
- **Durable graph state in Postgres** - conversations span days (waiting on a customer payment, waiting on human approval). Same checkpointing shape as BlackBox graph engine (`resume.txt L53-54`).

---

## 4. Numbers to have at hand

- 1M SMBs · 300K DAU · 50K peak concurrent runs
- 8M agent runs/month · 18B LLM tokens/month
- **27× BlackBox runs scale, 18× BlackBox tokens** - anchor (`resume.txt L51-56`: 10K runs/day, 1B tokens/month)
- p95 conversation 6s · forecast 30s · HITL approval median 4h
- ~$0.30/MAU/month direct cost · ~$0.05/conversation
- SOC-2 Type II · RBI data residency · DPDP/GDPR

---

## 5. Resume bridge (4–5 phrases - drop one per major beat)

- "At BlackBox I architected LangGraph DAG runtimes for 10K+ agent runs/day - **same shape, 27× the volume**" (`resume.txt L51-52`)
- "Durable resumable execution with memory persistence - **proven pattern**, applied to multi-day cashflow conversations" (`resume.txt L53-54`)
- "Model router across Claude/GPT/Grok at 1B+ tokens/month - **same router lives here, sized for 18B**" (`resume.txt L55-56`)
- "LLMOps telemetry mesh, 50M spans/day, deterministic replay, **60% MTTR cut - directly reused**" (`resume.txt L58-59`)
- "WASM sandbox for code isolation and SOC-2 - pattern extended to **OCR workers parsing untrusted PDFs**" (`resume.txt L49-50`)

---

## 6. Pitfalls to avoid in the verbal answer

- Don't start with the LLM - start with the SMB owner's pain (cashflow blind spots).
- Don't lean on "AI will figure it out" - the forecast is a deterministic numerical model.
- Don't claim Microsoft product internals - cite generally (`resume.txt L88-89`).
- Don't ignore HITL - interviewers love "what if the agent sends money wrong"; have the answer ready.
- Don't draw the agents before the orchestrator - the run lifecycle is the spine.

---

## 7. Tradeoffs to volunteer (signals seniority)

- "I'm trading some response latency for durability - **every node checkpoints**."
- "I'm trading model freedom for **capability allow-lists per agent node** - necessary for tool safety."
- "I'm trading edge-intent accuracy for the **bounded behavior of a supervisor classifier** I can audit."
- "I'm trading vendor flexibility for **per-region model pinning** - RBI residency."

---

## 8. Scoping questions - ask first (30s, before drawing)

- Single-country (India) day 1, or global? Drives residency, AA framework, KYC.
- Read-only intelligence only, or also **write actions** (move money, file taxes)? Drives HITL surface area.
- Bank-integrated already via Account Aggregator, or do we build adapters per bank?

---

## 9. "What would you build in week 1?"

- **Read-only path end-to-end**: ingest bank txns → forecast → explainer LLM → answer.
- One bank source, one accounting source, one model.
- **HITL on every write** - defer write tools to month 2.
- Telemetry from day 1 - replay matters even at 10 conversations/day (BlackBox lesson, `resume.txt L58-59`).

---

## 10. Elevator close (one line)

> "It's the BlackBox agentic platform applied to a vertical the platform itself can't see - SMB cashflow - with the correctness, audit, and isolation that finance demands."

---

**Print check**: Letter, 11pt, single column - fits one page. If it spills, cut section 5 to 3 bullets.
