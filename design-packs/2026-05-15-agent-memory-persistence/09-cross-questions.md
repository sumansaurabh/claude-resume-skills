# 09 - Cross Questions and Rebuttals

Compact set of follow-ups a Principal-level interviewer is likely to throw,
with the strong answer.

---

**Q1. "Why do you have five stores? You're over-engineering."**

A: Each tier has an incompatible constraint. Short-term needs <5 ms reads on
the hot loop; execution state needs strong durability and replay; long-term
needs schema-typed, audited writes; vector needs ANN + rerank with its own
scaling envelope; episodic needs lossless append-only history with
summarization. Folding two of them collapses one constraint. We tried
"vector for everything" early; it lost long-term fidelity (`org.policies.x`
got fuzzy-matched to the wrong key). The five-tier split is the *minimum*
that respects the constraints, not the maximum.

---

**Q2. "Vector memory is the famous one. Why isn't it the primary store?"**

A: Vector memory is a *recall surface*, not a write target. Sources of truth
live in episodic and long-term; vector is derived (embedding of summaries
and facts). That separation means we can: (a) rebuild the vector store
without losing data, (b) delete a user's data deterministically (delete the
sources, then re-embed), and (c) keep keyed lookups for facts that should
be exact rather than fuzzy.

---

**Q3. "What does 'durable execution' mean here, concretely, beyond 'we
retry'?"**

A: It means three things, all observable: (1) every step is bracketed by
`BeginStep` and `CommitStep`, with a unique `(run_id, step_id, kind)`
constraint in PG that makes duplicate writes a no-op; (2) every retry resumes
from the latest committed checkpoint, not from the top of the run; (3)
content-addressed inputs (`prompt_hash`, `args_hash`) make replay
deterministic at the system level even when the model is nondeterministic.
"We retry" is at-most-once guessing; this is at-least-once with idempotent
fencing → effectively exactly-once at the memory plane.

---

**Q4. "How do you handle tools that already executed side effects when the
agent crashes mid-step?"**

A: The `committed` event for a tool call records `tool_call_id`,
`args_hash`, `result_hash`, and the sandbox run id. If a worker crashes
*after* the tool ran but *before* `CommitStep`, recovery sees an abandoned
draft, looks up the tool's idempotency log (most tools we expose require
client-side idempotency keys we generate), and either reuses the prior
result or, for non-idempotent tools, surfaces it for human approval rather
than re-executing. Critically: replay never re-executes side-effect tools;
it only re-uses stored results.

---

**Q5. "Show me how cross-tenant leakage can't happen via vector retrieval."**

A: Layered defenses: (1) tenant claim in JWT verified by gateway; (2) per-tenant
Qdrant collections, so ANN can't even *see* another tenant's items;
(3) PolicyEngine-level scope enforcement on the query payload; (4) the
ContextBuilder asserts every assembled item's `tenant_id` matches the
request's; mismatch aborts the run and pages security. The single most
important choice was collections-per-tenant; filters alone are a soft
boundary and degrade under low selectivity.

---

**Q6. "What stops the agent from writing garbage into long-term memory?"**

A: Three guards. (1) Schema registry - keys are declared with JSON schemas;
unknown keys → 422. (2) Source attribution + confidence - writes derived
from user input get `confidence < 0.5` and high-risk keys are
`review_required`, which queues for human approval. (3) Audit trail per
key change, so "the agent decided I'm in Berlin" is reversible and
auditable. Combined, an injected prompt cannot turn into a permanent lie
without going through gates.

---

**Q7. "Why do you need a separate Memory Manager service? Why not make it a
library?"**

A: Tenant isolation, audit, and replay all benefit from a single chokepoint.
A library scatters those concerns across every agent author's repo. Also,
the cross-encoder rerank is GPU-bound; it scales differently than the rest
of the agent runtime. The cost is one network hop, ~1 ms, well below the
ReAct budget.

---

**Q8. "How do you keep context within budget at 1B+ tokens/month?"**

A: The ContextBuilder is the budgeter. It receives tier outputs and packs
with a fixed priority: system prompt → short-term trace (most recent first)
→ episodic summary → long-term keyed facts → vector top-K. Each tier has a
soft cap. The cross-encoder rerank is the lever for vector - top-50 ANN
∪ top-50 bm25 reranked to 5–8 relevant chunks rather than 30 mediocre
ones. Over six months, we cut average context size by ~35% while improving
agent task success by ~12% on internal evals. The math: rerank pays for
itself in saved input tokens within weeks.

