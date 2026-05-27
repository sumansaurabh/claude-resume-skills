# Multi-Persona AI Banker - Shared Platform (R2 System Design Pack)

> Staff Engineer interview pack, Round 2 (System Design).
> Pack archetype: `system-design` (v2). Agentic: yes. Knowledge base: yes.
> Created: 2026-05-21. Slug: `multi-persona-ai-banker-shared-platform`.

## One-screen summary

A **shared AI platform with persona-aware specialization** - Retail / SME / CFO
run on the same orchestrator, memory, tool router, and governance plane.
Persona is a parameter, not a code fork. Financial math is deterministic;
LLMs do reasoning and the conversational surface. Money-moving actions are
risk-tiered with human-in-the-loop. Proactive intelligence is event-driven
with cooldowns and fatigue prevention. Observability is per-step trace +
deterministic replay.

Read **`01-executive-summary.md`** first if you only have 5 minutes.
Read **`02-design-estimates.md`** before architecture if you have 15.

## File map

| File | What it covers |
|---|---|
| `00-question-and-context.md` | Original prompt, scope decomposition, assumptions, resume anchors |
| `01-executive-summary.md` | The strong short answer + the 5 things to land in the interview |
| `02-design-estimates.md` | Use case, personas, build-vs-buy, capacity, fleet sizing on m8g, NFRs |
| `03-architecture.md` | End-to-end architecture, LB chain, control vs data plane |
| `04-api-and-contracts.md` | External API contracts, request flows, idempotency, error model |
| `05-low-level-design.md` | Service decomposition, state machines, schemas, sequence flows |
| `06-scaling-and-capacity.md` | Throughput model, bottlenecks, quotas, backpressure, cost |
| `07-security-and-isolation.md` | Threat model, identity, network, secrets, tenant isolation |
| `08-reliability-observability-and-failures.md` | Retries, failure modes, OTel mesh, replay |
| `09-tradeoffs-and-alternatives.md` | Rejected approaches and why |
| `10-cross-questions.md` | Skeptical follow-ups + best rebuttals |
| `11-cheat-sheet.md` | Talking points for delivery |
| **Agentic deep-dives** | |
| `12-agentic-graph-structure.md` | Node + edge taxonomy, supervisor/worker hierarchy, per-node state |
| `13-memory-layer-design.md` | 15-point memory subsystem deep-dive |
| `14-ingestion-pipeline.md` | 15-point knowledge-base write-path deep-dive |
| `15-guardrails.md` | 15-point behavioral safety deep-dive |
| `16-challenges-by-stage.md` | Stage-scoped engineering challenges (CoT-generated) |
| `manifest.json` | Machine-readable pack metadata |

## Key principles (interview-ready phrases)

- *Persona-aware context injection.*
- *Deterministic vs probabilistic boundary.*
- *Shared orchestration layer.*
- *Policy-driven execution.*
- *Human-in-the-loop workflows.*
- *Memory stratification.*
- *Event-driven proactivity.*
- *Confidence-scored actions.*

## Reference problem folders consumed (not solved)

- `/Users/sumansaurabh/Documents/slcie/problems/spending_coach_agent/` - Retail
  reference implementation; the platform's Retail lane subsumes it.
- `/Users/sumansaurabh/Documents/slcie/problems/cash_flow_risk_detector/` -
  open SME problem; the platform's SME lane subsumes it.

## Resume anchors used

`resume.txt`, `blackbox-experience.md`, `microsoft-experience.md` - see
`00-question-and-context.md` for the load-bearing citations.

## How to extend

For deeper cross-exam, add `cross-exam/api-and-lld-pushback.md`,
`cross-exam/scale-stressors.md`, `cross-exam/security-pushback.md`,
`cross-exam/leadership-and-business-pushback.md`, and `cross-exam/fast-rebuttals.md`
under `cross-exam/`. The root `10-cross-questions.md` stays the compact set.

If `/critical-agent` is run against this pack, the approval artifact lands as
`20-critical-agent-approval.md` (never written by hand).
