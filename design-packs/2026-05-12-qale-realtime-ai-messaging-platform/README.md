# Qale — Real-Time AI-Native Messaging Platform

**Target role:** Head of Engineering, Turium AI (Hyderabad). Builder-first leadership, hands-on across architecture, performance, execution.

**Product framing:** Qale is a real-time, AI-native communication platform meant to replace legacy email and reset the global messaging baseline. Approaching Alpha; the engineering job is to take it Alpha → Public Launch → 1M+ users.

**Why this pack exists:** to walk an interviewer through how I would architect Qale end-to-end, scale it to 1M+ users, and run engineering — grounded in concrete prior work (BlackBox model router & telemetry mesh, Microsoft TunDRA + secure multi-tenant infra, ShareChat real-time pub/sub at 40M DAU, HomeLane WebRTC).

## File map

| File | What's in it |
| --- | --- |
| `manifest.json` | Pack metadata, archetype, question hash, anchors |
| `00-question-and-context.md` | The Turium JD as the question, scope, assumptions, resume anchors used |
| `01-executive-summary.md` | The strong, 3-minute version of the answer |
| `02-architecture.md` | End-to-end architecture, control vs data plane, real-time backbone, AI plane |
| `03-api-and-contracts.md` | REST + WebSocket + SSE contracts, idempotency, error model, AI streaming |
| `04-low-level-design.md` | Service decomposition, modules, classes, schemas, sequence flows |
| `05-scaling-and-capacity.md` | Capacity model, fanout math, connection sharding, AI cost model |
| `06-security-and-isolation.md` | Trust boundaries, auth, E2E options, AI safety, SOC-2 path |
| `07-reliability-observability-and-failures.md` | Failure modes, retries, telemetry mesh, LLM tracing, runbooks |
| `08-tradeoffs-and-alternatives.md` | Build vs buy, WS vs SSE, custom infra vs Stream/Sendbird, monolith vs services |
| `09-cross-questions.md` | Hard interviewer pushback with crisp rebuttals |
| `10-cheat-sheet.md` | One-page talking points for live delivery |
| `11-control-plane-vs-data-plane.md` | What runs on the slow control plane vs the hot data plane |
| `12-state-machine-and-workflows.md` | Message + AI run state machines, durable workflows |
| `13-data-model-and-storage.md` | Schemas, partitioning, hot/warm/cold tiers, search index |
| `14-leadership-and-business-framing.md` | Hiring plan in Hyderabad, Alpha→Launch→Scale roadmap, engineering standards |
| `15-risk-register.md` | Top 12 delivery, scale, security, AI-cost risks with mitigations |

## How to read this pack in an interview

1. Open with `01-executive-summary.md` — the 3-minute version.
2. If they want depth, jump into `02-architecture.md` and `11-control-plane-vs-data-plane.md`.
3. For API/LLD follow-ups, use `03` and `04`.
4. For "how do you get to 1M users" pressure, use `05` and `15`.
5. For the leadership half of the role, use `14`.
6. If they push back, `09` and `08` are the rebuttal arsenal.

## Grounding

Every load-bearing claim is anchored to a specific bullet from `resume.txt`, `blackbox-experience.md`, or `microsoft-experience.md`. Where Qale-specific implementation details are unknown (it's pre-Alpha), I label them as **assumption** explicitly.
