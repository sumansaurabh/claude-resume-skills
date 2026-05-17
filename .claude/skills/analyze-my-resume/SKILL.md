---
name: analyze-my-resume
description: |
  Primary resume-grounded interview design orchestrator. It reads `resume.txt` plus
  `*-experience.md` files in this repo, maps the user's question to the strongest
  experience anchors, fans work out across parallel agents, and writes a principal
  engineer design pack under `design-packs/`, including API and low-level design
  follow-through when the interview topic warrants it.
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
  - Bash
triggers:
  - analyze my resume
  - based on my experience answer this question
  - create a principal engineer design pack
  - build an interview answer from my resume
---

## Purpose

Use this as the default skill whenever the user asks a system design, API design, or
architecture question that should be answered from the experience captured in this repo.

The skill should not stop at a chat answer. By default it should create a reusable,
multi-file markdown pack under `design-packs/` unless the user explicitly asks not to.

The pack must follow one of the supported archetypes in `design-packs/README.md` and
must include `manifest.json`.

## Inputs To Read First

Always read:

- `resume.txt`
- every root-level `*-experience.md`

Read when present and relevant:

- `*-questions.md`
- `*-notes.md`
- `*-architecture.md`
- an explicitly named pack folder in `design-packs/`
- a pack whose `manifest.json` has an exact `questionHash` match

If the question is ambiguous across multiple companies or roles, ask one short
clarifying question. If the user names a company or domain, prioritize the matching
experience file.

## Archetype Selection

- Use `system-design` for architecture, API design, LLD, scaling, protocol, and platform questions.
- Use `security-review` for vulnerability-class, CI/CD security, CodeQL, or threat-model-to-control questions.
- If the question does not fit a supported archetype cleanly, default to `system-design`
  and say so explicitly.

## Grounding Standard

- Treat a bullet or sentence from `resume.txt` or a `*-experience.md` file as an anchor.
- Use at least two concrete anchors when making detailed claims about architecture,
  scale, security posture, or business impact.
- If fewer than two anchors exist, lower the confidence and label assumptions clearly.
- Never present inferred Microsoft internal details as facts.

## What Good Looks Like

The output should feel like a principal engineer answer, not a generic tutorial:

- tie the design back to concrete resume evidence
- call out assumptions explicitly
- separate control plane and data plane when relevant
- include API contracts and likely low-level design follow-ups when relevant
- use the manifest and archetype contract so outputs are deterministic and reusable
- discuss scale, cost, reliability, security, observability, and tradeoffs
- include interviewer pushback and crisp rebuttals
- avoid pretending to know confidential internal Microsoft implementation details

## Agentic System Detection

Before choosing lanes, determine whether the question describes or requires an **agentic system** — one where autonomous agents execute multi-step tasks, call tools, maintain memory, and hand off to other agents.

A question is agentic when it contains at least two of the following signals:

- mentions "agent", "multi-agent", "LangGraph", "LangChain", "AutoGen", "CrewAI", "WASM sandbox", "tool-calling", or "ReAct loop"
- describes a system where a model must plan, execute, and iterate before returning a result
- involves autonomous code execution, browser use, or tool orchestration on behalf of a user
- involves supervisor/worker agent topologies, agent handoff, or agent memory

When the question is agentic, set `isAgentic: true` in `manifest.json`, activate the two agentic-specific lanes (lanes 11 and 12 below), and run the **Agentic Design Estimates Checklist** inside the design-estimates lane before writing `02-design-estimates.md`.

## Agentic Design Estimates Checklist

When `isAgentic: true`, the design-estimates lane MUST reason through all 20 points below **before** writing `02-design-estimates.md`. Each point requires a concrete answer or an explicit assumption — "TBD" is not acceptable. The answers drive the architecture, capacity model, and graph structure that follow.

1. **State persistence** — what agent state survives a crash or coordinator restart, and what is recomputed?
2. **Idempotency of tool calls** — when a node re-executes after a retry, which tool calls are safe to repeat and which must be deduplicated via idempotency keys?
3. **Cycle detection and loop prevention** — how does the graph detect and break infinite ReAct loops or back-edges that never converge?
4. **Parallel subgraph execution and join semantics** — when two subgraphs run concurrently, what does the join node do if one subgraph fails, times out, or returns a partial result?
5. **Conditional edge logic** — how is branching evaluated (model output, rule-based, score threshold), and who is responsible for the routing decision?
6. **Human-in-the-loop interrupt and resume** — at which nodes can a human pause, inspect, or redirect execution, and how does the graph checkpoint before the interrupt?
7. **Short-term, long-term, and episodic memory separation** — what lives in the run context, what is persisted to a vector store, and what is summarized into episodic snapshots?
8. **Tool routing** — which agent node is authorized to call which tools, and how is that enforced at the graph level (not just in the prompt)?
9. **Tool failure handling per node** — what is the retry policy when a tool returns an error, and when does the graph route to a fallback node vs halt the run?
10. **Agent-to-agent communication protocol** — do agents share a mutable state object, pass messages on a queue, or write/read from a shared scratchpad, and what are the consistency guarantees?
11. **Concurrent run isolation at 1M users** — how are agent runs isolated at the tenant boundary (separate threads, processes, WASM sandboxes, or ephemeral pods), and what prevents prompt or data bleed?
12. **Latency budget per graph hop** — what is the p99 latency target for a single node execution, and what is the total latency budget for a full multi-hop run?
13. **Checkpoint and resume from mid-graph** — can a run resume from an arbitrary intermediate node after a failure, or only from the start?
14. **Versioning of graph definitions during live traffic** — when the agent graph schema changes (new node, deleted edge), how are in-flight runs that were started under the old schema handled?
15. **Multi-tenant isolation** — what prevents one tenant's agent run from reading another tenant's tool outputs, memory, or intermediate state?
16. **Prompt injection through tool outputs** — if an external tool (web search, code executor, API call) returns adversarial content, what sanitization layer prevents it from hijacking the agent's next action?
17. **Token budget enforcement per run** — how is per-run token spend tracked and capped, and what does the graph do when a run approaches the limit mid-execution?
18. **Partial execution failure and rollback semantics** — if a node at step N of an M-step plan fails with side effects already applied (e.g., a file written, an email sent), what is the compensation logic?
19. **Observability: tracing a stuck or looping graph** — what does the on-call engineer look at when a run appears to be hung, and how is a specific graph hop identified as the bottleneck?
20. **Scale model** — what is the expected peak concurrent graph runs, average fan-out per planner node, and where is the coordinator bottleneck under that load?

After answering all 20 points, use the answers to populate the capacity estimates, functional requirements, and non-functional requirements subsections of `02-design-estimates.md`. Mark any point answered by assumption rather than resume evidence.

## Memory Layer Checklist

When `isAgentic: true`, Lane 13 must answer all 15 points below before writing
`13-memory-layer-design.md`. Each point must be a concrete subsection in the file —
not a paragraph mention inside a larger section. "Not applicable" requires a one-sentence
justification; silence is not acceptable.

