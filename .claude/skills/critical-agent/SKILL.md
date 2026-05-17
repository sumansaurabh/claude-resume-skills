---
name: critical-agent
description: |
  Three-phase gate that pressure-tests an agentic system design pack before
  approving it. Phase 1: a Critic agent evaluates both the agentic layer (20-point
  rubric + 1M-user scale gate) and the memory layer (15-point rubric) independently.
  Phase 2 (only if Phase 1 passes): a Principal Engineer agent independently
  validates the full design for production readiness. Only when both agents approve
  does the skill write the final approval artifact. Halts with explicit blocking
  objections on any failure.
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
  - critical agent
  - critique this agentic design
  - validate the agentic architecture
  - run the critic
  - approve this design
---

## Purpose

This skill enforces a three-phase quality gate on agentic system design packs.
It does not generate designs — it evaluates them. The output is either a blocking
failure report or a stamped approval artifact.

Run this skill after `analyze-my-resume` or `resume-design-pack` has produced an
agentic design pack. Do NOT run it before the pack exists.

## Pre-Flight Check

Before starting, confirm:

1. A `design-packs/` folder is explicitly named, OR the user described a topic
   that matches exactly one existing pack's `manifest.json` (via `questionHash`).
2. The target pack's `manifest.json` exists and contains `"isAgentic": true`.
3. `12-agentic-graph-structure.md` is present in the pack folder.
4. `13-memory-layer-design.md` is present in the pack folder.
5. `15-guardrails.md` is present in the pack folder.
6. If `manifest.json` contains `"hasKnowledgeBase": true`, then
   `14-ingestion-pipeline.md` must also be present in the pack folder.

If any check fails, print the relevant message and halt — do not proceed:

- Missing pack → "No design pack found. Run `/analyze-my-resume` first, then
  re-invoke `/critical-agent` with the pack folder path."
- Pack exists but `isAgentic` is missing or false → "This pack is not marked as
  an agentic system (`isAgentic: true` not set). This skill is only for agentic
  designs."
- `12-agentic-graph-structure.md` missing → "The pack is missing
  `12-agentic-graph-structure.md`. Re-run `/analyze-my-resume` to regenerate
  the agentic graph layer before critiquing."
- `13-memory-layer-design.md` missing → "The pack is missing
  `13-memory-layer-design.md`. Re-run `/analyze-my-resume` to generate the
  memory layer design before critiquing."
- `15-guardrails.md` missing → "The pack is missing `15-guardrails.md`.
  Re-run `/analyze-my-resume` to generate the guardrails design before critiquing."
- `14-ingestion-pipeline.md` missing (when `hasKnowledgeBase: true`) → "The
  pack declares `hasKnowledgeBase: true` but is missing `14-ingestion-pipeline.md`.
  Re-run `/analyze-my-resume` to generate the ingestion pipeline design before
  critiquing."

## Phase 1: Parallel Critic Sub-Agents

Phase 1 uses **four parallel `Agent` calls** — one per rubric section. Send
them in a single message. Each agent reads only the files relevant to its
rubric. None reads the full pack. After all four complete, a fifth sequential
synthesizer agent produces the unified Phase 1 report.

**Never collapse these into fewer agents.** Giving one agent 70+ evaluation
points and a full pack to read produces shallow verdicts. The isolation is the
quality mechanism.

### Sub-Agent A — Agentic Layer (20-point rubric + Scale Gate)

Reads: `manifest.json`, `02-design-estimates.md`, `03-architecture.md`,
`12-agentic-graph-structure.md`.

Mandate:
> You are a skeptical principal architect. Your job is to find gaps, not affirm
> the design. Evaluate the design against the 20 Agentic Design Points below.
> For each point: `PASS`, `PARTIAL`, or `FAIL`, followed by one sentence of
> evidence (file + section). Do not soften FAILs.
> After all 20 points, run the 1M-User Scale Gate. Return a structured verdict
> report — nothing else.

Pass the 20-point table and the 1M-User Scale Gate table inline in the prompt.
The agent must not read files outside the list above.

### The 20 Agentic Design Points (Critic's Rubric)

The Critic must evaluate each of these in order. Do not skip any.

