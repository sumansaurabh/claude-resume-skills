# 09 - Tradeoffs and Alternatives


## Section 2 - Big crossroads decisions

### Decision: Workflow engine

**Context.** Agent runs are non-trivial graphs: reason, choose tool, call tool, observe, branch, retry, suspend for human approval, resume hours later. At BlackBox we ran 10K+ agent runs/day on LangGraph-based ReAct + DAG orchestration, and we know the failure modes. The question is whether to repeat that choice for a B2C product that has to be cheap, fast on the happy path, and operable by a small team.

**Options compared:**
- **LangGraph + a custom durable layer.** Use LangGraph for graph definition + ReAct primitives, add our own checkpoint store, retry semantics, and resume API on top.
- **Temporal.** Industrial-strength durable workflow engine; we'd model agents as workflows and tool calls as activities.
- **AWS Step Functions.** Managed state machines; very durable, very expensive per-transition, very AWS-locked.
- **In-house DAG engine.** Build the whole thing. We have the experience to.
- **Inngest / Trigger.dev.** Newer durable-execution products with friendlier developer ergonomics.

**What we picked.** LangGraph + a custom durable layer.

**Why:**
- LangGraph's graph + ReAct primitives are the natural shape of agent code.
- The custom durable layer is small (checkpoint store on Postgres, retry policy, resume API) compared to building a full workflow engine, and it gives us deterministic replay for trace-based debugging.
- We avoid vendor lock-in to AWS and we keep local-dev story tight (LangGraph runs in a single process for tests).

**Downside accepted:**
- **LangGraph maturity risk.** It's a fast-moving open-source project; we will absorb breakage on minor versions and may fork or patch.
- **In-house ops burden.** We own the durable layer end-to-end (replication, backups, the resume-from-checkpoint semantics). That's a few engineers' headspace forever.

---

### Decision: Memory store

**Context.** Memory is per-user, mostly small (hundreds to low-thousands of vectors per active user), heavily read at agent-start, and security-sensitive (cross-tenant leakage is unacceptable). We already operate Postgres for users / billing / catalog. RAG document chunks for popular catalog agents could push total vectors into the 100M–1B range over a couple of years.

**Options compared:**
- **pgvector on our existing Postgres.** Single stateful system, transactional with the rest of user data, deletion = SQL DELETE.
- **Pinecone (managed).** Best-in-class managed vector DB; pay per pod-hour.
- **Weaviate (self-hosted or managed).** Hybrid search built-in; richer schema.
- **Milvus.** Cassandra-style scale ceiling, more operationally heavy.
- **Qdrant.** good defaults.

**What we picked.** Qdran, with HNSW indexes per tenant-scoped table partition.


---

### Decision: Skill sandbox

**Context.** Skills are user-written or catalog-installed scripts that execute as part of an agent run. They may be untrusted (catalog) or semi-trusted (the user's own). We need the same shape here, sized for consumer load.

**Options compared:**
- **Sandbox.** Per-request sandbox spun up in microseconds, memory-safe by construction, no syscall surface unless we grant it.
- **Docker containers.** Familiar, native binaries, but slow cold-start and a much larger trusted attack surface.
- **Firecracker microVMs.** True microVM isolation, KVM-backed; the AWS Lambda model.
- **gVisor.** Userspace kernel intercept; mid-tier isolation, mid-tier cost.
- **No sandbox, run in a constrained Node.js VM context.** Cheap, fast, demonstrably unsafe.

**What we picked.** Firecracker

**Why:**
- Cold start under 90 - critical because we expect dozens of skill calls per agent run on the median path, and a slow sandbox destroys interactive UX.
- Memory and CPU overhead per execution is 5–10x cheaper than container approaches, which matters at consumer scale and aggressive free-tier limits.

---

### Decision: Model routing strategy

**Context.** We will run 3+ LLM providers from day one. Every agent step needs a model picked for it, balancing capability (long context, tool use, structured output, multimodal), cost, latency, and reliability. The routing decision can be made by static rules or by a learned router.

**Options compared:**
- **Static capability-aware rules table.** Hand-authored decision tree: "step type X + context length Y + tool-use needed Z → model A; fallback B."
- **Learned router (small classifier).** Train a model on labelled examples of (request, best model) and use it to predict at runtime.
- **LLM-as-router.** Ask a cheap LLM to pick the model for each step.
- **Round-robin / cheapest-first.** No routing logic, just price ordering.
- **Per-agent declared preference.** Agent author hard-codes the model.

**What we picked.** Static capability-aware rules **plus** an online evaluation feedback loop that flags rule cells where the chosen model under-performs.

**Why:**
- Static rules are debuggable and auditable. When a user asks "why did my agent slow down today?" we can point at a row in a table, not a model output. 
- The feedback loop closes the gap: when a rule cell shows quality regression in online evals or in user thumbs-down rates, ops can iterate on the rule. We don't need a learned router to start; we need a tight feedback loop.
- Cold-start is zero. New providers slot into the rules table immediately.

**Downside accepted:**
- **Rules table grows.** Combinatorial growth in cells (step-type x context-length x tool-need x latency-budget x cost-tier). We accept that the table will need pruning passes every quarter. The right time to swap in a learned router is when the table grows past human-maintainable (~50 cells), not before.

---

### Decision: Memory write triggers

**Context.** When does the agent write to long-term memory? Every turn writes too much noise and inflates cost. Writing only on explicit user request misses the value. We need a middle ground.

**Options compared:**
- **Every turn.** Every assistant turn produces an embedding + memory record.
- **Importance-scored writes.** A cheap heuristic (length, novelty, presence of declarative facts, user-corrected information) scores each turn; only above threshold gets written, plus periodic LLM-judged consolidation.
- **Explicit user request only.** "Remember this" button.
- **Tool-driven only.** The agent decides via a `remember()` tool call.

**What we picked.** Importance-scored writes with cheap heuristics, plus a periodic (e.g. every N turns or once per session-end) LLM-judged consolidation pass that summarizes and promotes short-term memory to long-term.

**Why:**
- Heuristic-first is cheap and lets us reject obvious noise (small-talk, repeated questions, tool failures).
- The LLM-judged consolidation pass catches what the heuristic misses, and amortizes its cost across many turns.

---