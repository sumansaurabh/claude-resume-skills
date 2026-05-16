# 00 - Question and Context

## Original Question

> You built memory persistence for agents. What should be stored in short-term
> memory, long-term memory, vector memory, episodic memory and execution state -
> how did you build it, deep dive into architecture.

## In Scope

- The memory **plane** of the BlackBox agentic AI platform: short-term (working),
  long-term (semantic facts), vector (retrieval), episodic (per-session story),
  and execution state (durable workflow state).
- How memory plugs into the **ReAct/LangGraph runtime** and the **DAG workflow
  engine** with checkpointing and retry semantics.
- Multi-tenant **isolation**, SOC-2 controls, retention, and PII redaction.
- **Deterministic replay** support via the LLMOps telemetry mesh.
- Capacity planning at **10K+ agent runs/day** and **1B+ tokens/month**.

## Out Of Scope (call out, do not deep-dive)

- WASM sandbox internals - covered in `2026-05-07-wasm-sandbox-security-isolation`.
- Model router design across Claude/GPT/Grok - separate question.
- Telemetry mesh storage internals (Clickhouse layout, span schema) - referenced
  but not designed end-to-end here.

## Resume Anchors Used

| Claim | Source |
| --- | --- |
| Memory persistence with DAG checkpointing and retry semantics | `resume.txt` (BlackBox bullet 3) |
| Long-running resumable agents with memory persistence | `blackbox-experience.md` point 13–14 |
| ReAct agent runtimes on LangGraph / LangChain | `resume.txt`; `blackbox-experience.md` #7 |
| 10K+ agent runs/day | `resume.txt`; `blackbox-experience.md` #11 |
| 1B+ tokens/month, context optimization | `resume.txt`; `blackbox-experience.md` #18–19 |
| LLMOps telemetry mesh, 50M spans/day, deterministic replay | `resume.txt`; `blackbox-experience.md` #20 |
| Vector DB, HNSW, bm25, cross-encoder, embeddings stack | `resume.txt` (technologies) |
| Multi-tenant + SOC-2 | `blackbox-experience.md` #5 |

## Assumptions

These are explicitly assumptions because the resume does not name internals:

1. The **execution state** for the DAG engine is checkpointed in Postgres and
   blob storage; the runtime is durable in the Temporal/LangGraph-checkpoint
   sense (history-replay vs state-snapshot is a hybrid - see `02-architecture.md`).
2. The **vector memory** uses Qdrant with HNSW (Qdrant is on the resume's
   Microsoft stack and the BlackBox bullets list HNSW + bm25); we treat it as the
   default ANN store, with bm25 + cross-encoder reranking on top.
3. **Short-term memory** is held in Redis with a per-run TTL and per-step write-
   through to the durable execution log so retries see the same content.
4. **Episodic memory** is a per-session append-only event log in Postgres + S3,
   with a periodic LLM-summarized rollup written into vector memory.
5. **Long-term memory** is a curated, schema-typed key/value + JSONB store
   (Postgres) with optional vector embeddings of values for semantic recall.
6. The platform is **multi-tenant by `tenant_id`**, with row-level security in
   Postgres, payload-level encryption with per-tenant DEKs, and
   namespace-per-tenant isolation in Qdrant.

These assumptions are flagged in each downstream file and challenged in
`09-cross-questions.md`.

## Why This Question Matters For BlackBox

A No-Code AI platform that runs **10K+ agent runs/day** with **durable
execution** and **deterministic replay** has to answer four memory questions
correctly - and they are usually conflated:

1. *Will my retry resume from where it crashed?* → execution state.
2. *Does the agent remember the last 4 turns of "the user wanted JSON, not YAML"?* → short-term + episodic.
3. *Does it remember anything about my account next week?* → long-term + vector.
4. *Can support replay this run when the customer says "the agent went rogue"?* → execution state + episodic + telemetry.

A weak answer collapses these into "we use a vector DB." A strong answer assigns
each one a tier with its own latency budget, retention policy, isolation model,
and replay semantics - which is what this pack does.
