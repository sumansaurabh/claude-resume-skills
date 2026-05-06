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

## Inputs To Read First

Always read:

- `resume.txt`
- every root-level `*-experience.md`

Read when present and relevant:

- `*-questions.md`
- `*-notes.md`
- `*-architecture.md`
- the most recent matching pack in `design-packs/`

If the question is ambiguous across multiple companies or roles, ask one short
clarifying question. If the user names a company or domain, prioritize the matching
experience file.

## What Good Looks Like

The output should feel like a principal engineer answer, not a generic tutorial:

- tie the design back to concrete resume evidence
- call out assumptions explicitly
- separate control plane and data plane when relevant
- include API contracts and likely low-level design follow-ups when relevant
- discuss scale, cost, reliability, security, observability, and tradeoffs
- include interviewer pushback and crisp rebuttals
- avoid pretending to know confidential internal Microsoft implementation details

## Default Workflow

1. Read the core context files and extract the strongest resume anchors for the question.
2. Classify the request. Common classes are system design, API design, LLD,
   scaling, debugging, threat model, protocol design, or platform tradeoff analysis.
3. Create or update a pack folder in `design-packs/YYYY-MM-DD-short-topic-slug/`.
4. Fan out parallel agent lanes when the Agent or Task tool is available.
5. Synthesize the agent results into a coherent file set.
6. Write the files, then return a short summary with the created folder path.

## Parallel Agent Lanes

Use parallel agents whenever possible. Default lanes:

1. Architecture lane: end-to-end request flow, component map, control flow.
2. API and LLD lane: public APIs, internal contracts, state machines, schemas, component interfaces.
3. Scale lane: capacity model, quotas, bottlenecks, backpressure, cost controls.
4. Security lane: isolation, identity, secrets, trust boundaries, threat model.
5. Reliability lane: retries, checkpointing, failure handling, observability.
6. Cross-exam lane: skeptical interviewer questions, traps, and strong rebuttals.
7. Leadership lane: roadmap, tradeoffs, business framing, why this mattered.

If agent support is unavailable, do the same reasoning sequentially and note the fallback.

## Required Output Files

Create at least these files for a full pack:

- `README.md`: one-screen overview and file map.
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

Add extra files when needed. Good optional files include:

- `11-control-plane-vs-data-plane.md`
- `12-state-machine-and-workflows.md`
- `13-data-model-and-storage.md`
- `14-leadership-and-business-framing.md`
- `15-risk-register.md`

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

## Failure Modes To Avoid

- Do not answer with one big monolithic markdown file when the user asked for a folder of files.
- Do not skip API design or likely LLD follow-up if the question touches workflows, orchestration, or services.
- Do not skip scaling, security, or tradeoff analysis.
- Do not generate generic architecture that is not anchored in the resume.
- Do not omit cross-questions or rebuttals.
