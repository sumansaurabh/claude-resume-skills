---
name: analyze-my-resume
description: |
  Primary resume-grounded interview design orchestrator. It reads `resume.txt` plus
  `*-experience.md` files in this repo, maps the user's question to the strongest
  experience anchors, fans work out across parallel agents, and writes a principal
  engineer design pack under `design-packs/`, including API and low-level design
  follow-through when the interview topic warrants it.
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
  - analyze my resume
  - based on my experience answer this question
  - create a principal engineer design pack
  - build an interview answer from my resume
---

## Purpose

Use this as the default skill whenever the user asks a system design, API design, or
architecture question that should be answered from the experience captured in this repo.

The skill should not stop at a chat answer. By default it should create a reusable,
multi-file markdown pack under `design-packs/` unless the user explicitly asks not to.

The pack must follow one of the supported archetypes in `design-packs/README.md` and
must include `manifest.json`.

## Inputs To Read First

Always read:

- `resume.txt`
- every root-level `*-experience.md`

Read when present and relevant:

- `*-questions.md`
- `*-notes.md`
- `*-architecture.md`
- an explicitly named pack folder in `design-packs/`
- a pack whose `manifest.json` has an exact `questionHash` match

If the question is ambiguous across multiple companies or roles, ask one short
clarifying question. If the user names a company or domain, prioritize the matching
experience file.

## Archetype Selection

- Use `system-design` for architecture, API design, LLD, scaling, protocol, and platform questions.
- Use `security-review` for vulnerability-class, CI/CD security, CodeQL, or threat-model-to-control questions.
- If the question does not fit a supported archetype cleanly, default to `system-design`
  and say so explicitly.

## Grounding Standard

- Treat a bullet or sentence from `resume.txt` or a `*-experience.md` file as an anchor.
- Use at least two concrete anchors when making detailed claims about architecture,
  scale, security posture, or business impact.
- If fewer than two anchors exist, lower the confidence and label assumptions clearly.
- Never present inferred Microsoft internal details as facts.

## What Good Looks Like

The output should feel like a principal engineer answer, not a generic tutorial:

- tie the design back to concrete resume evidence
- call out assumptions explicitly
- separate control plane and data plane when relevant
- include API contracts and likely low-level design follow-ups when relevant
- use the manifest and archetype contract so outputs are deterministic and reusable
- discuss scale, cost, reliability, security, observability, and tradeoffs
- include interviewer pushback and crisp rebuttals
- avoid pretending to know confidential internal Microsoft implementation details

## Default Workflow

1. Read the core context files and extract the strongest resume anchors for the question.
2. Classify the request and choose a supported archetype.
3. Compute the normalized `questionHash`.
4. Reuse a pack only if the folder was explicitly named or an exact manifest hash match exists.
5. Otherwise create a new pack folder in `design-packs/YYYY-MM-DD-short-topic-slug/`.
6. Write `manifest.json` before writing the rest of the pack.
7. Fan out the seven parallel agent lanes when the Agent or Task tool is available.
8. Synthesize the agent results into a coherent file set.
9. Write the files, then return a short summary with the created folder path.

## Parallel Agent Lanes

Use parallel agents whenever possible. Default lanes:

1. Architecture lane: end-to-end request flow, component map, control flow.
2. API and LLD lane: public APIs, internal contracts, state machines, schemas, component interfaces.
3. Scale lane: capacity model, quotas, bottlenecks, backpressure, cost controls.
4. Security lane: isolation, identity, secrets, trust boundaries, threat model.
5. Reliability lane: retries, checkpointing, failure handling, observability.
6. Cross-exam lane: skeptical interviewer questions, traps, and strong rebuttals.
7. Leadership lane: roadmap, tradeoffs, business framing, why this mattered.
8. Challenge lane: produces `14-challenges-by-stage.md` using the Chain-of-Thought Challenge Generation procedure below. Runs after lanes 1-7 because it consumes their findings.

If agent support is unavailable, do the same reasoning sequentially and note the fallback.

## Required Output Files

For `system-design`, create at least these files:

