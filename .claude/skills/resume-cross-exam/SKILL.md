---
name: resume-cross-exam
description: |
  Pressure-test a system design answer or an existing design pack with skeptical
  interviewer questions, including API and low-level design pushback, plus scaling
  stressors, security pushback, and concise rebuttals.
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
triggers:
  - challenge this answer
  - generate follow-up questions
  - mock interview pushback
  - pressure test this design
---

## When To Use

Use this skill when the user wants the hard questions, not the first-pass architecture.

The input can be either:

- an existing folder in `design-packs/`, or
- a fresh question grounded in `resume.txt` and the experience docs

## Output Behavior

If a pack already exists, append or update cross-exam files inside that same folder.
If no pack exists yet, create a new folder in `design-packs/` first.

## Required Files

Create or update these files:

- `09-cross-questions.md`: core follow-up questions and high-quality answers.
- `11-api-and-lld-pushback.md`: contract design, schemas, concurrency, and component-level objections.
- `12-scale-stressors.md`: bottleneck pushes, capacity shocks, and degradation scenarios.
- `13-security-pushback.md`: threat-model objections and mitigation gaps.
- `14-leadership-and-business-pushback.md`: roadmap, prioritization, and stakeholder tension.
- `15-fast-rebuttals.md`: concise answers that can be delivered in under 60 seconds each.

## Parallel Lanes

When agent support is available, split the work into these lanes:

1. skeptical architect
2. API and LLD reviewer
3. scale and performance reviewer
4. security reviewer
5. principal engineer interviewer

## Quality Bar

- challenge weak assumptions instead of accepting them
- include API design and LLD follow-up questions for stateful or orchestration-heavy systems
- include at least one failure-mode question per major subsystem
- include at least one tradeoff question per design
- include direct, crisp answer outlines instead of vague hints
- anchor the pushback in the candidate's actual experience claims
