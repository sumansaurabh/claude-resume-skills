# Project Claude Routing

## Available Local Skills

- `/analyze-my-resume`: primary entrypoint for resume-grounded architecture, system design, scaling, security, and principal engineer interview questions.
- `/resume-design-pack`: direct multi-file design-pack generator when the user already has a specific question.
- `/resume-cross-exam`: pressure-tests an answer or an existing design pack with skeptical follow-up questions and rebuttals.

## Routing Rules

When the user asks a system design, architecture, scaling, security, distributed systems, or interview-prep question grounded in the files in this repo, invoke `/analyze-my-resume`.

When the user already has a concrete prompt and explicitly wants files written to a folder, invoke `/resume-design-pack`.

When the user wants only follow-up questions, mock interview pressure, skepticism, or challenging pushback, invoke `/resume-cross-exam`.

## Repo Conventions

- Primary context comes from `resume.txt` and any `*-experience.md` files in the repo root.
- Generated outputs go under `design-packs/YYYY-MM-DD-short-topic-slug/`.
- Every full pack should include summary, architecture, scaling, security, reliability, tradeoffs, cross-questions, and a cheat sheet.
- Use parallel agents when the Agent or Task tool is available. Default lanes are architecture, scale, security, reliability, and cross-exam.
- Keep answers resume-grounded. If a detail is not supported by the source files, state it as an assumption instead of presenting it as fact.