- `README.md`: one-screen overview and file map.
- `manifest.json`: pack metadata, archetype, question, hash, and grounding confidence.
- `00-question-and-context.md`: original question, scope, assumptions, and resume anchors used.
- `01-executive-summary.md`: the short, strong version of the answer.
- `02-architecture.md`: end-to-end architecture and major components.
- `03-api-and-contracts.md`: external APIs, internal contracts, request flows, idempotency, and error model.
- `04-low-level-design.md`: service decomposition, classes or modules, state machines, schemas, and component interactions.
- `05-scaling-and-capacity.md`: throughput model, bottlenecks, quotas, and growth plan.
- `06-security-and-isolation.md`: threat model, identity, network boundaries, and secret handling.
- `07-reliability-observability-and-failures.md`: retries, failure modes, logs, metrics, traces, and recovery.
- `08-tradeoffs-and-alternatives.md`: rejected options and why.
- `09-cross-questions.md`: challenging follow-ups and best answers.
- `10-cheat-sheet.md`: concise talking points for interview delivery.
- `14-challenges-by-stage.md`: stage-scoped, rated engineering challenges. Generated using the **Chain-of-Thought Challenge Generation** procedure below. This file is a default for every system-design pack, not an optional add-on.

Optional root files include:

- `11-control-plane-vs-data-plane.md`
- `12-state-machine-and-workflows.md`
- `13-data-model-and-storage.md`
- `15-leadership-and-business-framing.md`
- `16-risk-register.md`

For `security-review`, create the required root files defined in `design-packs/README.md`.

If the user asks for deeper challenge material, write it under `cross-exam/` using the
contract in `design-packs/README.md`.

## Writing Rules

- Use markdown headings and short paragraphs.
- Prefer tables for tradeoffs, failure taxonomies, and component responsibilities.
- Include example API resources, request and response examples, and major error cases when applicable.
- Include LLD artifacts such as class or module responsibilities, sequence flows, state transitions, and schema notes when applicable.
- Add Mermaid diagrams when a topology or state flow needs it.
- Name uncertain details as assumptions.
- Keep the tone direct, technical, and interview-ready.

## Special Behavior For The Example Question

For prompts like:

"You say you scaled secure LLM training across VNet and Kubernetes. Walk me through the end-to-end architecture: user request, job submission, scheduling, data access, training, checkpointing, logs, and artifact publishing."

The pack should explicitly cover:

- user entry points and API contract
- control plane versus data plane
- job submission and validation
- job resource model, create or get or cancel semantics, idempotency keys, and status polling model
- scheduler, gang scheduling, and quota flow
- storage and checkpoint topology
- data access through private networking and identity
- runtime stack for distributed training
- low-level workflow components such as submitter, validator, scheduler adapter, launcher, checkpoint manager, log shipper, and artifact publisher
- logs, metrics, traces, and debugging flow
- model artifact publishing and rollout gates
- scaling limits, failure modes, and interviewer pushback

## Chain-of-Thought Challenge Generation

Every `system-design` pack must include `14-challenges-by-stage.md`. This file is
**not** an optional appendix: it is the deliverable that demonstrates the
candidate has thought about what actually goes wrong when you build the system,
not just the happy path. To generate it reliably, follow this Chain-of-Thought
procedure step by step. Do not skip steps. Do not collapse the reasoning into a
single pass.

### Step 0: scope

Before generating any challenges, restate two things in plain English (in your
own working notes, not in the file):

1. What the system actually does and who pays for it being broken.
2. The single resume anchor most load-bearing for the answer (one quote with a
   line number).

If you cannot do (1) and (2), stop and re-read the inputs.

### Step 1: enumerate stages

Use these five default stages. Override only when the question is clearly
outside the lifecycle (e.g., a one-off protocol design):

| Stage | Window | What is true in this stage |
|---|---|---|
| 1. Inception | weeks 0-12 | One team, no real customers, "make it work once" |
| 2. Early scale | months 3-9 | First 1-50 tenants, behaviors that only show up under concurrency emerge |
| 3. Production hardening | months 6-18 | Product works; reliability, observability, and edges dominate |
| 4. Multi-tenant scale | months 12-30 | Next 10x of tenants exposes multi-tenancy bugs and policy gaps |
| 5. Frontier / next-platform | months 18+ | Adjacent ambitions: new hardware, new model class, new region, new compliance regime |

Per stage, write a one-line "stage truth" header in the file that captures what
is materially different from the prior stage. Do this **before** listing
challenges, because it constrains what is and is not a challenge for that stage.

### Step 2: per-stage Chain-of-Thought brainstorming

