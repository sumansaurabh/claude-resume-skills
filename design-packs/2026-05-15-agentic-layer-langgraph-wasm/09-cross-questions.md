# 09 — Cross-Questions and Rebuttals

Pushback questions an interviewer will fire after the main answer, with
crisp Principal-level rebuttals. Each rebuttal is the kind of thing you
should be ready to say in 90 seconds.

---

## Q1. "LangGraph is just a wrapper — what does it actually buy you that you couldn't write in two weeks?"

**Rebuttal.** LangGraph gives three things I'd otherwise build: (a) a typed
state model with named reducers, (b) a compiled graph definition with
checkpointer hooks, and (c) a community that's actively patching the
LangChain ecosystem we already depend on. Yes, I could rewrite all of that
— I'd build the same primitives. The reason I don't is opportunity cost.
At 10K runs/day, the bottleneck is the *policy*, *replay*, *cost*, and
*sandbox* surfaces — not the graph runtime. LangGraph carries its weight
because it lets a team of 6 ship in months instead of writing a graph
runtime from scratch.

What I do *own* is the executor, checkpointer backend, tool registry,
policy gate, and observability. LangGraph's default executor is a nice
in-process Pregel-style loop; we replace it with the stateless coordinator
in `04-low-level-design.md`. That's the principal-level move: keep the
ergonomic library, replace the parts that need to scale.

---

## Q2. "Why not Temporal? It already has durable execution, retries, and replay."

**Rebuttal.** Temporal is excellent for *workflows* — imperative code that
orchestrates services. It's a poor fit for *agent reasoning loops*. Three
specific frictions: (1) ReAct's reasoning trace isn't a workflow, it's a
graph with re-entry on critic feedback, which is awkward in Temporal's
activity model. (2) Temporal's history-based replay is great for
deterministic activities but our activities — model calls — are inherently
non-deterministic; we need our own caching layer on top, which negates the
benefit. (3) Operating a Temporal cluster is a real ongoing cost; LangGraph
runs in our existing Kubernetes fleet.

If we were building a workflow engine for human-defined flows
(invoice approvals, ETL), Temporal would be the right answer. For an agent
reasoning loop, it isn't.

---

## Q3. "WASM doesn't really sandbox network or system calls. How is this SOC-2-grade?"

**Rebuttal.** Two parts to this answer.

First, the threat model: WASM's *strong* isolation is at the memory and
syscall boundary — no shared linear memory between instances, no syscalls
without a host import. That's exactly what we want for AI-generated code,
which is most likely to *try* to read process memory, write the host
filesystem, or invoke `exec`. WASM denies all three at the runtime level.

Second, defense in depth. WASM is the innermost layer. Outside it: Seccomp
on the host runner, gVisor for the syscall surface, brokered HTTP egress
through an allowlisted proxy, ephemeral workspaces, signed envelopes.
SOC-2 doesn't ask "is one technology unbreakable" — it asks "are there
documented compensating controls." The audit trail at the agent layer
(policy decisions, signed envelopes, egress proxy logs) is what
unblocks the certification, not WASM in isolation.

---

## Q4. "Your ReAct loop will burn money on edge cases. How do you cap it?"

**Rebuttal.** Six layered caps:

1. `max_iterations` per milestone (default 12).
2. `loop_signature` detection: if the same `(tool, args_hash)` trigram
   repeats, the run parks to `human_gate`.
3. Per-run `max_tokens`, `max_tool_calls`, `max_wallclock_ms` from the
   request payload, enforced before every model and tool call.
4. Per-tenant monthly quotas.
5. The dedup observation message: when a coder is about to call the same
   tool with the same args again, we short-circuit and inject a system
   message telling the model the call was already made.
6. A critic node after every milestone — a milestone that doesn't
   make progress in N iterations is escalated to a stronger model once,
   then failed.

Without these, a single bad prompt can burn $50 in tokens in twenty
minutes. With them, the worst-case run cost is bounded and predictable.

---

## Q5. "How do you make a non-deterministic agent reproducible?"

