# Project Claude Routing

## Available Local Skills

- `/analyze-my-resume`: primary entrypoint for resume-grounded architecture, system design, API design, LLD, scaling, security, and principal engineer interview questions. Automatically detects agentic system questions and activates two additional deep-dive lanes plus the 20-point agentic design checklist.
- `/resume-design-pack`: direct multi-file design-pack generator when the user already has a specific system, API, or LLD question.
- `/resume-cross-exam`: pressure-tests an answer or an existing design pack with skeptical follow-up questions and rebuttals.
- `/critical-agent`: three-phase quality gate for agentic design packs. Phase 1: Critic agent evaluates the pack against the 20-point agentic rubric and the 1M-user scale gate. Phase 2 (only if Phase 1 passes): Principal Engineer agent validates production readiness independently. Phase 3 (only if both phases pass): writes `20-critical-agent-approval.md`. Halts with blocking objections on any failure.

## Routing Rules

When the user asks a system design, architecture, API design, low-level design, scaling, security, distributed systems, or interview-prep question grounded in the files in this repo, invoke `/analyze-my-resume`.

When the user already has a concrete prompt and explicitly wants files written to a folder, invoke `/resume-design-pack`.

When the user wants only follow-up questions, mock interview pressure, skepticism, or challenging pushback, invoke `/resume-cross-exam`.

When the user has an existing agentic design pack and wants it validated, criticized, or approved before implementation, invoke `/critical-agent`.

## Agentic System Convention

When a design question involves autonomous agents, LangGraph, WASM sandboxes, tool-calling loops, or multi-agent orchestration:

1. `/analyze-my-resume` will set `isAgentic: true` in the manifest, activate the agentic graph lanes (11 and 12), run the 20-point Agentic Design Estimates Checklist inside the design-estimates lane, and produce `19-agentic-graph-structure.md` alongside the standard file set.
2. After the pack is written, the user may invoke `/critical-agent` to run the three-phase gate before implementing the design.
3. The approval artifact (`20-critical-agent-approval.md`) is only written by `/critical-agent` — never by hand.

## Repo Conventions

- Primary context comes from `resume.txt` and any `*-experience.md` files in the repo root.
- Generated outputs go under `design-packs/YYYY-MM-DD-short-topic-slug/` and must include `manifest.json`.
- Supported pack archetypes and required file sets are defined in `design-packs/README.md`.
- Reuse a pack only when the folder is explicitly named or the manifest `questionHash` matches exactly.
- Use the lane bundle from `/analyze-my-resume`: architecture, API and LLD, scale, security, reliability, cross-exam, leadership, LB/fleet-sizing, challenge generation, plus the two agentic lanes when `isAgentic: true`.
- Keep answers resume-grounded. Use at least two concrete anchors when claiming specifics; otherwise lower confidence and label assumptions explicitly.
