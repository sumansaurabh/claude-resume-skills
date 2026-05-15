# 10 — Cheat Sheet

## The Opener (memorize this)

> "Memory in our agent platform is a **plane**, not a store. Five tiers:
> execution state, short-term, episodic, long-term, vector. The DAG workflow
> engine treats every ReAct step as a checkpointed transaction over those
> tiers — that's what makes the agent durably resumable and deterministically
> replayable at 10K+ runs/day. A Memory Manager is the chokepoint for
> isolation, audit, and context budgeting at 1B+ tokens/month."

## The Tier Cheat Card

| Tier | One-liner | Store |
| --- | --- | --- |
| **Execution state** | Source of truth for the run; not visible to LLM | PG append-only events + blob; checkpoints |
| **Short-term** | Working scratchpad for *this* run | Redis primary + PG write-through |
| **Episodic** | Per-session story across runs + LLM rollups | PG events + S3 + summary table |
| **Long-term** | Schema-typed durable facts about user/org/tenant | PG JSONB + schema registry + audit |
| **Vector** | Recall surface for episodic rollups, long-term facts, docs | Qdrant HNSW + bm25 + cross-encoder rerank |

## Five Things To Land In Every Answer

1. **Five tiers, different contracts** — collapsing them is the failure mode.
2. **Execution state is the substrate**, not memory the model sees.
3. **Vector is derived**, not a write target. Sources live in episodic /
   long-term.
4. **Determinism comes from the system** (event log, manifests, content
   hashes), not from pinning the model.
5. **Multi-tenant isolation enforced everywhere** — collections per tenant
   in Qdrant, RLS in PG, JWT-bound tenant claim, ContextBuilder asserts.

## Numbers To Drop

- **10K+ agent runs/day** (resume).
- **1B+ tokens/month** through the model orchestration layer (resume).
- **50M spans/day**, **2.5TB+/month** trace data, **60% MTTR reduction**
  (resume).
- ~80K ReAct steps/day → ~600 RPS peak on `exec_event` writes.
- p99 < 50 ms for step writes; p99 < 200 ms for context build.

## Mini-Stories To Pull Out

- **The schema registry incident.** An agent author shipped a write to
  `user.notes` not in the registry; platform 422'd before any pollution.
- **The rollup template confusion.** Rollup-generated text shaped like a
  tool call; safety gate caught it; clean recovery in ~30 min thanks to
  determinism + replay.
- **The Qdrant degradation.** ContextBuilder marked manifests
  `vector=skipped`; replay viewer correctly attributed the drop in agent
  quality to retrieval, not to the LLM.

## Pushback Reflexes

- "Why not one store?" → incompatible latency / durability / write semantics.
- "Why not vector for everything?" → keyed lookup matters for facts; vector
  is a recall surface, not a source of truth; sources live in
  episodic / long-term.
- "Why a Memory Manager service?" → tenant isolation, audit, replay all
  benefit from one chokepoint; rerank scales independently.
- "How do you stop poisoning?" → schema registry, source attribution,
  `review_required`, audit. Agent cannot directly persist long-term at will.
- "Where's KV cache?" → it's in the model serving layer; we keep prompt
  shape stable to maximize provider prefix caching.

## What NOT To Say

- "We use a vector DB for memory." (Wrong — that's one tier of five.)
- "Retries cover durability." (Wrong — durability is the event log + idempotent
  fencing.)
- "Filters isolate tenants in Qdrant." (Wrong — collections do; filters are
  for scope-within-tenant.)
- "We pin the model so replay is deterministic." (Wrong — the system is
  deterministic; the model intentionally isn't.)
- "Memory is just LangChain memory." (Wrong — LangGraph runs the graph; we
  own what's remembered.)

## Closing Line

> "The whole design exists so two things are simultaneously true: the agent
> can fail mid-step at 3am and resume cleanly, and a support engineer can
> replay the run end-to-end and tell you exactly which retrieved chunk
> caused the wrong answer. That combination is what cut MTTR by 60% on a
> system running 10K+ runs/day on 1B+ tokens/month."
