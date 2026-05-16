# Agent Memory Persistence - Design Pack

Principal-engineer pack on the BlackBox agent memory subsystem: short-term,
long-term, vector, episodic, and execution-state stores, and the architecture
that ties them into the ReAct/LangGraph runtime, the DAG workflow engine, and
the LLMOps telemetry mesh.

## File Map

| File | What it covers |
| --- | --- |
| `manifest.json` | pack metadata, archetype, question hash, anchors |
| `00-question-and-context.md` | original prompt, scope, assumptions, resume anchors |
| `01-executive-summary.md` | the short, strong answer |
| `02-architecture.md` | end-to-end memory plane, components, write/read paths |
| `03-api-and-contracts.md` | memory APIs, idempotency, error model, payload schemas |
| `04-low-level-design.md` | services, modules, classes, sequence flows |
| `05-scaling-and-capacity.md` | volume model at 10K+ runs/day and 1B+ tokens/month |
| `06-security-and-isolation.md` | tenant isolation, PII, poisoning, SOC-2 controls |
| `07-reliability-observability-and-failures.md` | retries, replay, traces, failure modes |
| `08-tradeoffs-and-alternatives.md` | rejected designs and why |
| `09-cross-questions.md` | interviewer follow-ups + crisp rebuttals |
| `10-cheat-sheet.md` | talking points for live delivery |
| `12-state-machine-and-workflows.md` | run state, checkpoint state, memory lifecycle |
| `13-data-model-and-storage.md` | schemas, retention, store-by-store choices |

## How To Use

1. Read `01-executive-summary.md` to get the spine of the answer.
2. Walk `02-architecture.md` and `12-state-machine-and-workflows.md` together; the
   memory tiers only make sense alongside the run lifecycle.
3. Use `04-low-level-design.md` and `13-data-model-and-storage.md` to handle
   "what's in the row" follow-ups.
4. Use `09-cross-questions.md` for adversarial pressure prep.
5. Use `10-cheat-sheet.md` as the last-mile flashcard before the interview.

## Grounding

Anchored in `resume.txt` and `blackbox-experience.md`:

- "Designed graph workflow engine (DAG execution, checkpointing, retry semantics)
  enabling long-running, resumable agents with **memory persistence** and
  fault-tolerant execution across distributed environments." (resume.txt)
- "You built or led **memory persistence** for agents, allowing state to survive
  across workflow steps and possibly across sessions." (blackbox-experience.md #14)
- LangGraph/LangChain ReAct agent runtimes (resume.txt; blackbox #7).
- LLMOps telemetry mesh - 50M spans/day, 2.5TB+/month, deterministic replay
  (resume.txt; blackbox #20).
- 10K+ agent runs/day; 1B+ tokens/month context optimization (resume.txt).
- Vector DB / HNSW / bm25 / cross-encoder stack (resume.txt technologies line).
- Multi-tenant isolation + SOC-2 driver (blackbox #5).

Where exact internal implementation is not in the resume, the pack labels
choices as **assumptions** rather than facts.
