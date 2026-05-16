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
6. stage-scoped challenge reviewer (consumes `14-challenges-by-stage.md` if present)

## Chain-of-Thought Challenge Generation (when no base pack exists)

If the base pack does not yet have `14-challenges-by-stage.md`, generate it
using the Chain-of-Thought procedure documented in `analyze-my-resume/SKILL.md`
and `resume-design-pack/SKILL.md`. Cross-exam reuses the same procedure for
two reasons:

1. The hardest interviewer pushback usually targets a high-Pain challenge from
   a specific stage; without that ranked inventory, pushback drifts into
   generic skepticism.
2. The Pain scores (Severity × Frequency × Difficulty / 100) give the
   cross-exam writer a defensible reason to choose *which* objections to lead
   with: top-Pain rows become the "make-or-break" cross-exam questions.

When the base pack already has the file, **do not regenerate it**. Read it,
map its top-10 leaderboard onto the cross-exam files as follows:

| Top-10 row maps to | Cross-exam file |
|---|---|
| Identity, network, isolation, threat-model rows | `cross-exam/security-pushback.md` |
| Comm-bound, all-to-all, fabric, capacity rows | `cross-exam/scale-stressors.md` |
| Schema, contract, idempotency, state-machine rows | `cross-exam/api-and-lld-pushback.md` |
| Quota fairness, SDK simplicity, roadmap, vendor rows | `cross-exam/leadership-and-business-pushback.md` |
| Anything that needs a 60-second answer | `cross-exam/fast-rebuttals.md` |

Each cross-exam objection should cite the challenge ID (e.g. `C2.1`) it derives
from, so a reader can trace pushback back to the substrate.

## Quality Bar

- challenge weak assumptions instead of accepting them
- include API design and LLD follow-up questions for stateful or orchestration-heavy systems
- include at least one failure-mode question per major subsystem
- include at least one tradeoff question per design
- include direct, crisp answer outlines instead of vague hints
- anchor the pushback in the candidate's actual experience claims
- when `14-challenges-by-stage.md` exists, the cross-exam must trace at least 50% of its objections to specific challenge IDs from the leaderboard
- do not create numbered root files that collide with the base pack schema
- do not regenerate `14-challenges-by-stage.md` if it already exists; cross-exam consumes it, the base skills produce it