| # | Point |
|---|---|
| 1 | State persistence — what survives a crash/coordinator restart |
| 2 | Idempotency of tool calls — retry safety per node |
| 3 | Cycle detection and loop prevention in the graph |
| 4 | Parallel subgraph execution and join semantics |
| 5 | Conditional edge logic — how branching is evaluated |
| 6 | Human-in-the-loop interrupt and resume points |
| 7 | Short-term, long-term, and episodic memory separation |
| 8 | Tool routing — which agent node can call which tools |
| 9 | Tool failure handling and retry policy per node |
| 10 | Agent-to-agent communication protocol and consistency guarantees |
| 11 | Concurrent run isolation at 1M users (tenant boundary) |
| 12 | Latency budget per graph hop and total run budget |
| 13 | Checkpoint and resume from mid-graph |
| 14 | Versioning of graph definitions during live traffic |
| 15 | Multi-tenant data isolation between agent runs |
| 16 | Prompt injection through tool outputs |
| 17 | Token budget enforcement per run |
| 18 | Partial execution failure and rollback semantics |
| 19 | Observability — tracing a stuck or looping graph |
| 20 | Scale model — peak concurrent runs, fan-out, coordinator bottleneck |

### 1M-User Scale Gate

After the 20-point evaluation, the Critic must additionally confirm the design
handles **1 million concurrent users** on at least **4 of the following 5 axes**.
Each axis requires a concrete, numbered answer from the pack — not a claim that
it "can scale":

| Axis | What a passing answer looks like |
|---|---|
| **Latency** | p99 latency target stated, and the architecture shows how it's met under 1M concurrent runs (fleet size, queue depth, backpressure) |
| **Isolation** | Per-tenant isolation mechanism named (WASM sandbox, ephemeral pod, separate thread + memory fence) with an explanation of why cross-tenant bleed is impossible |
| **Cost** | Per-run token cost estimated, total monthly cost at 1M DAU estimated, and a named cost control mechanism (budget cap, tier throttle, or token quota) |
| **Observability** | A named tracing mechanism (e.g., run-scoped trace IDs propagated through every graph hop) plus a stated SLO for mean-time-to-detect a stuck run |
| **Failure recovery** | Failure rate assumption stated, RTO / RPO defined, and a concrete path from node failure to run resume without re-doing completed steps |

If fewer than 4 axes pass, this is a **Scale Gate FAIL** regardless of the 20-point scores.

### Sub-Agent B — Memory Layer (15-point rubric)

Reads: `13-memory-layer-design.md` only.