**Rebuttal.** Reproducible isn't a single property — there are levels:

- **Replay reproducibility**: any past run can be re-executed with cached
  model and tool observations. This is what we have. The system stores
  the prompt hash, the canonical args hash, and the response payload as
  a blob. Replay feeds those back to the graph in deterministic order.
- **Re-run reproducibility**: running the same prompt through the same
  model again. This is *not* generally possible because LLMs aren't
  bit-stable across calls even at temperature=0; we approximate it with
  pinned model snapshots and seed where the provider supports it.
- **Re-roll reproducibility**: same prompt, different model. We *want*
  divergence here — it's how we evaluate the router.

The MTTR claim in the resume relies on the first level. An incident
investigator pulls a past run from the trace store, replays through the
checkpoints, sees where the divergence happened in the graph, and fixes
the code. That's deterministic enough to debug.

---

## Q6. "Why a separate model router service? Why not call providers from the worker?"

**Rebuttal.** Three reasons:

1. **Failover and capability routing are global concerns** — the worker
   shouldn't know that GPT is currently 429'ing across the fleet. The
   router has a fleet-wide view of provider health.
2. **API keys are scarce.** Sharing them across many workers, with a
   centralized rate limiter and per-key burn tracking, is much more
   efficient than per-worker key allocation.
3. **The router is the audit boundary for model spend.** Every token
   billed flows through it; cost attribution, quota enforcement, and
   per-tenant billing all live there. Letting workers call providers
   directly would scatter that logic.

The cost is one extra hop (~1 ms locally) — negligible compared to LLM
latency.

---

## Q7. "What happens when a coder node makes a destructive tool call mid-loop, and the next iteration thinks it should undo it?"

**Rebuttal.** Two mechanisms cooperate.

First, `side_effect_class`. `DESTRUCTIVE` is the highest class — the policy
gate requires human approval. So the destructive call doesn't fire without
explicit consent.

Second, `human_gate` isn't a hard wall. The agent worker writes a
`policy_decisions` row, parks the run, and the user is shown a structured
preview ("the agent wants to run `rm -rf node_modules`; approve or deny"). On
approval, the call goes through; on denial, an observation flows back to
the coder saying "the user denied that action." The coder then reasons
about what to do next.

For the `EXTERNAL_MUTATION` class (webhook sends, network mutations), we
*never* auto-retry, even on apparent failure. The model has to explicitly
decide to call the tool again. This prevents the "thought the webhook
failed, sent it again, now the customer got two emails" failure mode.

---

## Q8. "Memory persistence sounds fancy but can leak across tenants. How do you stop it?"

**Rebuttal.** Three structural controls.

1. Vector collections are *named* per tenant + project: `mem-{tenant}-{project}`.
   The retriever client can't pass an arbitrary collection name — it passes
   `project_id`, and the resolution happens server-side after auth.
2. Postgres rows for working memory carry `tenant_id` with row-level
   security. A worker that picks up a run whose state's `tenant_id` doesn't
   match the lease's authorized tenant fails immediately.
3. Memory writes go through a redaction step. Specifically, any string
   matching common secret patterns or PII-classified content is replaced
   with a typed placeholder before storage. We don't want to learn that
   a tenant's API key got memorized into our vector store.

The thing that *isn't* a control — model embedding similarity — could in
theory bring up content from another collection if we made a routing
mistake. The structural namespacing in (1) makes that mistake impossible
at the API level.

---

## Q9. "1B tokens/month sounds expensive. How do you control cost without hurting quality?"

**Rebuttal.** Five techniques, ordered by impact:

1. **Capability-based routing.** Route only the prompts that need the long
   context or the strong reasoning to the expensive model. Slack-clone
   planning → Claude long-context; per-file code patches → GPT 4.1;
   classification / critics → Haiku-tier or Grok. This is where the
   biggest savings come from.
2. **Prompt caching.** Claude's prompt cache reuses the system prompt +
   plan across all coder calls in a run. That's roughly 70% of the input
   tokens of a multi-milestone run cached. Real money.