1. **Memory taxonomy** — enumerate each memory type in the system (working/short-term,
   long-term semantic, episodic, procedural/skill), state its purpose, and identify which
   agent nodes read and write each type.
2. **Storage backend per type** — for each memory type, name the backing store (Redis,
   Postgres, Pinecone, Weaviate, pgvector, in-process dict, etc.) and justify the choice
   against at least one alternative.
3. **Write triggers** — specify exactly when memory is written: after every agent turn,
   after task completion, on explicit save instruction, when an importance score exceeds a
   threshold, or on a scheduled flush. State who decides (the model, a rule, or the user).
4. **Retrieval strategy** — describe how relevant memories are surfaced: semantic vector
   search, recency ranking, importance scoring, BM25 keyword, or a hybrid. State the
   similarity threshold or top-K cutoff and what happens when no memory clears the bar.
5. **Context window budget allocation** — how many tokens are reserved for retrieved
   memories in the prompt, how the budget is split across memory types, and what the
   eviction order is when retrieved memories exceed the budget.
6. **Embedding model selection and consistency** — which model produces embeddings, what
   the vector dimension is, and what happens to stored embeddings when the model is
   upgraded (re-indexing strategy or version tagging).
7. **Memory eviction and TTL** — what expires (and when), what is retained indefinitely,
   and who sets the policy (system default, per-tenant config, or per-user preference).
8. **Memory consolidation** — describe how short-term memories are promoted to long-term:
   summarization cadence, importance-scoring function, and the merge or de-duplication
   strategy when new memories conflict with stored ones.
9. **Cross-tenant memory isolation** — explain the isolation boundary that prevents one
   tenant's agent from retrieving another tenant's stored memories. Name the enforcement
   mechanism (namespace prefix, row-level security, separate index, or separate store).
10. **Memory poisoning and injection via retrieval** — if adversarial or malformed content
    was stored in memory (e.g., from a previous tool output), what sanitization layer
    prevents it from hijacking the next agent turn when retrieved.
11. **Memory staleness detection** — how outdated memories are identified (timestamp-based,
    contradiction detection, confidence decay) and what action is taken: suppress, flag,
    update, or delete.
12. **Retrieval latency budget** — state the p99 retrieval target (e.g., <50 ms) and show
    how it fits within the per-hop latency budget from the agentic design. Name the index
    type (HNSW, IVF-Flat, etc.) and the approximate-vs-exact tradeoff made.
13. **Memory at scale** — estimate storage growth rate per active user per day, total
    index size at 1M users, and retrieval latency degradation under that load. Show the
    arithmetic.
14. **Memory observability and debugging** — describe what an on-call engineer looks at
    when a run retrieved the wrong memory or missed a relevant one: which logs, metrics,
    or trace spans are present, and what the remediation path is.
15. **Memory schema versioning** — what happens when the embedding dimension changes, a
    memory type is added or removed, or the schema of a stored memory object changes for
    in-flight or archived memories.

Lane 13 runs concurrently with lanes 11 and 12. It does not depend on their output and
must not block waiting for them. The file it produces (`13-memory-layer-design.md`) is
standalone — it should not require the reader to cross-reference `12-agentic-graph-structure.md`.

## Ingestion Pipeline Checklist

When `isAgentic: true` AND `hasKnowledgeBase: true`, Lane 14 must answer all 15 points
below before writing `14-ingestion-pipeline.md`. Each point must be a concrete subsection.
"Not applicable" requires a one-sentence justification.

RAG-as-tool-call (agent explicitly invokes a `search()` tool) lives in
`04-api-and-contracts.md` and `05-low-level-design.md` — not here. This file covers
the **write path**: how external content flows into the stores the agent reads from.

1. **Ingestion triggers** — what initiates ingestion: user upload event, webhook from
   an external system, scheduled crawler, API push, or real-time event stream. State
   whether ingestion is synchronous (caller waits for indexing) or asynchronous
   (caller gets an async job ID).
2. **Chunking strategy** — fixed-size, sentence-boundary, semantic, hierarchical, or
   document-structure-aware chunking. State chunk size (tokens), overlap (tokens), and
   the rationale for the choice relative to the retrieval use case.
3. **Embedding pipeline** — which model embeds chunks, batching strategy (batch size,
   throughput target), and whether embedding is CPU or GPU. **This model must match
   the embedding model named in `13-memory-layer-design.md` point 6.** If they differ,
   flag it explicitly and explain how the inconsistency is resolved.
4. **Index write path** — how embedded chunks reach the vector store: synchronous
   direct write, async queue-backed (Kafka, SQS), or streaming. State what happens
   on write failure: retry policy, dead-letter destination, and whether the document
   is partially or fully visible during a write.
5. **Deduplication** — how duplicate or near-duplicate content is detected: content
   hash (exact), MinHash (near-duplicate), or semantic similarity threshold. State
   the action taken on a detected duplicate: skip, merge, or replace.
6. **Document versioning** — when a document is updated, how its previous chunks are
   invalidated and replaced in the index. State whether old chunks are tombstoned
   (soft delete) or physically removed, and the staleness window between update and
   old chunks expiring from query results.
7. **Re-indexing on embedding model upgrade** — when the embedding model changes
   (new model, dimension change), describe the re-indexing strategy: full re-index
   offline, lazy re-index on next retrieval miss, or dual-index with version tagging.
   State how query correctness is maintained during the transition window.
8. **Freshness and TTL** — how indexed content that should expire is identified and
   evicted. State whether TTL is set at ingestion time (per-document metadata) or
   centrally (policy-driven), and what triggers a re-crawl or re-ingest.
9. **Ingestion throughput and latency** — peak documents/sec the pipeline must handle,
   p99 latency from document arrival to queryable in the index, and queue depth under
   peak load. Show the arithmetic anchored on the capacity model in `02-design-estimates.md`.
10. **Multi-tenant isolation in the index** — how one tenant's ingested content is
    isolated from another's: namespace prefix, separate index per tenant, row-level
    filter enforced at query time, or hybrid. State the enforcement point and the
    failure mode if isolation is bypassed.
11. **Content filtering and safety** — what pre-processing happens before content is
    indexed: PII detection and redaction, malicious content or prompt-injection
    screening, format validation, and size limits. State what happens to content
    that fails a filter (reject, quarantine, or partial ingest).
12. **Ingestion observability** — which metrics and logs exist for: ingestion lag
    (time from trigger to queryable), failure rate per document type, dead-letter
    queue depth, and index size growth. State the alert threshold for each.
13. **Scale model** — estimated document count at 1M users, total vector index size
    (GB), monthly storage cost, monthly embedding compute cost, and growth rate.
    Show the arithmetic. Flag any tier where cost grows super-linearly with users.
14. **Error handling and dead-letter** — full error taxonomy: embedding failure,
    index write failure, chunking error, filter rejection. Per error type: retry
    count, backoff, dead-letter destination, and whether the user is notified.
15. **Access control on ingested content** — who can query which content. State
    whether ACLs are enforced at ingestion time (content tagged with tenant/user
    scope at index time) or at query time (filter injected into every retrieval
    call). Explain the failure mode if the ACL enforcement point is bypassed.

