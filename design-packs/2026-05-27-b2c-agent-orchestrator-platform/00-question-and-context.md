# Question and Context

## Original Question

Create a web-based AI-agent orchestrator + catalog of agents - something similar to what OpenAI has built with Custom GPTs.

It's a **B2C orchestrator** where anyone can create their own agent. When someone is creating an agent, they can:

- Define a **persona** for that particular agent (system prompt, voice, behavior) for example it can act like CEO, CFO or a Head of Engineering.
- Define what **connectors** it can connect to. These could be **MCP connectors**, or **token-based connectors** like Gmail, Slack, etc. The agent will read data from these sources, reason over it, and send information back.
- Connect to **RAG databases** and other knowledge sources.
- Define its own **skills** using the **Claude skills syntax** with scripts that can run inside those skills.
- Have a **memory layer** that stores different sorts of memory data.

The expected deliverable includes a Mermaid diagram showing how all components - agents, memory (deep-diving memory), connectors, skills, and orchestrator - interact with each other.

## Functional and non-functional requirements

### Functional

- **Persona authoring**: editor with prompt, voice settings, model preference, safety filter selection; live preview.
- **Connector management**: install MCP servers from a registry; OAuth handshake for Gmail/Slack/Drive/GitHub/Notion; scoped token vault; per-agent connector allowlist.
- **Skill authoring**: upload Claude-Skill markdown + scripts; lint + dry-run in sandbox; version per-skill.
- **Agent run**: streamed chat, tool-call visualization, mid-run pause/resume, HITL approval gates.
- **Catalog browse**: search (semantic + keyword), filter by category/connectors-needed/rating, preview, fork-with-memory or fork-without-memory.
- **Fork**: deep-copy persona+skills+connectors-manifest; optional memory carryover (user choice + GDPR-clean).
- **Memory inspect/export**: user can see their per-agent memory, edit/delete entries, export as JSON (GDPR Article 20).
- **Author analytics + payout**: per-agent runs, tokens, revenue, churn.
- **Trust & safety**: kill switch per agent, moderation queue for catalog submissions.

### Non-functional

- **Latency**: p50 first-token **1.5s**, p99 first-token **4s**, p99 full-run **30s** for an 8-hop graph. *(Assumption: aligned with Custom-GPT-class expectations; not directly anchored on a resume number.)*
- **Availability**: **99.9%** monthly (43.8 min/month error budget) for orchestrator + gateway; **99.5%** for catalog (degraded read-only mode acceptable).
- **Durability**: **99.999999999%** (11 nines) for memory + skill artifacts (S3 + cross-region replication).
- **RTO**: **30 min** for orchestrator failover (multi-AZ); **2h** for full-region failover.
- **RPO**: **5 min** for memory + checkpoints (Postgres WAL ship + S3 PITR).
- **Compliance**: GDPR (data export, right-to-delete, EU region option) within 6 months; **SOC-2 Type II within 12 months**, anchored on prior SOC-2 work via WASM sandbox isolation (resume.txt:49-50).
- **Multi-tenant isolation**: row-level security in Postgres, per-tenant vector namespace, per-run WASM isolate; reusing patterns from multi-tenant K8s + VNet isolation at Microsoft (resume.txt:87-89).
- **Observability**: every run is traceable end-to-end via OTel; deterministic replay supported on a sampled basis. Anchored on 50M spans/day mesh and 60% MTTR reduction (resume.txt:58-59).
- **Cost guardrails**: per-user soft cap (free 50K tokens/day, pro 500K/day), platform-wide hard cap to avoid runaway LLM spend, automatic fallback to cheap-model on cap breach.