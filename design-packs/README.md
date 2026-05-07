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
	"schemaVersion": 1,
	"archetype": "system-design",
	"slug": "llm-training-platform",
	"createdAt": "2026-05-06",
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

`questionHash` is the SHA-256 of the question after trimming leading and trailing
whitespace and collapsing internal whitespace runs to a single space.

## Supported Archetypes

### `system-design`

Use for architecture, API design, LLD, scaling, protocol, and multi-component platform questions.

Required root files:

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

Optional root files:

Add more files when the question needs them, for example:

- `11-control-plane-vs-data-plane.md`
- `12-state-machine-and-workflows.md`
- `13-data-model-and-storage.md`
- `14-leadership-and-business-framing.md`
- `15-risk-register.md`
- `16-debugging-playbooks.md`

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

The root `09-cross-questions.md` file remains the compact core interview follow-up set.

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
