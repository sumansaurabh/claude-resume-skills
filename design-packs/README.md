# Design Packs

Generated interview-prep outputs should be written here.

## Naming

Use a folder name shaped like:

`design-packs/YYYY-MM-DD-short-topic-slug/`

Example:

`design-packs/2026-05-06-secure-llm-training-vnet-kubernetes/`

## Required Metadata

Every pack folder must include a machine-readable `manifest.json`.

Use this shape:

```json
{
	"schemaVersion": 2,
	"archetype": "system-design",
	"slug": "llm-training-platform",
	"createdAt": "2026-05-17",
	"question": "You say you scaled secure LLM training across VNet and Kubernetes...",
	"questionHash": "sha256:...",
	"company": "Microsoft",
	"primarySkill": "/analyze-my-resume",
	"sourceFiles": ["resume.txt", "microsoft-experience.md"],
	"grounding": {
		"confidence": "high",
		"strongAnchors": 2,
		"supportingAnchors": 2
	}
}
```

For agentic system packs, add `"isAgentic": true` to the manifest:

```json
{
	"schemaVersion": 2,
	"archetype": "system-design",
	"isAgentic": true,
	"slug": "agentic-code-execution-platform",
	"createdAt": "2026-05-17",
	"question": "Design the agentic layer for a no-code AI platform...",
	"questionHash": "sha256:...",
	"company": "BlackBox",
	"primarySkill": "/analyze-my-resume",
	"sourceFiles": ["resume.txt", "blackbox-experience.md"],
	"grounding": {
		"confidence": "high",
		"strongAnchors": 3,
		"supportingAnchors": 2
	}
}
```

`isAgentic: true` activates agentic-specific lanes in `/analyze-my-resume` and
makes `19-agentic-graph-structure.md` a required file. It also enables
`/critical-agent` to run the three-phase validation gate on the pack.

`questionHash` is the SHA-256 of the question after trimming leading and trailing
whitespace and collapsing internal whitespace runs to a single space.

`schemaVersion` controls the required file layout:

- `1` (legacy): no `02-design-estimates.md`; architecture is `02`. Packs created
	before 2026-05-17 use this layout and continue to validate under v1.
- `2` (current): `02-design-estimates.md` is required and sits between the
	executive summary and architecture; all subsequent numbered files shift by
	one. Use v2 for every new pack going forward.

## Supported Archetypes

### `system-design`

Use for architecture, API design, LLD, scaling, protocol, and multi-component platform questions.

#### Required root files (v2, current)

- `README.md`
- `manifest.json`
- `00-question-and-context.md`
- `01-executive-summary.md`
- `02-design-estimates.md`
- `03-architecture.md`
- `04-api-and-contracts.md`
- `05-low-level-design.md`
- `06-scaling-and-capacity.md`
- `07-security-and-isolation.md`
- `08-reliability-observability-and-failures.md`
- `09-tradeoffs-and-alternatives.md`
- `10-cross-questions.md`
- `11-cheat-sheet.md`
- `15-challenges-by-stage.md` (generated via Chain-of-Thought Challenge Generation; see the analyze-my-resume and resume-design-pack skills)

`02-design-estimates.md` is the upfront framing section that the interviewer
expects before architecture. It must cover:

- **Use case and problem statement** — what is being solved and the business
	motivation; why this is worth building at all.
- **User personas and access patterns** — who uses the system (developers,
	internal services, end users, automated pipelines), in what context, and at
	what cadence.
- **Existing options and build-vs-buy** — open source projects, commercial
	products, and adjacent internal systems that could plausibly solve the
	problem; the specific gaps in those options that justify building.
- **Why we are building it** — the load-bearing reason a custom system beats
	the alternatives (compliance, isolation, scale, cost, latency, integration).
- **Capacity and load estimates** — back-of-envelope sizing for users, QPS,
	storage, bandwidth, and growth rate, plus functional and non-functional
	requirements (latency targets, availability, durability, recovery time).

Treat this file as the interviewer's "frame the problem" expectation; without
it, architecture lands without context.

#### Optional root files (v2)

Add more files when the question needs them, for example:

- `12-control-plane-vs-data-plane.md`
- `13-state-machine-and-workflows.md`
- `14-data-model-and-storage.md`
- `16-leadership-and-business-framing.md`
- `17-risk-register.md`
- `18-debugging-playbooks.md`

#### Agentic-system conditional required files (v2, `isAgentic: true`)

When `manifest.json` contains `"isAgentic": true`, the following file is also
**required** (not optional):

- `19-agentic-graph-structure.md`: two-layer deep-dive into the agent graph.
  Must contain:
  - **Layer 1 — Graph Topology**: node type taxonomy, edge type taxonomy, a
    full Mermaid diagram of the agent graph, and the supervisor/worker hierarchy.
  - **Layer 2 — Per-Node State and Edge Conditions**: per-node checkpoint state
    shape, conditional edge logic, parallel-join semantics, and human-in-the-loop
    interrupt/resume contracts.
- `20-critical-agent-approval.md` *(written by `/critical-agent` only)*: the
  approval artifact produced after the three-phase critic + PE validation gate
  passes. This file is never written manually.

#### Required root files (v1, legacy)

Packs with `schemaVersion: 1` keep the original layout (no design-estimates;
architecture at `02`, challenges at `14`). New packs must not use v1; it exists
only so existing packs continue to validate.

### `security-review`

Use for vulnerability-class, CI/CD, secure tooling, and security-program design questions.

Required root files:

- `README.md`
- `manifest.json`
- `00-question-and-context.md`
- `01-executive-summary.md`
- `02-vulnerability-classes.md`
- `03-tooling-and-configuration.md`
- `04-threat-model-connection.md`
- `05-cross-questions.md`
- `06-cheat-sheet.md`

Optional root files:

- `07-remediation-roadmap.md`
- `08-policy-and-governance.md`
- `09-debugging-and-operations.md`

## Cross-Exam Expansion

Extended cross-exam artifacts must live under `cross-exam/`, not in the numbered root sequence.

If present, use:

- `cross-exam/README.md`
- `cross-exam/api-and-lld-pushback.md`
- `cross-exam/scale-stressors.md`
- `cross-exam/security-pushback.md`
- `cross-exam/leadership-and-business-pushback.md`
- `cross-exam/fast-rebuttals.md`

The root `10-cross-questions.md` file (v2) remains the compact core interview
follow-up set. For v1 packs, the equivalent file is `09-cross-questions.md`.

## Matching And Reuse

- Reuse an existing pack only when the target folder is explicit or `manifest.json`
	has an exact `questionHash` match.
- Never pick a pack by recency alone.
- If the prompt materially changes, create a new pack even if the topic is similar.
- Keep `slug` aligned with the folder name suffix after the date prefix.

## Grounding Standard

- Every pack should tie key claims back to at least two concrete resume or experience anchors.
- If fewer than two anchors exist, mark the answer as assumption-heavy and lower confidence.
- Do not present unsupported implementation details as facts.

## Quality Bar

- Tie claims back to the resume and experience documents in this repo.
- Do not invent confidential internal details.
- Prefer explicit assumptions over vague hand-waving.
- Include API-level design and likely LLD follow-ups when the topic naturally leads there.
- Show tradeoffs, bottlenecks, and failure modes.
- Write for principal engineer interview prep, not generic tutorial prose.

## Validation

Run:

`python3 scripts/validate_design_packs.py`
