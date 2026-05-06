---
name: resume-design-pack
description: |
  Build a multi-file principal engineer design pack from a concrete interview question
  using `resume.txt` and the experience markdown files in this repo.
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

## Required Inputs

- `resume.txt`
- the most relevant `*-experience.md` files
- the question itself

If the user supplied a target folder, use it. Otherwise create one in
`design-packs/YYYY-MM-DD-short-topic-slug/`.

## Mandatory Deliverables

Write a pack with at least these files:

- `README.md`
- `00-question-and-context.md`
- `01-executive-summary.md`
- `02-architecture.md`
- `03-deep-dive.md`
- `04-scaling-and-capacity.md`
- `05-security-and-isolation.md`
- `06-reliability-observability-and-failures.md`
- `07-tradeoffs-and-alternatives.md`
- `08-cross-questions.md`
- `09-cheat-sheet.md`

Add extra files when the question calls for them, especially around state machines,
data models, protocol design, or control plane and data plane separation.

## Parallel Decomposition

Use parallel agents when available.

Minimum lanes:

1. system architecture
2. scale and cost
3. security and isolation
4. reliability and debugging
5. skeptical interviewer follow-ups

Each lane should return concise notes that are then synthesized into the final files.

## Pack Quality Bar

- principal engineer tone and structure
- explicit assumptions and scope limits
- concrete failure handling and operational metrics
- strong tradeoff discussion, not just a happy path
- interview-ready cross-questions and short talking points

## Guardrails

- Do not invent private implementation details.
- Do not leave the answer only in chat; write the files.
- Do not collapse everything into a single summary file.
