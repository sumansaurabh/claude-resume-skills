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
3. `19-agentic-graph-structure.md` is present in the pack folder.
4. `20-memory-layer-design.md` is present in the pack folder.
5. If `manifest.json` contains `"hasKnowledgeBase": true`, then
   `22-ingestion-pipeline.md` must also be present in the pack folder.

If any check fails, print the relevant message and halt — do not proceed:

- Missing pack → "No design pack found. Run `/analyze-my-resume` first, then
  re-invoke `/critical-agent` with the pack folder path."
- Pack exists but `isAgentic` is missing or false → "This pack is not marked as
  an agentic system (`isAgentic: true` not set). This skill is only for agentic
  designs."
- `19-agentic-graph-structure.md` missing → "The pack is missing
  `19-agentic-graph-structure.md`. Re-run `/analyze-my-resume` to regenerate
  the agentic graph layer before critiquing."
- `20-memory-layer-design.md` missing → "The pack is missing
  `20-memory-layer-design.md`. Re-run `/analyze-my-resume` to generate the
  memory layer design before critiquing."
- `22-ingestion-pipeline.md` missing (when `hasKnowledgeBase: true`) → "The
  pack declares `hasKnowledgeBase: true` but is missing `22-ingestion-pipeline.md`.
  Re-run `/analyze-my-resume` to generate the ingestion pipeline design before
  critiquing."

## Phase 1: Critic Agent

Spawn an Agent with the following mandate (pass it the full pack path and the
20-point checklist from `analyze-my-resume/SKILL.md` as context):

> You are a skeptical principal architect reviewing an agentic system design
> pack. Your job is to find every gap, not to affirm the design.
>
> Read the entire pack. Then evaluate the design against each of the 20 Agentic
> Design Estimates points below. For each point, produce exactly one of:
>
> - `PASS` — the design answers this point concretely and defensibly.
> - `PARTIAL` — the design addresses it but leaves a named gap or relies on an
>   unstated assumption.
> - `FAIL` — the design ignores this point, gives a hand-wave answer, or the
>   proposed solution is incorrect.
>
> Follow each verdict with one sentence of evidence quoting the specific file
> and section where you found (or did not find) the answer. Do not soften FAILs.
>
> After all 20 points, run the **1M-User Scale Gate** (see below).
>
> Return a structured verdict report — nothing else.

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

### Memory Layer Evaluation

After the 1M-User Scale Gate, the Critic must evaluate `20-memory-layer-design.md`
independently using the 15-point memory layer rubric below. Apply the same
`PASS | PARTIAL | FAIL` verdict per point with one sentence of evidence.

This evaluation is **separate** from the 20-point agentic rubric. A design can
pass all 20 agentic points and still fail here. A single `FAIL` in the memory
evaluation is a Phase 1 halt — same rule as the agentic rubric.

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

### Phase 1 Halt Condition

If the Critic's report contains **any `FAIL`** among the 20 agentic points, a
**Scale Gate FAIL**, or **any `FAIL`** among the 15 memory layer points:

1. Print the full critic report with all FAIL and PARTIAL items highlighted,
   grouped by section (agentic rubric / scale gate / memory layer).
2. Print: "Phase 1 FAILED. The following blocking objections must be addressed
   before this design can proceed to Principal Engineer validation."
3. List each FAIL item with a one-sentence remediation hint.
4. **Halt. Do not proceed to Phase 2.**

The user must fix the design pack (re-run `analyze-my-resume` or edit manually)
and re-invoke `/critical-agent`.

### Phase 1 Pass Condition

Phase 1 passes when **all 20 agentic points are PASS or PARTIAL**, **at least 4
of 5 Scale Gate axes pass**, and **all 15 memory layer points are PASS or PARTIAL**.

PARTIAL is not a halt — it is a warning. Print all PARTIAL items prominently,
grouped by section. The Principal Engineer in Phase 2 will see them.

## Phase 2: Principal Engineer Validation Agent

Spawn a second, independent Agent. This agent must NOT be shown the Critic's
verdicts for individual points — only the aggregated summary (how many PASS,
PARTIAL, and the Scale Gate result). This keeps the PE's judgment independent.

> You are a principal engineer at a company that runs agentic AI systems for
> over a million users. You are conducting a final production-readiness review
> of a design pack. You are NOT a yes-man — you approve only when the design
> is genuinely production-ready.
>
> You have been told: Critic agentic rubric — N PASS, M PARTIAL, 0 FAIL.
> Scale gate — K of 5 axes passed. Memory layer rubric — P PASS, Q PARTIAL,
> 0 FAIL. All PARTIAL items are: [list agentic PARTIALs and memory PARTIALs
> grouped separately].
>
> Read the full design pack independently, including both
> `19-agentic-graph-structure.md` and `20-memory-layer-design.md`. Then answer
> these six questions:
>
> 1. Is the agentic graph structure (`19-agentic-graph-structure.md`) specific
>    enough that an engineer could implement it without ambiguity? If not, what
>    is the first ambiguous decision?
> 2. Is the memory layer design (`20-memory-layer-design.md`) specific enough
>    to implement without ambiguity? Are the retrieval strategy, isolation
>    boundary, and scale model credible? If not, what is the first gap?
> 3. Are the PARTIAL items from the Critic genuinely acceptable gaps for an MVP,
>    or are any of them blockers for a production launch at 1M users?
> 4. Does the combined agentic + memory design show a credible path to operating
>    at 1M users — fleet, queue depth, isolation boundary, cost model, and
>    memory index scale all addressed?
> 5. Are there any gaps the Critic missed in either layer that you consider
>    blocking?
> 6. Would you sign off on this design as ready for implementation?
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

Write `21-critical-agent-approval.md` into the pack folder with this structure:

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

### PARTIAL Items (must be addressed before GA)

**Agentic layer PARTIALs:**
<list each agentic PARTIAL with its remediation note>

**Memory layer PARTIALs:**
<list each memory PARTIAL with its remediation note>

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
Approval artifact: 21-critical-agent-approval.md
Remaining obligations: <count of PARTIALs + PE concerns>
```

## Execution Rules

- **Never merge Phase 1 and Phase 2 into one agent.** The two agents must be
  spawned separately. The Critic evaluates against the rubric; the PE evaluates
  for production readiness. If they are the same agent, the independence check
  is worthless.
- **Never skip a FAIL to proceed.** A single FAIL in the 20-point rubric is a
  hard stop regardless of how strong the rest of the design is.
- **Never write `21-critical-agent-approval.md` unless Phase 3 conditions are met.**
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