Mandate:
> You are a skeptical principal architect specializing in stateful AI systems.
> Evaluate `13-memory-layer-design.md` against the 15 Memory Layer points below.
> For each point: `PASS`, `PARTIAL`, or `FAIL`, followed by one sentence of
> evidence (section name + what you found or didn't find). Do not soften FAILs.
> Return a structured verdict report — nothing else.

Pass the 15-point memory rubric table inline in the prompt.
The agent must not read files outside `13-memory-layer-design.md`.

This evaluation is **separate** from the 20-point agentic rubric. A design can
pass all 20 agentic points and still fail here. A single `FAIL` is a Phase 1 halt.

| # | Memory Layer Point |
|---|---|
| 1 | Memory taxonomy — each type named, purpose stated, nodes that read/write identified |
| 2 | Storage backend per type — named store with justification against one alternative |
| 3 | Write triggers — exact condition stated, decision-maker identified |
| 4 | Retrieval strategy — algorithm named, similarity threshold or top-K stated, no-match behavior defined |
| 5 | Context window budget allocation — token reservation stated, split across types, eviction order defined |
| 6 | Embedding model and consistency — model named, dimension stated, upgrade/re-indexing strategy present |
| 7 | Eviction and TTL — what expires, when, and policy owner stated |
| 8 | Memory consolidation — cadence, importance function, and conflict-merge strategy described |
| 9 | Cross-tenant memory isolation — isolation boundary named and enforcement mechanism explained |
| 10 | Memory poisoning defense — sanitization layer for adversarial stored content described |
| 11 | Staleness detection — detection method and remediation action stated |
| 12 | Retrieval latency budget — p99 target stated and fits within the per-hop agentic latency budget |
| 13 | Memory at scale — storage growth rate, index size at 1M users, latency degradation under load with arithmetic |
| 14 | Memory observability — specific logs, metrics, or traces named for wrong-retrieval debugging |
| 15 | Schema versioning — strategy for embedding dimension change or memory object schema migration stated |

### Sub-Agent C — Ingestion Pipeline *(only when `hasKnowledgeBase: true`)*

Reads: `14-ingestion-pipeline.md` and `13-memory-layer-design.md` (embedding
model consistency check only — point 6 of memory file, point 3 of ingestion file).

Mandate:
> You are a skeptical data-platform engineer. Evaluate `14-ingestion-pipeline.md`
> against the 15 Ingestion Pipeline points below. For each point: `PASS`,
> `PARTIAL`, or `FAIL`, followed by one sentence of evidence. Additionally, check
> that the embedding model in point 3 matches the model in `13-memory-layer-design.md`
> point 6. If they differ with no migration strategy, auto-FAIL point 3.
> Return a structured verdict report — nothing else.

Pass the 15-point ingestion rubric table inline. If `hasKnowledgeBase` is false,
skip this agent entirely. A single `FAIL` is a Phase 1 halt.

| # | Ingestion Pipeline Point |
|---|---|
| 1 | Ingestion triggers — event type named, sync vs async stated |
| 2 | Chunking strategy — algorithm, chunk size (tokens), overlap, and rationale stated |
| 3 | Embedding pipeline — model named, matches memory layer model, batching strategy described |
| 4 | Index write path — sync/async named, failure handling and partial-visibility behavior stated |
| 5 | Deduplication — detection method and action on duplicate stated |
| 6 | Document versioning — chunk invalidation strategy and staleness window stated |
| 7 | Re-indexing on embedding model upgrade — strategy and query-correctness during transition stated |
| 8 | Freshness and TTL — expiry detection method and re-ingest trigger stated |
| 9 | Ingestion throughput and latency — peak doc/sec, p99 index latency, and queue depth arithmetic present |
| 10 | Multi-tenant index isolation — isolation mechanism named and enforcement point stated |
| 11 | Content filtering and safety — PII/injection screening named, action on filter failure stated |
| 12 | Ingestion observability — lag, failure rate, dead-letter depth, and index growth metrics named |
| 13 | Scale model — document count, index size, storage cost, and embedding compute cost at 1M users with arithmetic |
| 14 | Error handling and dead-letter — error taxonomy present, per-type retry + dead-letter destination stated |
| 15 | Access control on ingested content — ACL enforcement point (ingest-time vs query-time) and bypass failure mode stated |

### Sub-Agent D — Guardrails (15-point rubric)

Reads: `15-guardrails.md` only.

Mandate:
> You are a skeptical AI safety engineer. Evaluate `15-guardrails.md` against the
> 15 Guardrails points below. For each point: `PASS`, `PARTIAL`, or `FAIL`,
> followed by one sentence of evidence (section name + what you found or didn't
> find). Do NOT credit content from the security file — this rubric covers
> behavioral and content safety only, not infrastructure security.
> Return a structured verdict report — nothing else.

Pass the 15-point guardrails rubric table inline. A single `FAIL` is a Phase 1 halt.

| # | Guardrails Point |
|---|---|
| 1 | Input guardrail pipeline — check types named, sync/async mode stated, action per check type stated |
| 2 | Output guardrail pipeline — checks named, latency cost stated, parallel/sequential execution stated |
| 3 | Tool call validation — capability RBAC per node named, parameter validation described, failure action stated |
| 4 | Escalation policy — trigger conditions enumerated, action per condition stated, user-facing behavior described |
| 5 | Cross-agent instruction boundaries — scope of valid instructions defined, privilege escalation detection described |
| 6 | Behavioral policy enforcement — policy format named, scope creep detection described, violation response stated |
| 7 | Prompt injection defense (input surface) — detection approach named, confidence threshold stated, action on detection stated |
| 8 | Prompt injection defense (tool output surface) — sanitization layer described, detection approach named, quarantine strategy stated |
| 9 | Confidentiality protection — output scanning for leakage described, inter-tenant isolation at response layer stated, log redaction policy stated |
| 10 | Guardrail latency budget — p99 cost of full stack stated and fits within run budget, optimization approach named |
| 11 | Bypass and override policy — conditions stated (or hard no-bypass), audit trail requirement stated |
| 12 | Multi-tenant guardrail isolation — per-tenant policy scoping described, runtime loading strategy stated |
| 13 | Guardrail observability — trigger rate, false positive rate, latency, bypass events, and escalation rate metrics named; alert threshold stated |
| 14 | Guardrail failure mode — fail-open/fail-closed/degrade choice stated with rationale and configurability noted |
| 15 | Guardrail model versioning — rollout strategy named (canary/shadow/A-B), regression detection method stated |

### Phase 1 Synthesizer (sequential, after A–D complete)

After all parallel sub-agents return, spawn one final sequential `Agent` as the
synthesizer. This agent **does not re-read the pack** — it receives only the
structured verdict reports from sub-agents A, B, C (if applicable), and D.

Reads: the four verdict reports passed as inline text in the prompt. Nothing else.

Mandate:
> You are assembling the Phase 1 gate decision from four independent critic reports.
> Merge them into a single structured Phase 1 report with these sections:
> - Agentic layer: N PASS, M PARTIAL, F FAIL (list FAILs and PARTIALs)
> - Scale gate: K/5 axes
> - Memory layer: N PASS, M PARTIAL, F FAIL
> - Guardrails: N PASS, M PARTIAL, F FAIL
> - Ingestion pipeline: N PASS, M PARTIAL, F FAIL (omit if not applicable)
> - Phase 1 verdict: PASS or FAIL
> A verdict of FAIL if ANY rubric has even one FAIL or if scale gate < 4/5.
> List every FAIL with a one-sentence remediation hint.
> List every PARTIAL grouped by section.
> Return the structured report only.

### Phase 1 Halt Condition

If the synthesizer's Phase 1 verdict is **FAIL** (any FAIL across any active rubric,
or scale gate < 4/5):

