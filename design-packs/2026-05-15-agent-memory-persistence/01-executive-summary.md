# 01 — Executive Summary

## The 60-Second Answer

At BlackBox we treated "agent memory" as **five distinct stores with different
latency, durability, isolation, and retention contracts**, not one bag.

- **Execution state** — the source of truth for the DAG run. Append-only event
  log of (step, input, output, tool result, retry count, checkpoint version) in
  Postgres + blob storage. Survives crashes, drives durable execution and
  deterministic replay. Not visible to the model.
- **Short-term memory** — the working scratchpad for the current run. Live
  ReAct trace (thoughts, tool calls, observations) in Redis, with a Postgres
  write-through so retries don't lose it. TTL ≤ run lifetime.
- **Episodic memory** — the per-session story across runs. Append-only event
  log of "what the user said, what the agent did, what happened" in Postgres
  with periodic LLM rollup summaries. Survives the session.
- **Long-term memory** — schema-typed facts about a user/tenant/org that
  should persist forever (preferences, account profile, learned heuristics).
  Postgres JSONB with optional embeddings, gated by an explicit "memorize"
  decision so the agent can't write garbage at will.
- **Vector memory** — embedding-indexed *recall surface* for episodic rollups,
  long-term facts, and tenant documents (RAG). Qdrant + HNSW + bm25 + a
  cross-encoder reranker. Multi-tenant via per-tenant collections/namespaces.

These five stores are coordinated by a single **Memory Manager** service that
the LangGraph runtime calls; each ReAct step is wrapped in a checkpoint, and
each checkpoint emits OTel spans into the LLMOps telemetry mesh — that is what
makes the **60% MTTR reduction** and the **deterministic replay** real.

## Why This Architecture (vs "just use a vector DB")

| Force | What it implies | Where it lands |
| --- | --- | --- |
| Durable execution across crashes | Append-only event log + checkpoints | Execution state (Postgres + blob) |
| ReAct loop needs <50 ms read | In-process or in-memory cache | Short-term (Redis) with Postgres write-through |
| 10K+ runs/day, multi-turn | Session story compaction | Episodic (Postgres + LLM rollup) |
| Cross-session recall, RAG | Semantic search over text | Vector (Qdrant + HNSW + bm25 + reranker) |
| Stable user/tenant facts | Typed, queryable, mutable | Long-term (Postgres JSONB) |
| Multi-tenant + SOC-2 | Hard isolation, audit, retention | Per-tenant DEK + RLS + namespace + retention jobs |
| 1B+ tokens/month | Aggressive context budgeting | Memory Manager picks tiers per step |
| 50M spans/day, replay | Every memory op is a span | OTel into Clickhouse |

## The Spine Of The Answer (use this in the interview opener)

> "Memory is not a single store; it's a **plane**. We split it into execution
> state, short-term, episodic, long-term, and vector — each with its own
> durability and isolation contract. The DAG workflow engine treats every
> ReAct step as a checkpointed transaction over those stores, which is what
> makes the agent both **durably resumable** and **deterministically
> replayable** at 10K+ runs/day. A Memory Manager arbitrates context budget
> per step so we stay efficient at 1B+ tokens/month, and every memory write is
> a span in our LLMOps telemetry mesh, which is what cut MTTR by 60%."

## Top 5 Things The Pack Defends

1. Five tiers, not one — and why collapsing them is wrong.
2. Execution state is not memory the model sees — it is the durable substrate.
3. Vector memory is a *recall surface*, not a write target — writes go through
   short-term/episodic/long-term first; vector is derived.
4. Multi-tenant isolation is enforced at *every* tier, including ANN.
5. Determinism comes from the **execution log + content-addressable inputs**,
   not from pinning the LLM.
