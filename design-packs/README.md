# Design Packs

Generated interview-prep outputs should be written here.

## Naming

Use a folder name shaped like:

`design-packs/YYYY-MM-DD-short-topic-slug/`

Example:

`design-packs/2026-05-06-secure-llm-training-vnet-kubernetes/`

## Minimum File Set

Each full pack should contain at least these files:

- `README.md`
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

## Optional Files

Add more files when the question needs them, for example:

- `11-control-plane-vs-data-plane.md`
- `12-state-machine-and-workflows.md`
- `13-data-model-and-storage.md`
- `14-leadership-and-business-framing.md`
- `15-risk-register.md`
- `16-debugging-playbooks.md`

## Quality Bar

- Tie claims back to the resume and experience documents in this repo.
- Do not invent confidential internal details.
- Prefer explicit assumptions over vague hand-waving.
- Include API-level design and likely LLD follow-ups when the topic naturally leads there.
- Show tradeoffs, bottlenecks, and failure modes.
- Write for principal engineer interview prep, not generic tutorial prose.