3. **Context budgeting per node.** Each node has a token budget for its
   prompt. The retriever and memory layer must fit inside it. If they
   don't, the memory selection step summarizes before injecting.
4. **Observation caching by `args_hash`.** A repeat tool call returns the
   cached observation without re-execution. This both saves sandbox spend
   and shortens the conversation, saving tokens on the next model call.
5. **Output schema enforcement.** Constrained JSON output cuts ~30% of
   output tokens vs free-form natural language for the same data.

Together these turn a $5 raw cost run into a ~$1.20 actual cost run.

---

## Q10. "If the WASM sandbox plane is down, what does the user see?"

**Rebuttal.** A graceful failure, not a stuck run.

The sequence: agent worker emits a tool call → broker returns
`RESOURCE_EXHAUSTED` after retry → worker bumps an internal retry counter
→ on second failure, writes a checkpoint with `status=paused`,
`error.code=SANDBOX_UNAVAILABLE`, emits an SSE `error` event with
`recoverable=true`, releases the lease. The UI shows "the sandbox plane is
temporarily unavailable; the run is paused and will resume automatically
when service returns." A platform-level health monitor watches sandbox
broker health; when it recovers, paused runs are re-enqueued.

The principal-level point: **failure modes are designed, not stumbled
into.** Pausing-with-resumability is a first-class state, not an exception
path.

---

## Q11. "Six engineers on this platform — what's the actual decomposition?"

**Rebuttal.** Roughly:

- **2 engineers on the agent runtime**: graph, executor, checkpointer, nodes.
- **1 engineer on the tool registry + policy gate + SOC-2 evidence path.**
- **1 engineer on the model router and cost/routing logic.**
- **1 engineer on the LLMOps telemetry mesh and replay engine.**
- **1 engineer on the API gateway, SSE hub, and product surface integration.**
- (The Golang WASM sandbox plane is a separate ownership; I led architecture
  on both but day-to-day staffing is separate.)

The interface between these pairs is the contract surface in
`03-api-and-contracts.md`. We avoided shared-database antipatterns; every
pair talks over either gRPC or a small Postgres-table contract.

---

## Q12. "What was the hardest distributed systems problem on this platform?"

**Rebuttal.** Honestly, **idempotency for tool calls with side effects when
the worker can die between dispatch and observation**.

The naive thing — retry on lease loss — duplicates the side effect. The
opposite — never retry — fails the run on every transient hiccup. The
solution is a content-addressed envelope (`envelope_id` is a ULID computed
deterministically from `run_id + node_seq + tool + args_hash + attempt`),
with the broker maintaining an idempotency table keyed by envelope_id. A
duplicate envelope returns the cached observation, not a re-execution.

The subtle bit: `attempt` is incremented only when the *agent's policy*
decides to re-try (e.g. the model emitted a "let me try again" message),
not when the worker simply lost its lease. Lease-loss retries reuse the
exact same envelope ID, so the side effect is deduped.

This is the kind of detail that distinguishes a Principal-level answer
from a senior one — knowing exactly where the determinism boundary sits.

---

## Q13. "Sell me on this platform vs just paying for OpenAI Assistants and Code Interpreter."

**Rebuttal.** OpenAI Assistants is a fine product for *single-tenant
hobbyist scale*. It falls apart on three dimensions BlackBox cared about:

1. **Vendor lock-in.** Assistants ties you to OpenAI. Our resume
   explicitly says we span Claude, GPT, and Grok — that's not possible on
   Assistants.
2. **SOC-2.** OpenAI's Code Interpreter runs on OpenAI infrastructure;
   the audit boundary is OpenAI's, not ours. Enterprise customers want
   the audit boundary inside our cluster. WASM sandbox plane sits inside
   our VPC.
3. **Cost control and replay.** Assistants doesn't expose enough trace
   data to do real cost attribution or deterministic replay at our scale.
   The MTTR claim — 60% reduction — depends on owning every span.

If we were a 3-person startup, Assistants would be the right starting
point. At enterprise scale with SOC-2 and multi-model needs, we'd build
exactly what we built.