Lane 14 runs concurrently with lanes 11–13. The embedding model consistency check
(point 3 vs `13-memory-layer-design.md` point 6) is the only cross-lane dependency —
note the inconsistency in the file if it exists; do not block lane completion waiting
for lane 13 to finish. The file it produces (`14-ingestion-pipeline.md`) is standalone.

## Guardrails Checklist

When `isAgentic: true`, Lane 15 must answer all 15 points below before writing
`15-guardrails.md`. Each point must be a concrete subsection — not a mention inside
a larger paragraph. "Not applicable" requires a one-sentence justification.

Do NOT duplicate content from `07-security-and-isolation.md` (which covers
infrastructure security: network, identity, secrets). This file covers **behavioral
and content safety** — the enforcement layer that governs what the agent is allowed
to do and say at runtime.

1. **Input guardrail pipeline** — what checks run on user input before it reaches
   the first agent node: jailbreak/prompt-injection detection, toxicity and harmful
   content filtering, PII detection and redaction, input length/size limits. State
   which checks are synchronous (block until verdict) vs asynchronous (tag and
   continue), and what the action is on each check type (reject, sanitize, flag).

2. **Output guardrail pipeline** — what checks run on agent output before it reaches
   the user: policy compliance check, hallucination/factuality gate (if applicable),
   confidentiality leakage detection (system prompt, internal state, cross-tenant data
   bleeding into the response). State latency cost per check and whether checks run
   in parallel or sequentially.

3. **Tool call validation** — before any tool call executes, what validates the
   proposed call: capability RBAC per agent node (which nodes are authorized to call
   which tools), parameter schema and bounds validation, rate limiting per tool per
   run, and detection of anomalous or recursive tool invocations. State the enforcement
   mechanism and the action on validation failure (retry with sanitized params, reroute
   to fallback node, or halt run).

4. **Escalation policy** — the conditions under which the system halts, refuses, or
   routes to human-in-the-loop rather than completing the run: confidence below
   threshold, policy violation detected, repeated tool failure, budget exhausted,
   or user-requested pause. For each condition, state the trigger logic and what the
   user sees (error message, partial result, or hold state).

