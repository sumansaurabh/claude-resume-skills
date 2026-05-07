# Project Claude Routing

## Available Local Skills

- `/analyze-my-resume`: primary entrypoint for resume-grounded architecture, system design, API design, LLD, scaling, security, and principal engineer interview questions.
- `/resume-design-pack`: direct multi-file design-pack generator when the user already has a specific system, API, or LLD question.
- `/resume-cross-exam`: pressure-tests an answer or an existing design pack with skeptical follow-up questions and rebuttals.

## Routing Rules

When the user asks a system design, architecture, API design, low-level design, scaling, security, distributed systems, or interview-prep question grounded in the files in this repo, invoke `/analyze-my-resume`.

When the user already has a concrete prompt and explicitly wants files written to a folder, invoke `/resume-design-pack`.

When the user wants only follow-up questions, mock interview pressure, skepticism, or challenging pushback, invoke `/resume-cross-exam`.

## Repo Conventions

- Primary context comes from `resume.txt` and any `*-experience.md` files in the repo root.
- Generated outputs go under `design-packs/YYYY-MM-DD-short-topic-slug/` and must include `manifest.json`.
- Supported pack archetypes and required file sets are defined in `design-packs/README.md`.
- Reuse a pack only when the folder is explicitly named or the manifest `questionHash` matches exactly.
- Use the seven-lane default bundle from `/analyze-my-resume`: architecture, API and LLD, scale, security, reliability, cross-exam, and leadership.
- Keep answers resume-grounded. Use at least two concrete anchors when claiming specifics; otherwise lower confidence and label assumptions explicitly.
