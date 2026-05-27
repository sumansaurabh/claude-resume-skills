# B2C Agent Orchestrator + Catalog — Design Pack

A principal-engineer-grade design pack for a B2C web platform where consumers author AI agents (persona + MCP/OAuth connectors + RAG corpora + Claude-skills-syntax scripts + four-tier memory) and publish them to a public catalog that other users browse, fork, and run.

## Pack Metadata

| Field | Value |
|---|---|
| createdAt | 2026-05-27 |
| slug | b2c-agent-orchestrator-platform |
| archetype | system-design |
| isAgentic | true |
| hasKnowledgeBase | true |
| confidence | high |
| strong anchors | 6 |
| supporting anchors | 4 |
| primary skill | `/analyze-my-resume` |
| source files | `resume.txt`, `blackbox-experience.md`, `microsoft-experience.md` |
| company synthesis | BlackBox (runtime + sandbox + telemetry) + Microsoft (multi-tenant infra) |

Full manifest in `manifest.json`. Two-anchor-minimum rule satisfied for every load-bearing claim; assumptions flagged inline.

## File Index

| File | What's In It |
|---|---|
| `00-question-and-context.md` | Original question, scope (in/out), resume anchors, assumptions, pack layout |
| `01-executive-summary.md` | Five design decisions, scale shape table, top-level Mermaid, reading order |
| `02-design-estimates.md` | Capacity math + 20-point agentic design rubric (Planner, Router, Critic, HITL, etc.) |
| `03-architecture.md` | End-to-end architecture with Mermaid, request lifecycle, LB chain |
| `04-api-and-contracts.md` | REST + WebSocket APIs (OrchestratorAPI, CatalogAPI, ConnectorBroker callbacks) |
| `05-low-level-design.md` | Per-service LLD: AgentRuntime, SkillExecutor, MemoryService, RAGService |
| `06-scaling-and-capacity.md` | Fleet sizing, sharding, cache layers, hot path analysis at 1M users / 5K concurrent |
| `07-security-and-isolation.md` | Multi-tenant isolation, WASM sandbox, ConnectorBroker, secret rotation, SOC-2 path |
| `08-reliability-observability-and-failures.md` | SLOs, failure modes, runbooks, TelemetryMesh, deterministic replay |
| `09-tradeoffs-and-alternatives.md` | LangGraph vs custom, Pgvector vs Pinecone, WASM vs containers, build vs buy on OpenAI Assistants |
| `10-cross-questions.md` | 30+ adversarial interviewer questions with answers |
| `11-cheat-sheet.md` | One-page whiteboard reference for live interview |
| `12-agentic-graph-structure.md` | Layer 1 (component graph) + Layer 2 (per-node state) with Mermaid |
| `13-memory-layer-design.md` | 15-point memory rubric: Working / Episodic / Semantic / Procedural with Mermaid |
| `14-ingestion-pipeline.md` | 15-point ingestion rubric: parse → chunk → dedup → embed → dual-write |
| `15-guardrails.md` | 15-point guardrail rubric: 5 boundary checks, prompt injection, PII, output classification |
| `manifest.json` | Pack metadata, anchors, question hash |

## How to Use This Pack for Interviews

**Before the interview (15 min prep):**
1. Read `11-cheat-sheet.md` end-to-end. It is the only file you must have in working memory.
2. Skim `01-executive-summary.md` for the five design decisions and the top-level Mermaid.
3. Glance at `03-architecture.md` Mermaid so you can redraw it from memory.

**Opening (interviewer asks the question):**
- Restate the problem in your own words. Anchor it: "this is a B2C extension of the LangGraph runtime + WASM sandbox I built at BlackBox."
- Draw the five-row stack (Edge / Control / Runtime / Intelligence / Data) from `11-cheat-sheet.md`.

**During the deep dive:**
- When asked about memory, switch to `13-memory-layer-design.md` mental model (4 stores, facade, write through GuardrailService).
- When asked about safety, switch to `15-guardrails.md` mental model (5 boundary checks, not 1).
- When asked about scale, anchor on the numbers in `06-scaling-and-capacity.md` (5K concurrent, 250 runtime pods, 50M spans/day).
- When asked "why this choice", answer from `09-tradeoffs-and-alternatives.md` — always with the cost AND the mitigation.

**Adversarial follow-ups:**
- Pre-canned answers in `10-cross-questions.md` cover 30+ likely challenges. If the interviewer asks something not listed there, follow the structure: name the failure mode, name the blast radius, name the mitigation, name the fallback.

**If asked to draw the API:**
- `04-api-and-contracts.md` has the request/response shape for run lifecycle, catalog, fork, connector OAuth callback.

**If asked about implementation specifics (LLD):**
- `05-low-level-design.md` covers service-internal logic, data models, concurrency control.

## Resume Grounding Quick Reference

| Anchor | Resume Line | Used For |
|---|---|---|
| LangGraph ReAct runtime, 10K+ runs/day | `resume.txt:51-52` | AgentRuntime, durable graph design |
| WASM sandbox, 1M+ executions, SOC-2 | `resume.txt:49-50` | SkillExecutor, isolation design |
| Graph workflow engine + checkpointing | `resume.txt:53-54` | Checkpoint contract, HITL pause/resume |
| Model router Claude/GPT/Grok, 1B tokens/mo | `resume.txt:55-56` | ModelGateway capability-aware routing |
| Telemetry mesh, 50M spans/day, 60% MTTR | `resume.txt:58-59` | TelemetryMesh, deterministic replay |
| Multi-tenant K8s + Azure VNet isolation | `resume.txt:87-89` | Per-tenant network policies, identity |
| AutoML 15M+ jobs/month, 200K users | `resume.txt:90-92` | Catalog scale + self-serve UX pattern |
| QUIC + Rust + identity rotation, 1M instances | `resume.txt:97-98` | ConnectorBroker identity rotation |
| RAG, HNSW, BM25, cross-encoder, Clickhouse | `resume.txt:60-61` | RAGService, IngestionPipeline, TelemetryMesh |
| ShareChat real-time bidding, 40M DAU | `resume.txt:111-114` | High-QPS consumer scale pattern |

## Project Conventions

This pack follows the conventions defined in:

- `/Users/sumansaurabh/Documents/startup-3/resume-skiller/design-packs/README.md` — supported pack archetypes and required file sets.
- `/Users/sumansaurabh/Documents/startup-3/resume-skiller/CLAUDE.md` — routing rules, agentic convention, two-anchor-minimum rule.

Generated by `/analyze-my-resume` with `isAgentic: true` and `hasKnowledgeBase: true`. The agentic lanes (12, 13, 14, 15) were activated automatically; the 20-point agentic checklist runs inside `02-design-estimates.md`.

## Validation Status

The in-loop critic checkpoint described in `CLAUDE.md` runs against `03-architecture.md`, `12-agentic-graph-structure.md`, `13-memory-layer-design.md`, `14-ingestion-pipeline.md`, and `15-guardrails.md` before this pack is finalized. Surviving objections, if any, land in `00-question-and-context.md` under `## Surviving Critic Objections`.

For the full three-phase production-readiness gate (Critic agent + Principal Engineer agent + approval artifact at `20-critical-agent-approval.md`), invoke `/critical-agent` against this pack folder.