For each stage, generate at least four candidate challenges using this four-step
inner CoT. Do this in your reasoning before writing anything to disk.

1. **Surface (what hurts).** What concrete symptom does the team see at this
   stage? Write it as a sentence ("the first multi-node run hangs in
   `init_process_group`", not "networking issues").
2. **Root layer (why it hurts).** Which architectural layer is responsible?
   Identity, network, scheduling, runtime, storage, observability, product
   surface, or organizational?
3. **Who pays (the blast radius).** Is the pain felt by one engineer, one
   tenant, all tenants, the security team, the finance team, or the customer
   trust narrative?
4. **Counterfactual (why it is not trivial).** Why does the easy fix not work?
   What is the design constraint that makes the challenge interesting?

After the inner CoT, drop the candidate challenge in the file if and only if
all four steps produced a non-generic answer. If step 4 collapses to "you just
do X", the challenge is too easy to include.

### Step 3: rate each challenge on three axes

Use this rubric. Do not invent new axes per pack.

| Axis | Scale | Anchor for 1 | Anchor for 10 |
|---|---|---|---|
| **Severity** | 1-10 | Paper cut; one engineer's afternoon | Product cannot ship; recurring SEV-1 |
| **Frequency** | 1-10 | Once in the program's life | Daily, every job |
| **Difficulty** | 1-10 | Read the manual | Open research; multi-quarter |

Compute `Pain = Severity × Frequency × Difficulty / 100`, cap at 100, round to
one decimal. Pain is the file's sortable column; the three component scores
must remain visible so a reader can challenge a number.

When tempted to give the same axis score to many challenges in a row, force
yourself to **pairwise compare** the two highest and the two lowest in that
stage and re-rank. Uniform 7-7-7 ratings mean you stopped thinking.

### Step 4: resume-anchor at least 30% of challenges

At least one in three challenges across the file must cite a specific
`resume.txt` or `*-experience.md` anchor inline (line number or quoted bullet).
Without anchors, the file becomes a generic "things that go wrong with
distributed systems" essay. Anchors keep it interview-defensible.

### Step 5: top-10 leaderboard and meta-observations

End the file with:

1. A top-10 table ranked by Pain, with stage and ID columns.
2. Two to four bullet "what this list tells you" observations that name a
   pattern the ranking exposes. Examples of good patterns:
   - Stage-1 mistakes have outsized Pain because they compound.
   - The hardest problems live at the boundaries (identity, fairness, fabric).
   - Frontier-scale challenges are increasingly organizational, not technical.

Do **not** write a generic "in conclusion" paragraph. The meta-observations
must point to specific rows in the leaderboard.

### Step 6: sanity checks before save

Before writing the file, run this checklist mentally:

- [ ] At least 4 challenges per stage, at least 20 total.
- [ ] Every challenge has Severity, Frequency, Difficulty, Pain.
- [ ] Top-10 leaderboard exists and is sorted descending by Pain.
- [ ] At least 30% of challenges cite a resume anchor.
- [ ] No two challenges in the same stage have identical (S, F, D) triples
      unless that is a deliberate, defensible call.
- [ ] No challenge is generic enough to apply to "any distributed system"
      without the resume context.

If any box is unchecked, redo the relevant step before writing.

### Worked exemplar

The pack at `design-packs/2026-05-17-distributed-finetuning-dataplane-internals/`
contains a reference `14-challenges-by-stage.md` produced by this procedure.
When in doubt about format or rigor, mirror that file's structure (stage
heading, stage truth, numbered challenges with `C{stage}.{n}` IDs, rating
block, prose justification, top-10 leaderboard, meta-observations).

## Failure Modes To Avoid

- Do not answer with one big monolithic markdown file when the user asked for a folder of files.
- Do not reuse a pack just because it is the most recent similar topic.
- Do not write extended cross-exam artifacts into the numbered root file sequence.
- Do not skip API design or likely LLD follow-up if the question touches workflows, orchestration, or services.
- Do not skip scaling, security, or tradeoff analysis.
- Do not generate generic architecture that is not anchored in the resume.
- Do not claim specifics without adequate anchors.
- Do not omit cross-questions or rebuttals.
- Do not produce `14-challenges-by-stage.md` by enumerating challenges first and rating after; the Chain-of-Thought order in this file is load-bearing for quality.
- Do not let the three rating axes converge to the same number for many challenges in a row; that means the CoT was skipped.
