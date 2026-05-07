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

If a target pack folder is explicit, use it.

If a target pack folder is not explicit, only attach to a pack when `manifest.json` has an
exact `questionHash` match.

If no matching pack exists yet, first create the base pack using the archetype rules from
`design-packs/README.md`, then add the cross-exam expansion.

## Required Files

Keep the compact root `09-cross-questions.md` file in the base pack.

Write deeper challenge material under `cross-exam/`:

- `cross-exam/README.md`: scope of the pressure test and how it maps to the base pack.
- `cross-exam/api-and-lld-pushback.md`: contract design, schemas, concurrency, and component-level objections.
- `cross-exam/scale-stressors.md`: bottleneck pushes, capacity shocks, and degradation scenarios.
- `cross-exam/security-pushback.md`: threat-model objections and mitigation gaps.
- `cross-exam/leadership-and-business-pushback.md`: roadmap, prioritization, and stakeholder tension.
- `cross-exam/fast-rebuttals.md`: concise answers that can be delivered in under 60 seconds each.

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
- do not create numbered root files that collide with the base pack schema
