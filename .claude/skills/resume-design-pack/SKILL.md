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

Each lane should return concise notes that are then synthesized into the final files.

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