---

**Q9. "Describe one real failure mode this design caught that a simpler
design wouldn't."**

A: Two examples. (1) An agent author shipped a prompt that started writing
a new long-term key `user.notes` that wasn't in the registry - the platform
refused all writes with 422, which surfaced in the schema-rejection
dashboard before any user noticed; in a free-form K/V design the writes
would have succeeded and polluted memory across tenants. (2) During a Qdrant
deployment, retrieval went degraded; ContextBuilder marked manifests
`vector=skipped` and the replay viewer correctly showed "this run had no
vector context" - without that, the symptom ("agent forgot about the
user's docs") would have looked like an LLM regression and we'd have
chased our tail.

---

**Q10. "What about KV cache? You didn't mention it."**

A: KV cache lives in the model serving layer, not the memory plane.
Provider APIs we use (Anthropic, OpenAI) own their cache. Where we *do*
care: the prompt structure of context builds is stable across steps in a
run (system prompt → long-term facts → episodic summary → STM), which
maximizes provider prefix cache hit rate. That's a context-shape choice
the ContextBuilder enforces, not a store we run.

---

**Q11. "How does this compare to what LangGraph gives you out of the box?"**

A: LangGraph gives a checkpointer interface with default backends for
SQLite/Postgres. We implemented the interface; we did not use the default
backend. Reasons: (a) the default checkpoint is a serialized state snapshot
per checkpoint, which is fine for graphs but doesn't cover episodic /
long-term / vector or audit / tenant isolation; (b) we need an event log,
not just snapshots, for replay; (c) the LangGraph checkpoint table doesn't
have multi-tenant semantics. So the boundary is: LangGraph runs the graph;
we own what's remembered.

---

**Q12. "Walk me through the worst incident."**

A: A rollup pipeline regression generated summaries that contained
JSON-shaped strings the agent then mis-parsed as tool calls - a classic
"data eaten as instructions" bug. The blast radius was contained because
(a) episodic events themselves were untouched (rollup is derived), (b) the
safety eval gate on rollup output started failing, paging us within 4
minutes, and (c) we rolled back the rollup template, re-ran rollups, and
the system was clean within 30 minutes. The fix: the rollup prompt now
wraps user content in a way the agent cannot interpret as instructions, and
the eval gate explicitly tests for "no tool-call-shaped tokens." This is a
standard prompt-injection / template-confusion pattern, and the *only*
reason MTTR was minutes not hours is the determinism + replay tooling
(`resume.txt` 60% MTTR claim).

---

**Q13. "Replay sounds expensive. How much trace volume is that?"**

A: Spans for memory ops are a fraction of the platform's 50M spans/day.
We don't store full payloads in spans - we store hashes and pointers; the
payloads live in PG/blob with bounded retention. So replay reads from PG
and blob, not from the trace store. Trace store gives us the *index* into
which run/step to look at; the actual replay reads source-of-truth
storage. Cost stays bounded because retention windows are tight (30–90
days hot for execution event payloads; longer for long-term and audit).

---

**Q14. "How would you evolve this for a 10× scale jump?"**

A: Three moves. (1) Partition `exec_event` by tenant_id hash + month and
move cold partitions to columnar (Parquet on S3) earlier - keeps hot
PG flat. (2) Tiered embedding models - small for high-volume episodic,
large for long-term + RAG; cuts embed spend ~40%. (3) Per-region active
vector replicas with eventual consistency for cross-region read locality;
writes stay region-pinned. The architecture doesn't fundamentally change;
the per-tier scaling plan is what the model already supports.

---

**Q15. "If you had to remove one component, which and why?"**

A: The cross-encoder reranker, reluctantly. It's the most expensive piece
and tenants without dense retrieval needs don't benefit. We'd make it a
**per-tenant feature flag**, defaulting on, off-able for low-recall-need
workloads. We'd never remove the schema registry or the execution event
log - those are load-bearing for safety and replay respectively.

---

For deeper adversarial pressure (security-pushback, scale-stressors,
api-and-lld-pushback) - extend under `cross-exam/` per the design-pack
contract.
