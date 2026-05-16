---
name: resume-design-pack
description: |
  Build a multi-file principal engineer design pack from a concrete interview question
  using `resume.txt` and the experience markdown files in this repo, with explicit
  API design and low-level design coverage when relevant.
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
  - build a design pack
  - create a markdown interview pack
  - generate system design files
---

## When To Use

Use this skill when the user already has a concrete question and wants a file-backed answer
pack written into the repo.

The generated pack must follow a supported archetype from `design-packs/README.md` and
must include `manifest.json`.

## Required Inputs

- `resume.txt`
- the most relevant `*-experience.md` files
- the question itself

If the user supplied a target folder, use it. Otherwise create one in
`design-packs/YYYY-MM-DD-short-topic-slug/`.

Only update an existing pack when the folder is explicit or its manifest `questionHash`
matches the normalized prompt exactly.

## Grounding Standard

- Use at least two concrete anchors when claiming architecture specifics or impact.
- If the source material is thin, lower confidence and label assumptions explicitly.

## Mandatory Deliverables

Write `manifest.json` first, then the archetype-specific required files.

For `system-design`, write at least these files:

- `README.md`
- `manifest.json`
- `00-question-and-context.md`
- `01-executive-summary.md`
- `02-architecture.md`
- `03-api-and-contracts.md`
- `04-low-level-design.md`
- `05-scaling-and-capacity.md`
- `06-security-and-isolation.md`
- `07-reliability-observability-and-failures.md`
- `08-tradeoffs-and-alternatives.md`
- `09-cross-questions.md`
- `10-cheat-sheet.md`
- `14-challenges-by-stage.md` (generated via the Chain-of-Thought Challenge Generation procedure below; this file is required for `system-design`, not optional)

For `security-review`, write the required files listed in `design-packs/README.md`.

Add extra files when the question calls for them, especially around state machines,
data models, protocol design, control plane and data plane separation, or cross-exam.

Place extended challenge material under `cross-exam/`, not in the numbered root file sequence.

## Parallel Decomposition

Use parallel agents when available.

Minimum lanes:

1. system architecture
2. API and contract design
3. low-level design and state machine
4. scale and cost
5. security and isolation
6. reliability and debugging
7. skeptical interviewer follow-ups
8. stage-scoped challenge generation (consumes lanes 1-7; runs after them)

Each lane should return concise notes that are then synthesized into the final files.

## Chain-of-Thought Challenge Generation

`14-challenges-by-stage.md` is a required deliverable for every `system-design`
pack. To make the output reliable across runs, generate it with this explicit
Chain-of-Thought procedure rather than free-form brainstorming.

### Step 0: scope check

In working notes, restate the system in one sentence and pick the single most
load-bearing resume anchor for it (file + line number). If either is unclear,
re-read the inputs before continuing.

### Step 1: fix the stages

Default stages, used unless the question is clearly outside this lifecycle:

| Stage | Window | Stage truth |
|---|---|---|
| 1. Inception | weeks 0-12 | One team, no real customers; "make it work once" |
| 2. Early scale | months 3-9 | First 1-50 tenants; concurrency exposes bugs |
| 3. Production hardening | months 6-18 | Reliability and observability dominate |
| 4. Multi-tenant scale | months 12-30 | Next 10x exposes multi-tenancy and policy gaps |
| 5. Frontier / next-platform | months 18+ | Adjacent ambitions: new hardware, new model class, new region |

Write the stage-truth header for each stage in the file before listing
challenges. The header constrains what counts as a challenge for that stage.

### Step 2: per-stage inner CoT

For each stage, produce at least four candidate challenges using this
four-question inner CoT, executed in your reasoning before writing to disk.

1. **Surface:** what concrete symptom does the team see at this stage? Write a
   sentence, not a noun.
2. **Root layer:** which architectural layer is responsible (identity, network,
   scheduling, runtime, storage, observability, product surface, organizational)?
3. **Blast radius:** one engineer, one tenant, all tenants, security, finance,
   or trust narrative?
4. **Counterfactual:** why does the easy fix not work? What design constraint
   makes it interesting?

Include a candidate only when all four steps produced a non-generic answer.

### Step 3: rate on three axes

| Axis | Scale | 1 anchor | 10 anchor |
|---|---|---|---|
| Severity | 1-10 | Paper cut | Cannot ship; recurring SEV-1 |
| Frequency | 1-10 | Once in the program's life | Daily, every job |
| Difficulty | 1-10 | Read the manual | Open research, multi-quarter |

`Pain = Severity × Frequency × Difficulty / 100`, capped at 100, one decimal.
Keep S, F, D visible alongside Pain. Pairwise compare highest two and lowest
two within each stage if many ratings cluster.

### Step 4: anchors

At least one in three challenges across the file must cite a specific
`resume.txt` or `*-experience.md` line. No anchor at all means the file slides
into a generic "things that go wrong" essay.

### Step 5: top-10 and meta-observations

End the file with a top-10 leaderboard sorted descending by Pain (include
stage, ID, name, Pain), and two to four bullet observations naming patterns
the ranking exposes. Observations must point to specific top-10 rows; no
generic conclusion paragraph.

### Step 6: pre-save checklist

- [ ] At least 4 challenges per stage; at least 20 total
- [ ] Every challenge rated on S, F, D, Pain
- [ ] Top-10 leaderboard present and sorted
- [ ] At least 30% of challenges cite an anchor
- [ ] No identical (S, F, D) triples in the same stage unless deliberate
- [ ] No challenge is fully generic to "any distributed system"

If any item is unchecked, redo the relevant step before writing.

### Reference exemplar

`design-packs/2026-05-17-distributed-finetuning-dataplane-internals/14-challenges-by-stage.md`
is the canonical example of this procedure's output. Mirror its layout when in
doubt.

## Pack Quality Bar

- principal engineer tone and structure
- explicit assumptions and scope limits
- concrete API contract and likely LLD follow-through, not just high-level boxes
- concrete failure handling and operational metrics
- strong tradeoff discussion, not just a happy path
- interview-ready cross-questions and short talking points
- deterministic reuse through `manifest.json` and exact `questionHash` matching

## Guardrails

- Do not invent private implementation details.
- Do not leave the answer only in chat; write the files.
- Do not collapse everything into a single summary file.
- Do not update a pack based on recency heuristics.
- Do not omit API or LLD details when the prompt includes workflows, jobs, control planes, or orchestration.
- Do not skip `14-challenges-by-stage.md` for `system-design` packs; it is required.
- Do not generate the challenges file by listing problems and rating after the fact; follow the Chain-of-Thought order or quality drops.
- Do not give the same (S, F, D) triple to many challenges in a row; that signals the inner CoT was skipped.