1. Print the synthesizer's Phase 1 report with all FAIL and PARTIAL items,
   grouped by section (agentic / scale gate / memory / guardrails / ingestion).
2. Print: "Phase 1 FAILED. The following blocking objections must be addressed
   before this design can proceed to Principal Engineer validation."
3. List each FAIL with its one-sentence remediation hint from the synthesizer.
4. **Halt. Do not proceed to Phase 2.**

Fix the design pack (re-run `analyze-my-resume` or edit manually) and re-invoke.

### Phase 1 Pass Condition

The synthesizer returns Phase 1 PASS: no FAILs in any rubric, scale gate ≥ 4/5.
PARTIAL items are warnings, not halts. Print them grouped by section before
proceeding. The Principal Engineer in Phase 2 will see the full synthesizer report.

## Phase 2: Principal Engineer Validation Agent

Reads: the synthesizer's Phase 1 report (passed as inline text) + the pack folder
path so the PE can selectively read files. The PE must NOT be given the individual
sub-agent verdict reports — only the aggregated synthesizer output.

## Phase 2: Principal Engineer Validation Agent

Spawn a fresh `Agent` for the PE review. This agent receives the synthesizer's
Phase 1 report as inline text — NOT the individual sub-agent verdicts. It also
receives the pack folder path and is asked to selectively read the deep-dive files.
Keeping the PE independent from the raw sub-agent verdicts prevents anchoring bias.

> You are a principal engineer at a company that runs agentic AI systems for
> over a million users. You are conducting a final production-readiness review.
> You are NOT a yes-man — you approve only when the design is genuinely
> production-ready.
>
> You have been given a Phase 1 critic summary (aggregated counts only, no raw
> verdicts). The PARTIAL items are listed below by section. Read
> `12-agentic-graph-structure.md`, `13-memory-layer-design.md`,
> `15-guardrails.md`, and (if present) `14-ingestion-pipeline.md` yourself.
> Do not read the entire pack — focus on the deep-dive files and the executive
> summary. Then answer these eight questions:
>
> 1. Is the agentic graph structure (`12-agentic-graph-structure.md`) specific
>    enough that an engineer could implement it without ambiguity? If not, what
>    is the first ambiguous decision?
> 2. Is the memory layer design (`13-memory-layer-design.md`) specific enough
>    to implement? Are the retrieval strategy, isolation boundary, and scale
>    model credible? If not, what is the first gap?
> 3. Does the guardrails design (`15-guardrails.md`) cover the full execution
>    pipeline — input, output, tool calls, and cross-agent boundaries? Is the
>    fail-open/fail-closed policy appropriate for the threat model? Any gaps?
> 4. If `14-ingestion-pipeline.md` is present: does it close the loop between
>    the write path and the memory layer's read path, with consistent embedding
>    model and credible throughput at 1M users? Skip if not present.
> 5. Are the PARTIAL items from the Critic genuinely acceptable for an MVP, or
>    are any blockers for a production launch at 1M users?
> 6. Does the combined design — agentic layer, memory, guardrails, and
>    ingestion (if present) — show a credible end-to-end path to 1M users with
>    fleet, queue depth, isolation boundary, cost model, and index scale addressed?
> 7. Are there any gaps the Critic missed in any layer that you consider blocking?
> 8. Would you sign off on this design as ready for implementation?
>
> Return your verdict as: `APPROVED` or `REJECTED`.
> Follow it with a one-paragraph rationale and a bullet list of any remaining
> concerns the implementation team must address (even for `APPROVED` designs).

