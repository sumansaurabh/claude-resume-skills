---
name: critical-agent
description: |
  Three-phase gate that pressure-tests an agentic system design pack before
  approving it. Phase 1: a Critic agent evaluates the design against all 20
  agentic design points and the 1M-user scale gate. Phase 2 (only if Phase 1
  passes): a Principal Engineer agent independently validates the design for
  production readiness. Only when both agents approve does the skill write the
  final approval artifact and allow downstream work to proceed. Halts with
  explicit blocking objections on any failure.
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

If any check fails:

- Missing pack → "No design pack found. Run `/analyze-my-resume` first, then
  re-invoke `/critical-agent` with the pack folder path."
- Pack exists but `isAgentic` is missing or false → "This pack is not marked as
  an agentic system (`isAgentic: true` not set). This skill is only for agentic
  designs."
- `19-agentic-graph-structure.md` missing → "The pack is missing
  `19-agentic-graph-structure.md`. Re-run `/analyze-my-resume` to regenerate
  the agentic graph layer before critiquing."

Halt after printing the relevant message. Do not proceed.

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

### Phase 1 Halt Condition

If the Critic's report contains **any `FAIL`** among the 20 points **OR** a
**Scale Gate FAIL**:

1. Print the full critic report with all FAIL and PARTIAL items highlighted.
2. Print: "Phase 1 FAILED. The following blocking objections must be addressed
   before this design can proceed to Principal Engineer validation."
3. List each FAIL item with a one-sentence remediation hint.
4. **Halt. Do not proceed to Phase 2.**

The user must fix the design pack (re-run `analyze-my-resume` or edit manually)
and re-invoke `/critical-agent`.

### Phase 1 Pass Condition

Phase 1 passes when **all 20 points are PASS or PARTIAL** and **at least 4 of 5
Scale Gate axes pass**.

PARTIAL is not a halt — it is a warning. Print all PARTIAL items prominently
before continuing. The Principal Engineer in Phase 2 will see them.

## Phase 2: Principal Engineer Validation Agent

Spawn a second, independent Agent. This agent must NOT be shown the Critic's
verdicts for individual points — only the aggregated summary (how many PASS,
PARTIAL, and the Scale Gate result). This keeps the PE's judgment independent.

> You are a principal engineer at a company that runs agentic AI systems for
> over a million users. You are conducting a final production-readiness review
> of a design pack. You are NOT a yes-man — you approve only when the design
> is genuinely production-ready.
>
> You have been told the Critic found N points PASS, M points PARTIAL, and 0
> FAILs. Scale gate passed on K of 5 axes. The PARTIAL items are: [list them].
>
> Read the full design pack independently. Then answer these five questions:
>
> 1. Is the agentic graph structure (`19-agentic-graph-structure.md`) specific
>    enough that an engineer could implement it without ambiguity? If not, what
>    is the first ambiguous decision?
> 2. Are the PARTIAL items from the Critic genuinely acceptable gaps for an MVP,
>    or are any of them blockers for a production launch at 1M users?
> 3. Does the architecture show a credible path to operating this system at 1M
>    users — not just stating it scales, but showing the fleet, queue depth,
>    isolation boundary, and cost model?
> 4. Are there any gaps the Critic missed that you consider blocking?
> 5. Would you sign off on this design as ready for implementation?
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

- 20-point evaluation: N PASS, M PARTIAL, 0 FAIL
- Scale gate: K / 5 axes passed

### PARTIAL Items (must be addressed before GA)

<list each PARTIAL with its remediation note>

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

- **Never merge Phase 1 and Phase 2 into one agent.** The two agents must be
  spawned separately. The Critic evaluates against the rubric; the PE evaluates
  for production readiness. If they are the same agent, the independence check
  is worthless.
- **Never skip a FAIL to proceed.** A single FAIL in the 20-point rubric is a
  hard stop regardless of how strong the rest of the design is.
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
