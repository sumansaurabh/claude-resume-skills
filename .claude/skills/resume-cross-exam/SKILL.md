---
name: resume-cross-exam
description: |
  Pressure-test a system design answer or an existing design pack with skeptical
  interviewer questions, scaling stressors, security pushback, and concise rebuttals.
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

- `08-cross-questions.md`: core follow-up questions and high-quality answers.
- `10-scale-stressors.md`: bottleneck pushes, capacity shocks, and degradation scenarios.
- `11-security-pushback.md`: threat-model objections and mitigation gaps.
- `12-leadership-and-business-pushback.md`: roadmap, prioritization, and stakeholder tension.
- `13-fast-rebuttals.md`: concise answers that can be delivered in under 60 seconds each.

## Parallel Lanes

When agent support is available, split the work into these lanes:

1. skeptical architect
2. scale and performance reviewer
3. security reviewer
4. principal engineer interviewer

## Quality Bar

- challenge weak assumptions instead of accepting them
- include at least one failure-mode question per major subsystem
- include at least one tradeoff question per design
- include direct, crisp answer outlines instead of vague hints
- anchor the pushback in the candidate's actual experience claims
