# 00 - Question and Context

## Verbatim question

> Design an AI Banker for SMB owners that acts like a cashflow intelligence agent. Real-banker scope: cashflow visibility, vendor payments, invoice follow-ups, working capital loans, payroll readiness, tax/GST reminders, business account health, receivables/payables tracking, credit line usage, payment collection advice.
>
> Example tasks:
> - Will I have enough cash for payroll?
> - Which invoices are overdue?
> - Can I pay this vendor today?
> - Should I delay a non-critical payment?
> - Do I need a working capital loan?
> - Why is cash lower than expected?
> - What is my runway?

## What we are building (and what we are NOT)

We are building an **intelligence and orchestration layer** that sits on top of an SMB's existing financial stack. We are **not** building a bank, a PSP, an NBFC, or a ledger of record.

- We **read** bank statements, accounting data, payroll runs, GST filings, invoices, and vendor contracts via consented connectors.
- We **reason** over that data with a multi-agent system to produce answers, alerts, and recommendations.
- We **act** only through pre-approved tool calls into third-party systems - e.g., trigger a UPI/NEFT payout via RazorpayX, push an invoice reminder via WhatsApp Business, create a working-capital loan application with a partner NBFC - and every action that moves money or sends external communication passes a human-in-the-loop gate by default.

## In scope

1. **Cashflow visibility** - live position across all linked accounts, 13-week rolling forecast, runway, "why is cash lower than expected" variance explanations.
2. **Receivables** - overdue invoice list, prioritized chase queue, drafted reminder messages (email/WhatsApp/SMS), payment-link generation.
3. **Payables** - vendor list, due-today/this-week, "can I pay this vendor today" affordability check, "should I delay X" what-if simulation.
4. **Payroll readiness** - projected balance on payroll date, shortfall amount, recommended actions (delay vendor / draw credit line / advance receivable).
5. **Tax / GST** - GSTR-1/3B filing reminders, TDS deposit reminders, advance tax estimates, set-aside guidance.
6. **Credit & lending** - credit-line utilization, working-capital loan need detection, pre-qualified offer surfacing from partner NBFCs.
7. **Account health** - bounced payment detection, idle-balance sweep suggestions, fee anomaly detection.
8. **Conversational interface** - natural-language Q&A with memory across days/weeks, proactive nudges, weekly digest.

## Out of scope (v1)

- Holding customer funds, issuing accounts, or any activity requiring a banking/PSP license.
- Personal finance for the SMB owner (only business entities).
- Inventory financing, invoice discounting marketplace, or supply-chain finance origination (only referral to partners).
- Equity, M&A, or treasury / FX hedging advice.
- Tax filing itself - we remind, estimate, and prepare; a CA or filing partner submits.
- Markets outside India in v1; the architecture is designed to be geo-pluggable but launch is India-first.

## Named assumptions

| # | Assumption | Value |
|---|------------|-------|
| A1 | Geography | India-first. UPI, NEFT/RTGS/IMPS, GST, TDS, RBI account aggregator framework. Geo-pluggable connector layer for US/UK/SEA later. |
| A2 | Customer segment | Indian SMBs with annual revenue **₹50L–₹50Cr** (~$100K–$10M). Excludes micro-merchants (kirana) and mid-market (>₹50Cr). |
| A3 | Total addressable | ~14M GST-registered SMBs in India; serviceable target 1M businesses in 5 years. |
| A4 | Primary data sources | Account Aggregator (Setu/Finvu/Onemoney) for bank data; Tally/Zoho/QuickBooks for accounting; RazorpayX/Cashfree for payouts; ClearTax/GSTN for tax; RazorpayX Payroll / Keka for payroll. |
| A5 | Write surfaces | All money-moving writes go through partner PSPs (RazorpayX, Cashfree). No direct bank rails. |
| A6 | LLM access | Reuse BlackBox-style model router across Claude / GPT / Grok / Gemini; frontier for reasoning, cheap models for retrieval and templating (`resume.txt` L55-56). |
| A7 | Latency target | Conversational answers p95 < 4s for cached-context questions, < 12s for fresh-forecast questions. |
| A8 | Concurrency | 1M tenants, ~5% DAU at peak hours, ~50K concurrent agent runs at peak. ~10K agent runs per business per month. |
| A9 | Compliance frame | DPDP Act (India), RBI AA framework, SOC-2 Type II, ISO 27001. Data residency: India region only for v1. |
| A10 | Pricing model out of scope here - assume freemium + per-seat + transaction-volume tier. |

## Resume anchors used

- `resume.txt` L49-50 - WASM sandbox plane, SOC-2, 1M+ daily executions → used as precedent for safe execution of customer-defined cashflow rules and what-if scripts.
- `resume.txt` L51-54 - LangGraph/LangChain ReAct runtimes, DAG orchestration, 10K+ agent runs/day, durable execution → direct precedent for the supervisor + specialist agent topology and resumable multi-day conversations.
- `resume.txt` L55-56 - Model router across Claude/GPT/Grok with capability-aware routing, 1B+ tokens/month → used for cost-aware routing across reasoning vs retrieval vs summarization.
- `resume.txt` L58-59 - LLMOps telemetry mesh 50M spans/day, deterministic replay, 60% MTTR reduction → used for the "why is cash lower than expected" explainability path and incident response.
- `resume.txt` L73-92 - Microsoft AutoML / AI Fine-tuning / multi-tenant K8s, 15M+ jobs/month, 200K+ users, gang scheduling → precedent for multi-tenant isolation and scheduled forecast jobs.
- `blackbox-experience.md` #14 - memory persistence across workflow steps and sessions → direct precedent for the four-layer memory design.
- `blackbox-experience.md` #20 - 50M spans/day, 2.5TB monthly traces, deterministic replay → used for cashflow variance debugging.
