# AI Banker for SMB Owners - Cashflow Intelligence Agent

A multi-agent cashflow intelligence platform that behaves like a real small-business banker: it ingests bank, accounting, payroll, and tax data; answers questions like *"will I have enough for payroll on the 5th?"* or *"should I delay this vendor?"*; and reasons across receivables, payables, GST, payroll, and credit lines under a supervisor + specialist agent topology. India-first (UPI/GST/RazorpayX/Tally/Zoho) with a global-ready abstraction layer. This is an **intelligence layer**, not a bank - read-only data ingest plus consented write APIs to PSPs and accounting systems.

## File map

| # | File | One-line summary |
|---:|------|------------------|
| 00 | `00-question-and-context.md` | Verbatim question, in/out of scope, named assumptions, resume anchors |
| 01 | `01-executive-summary.md` | One-page principal-engineer answer: framing, architecture, 3 load-bearing decisions, scale numbers |
| 02 | `02-design-estimates.md` | 20-point agentic checklist scored; QPS, storage, token, cost estimates |
| 03 | `03-architecture.md` | C4-style component view, data flow, agent topology, deployment plane |
| 04 | `04-api-contracts.md` | External REST/gRPC surface, webhook ingest, tool-call schemas |
| 05 | `05-lld.md` | Forecast engine internals, ledger reconciliation, tool registry, idempotency keys |
| 06 | `06-scaling.md` | 1M SMB target, 50K concurrent runs, sharding, hot-tenant control, fan-out/in |
| 07 | `07-security.md` | Multi-tenant isolation, PII/financial data handling, RBI/DPDP/SOC-2 controls |
| 08 | `08-reliability.md` | Durable graph state, replay, partial-failure recovery, RPO/RTO targets |
| 09 | `09-tradeoffs.md` | Multi-agent vs single ReAct, deterministic tools vs LLM math, sync vs async |
| 10 | `10-cross-questions.md` | Skeptical interview follow-ups and rebuttals |
| 11 | `11-cheat-sheet.md` | One-glance numbers, anchors, talking points |
| 12 | `12-agentic-graph-structure.md` | LangGraph topology: supervisor + 7 specialist nodes, edges, state schema |
| 13 | `13-memory-layer-design.md` | Short-term scratchpad, episodic, semantic, procedural; per-tenant namespacing |
| 14 | `14-ingestion-pipeline.md` | Bank/accounting/payroll/tax connectors, CDC, ledger normalization, embeddings |
| 15 | `15-guardrails.md` | Input/output filters, action policy gates, human-in-the-loop on writes, PII scrubbers |
| 16 | `16-challenges-by-stage.md` | Failure modes by lifecycle stage (ingest → reason → act → observe) |
| 17 | `17-graph-store.md` | Durable LangGraph state store - `run_state` / `agent_checkpoint` build plan, two state classes, lease + resume, hop-batch checkpointing, schema versioning |

## Resume anchors

- **LangGraph DAG agent runtime at 10K+ runs/day** - direct precedent for the supervisor + specialist topology and durable graph state (`resume.txt` L51-54, `blackbox-experience.md` #7-#13).
- **Graph workflow engine with checkpointing, retry semantics, memory persistence** - load-bearing for multi-day cashflow conversations and resumable approval flows (`resume.txt` L52-54, `blackbox-experience.md` #12-#15).
- **Model router across Claude/GPT/Grok at 1B+ tokens/month** - reused for capability-aware routing: cheap models for retrieval/summaries, frontier models for forecasting explanations and loan reasoning (`resume.txt` L55-56, `blackbox-experience.md` #16-#19).
- **LLMOps telemetry mesh ingesting 50M spans/day, 2.5TB/month, deterministic replay, 60% MTTR cut** - directly applied to debugging "why is my cash lower than expected" via tool-call replay (`resume.txt` L58-59, `blackbox-experience.md` #20).
- **Golang WASM sandbox plane, 1M+ daily executions, SOC-2 compliant** - reused to safely execute customer-uploaded reconciliation rules and what-if scripts (`resume.txt` L49-50, `blackbox-experience.md` #3-#5).
- **Microsoft AutoML / AI Fine-tuning, 15M+ jobs/month, multi-tenant K8s isolation** - precedent for SMB multi-tenancy, gang scheduling of forecast jobs, and cost-aware resource allocation (`resume.txt` L73-92).