5. **Cross-agent instruction boundaries** — what one agent node is allowed to instruct
   another agent node to do: scope of valid instructions, instruction schema validation,
   and privilege escalation detection (a low-privilege node attempting to invoke a
   high-privilege node's capabilities). State how instruction integrity is verified and
   what happens when an out-of-scope instruction is detected.

6. **Behavioral policy enforcement** — how the agent is constrained to its defined
   purpose mid-run: intent classification on each major plan step, scope creep
   detection (agent attempting actions outside the user's original request), and the
   policy definition format (rules engine, classifier, constitutional AI, or system
   prompt constraints). State what triggers a behavioral violation verdict and what
   the graph does in response.

7. **Prompt injection defense — input surface** — defense against user-crafted inputs
   designed to override system instructions or hijack agent behavior: detection
   approach (regex heuristics, fine-tuned classifier, or LLM-based judge), confidence
   threshold, and the action on detection (sanitize and continue, reject with
   explanation, or flag for human review).

8. **Prompt injection defense — tool output surface** — defense against adversarial
   content returned by external tools (web search results, API responses, code
   execution output) that attempts to redirect subsequent agent behavior: sanitization
   layer between tool output and the next agent prompt, detection approach, and
   quarantine strategy for flagged outputs.

9. **Confidentiality protection** — preventing the agent from leaking system prompts,
   internal chain-of-thought, intermediate plan steps, or other tenants' data in its
   responses: output scanning for system prompt signature patterns, inter-tenant state
   isolation at the response layer, and the logging policy (what is retained, what is
   redacted from logs).

10. **Guardrail latency budget** — p99 latency cost of the full guardrail stack (input
    checks + output checks + tool validation combined), and how it fits within the total
    run latency budget from `12-agentic-graph-structure.md`. State the optimization
    approach when guardrails add too much latency (async checks, distilled classifier,
    result caching for repeated inputs).

11. **Guardrail bypass and override policy** — under what conditions, if any, a
    guardrail check can be bypassed: trusted-caller override (specific admin token),
    emergency degraded-mode path, or a hard rule that no bypass is possible. State the
    required audit trail for any override event and how bypasses are monitored.

12. **Multi-tenant guardrail isolation** — how guardrail policy configurations are
    scoped per tenant (one tenant's custom policy must not affect another's), and how
    per-tenant policy is loaded, cached, and applied at runtime without cross-tenant
    bleed.

13. **Guardrail observability** — which metrics and logs track: trigger rate per check
    type, false positive rate (legitimate requests blocked), p99 latency added per
    check, bypass events, and escalation rate. State the alert threshold for an
    anomalous trigger spike (which may indicate an attack or a broken classifier).

14. **Guardrail failure mode** — what the system does when a guardrail check itself
    fails (service unavailable, timeout, or classifier error): fail-open (pass the
    request through unguarded), fail-closed (block the request), or degrade (apply a
    stricter static default policy). State the chosen mode, the rationale, and
    whether the failure mode is configurable per tenant.

15. **Guardrail model and rule versioning** — when the guardrail classifier, safety
    model, or policy rules are updated, how the rollout is managed: canary deployment,
    shadow mode (new version runs alongside old, results compared but old verdict wins),
    or A/B test. State how regressions (increased false positives or missed violations)
    are detected before full rollout.

Lane 15 runs concurrently with lanes 11–14. It has no cross-lane dependencies and
must not block waiting for any other lane. The file it produces (`15-guardrails.md`)
is standalone — readable without cross-referencing other agentic deep-dive files.

## In-Loop Critic Checkpoint

When `isAgentic: true`, the pack MUST pass an in-loop critic review **after** the
parallel batch completes and **before** Lane 12 (per-node state) or Lane 10
(challenges) run. This exists because the agent structure, memory layer, guardrail
boundaries, ingestion pipeline, and end-to-end architecture are the load-bearing
decisions in an agentic system. Catching a structural flaw in any of these
after Layer 2 and challenges are written is wasteful — Layer 2 commits to the
topology, challenges consume the full pack.

This checkpoint is distinct from the standalone `/critical-agent` skill:

- `/critical-agent` is a **post-hoc production-readiness gate** (three phases:
  rubric critic, principal engineer validation, approval artifact). It runs
  against a frozen pack and produces `20-critical-agent-approval.md`.
- The in-loop checkpoint here is **design-time critique**: it returns structured
  per-file objections, the flagged lanes revise, and we re-critique. No approval
  artifact is written. It is bounded and cheap.

### Scope of files reviewed

The critic reviews exactly these files (others are out of scope for this
checkpoint):

| File | Lane that produced it | Focus of critique |
|---|---|---|
| `03-architecture.md` | Lane 2 | End-to-end component map, control/data plane split, LB topology, where the agent runtime fits in the broader system |
| `12-agentic-graph-structure.md` (Layer 1 only) | Lane 11 | Node taxonomy, edge taxonomy, supervisor/worker/tool-caller hierarchy, Mermaid topology |
| `13-memory-layer-design.md` | Lane 13 | 15-point memory rubric coverage, embedding model consistency, isolation, scale model |
| `14-ingestion-pipeline.md` *(if `hasKnowledgeBase: true`)* | Lane 14 | 15-point ingestion rubric, write-path safety, embedding-model match with memory layer |
| `15-guardrails.md` | Lane 15 | 15-point guardrail rubric, behavioral safety, escalation policy, fail-mode |

### Critic rubric (focused, not the full /critical-agent rubric)

The critic does NOT re-run the full `/critical-agent` three-phase gate. It
applies a focused structural rubric drawn from the existing checklists in this
SKILL.md:

- **Architecture (03):** does the runtime topology in `03` reconcile with the
  agent graph in `12`? Is the LB chain consistent with the latency budget in
  `02-design-estimates.md`? Are control plane and data plane clearly separated?
- **Graph topology (12 Layer 1):** does every node have a clear role? Are
  cycles bounded? Are joins explicit (not implicit)? Is the supervisor /
  worker / tool-caller hierarchy enforceable at the graph layer, not just in
  prompts? (Cross-check: the 20-point Agentic Design Estimates Checklist.)
- **Memory (13):** all 15 points present as discrete subsections? Embedding
  model named and consistent with `14`? Cross-tenant isolation enforced at a
  named layer, not assumed?
- **Ingestion (14, if applicable):** all 15 points present? Embedding model
  matches `13` point 6 exactly? Multi-tenant isolation in the index enforced
  at a named point? Dead-letter behavior specified per error class?
- **Guardrails (15):** all 15 points present? Input, output, and tool-call
  validation each addressed independently? Fail-mode (fail-open vs fail-closed)
  named per check? No infrastructure-security duplication with `07`?
- **Cross-file consistency:** embedding model named identically in `13` and
  `14`. Node names in `12` match service names in `03`. Latency budget in
  `13` point 12 fits within per-hop budget from `12`. Guardrail latency in
  `15` point 10 fits within the same budget.

### Verdict format

The critic returns a structured per-file verdict:

```
FILE: <relative path>
VERDICT: OK | NITS | BLOCKING
BLOCKING OBJECTIONS:
  - <objection 1, with the specific point of the rubric or cross-file check it violates, and a one-sentence revision instruction>
  - <objection 2 ...>
NITS:
  - <minor issue that does not require revision but should be noted>
```

`OK` means no revision needed. `NITS` means proceed but record the nit in the
file's preamble. `BLOCKING` means the flagged lane must revise.

### Revise protocol

For each file with `BLOCKING` verdict:

1. Re-spawn the lane that produced the file (Lane 2, 11, 13, 14, or 15).
2. Pass the lane: the original input files, the existing draft of the flagged
   file, and the critic's BLOCKING OBJECTIONS list with the explicit
   instruction "revise the file to address each objection; preserve all other
   sections unchanged."
3. After revision, re-spawn the critic agent on the revised file(s) only.
4. Cap at **2 revision cycles per file**. If a file still has BLOCKING
   verdict after 2 cycles, record the surviving objections in
   `00-question-and-context.md` under a new section "## Surviving Critic
   Objections" and proceed. Surface them in the final user-facing summary.

The 2-cycle cap exists because (a) a third cycle rarely converges if the
first two failed, and (b) cost grows linearly per cycle. Surviving objections
are a signal to the human reader, not a hard stop.

### When to skip this checkpoint

- Non-agentic packs (`isAgentic: false`) — the checkpoint is agentic-only.
- The `Agent` tool is unavailable — note the fallback in the summary; the
  user can run `/critical-agent` manually post-pack.

## Default Workflow

1. Read `resume.txt` and the relevant `*-experience.md` files in the main context.
   Extract the strongest resume anchors for the question. Do NOT read all pack
   files into the main context — delegate reading to sub-agents.
2. Classify the request and choose a supported archetype.
3. Detect whether the question is agentic (see **Agentic System Detection**). If
   yes, set `isAgentic: true` in the manifest plan and activate lanes 11–13 and 15.
   If the system also has a knowledge base, set `hasKnowledgeBase: true` and
   activate lane 14. For agentic packs, challenge lane (10) produces
   `16-challenges-by-stage.md` instead of `15-`.
4. Compute the normalized `questionHash`.
5. Reuse a pack only if the folder was explicitly named or an exact manifest hash
   match exists.
6. Create the pack folder and write `manifest.json` in the main context before
   spawning agents. This anchors the pack; sub-agents will write into it.
7. Spawn parallel sub-agents — one `Agent` tool call per lane (see below). Each
   agent receives only the files it needs, not the full pack. Send independent
   lanes in a single message as parallel `Agent` calls. Note: for agentic packs,
   Lane 12 (per-node state) is NOT in the parallel batch — it runs sequentially
   after the in-loop critic checkpoint confirms the Layer 1 topology.
8. Wait for all parallel agents to complete. Collect their output file paths.
9. **In-loop critic checkpoint** *(agentic packs only)*. Spawn the in-loop critic
   agent against `03-architecture.md`, `12-agentic-graph-structure.md`
   (Layer 1 only), `13-memory-layer-design.md`, `15-guardrails.md`, and
   `14-ingestion-pipeline.md` (if `hasKnowledgeBase: true`). For each file with
   BLOCKING verdict, respawn the lane that produced it with the critic's
   objections as revision input and re-critique. Cap at 2 revision cycles per
   file. Surviving objections go into `00-question-and-context.md` under
   `## Surviving Critic Objections`. See the **In-Loop Critic Checkpoint**
   section above for the full protocol.
10. Run Lane 12 (per-node state) sequentially. Layer 2 depends on a *confirmed*
    Layer 1 topology, so it must run *after* the critic checkpoint, never
    before. *(Agentic packs only.)*
11. Run the challenge lane (10) as a final sequential `Agent` call. It consumes
    the full pack output and must always run last.
12. Write a short summary with the created folder path. If the critic surfaced
    surviving objections, list them in the summary so the user sees them
    without having to open `00-question-and-context.md`.

## Sub-Agent Execution Rules

**Each lane is a separate `Agent` tool call.** Never collapse two lanes into one
agent. Never pass all 15 checklists to a single agent. Context discipline is the
point of the lane structure — violating it defeats the purpose.

For each lane, pass the agent:
- The question and a one-paragraph brief of what it must produce.
- Only the input files it actually needs to read (listed per lane below).
- The output file path it must write.
- The relevant checklist or procedure from this skill file (copied inline, not
  as a file reference — the agent does not have this SKILL.md in context).

Do not pass a sub-agent the full SKILL.md, the full resume, or files it does not
need. Each agent should be able to complete its task in a focused context.

If the `Agent` tool is unavailable, fall back to sequential execution in the main
context and note the fallback explicitly in the summary.

## Parallel Agent Lanes

Each lane entry lists: what it produces, what input files it reads, and whether
it runs in parallel or sequential.

### Parallel batch (send as one message with multiple Agent calls)

| Lane | Produces | Reads | Notes |
|---|---|---|---|
| 1. Design-estimates | `02-design-estimates.md` | `resume.txt`, relevant `*-experience.md`, the question | For agentic packs, must first work through the 20-point Agentic Design Estimates Checklist before writing |
| 2. Architecture | `03-architecture.md` | `resume.txt`, relevant `*-experience.md`, the question | End-to-end request flow, component map, control flow |
| 3. API and LLD | `04-api-and-contracts.md`, `05-low-level-design.md` | `resume.txt`, relevant `*-experience.md`, the question | Public APIs, internal contracts, state machines, schemas |
| 4. Scale | `06-scaling-and-capacity.md` | `resume.txt`, relevant `*-experience.md`, the question | Capacity model, quotas, bottlenecks, backpressure, cost |
| 5. Security | `07-security-and-isolation.md` | `resume.txt`, relevant `*-experience.md`, the question | Threat model, identity, network, secrets |
| 6. Reliability | `08-reliability-observability-and-failures.md` | `resume.txt`, relevant `*-experience.md`, the question | Retries, failure modes, observability |
| 7. Cross-exam | `10-cross-questions.md` | `resume.txt`, relevant `*-experience.md`, the question | Skeptical questions and rebuttals |
| 8. Leadership | section of `03-architecture.md` or `09-tradeoffs-and-alternatives.md` | `resume.txt`, relevant `*-experience.md`, the question | Roadmap, tradeoffs, business framing |
| 9. LB and fleet-sizing | LB section inside `03-architecture.md` | `resume.txt`, relevant `*-experience.md`, the question, LB config rules from this skill | Per-tier instance sizing on m8g, LB topology, AZ spread, health checks |
| 11. Agentic graph topology *(isAgentic only)* | `12-agentic-graph-structure.md` Layer 1 | `resume.txt`, relevant `*-experience.md`, the question | Node taxonomy, edge taxonomy, Mermaid graph, supervisor/worker hierarchy |
| 13. Memory layer *(isAgentic only)* | `13-memory-layer-design.md` | `resume.txt`, relevant `*-experience.md`, the question, Memory Layer Checklist (copy inline) | All 15 memory points as discrete subsections |
| 14. Ingestion pipeline *(isAgentic + hasKnowledgeBase only)* | `14-ingestion-pipeline.md` | `resume.txt`, relevant `*-experience.md`, the question, Ingestion Checklist (copy inline) | All 15 ingestion points; note embedding model must match memory layer |
| 15. Guardrails *(isAgentic only)* | `15-guardrails.md` | `resume.txt`, relevant `*-experience.md`, the question, Guardrails Checklist (copy inline) | All 15 guardrail points; behavioral safety only — not infra security |

### Sequential: after parallel batch completes

Order matters. Run in this exact order — Lane 16 (critic) must run before Lane 12
(per-node state) because Layer 2 commits to the topology that the critic is
reviewing. Lane 10 (challenges) consumes the full pack and always runs last.

| Order | Lane | Produces | Reads | Notes |
|---|---|---|---|---|
| 1 | 16. In-loop critic checkpoint *(isAgentic only)* | Per-file verdicts and revision rounds; on surviving objections, appends a `## Surviving Critic Objections` section to `00-question-and-context.md` | `03-architecture.md`, `12-agentic-graph-structure.md` (Layer 1 only), `13-memory-layer-design.md`, `15-guardrails.md`, and `14-ingestion-pipeline.md` (if `hasKnowledgeBase: true`) | See **In-Loop Critic Checkpoint** section. Spawns revision sub-agents for any lane with BLOCKING verdict. Cap at 2 revision cycles per file. |
| 2 | 12. Agentic per-node state *(isAgentic only)* | Merges into `12-agentic-graph-structure.md` | Lane 11's output (`12-agentic-graph-structure.md`), as revised by the critic checkpoint | Layer 2 content: per-node state shape, edge conditions, join semantics, HITL contracts. Must run *after* Lane 16 — Layer 2 commits to the Layer 1 topology, so the topology must be critic-confirmed first. |
| 3 | 10. Challenge | `15-challenges-by-stage.md` (non-agentic) or `16-challenges-by-stage.md` (agentic) | All files written by parallel lanes plus Lane 12 (for agentic) | Consumes full pack output. Chain-of-Thought procedure below. Always runs last. |

If the `Agent` tool is unavailable, execute lanes sequentially in the main context and note the fallback. Quality will be lower but the structure remains the same.

## Required Output Files

New packs must use `schemaVersion: 2`. For `system-design` at v2, create at least these files:

- `README.md`: one-screen overview and file map.
- `manifest.json`: pack metadata, archetype, question, hash, and grounding confidence. Set `schemaVersion` to `2`.
- `00-question-and-context.md`: original question, scope, assumptions, and resume anchors used.
- `01-executive-summary.md`: the short, strong version of the answer.
- `02-design-estimates.md`: upfront framing — use case and problem statement, user personas and access patterns, existing options and build-vs-buy, why we are building it, and back-of-envelope capacity and load estimates (QPS, storage, growth, latency / availability / durability targets). See the **Design Estimates** section below for required structure.
- `03-architecture.md`: end-to-end architecture and major components.
- `04-api-and-contracts.md`: external APIs, internal contracts, request flows, idempotency, and error model.
- `05-low-level-design.md`: service decomposition, classes or modules, state machines, schemas, and component interactions.
- `06-scaling-and-capacity.md`: throughput model, bottlenecks, quotas, and growth plan.
- `07-security-and-isolation.md`: threat model, identity, network boundaries, and secret handling.
- `08-reliability-observability-and-failures.md`: retries, failure modes, logs, metrics, traces, and recovery.
- `09-tradeoffs-and-alternatives.md`: rejected options and why.
- `10-cross-questions.md`: challenging follow-ups and best answers.
- `11-cheat-sheet.md`: concise talking points for interview delivery.
- `15-challenges-by-stage.md`: stage-scoped, rated engineering challenges. Generated using the **Chain-of-Thought Challenge Generation** procedure below. This file is a default for every system-design pack, not an optional add-on.

Optional root files include (use 16+ for agentic packs; 12–14 are reserved for agentic deep-dives):

- `16-control-plane-vs-data-plane.md`
- `17-state-machine-and-workflows.md`
- `18-data-model-and-storage.md`
- `19-leadership-and-business-framing.md`
- `21-risk-register.md`
- `22-debugging-playbooks.md`

**Agentic packs only** (`isAgentic: true` in manifest) must also include:

- `12-agentic-graph-structure.md`: two-layer deep-dive into the agent graph.
  - **Layer 1 — Graph Topology**: node type taxonomy (planner, executor, critic, router,
    tool-caller, human-in-loop, aggregator), edge type taxonomy (sequential,
    conditional, parallel-fork, parallel-join, back-edge with guard), the full
    Mermaid `graph TD` or `stateDiagram-v2` for this specific design, and the
    supervisor/worker/tool-caller hierarchy. Use Mermaid node IDs that match the
    service or component names from `03-architecture.md`.
  - **Layer 2 — Per-Node State and Edge Conditions**: for every node in the graph,
    specify the state shape that is checkpointed (keys, types, whether ephemeral or
    durable), the condition logic on each outgoing edge (model score, rule, regex,
    or schema validator), join semantics for parallel-fork outputs (all-of, any-of,
    majority-vote, or first-success), and the interrupt/resume contract for any
    human-in-the-loop node (what is frozen, what the human sees, how the run
    resumes with the human's decision injected).

- `13-memory-layer-design.md`: standalone deep-dive into the memory subsystem.
  Generated by Lane 13 using the **Memory Layer Checklist** below. Must cover
  all 15 memory layer points as discrete subsections — not as a paragraph summary.
  Treat it as a separate, self-contained design document: it should be readable
  without cross-referencing `12-agentic-graph-structure.md`.

- `14-ingestion-pipeline.md` *(required only when `hasKnowledgeBase: true`)*:
  standalone deep-dive into the document ingestion and indexing pipeline — the
  write path that feeds the stores the memory layer reads from. Generated by
  Lane 14 using the **Ingestion Pipeline Checklist** below. Must cover all 15
  ingestion points as discrete subsections. RAG-as-tool-call (agent invoking a
  `search()` tool explicitly) is NOT covered here — that lives in
  `04-api-and-contracts.md`. This file covers the data pipeline that makes
  content available for retrieval.

- `15-guardrails.md`: standalone deep-dive into the agentic guardrail stack —
  the enforcement layer that keeps agent behavior safe, scoped, and tenant-isolated
  across the full execution pipeline (input → planning → tool calls → output).
  Generated by Lane 15 using the **Guardrails Checklist** below. Must cover all
  15 guardrail points as discrete subsections. Readable without cross-referencing
  other files.

**Note on challenges file for agentic packs:** when `isAgentic: true`, the
challenge lane (10) produces `16-challenges-by-stage.md` — not `15-`. The `15`
slot is occupied by guardrails. For non-agentic packs, challenges remain at
`15-challenges-by-stage.md`.

Packs created before 2026-05-17 use `schemaVersion: 1`, which omits design-estimates and keeps architecture at `02`. Do not produce new v1 packs.

## Design Estimates

`02-design-estimates.md` is the interviewer's "frame the problem" expectation
and must come before architecture. Skipping it lands the architecture without
context. The file must include these subsections, in this order:

1. **Use case and problem statement.** One short paragraph naming the concrete
	 problem and the cost of not solving it. Tie the framing to a resume anchor
	 if the question came from the candidate's experience.
2. **Users and access patterns.** Enumerate user personas (developers, internal
	 services, end users, automated pipelines, security or compliance reviewers)
	 with the operations each one performs and rough cadence. Distinguish
	 first-party vs third-party callers when relevant.
3. **Existing options.** A short comparison table of open source projects,
	 commercial products, and adjacent internal systems that could plausibly
	 solve the problem, with the specific gap that disqualifies each.
4. **Why we are building it.** Two to four bullets naming the load-bearing
	 reasons a custom system beats the alternatives (compliance, isolation,
	 scale, cost, latency, integration, sovereignty). These must connect back
	 to the gaps in the previous section.
5. **Capacity and load estimates.** Back-of-envelope numbers — users, peak QPS,
	 average payload size, storage growth per month, bandwidth, fan-out — with
	 the arithmetic shown, not just the answers. Pick numbers consistent with
	 the resume scale claims; if those numbers are not on the resume, mark them
	 as assumptions.

	 **Instance sizing — always include a fleet estimate anchored on m8g.**
	 For every service tier in the capacity model, show: chosen instance size,
	 instance count, total vCPU, total RAM, total EBS/network throughput, and a
	 rough monthly cost anchor (On-Demand $/hr × fleet × 730 hr/month).

	 *m8g family reference (AWS Graviton 4 / Arm Neoverse V2 — general purpose,
	 ~4 GiB RAM per vCPU, EBS-optimized by default):*

	 | Size | vCPU | RAM | EBS bandwidth | Network | Local storage |
	 |---|---|---|---|---|---|
	 | m8g.xlarge | 4 | 16 GiB | up to 10 Gbps (burst) | up to 12.5 Gbps | EBS only |
	 | m8g.2xlarge | 8 | 32 GiB | up to 10 Gbps (burst) | up to 12.5 Gbps | EBS only |
	 | m8g.4xlarge | 16 | 64 GiB | up to 10 Gbps (burst) | up to 25 Gbps | EBS only |
	 | m8g.8xlarge | 32 | 128 GiB | 10 Gbps (sustained) | up to 25 Gbps | EBS only |
	 | m8g.16xlarge | 64 | 256 GiB | 20 Gbps (sustained) | 37.5 Gbps | EBS only |
	 | m8g.48xlarge | 192 | 768 GiB | 60 Gbps (sustained) | 100 Gbps | EBS only |
	 | m8g.metal-24xl | 96 | 384 GiB | 30 Gbps (sustained) | 50 Gbps | local NVMe SSD |
	 | m8g.metal-48xl | 192 | 768 GiB | 60 Gbps (sustained) | 100 Gbps | local NVMe SSD |

	 *Key configuration notes:*
	 - **EBS burst write**: sizes ≤ m8g.4xlarge have a burst EBS throughput bucket
	   (burst baseline is typically 3× the sustained floor for up to 30 min); state
	   the burst vs sustained figures separately when write spikes matter.
	 - **What m8g is optimized for**: balanced CPU/memory ratio; strong price-per-vCPU
	   on Graviton 4; well-suited for API servers, coordinators, metadata planes,
	   and stateless worker fleets. It is *not* storage-optimized — local NVMe is
	   only present on the metal-24xl and metal-48xl sizes.
	 - **EBS-attached NVMe (io2 Block Express)**: when low-latency durable writes are
	   needed on standard m8g sizes, attach an io2 volume; supports up to 256,000
	   provisioned IOPS and 4,000 MiB/s throughput, sub-millisecond latency, and
	   99.999% durability SLA.
	 - **Fleet count formula**: `ceil(peak_resource / per_instance_resource × headroom)`
	   where headroom = 1.3–1.5 for stateless tiers, 1.5–2.0 for stateful tiers.

	 *When to deviate from m8g:*
	 | Workload profile | Better family | Reason |
	 |---|---|---|
	 | Write-heavy NVMe (>1 GB/s sequential) | i4i | NVMe-backed, up to 7.5 GB/s sequential write, 1M+ IOPS |
	 | Memory-bound (>8 GiB/vCPU) | r8g | 8 GiB/vCPU ratio, Graviton 4 |
	 | CPU-bound, low memory (<2 GiB/vCPU) | c8g | Highest vCPU density, Graviton 4 |
	 | Dense warm storage (HDD) | d3en | Up to 336 TB local HDD per instance |
	 | ML inference | inf2 / trn2 | Inferentia2 / Trainium2 accelerators |
6. **Functional and non-functional requirements.** Bulleted list. Functional
	 covers the core operations the system must support; non-functional covers
	 latency targets (p50 / p99), availability (e.g., 99.9%), durability,
	 RTO / RPO, security and compliance posture, and explicit out-of-scope
	 items.

Keep this file short and dense — it is the framing, not the implementation.
Tables and bullets are preferred over prose.

For `security-review`, create the required root files defined in `design-packs/README.md`.

If the user asks for deeper challenge material, write it under `cross-exam/` using the
contract in `design-packs/README.md`.

## Load Balancer Configuration

Whenever the architecture includes a load-balancing tier — cloud, on-prem, or
hybrid — `03-architecture.md` must include a dedicated **Load Balancer
Configuration** subsection that covers all applicable types below and calls out
which combination the design uses and why. Do not leave LB configuration
implicit in a box diagram.

### NLB — AWS Network Load Balancer (Layer 4)

*Optimized for*: raw TCP/UDP throughput, ultra-low latency (<1 ms added),
static Elastic IPs, TLS passthrough, and PrivateLink endpoints.

Key configuration knobs to document:
- **Listener**: protocol (TCP / TLS / UDP / TCP_UDP), port, default action.
- **Target group**: target type (instance | IP | ALB), protocol, health-check
  protocol and threshold, deregistration delay (connection draining; default
  300 s — tune down to 30–60 s for short-lived jobs).
- **Cross-zone load balancing**: disabled by default on NLB (enable for
  uneven AZ capacity; incurs inter-AZ data charges).
- **TLS termination vs passthrough**: terminate at NLB for mutual TLS or
  certificate pinning; pass through when the backend owns the certificate.
- **Flow hash**: 5-tuple (protocol, src/dst IP, src/dst port) — sticky per
  connection. Mention when this matters (e.g., WebSocket, gRPC streams).
- **Preserve client IP**: enabled by default for instance targets; use proxy
  protocol v2 for IP targets behind a NAT.
- **Static IPs / Elastic IPs**: one static IP per AZ — required when
  downstream firewalls whitelist by IP.

### ALB — AWS Application Load Balancer (Layer 7)

*Optimized for*: HTTP/HTTPS/HTTP2/gRPC/WebSocket routing, content-based
routing rules, WAF integration, and OIDC/Cognito authentication offload.

Key configuration knobs to document:
- **Listener rules**: evaluated in priority order; conditions include host
  header, path pattern, HTTP header, query string, source IP, and HTTP method.
  State which rules the design relies on.
- **Target groups**: target type (instance | IP | Lambda), protocol
  (HTTP | HTTPS | gRPC), health-check path and matcher (e.g., `200-399`),
  and slow-start duration for warming up new targets.
- **Sticky sessions**: duration-based (ALB cookie, 1 s–7 days) or
  application-based (custom cookie); mention when stateful services need it
  and the tradeoff with even distribution.
- **Idle timeout**: default 60 s; increase for long-lived uploads or gRPC
  streams, decrease to shed idle connections faster.
- **gRPC routing**: requires HTTP/2 on the listener and target group;
  supports routing by gRPC service/method header.
- **WAF association**: attach an AWS WAF Web ACL to the ALB ARN; rules for
  rate limiting, IP reputation, and managed rule groups.
- **Access logs**: enable to S3 for forensics; include requester IP, latency,
  and matched rule in the log fields you care about.
- **Connection multiplexing**: ALB reuses backend connections; tune keep-alive
  timeout on the backend to be longer than the ALB idle timeout.

### MetalLB — Kubernetes Bare-Metal Load Balancer

*Optimized for*: exposing `LoadBalancer`-type Kubernetes Services on bare-metal
or on-prem clusters where no cloud LB controller is present.

Key configuration knobs to document:
- **IP address pool** (`IPAddressPool` CR): the CIDR or range MetalLB can
  assign to Services; must be routable from the client network. Separate pools
  per environment (prod vs staging) are best practice.
- **Mode — Layer 2 (ARP/NDP)**:
  - One node per Service acts as the "speaker leader" (elected via member-list).
  - Gratuitous ARP/NDP on failover; failover time ~10 s by default.
  - No ECMP — all traffic enters via the leader node, creating a single-node
    bottleneck. Document expected max throughput (limited to that node's NIC).
  - `L2Advertisement` CR selects which pools to advertise and which nodes
    are eligible speakers.
- **Mode — BGP**:
  - MetalLB peers with upstream BGP routers (`BGPPeer` CR); requires
    BGP-capable ToR switches or a router.
  - ECMP across all nodes — traffic is distributed per flow at the router.
  - `BGPAdvertisement` CR controls community strings, local-preference, and
    aggregation length.
  - FRR (Free Range Routing) is the recommended MetalLB backend for BGP;
    document the AS numbers, peer IPs, and hold-timer.
  - Document graceful-restart behavior to avoid route flaps during rolling
    deployments.
- **Speaker DaemonSet**: runs on every eligible node; node selector should
  exclude control-plane nodes unless explicitly required.

### Combination Patterns

For each design, state the combination in use and justify it:

| Pattern | When to use | Key wiring detail |
|---|---|---|
| **NLB → backend pods** | Pure TCP/gRPC, static IPs needed, PrivateLink | NLB target type = IP, targets are pod IPs; disable cross-zone unless AZ skew is large |
| **ALB → backend pods** | HTTP/HTTPS microservices, path routing, WAF | ALB target type = IP, security group allows ALB SG; use gRPC target group for proto services |
| **NLB → ALB → pods** | Static IPs at edge + L7 routing; required for WAF + PrivateLink | NLB target type = ALB (native NLB-ALB chaining); note dual-hop latency add (~0.5 ms) |
| **ALB → MetalLB → pods** | Hybrid: cloud ALB fronts on-prem cluster via DX/VPN | ALB targets = MetalLB VIP IPs; on-prem firewall must allow ALB health-check source CIDR |
| **NLB → MetalLB → pods** | PrivateLink / static IP entry into bare-metal cluster | NLB in cloud, MetalLB VIP is the NLB target; route via Direct Connect or VPN |
| **NLB → ALB → MetalLB → pods** | Full hybrid edge: cloud static IP → L7 routing → bare-metal | Document each hop's health-check chain; timeout budgets must decrease end-to-end |

For every combination used, state:
1. Which OSI layer each hop operates at.
2. Where TLS terminates (and whether mTLS is needed end-to-end).
3. How client IP is preserved (X-Forwarded-For, proxy protocol, or TPROXY).
4. Health-check chain — what each LB checks and at what interval.
5. Failure mode — what the client sees if one hop in the chain fails.

## Writing Rules

- Use markdown headings and short paragraphs.
- Prefer tables for tradeoffs, failure taxonomies, and component responsibilities.
- Include example API resources, request and response examples, and major error cases when applicable.
- Include LLD artifacts such as class or module responsibilities, sequence flows, state transitions, and schema notes when applicable.
- Add Mermaid diagrams when a topology or state flow needs it.
- Name uncertain details as assumptions.
- Keep the tone direct, technical, and interview-ready.

## Special Behavior For The Example Question

For prompts like:

"You say you scaled secure LLM training across VNet and Kubernetes. Walk me through the end-to-end architecture: user request, job submission, scheduling, data access, training, checkpointing, logs, and artifact publishing."

The pack should explicitly cover:

- user entry points and API contract
- control plane versus data plane
- job submission and validation
- job resource model, create or get or cancel semantics, idempotency keys, and status polling model
- scheduler, gang scheduling, and quota flow
- storage and checkpoint topology
- data access through private networking and identity
- runtime stack for distributed training
- low-level workflow components such as submitter, validator, scheduler adapter, launcher, checkpoint manager, log shipper, and artifact publisher
- logs, metrics, traces, and debugging flow
- model artifact publishing and rollout gates
- scaling limits, failure modes, and interviewer pushback

## Chain-of-Thought Challenge Generation

Every `system-design` pack must include `15-challenges-by-stage.md`. This file is
**not** an optional appendix: it is the deliverable that demonstrates the
candidate has thought about what actually goes wrong when you build the system,
not just the happy path. To generate it reliably, follow this Chain-of-Thought
procedure step by step. Do not skip steps. Do not collapse the reasoning into a
single pass.

### Step 0: scope

Before generating any challenges, restate two things in plain English (in your
own working notes, not in the file):

1. What the system actually does and who pays for it being broken.
2. The single resume anchor most load-bearing for the answer (one quote with a
   line number).

If you cannot do (1) and (2), stop and re-read the inputs.

### Step 1: enumerate stages

Use these five default stages. Override only when the question is clearly
outside the lifecycle (e.g., a one-off protocol design):

| Stage | Window | What is true in this stage |
|---|---|---|
| 1. Inception | weeks 0-12 | One team, no real customers, "make it work once" |
| 2. Early scale | months 3-9 | First 1-50 tenants, behaviors that only show up under concurrency emerge |
| 3. Production hardening | months 6-18 | Product works; reliability, observability, and edges dominate |
| 4. Multi-tenant scale | months 12-30 | Next 10x of tenants exposes multi-tenancy bugs and policy gaps |
| 5. Frontier / next-platform | months 18+ | Adjacent ambitions: new hardware, new model class, new region, new compliance regime |

Per stage, write a one-line "stage truth" header in the file that captures what
is materially different from the prior stage. Do this **before** listing
challenges, because it constrains what is and is not a challenge for that stage.

### Step 2: per-stage Chain-of-Thought brainstorming

For each stage, generate at least four candidate challenges using this four-step
inner CoT. Do this in your reasoning before writing anything to disk.

1. **Surface (what hurts).** What concrete symptom does the team see at this
   stage? Write it as a sentence ("the first multi-node run hangs in
   `init_process_group`", not "networking issues").
2. **Root layer (why it hurts).** Which architectural layer is responsible?
   Identity, network, scheduling, runtime, storage, observability, product
   surface, or organizational?
3. **Who pays (the blast radius).** Is the pain felt by one engineer, one
   tenant, all tenants, the security team, the finance team, or the customer
   trust narrative?
4. **Counterfactual (why it is not trivial).** Why does the easy fix not work?
   What is the design constraint that makes the challenge interesting?

After the inner CoT, drop the candidate challenge in the file if and only if
all four steps produced a non-generic answer. If step 4 collapses to "you just
do X", the challenge is too easy to include.

### Step 3: rate each challenge on three axes

Use this rubric. Do not invent new axes per pack.

| Axis | Scale | Anchor for 1 | Anchor for 10 |
|---|---|---|---|
| **Severity** | 1-10 | Paper cut; one engineer's afternoon | Product cannot ship; recurring SEV-1 |
| **Frequency** | 1-10 | Once in the program's life | Daily, every job |
| **Difficulty** | 1-10 | Read the manual | Open research; multi-quarter |

Compute `Pain = Severity × Frequency × Difficulty / 100`, cap at 100, round to
one decimal. Pain is the file's sortable column; the three component scores
must remain visible so a reader can challenge a number.

When tempted to give the same axis score to many challenges in a row, force
yourself to **pairwise compare** the two highest and the two lowest in that
stage and re-rank. Uniform 7-7-7 ratings mean you stopped thinking.

### Step 4: resume-anchor at least 30% of challenges

At least one in three challenges across the file must cite a specific
`resume.txt` or `*-experience.md` anchor inline (line number or quoted bullet).
Without anchors, the file becomes a generic "things that go wrong with
distributed systems" essay. Anchors keep it interview-defensible.

### Step 5: top-10 leaderboard and meta-observations

End the file with:

1. A top-10 table ranked by Pain, with stage and ID columns.
2. Two to four bullet "what this list tells you" observations that name a
   pattern the ranking exposes. Examples of good patterns:
   - Stage-1 mistakes have outsized Pain because they compound.
   - The hardest problems live at the boundaries (identity, fairness, fabric).
   - Frontier-scale challenges are increasingly organizational, not technical.

Do **not** write a generic "in conclusion" paragraph. The meta-observations
must point to specific rows in the leaderboard.

### Step 6: sanity checks before save

Before writing the file, run this checklist mentally:

- [ ] At least 4 challenges per stage, at least 20 total.
- [ ] Every challenge has Severity, Frequency, Difficulty, Pain.
- [ ] Top-10 leaderboard exists and is sorted descending by Pain.
- [ ] At least 30% of challenges cite a resume anchor.
- [ ] No two challenges in the same stage have identical (S, F, D) triples
      unless that is a deliberate, defensible call.
- [ ] No challenge is generic enough to apply to "any distributed system"
      without the resume context.

If any box is unchecked, redo the relevant step before writing.

### Worked exemplar

The pack at `design-packs/2026-05-17-distributed-finetuning-dataplane-internals/`
contains a reference challenges-by-stage file produced by this procedure (named
`14-challenges-by-stage.md` because that pack is `schemaVersion: 1`; under v2
the same content lives in `15-challenges-by-stage.md`).
When in doubt about format or rigor, mirror that file's structure (stage
heading, stage truth, numbered challenges with `C{stage}.{n}` IDs, rating
block, prose justification, top-10 leaderboard, meta-observations).

## Failure Modes To Avoid

- Do not answer with one big monolithic markdown file when the user asked for a folder of files.
- Do not reuse a pack just because it is the most recent similar topic.
- Do not write extended cross-exam artifacts into the numbered root file sequence.
- Do not skip API design or likely LLD follow-up if the question touches workflows, orchestration, or services.
- Do not skip scaling, security, or tradeoff analysis.
- Do not generate generic architecture that is not anchored in the resume.
- Do not claim specifics without adequate anchors.
- Do not omit cross-questions or rebuttals.
- Do not produce `15-challenges-by-stage.md` by enumerating challenges first and rating after; the Chain-of-Thought order in this file is load-bearing for quality.
- Do not let the three rating axes converge to the same number for many challenges in a row; that means the CoT was skipped.
