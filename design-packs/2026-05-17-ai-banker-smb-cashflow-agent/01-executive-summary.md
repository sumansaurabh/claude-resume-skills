# 01 — Executive Summary

## Product framing

The SMB owner gets a **banker on WhatsApp and dashboard** that always knows their cash position, their next three payroll dates, every overdue invoice, every vendor due this week, and their GST/TDS calendar. They ask in natural language — *"can I pay Tata Steel ₹4L today and still cover payroll on the 5th?"* — and get a grounded numeric answer with the underlying ledger, the forecast assumptions, and a one-tap action ("Pay now via RazorpayX", "Schedule for the 7th", "Send reminder to top 5 overdue customers"). Proactive nudges land before the owner asks: *"Heads up — payroll on the 5th is short by ₹2.3L given current receivables velocity. Three options inside."*

This is the **intelligence layer**, not the bank. Money still moves through RazorpayX / Cashfree / partner NBFCs. The product's defensibility is the agent's memory of the business, the quality of its forecast, and the trust earned by never being wrong about a number.

## Agentic architecture in one paragraph

A **LangGraph supervisor** routes each turn to one of seven specialist agents — *CashflowAgent, ReceivablesAgent, PayablesAgent, PayrollAgent, TaxAgent, CreditAgent, AccountHealthAgent* — each with a scoped tool registry (forecast tool, ledger query, payout API, reminder dispatcher, loan-prequalifier, etc.). The supervisor decides single-agent vs multi-agent fan-out, the specialists return structured observations, and the supervisor composes the user-facing answer through a capability-aware **model router** (reused from BlackBox, `resume.txt` L55-56). State lives in a **durable graph store** so a payroll conversation started on Monday can be resumed Wednesday with a vendor approval still pending — the same pattern that supported 10K+ agent runs/day at BlackBox (`resume.txt` L51-54). A four-layer **memory system** (scratchpad, episodic, semantic-vector over the business's own data, procedural over user preferences) gives every agent tenant-scoped recall. An **ingestion pipeline** keeps the knowledge base fresh: AA bank-statement webhooks, Tally/Zoho/QuickBooks CDC, GSTN polling, payroll-system webhooks → normalized ledger → embeddings → vector store + Postgres, all isolated per tenant. Every tool call, model call, and retrieval emits a structured span into an LLMOps telemetry mesh modeled on the BlackBox 50M-span/day system (`resume.txt` L58-59, `blackbox-experience.md` #20) so any answer can be deterministically replayed.

## Top three load-bearing technical decisions

### 1. Multi-agent supervisor over a single ReAct loop

A single ReAct agent with 40+ tools would blow the context window, conflate domains, and hallucinate cross-domain links (e.g., counting a deposit twice). Specialist agents with narrow tool registries keep each prompt small, let us tune temperature and model choice per domain (TaxAgent: low temp, structured output; CreditAgent: frontier model with reasoning), and let us version each agent independently. The supervisor handles routing, conflict resolution, and final composition. **Direct reuse of the BlackBox DAG agent runtime** (`resume.txt` L51-54, `blackbox-experience.md` #7-#13).

### 2. Durable graph state for multi-day cashflow conversations

Cashflow questions are rarely one-shot. *"Should I delay this vendor?"* spawns *"by how many days?"* → *"will that hurt my Tally vendor-aging report?"* → *"send them a note explaining"* — often across hours or days, with human approvals in between. We use the **same checkpointed LangGraph state model** proven at BlackBox (`resume.txt` L52-54, `blackbox-experience.md` #12-#15): every node transition writes a checkpoint to Postgres, every tool call is idempotency-keyed, and any run is resumable from its last successful node. This is what makes the agent feel like a real banker who remembers what you discussed yesterday.

### 3. Deterministic forecast tool wrapped by an LLM explainer to bound hallucination

The 13-week cashflow forecast and the affordability check (*"can I pay this vendor today"*) are computed by a **deterministic Python forecast engine** — not the LLM. The LLM only **calls the tool, summarizes the result, and explains the variance** in natural language. The forecast tool returns structured JSON: projected balance series, confidence interval, top three contributing line items, sensitivity to top assumptions. The LLM cannot move a number; it can only narrate one. This pattern eliminates the "LLM made up your cash balance" failure mode that would kill trust on day one. The forecast itself uses a hybrid: empirical receivables-velocity model + scheduled-payment ledger + Holt-Winters seasonality on discretionary inflows. Same WASM-sandboxed execution pattern proven at BlackBox for safe customer-defined rules (`resume.txt` L49-50, `blackbox-experience.md` #3-#5).

## Headline scale numbers

| Dimension | Target | Anchor |
|-----------|-------:|--------|
| Tenants (SMBs) | **1M** | Serviceable Indian segment, ₹50L–₹50Cr revenue |
| Peak concurrent agent runs | **~50K** | 5% DAU × ~10% in-session at peak hour |
| Agent runs per business / month | **~10K** | Proactive nudges + conversational + scheduled forecasts; matches BlackBox runs/day scale per-tenant (`resume.txt` L52`) |
| LLM tokens / month | **~3–5B** | Within precedent of 1B+/month router (`resume.txt` L55-56) |
| Telemetry spans / day | **~80M** | Higher than BlackBox 50M/day baseline; same mesh pattern (`resume.txt` L58-59) |
| Bank-statement events / day | **~10M** | 1M tenants × ~10 txns/day average |
| Forecast jobs / day | **~3M** | Daily refresh + on-demand; scheduled like AutoML 15M jobs/month (`resume.txt` L91`) |
| Latency p95 (cached) | **< 4s** | Conversational SLA |
| Latency p95 (fresh forecast) | **< 12s** | Includes ingest catchup + deterministic compute |
| MTTR for agent anomalies | **< 30 min** | Replay-driven, modeled on 60% MTTR cut at BlackBox (`resume.txt` L59`) |

## Why this team can build this

The four hardest pieces — **durable agent orchestration at scale, multi-model routing under cost pressure, multi-tenant LLM telemetry with deterministic replay, and SOC-2-grade sandboxed execution** — are all direct lifts from the BlackBox principal-engineer work (`resume.txt` L49-59). The SMB-banking domain layer is new; the agentic infrastructure underneath it is not.