### Phase 2 Halt Condition

If the PE Agent returns `REJECTED`:

1. Print the full PE rationale and concern list.
2. Print: "Phase 2 REJECTED. Principal Engineer validation failed. Address the
   PE's concerns, update the design pack, and re-invoke `/critical-agent`."
3. **Halt. Do not write the approval artifact.**

### Phase 2 Pass Condition

The PE Agent returns `APPROVED`. Print the full rationale and concern list.

## Phase 3: Write the Approval Artifact

Only execute this phase when Phase 1 and Phase 2 both passed.

Write `20-critical-agent-approval.md` into the pack folder with this structure:

```markdown
# Critical Agent Approval

**Pack:** <folder path>
**Date:** <today's date>
**Skill:** /critical-agent

## Phase 1: Critic Verdict

### Agentic Layer (20-point rubric)
- Result: N PASS, M PARTIAL, 0 FAIL
- Scale gate: K / 5 axes passed

### Memory Layer (15-point rubric)
- Result: P PASS, Q PARTIAL, 0 FAIL

### Guardrails (15-point rubric)
- Result: G PASS, H PARTIAL, 0 FAIL

### Ingestion Pipeline (15-point rubric — omit section if `hasKnowledgeBase: false`)
- Result: R PASS, S PARTIAL, 0 FAIL

### PARTIAL Items (must be addressed before GA)

**Agentic layer PARTIALs:**
<list each agentic PARTIAL with its remediation note>

**Memory layer PARTIALs:**
<list each memory PARTIAL with its remediation note>

**Guardrails PARTIALs:**
<list each guardrail PARTIAL with its remediation note>

**Ingestion pipeline PARTIALs:** *(omit if not applicable)*
<list each ingestion PARTIAL with its remediation note>

## Phase 2: Principal Engineer Verdict

**APPROVED**

<PE rationale paragraph>

### Remaining Concerns for Implementation Team

<PE concern bullet list>

## Approval Status

This agentic design pack has cleared the /critical-agent gate. Downstream work
(implementation, detailed LLD, handoff to engineers) may proceed. The PARTIAL
items and PE concerns above are tracked obligations — they are not optional.

**Approved by:** /critical-agent skill (automated gate, not a human sign-off)
```

After writing the file, print a short summary:

```
/critical-agent APPROVED
Pack: design-packs/<folder>
Approval artifact: 20-critical-agent-approval.md
Remaining obligations: <count of PARTIALs + PE concerns>
```

## Execution Rules

- **Never collapse the four Phase 1 sub-agents into fewer.** Sub-agents A, B, C,
  and D must be separate `Agent` calls reading only their scoped files. One agent
  reading all 70 points and the full pack produces shallow verdicts. The isolation
  is the quality mechanism.
- **Never pass individual sub-agent verdicts to the PE.** The PE receives only the
  synthesizer's aggregated summary. This prevents anchoring bias.
- **Never skip a FAIL to proceed.** A single FAIL anywhere is a hard stop.
- **Never write `20-critical-agent-approval.md` unless Phase 3 conditions are met.**
  Do not create a partial or draft version of the approval artifact.
- **The approval artifact is not a guarantee.** It is a record that an automated
  gate passed. Human engineering review is still required before production deployment.
- If the user asks "what's blocking this?", surface the Critic's FAIL list.
  Never summarize FAILs as "mostly good with a few gaps."

## What This Skill Does Not Do

- It does not fix the design. It identifies gaps; the user or `analyze-my-resume`
  must address them.
- It does not replace security review, load testing, or human architecture review.
- It does not validate that the implementation matches the design.
- It does not run for non-agentic packs (`isAgentic: true` required).
