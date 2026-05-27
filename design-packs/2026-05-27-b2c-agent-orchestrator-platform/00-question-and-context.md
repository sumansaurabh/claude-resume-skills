# Question and Context

## Original Question

I want to create a web-based AI-agent orchestrator + catalog of agents — something similar to what OpenAI has built with Custom GPTs.

It's a **B2C orchestrator** where anyone can create their own agent. When someone is creating an agent, they can:

- Define a **persona** for that particular agent (system prompt, voice, behavior).
- Define what **connectors** it can connect to. These could be **MCP connectors**, or **token-based connectors** like Gmail, Slack, etc. The agent will read data from these sources, reason over it, and send information back.
- Connect to **RAG databases** and other knowledge sources.
- Define its own **skills** using the **Claude skills syntax** with scripts that can run inside those skills.
- Have a **memory layer** that stores different sorts of memory data.

The expected deliverable includes a Mermaid diagram showing how all components — agents, memory (deep-diving memory), connectors, skills, and orchestrator — interact with each other.

## Scope

In scope:

- B2C self-serve agent authoring (persona, connectors, skills, memory).
- Agent runtime that executes a persona end-to-end across MCP, OAuth/token connectors, RAG retrieval, custom skills, and memory reads/writes.
- A catalog where agents can be discovered, forked, and run by other users.
- Multi-tenant isolation at the user level (consumer scale, not enterprise tenant scale).
- Memory subsystem with working / episodic / semantic / procedural memory.
- Skill execution sandbox modeled on Claude skills syntax (scripts + metadata).
- Connector trust boundary (OAuth scope, MCP capability filtering, token storage).
- Orchestrator graph (planner, router, executor, critic, HITL).

Out of scope (called out, not designed in depth):

- Billing and metering UX.
- Mobile app surface (assumed web-first, mobile reuses the same API).
- Custom on-prem deployment (this is a B2C SaaS, not enterprise self-hosted).
- Fine-tuning user-specific models (we use prompt + memory, not weight updates).
- Voice-mode inference. Out-of-scope for v1; the architecture should not preclude it.

## Resume Anchors Used

| Claim | Anchor | Confidence |
|---|---|---|
| LangGraph + LangChain ReAct agent runtime with DAG orchestration, tool-calling, durable execution at 10K+ runs/day | `resume.txt:51-52`, `blackbox-experience.md` point 7,8,11 | High |
| Golang-backed WASM sandbox for 1M+ daily zero-shot code executions, SOC-2 ready | `resume.txt:49-50`, `blackbox-experience.md` point 3,4,5 | High |
| Graph workflow engine with checkpointing, retry semantics, memory persistence | `resume.txt:53-54`, `blackbox-experience.md` point 12,13,14 | High |
| Model router across Claude/GPT/Grok with capability-aware routing, 1B+ tokens/month | `resume.txt:55-56`, `blackbox-experience.md` point 16,17,19 | High |
| LLMOps telemetry mesh, 50M spans/day, 2.5TB+ monthly traces, deterministic replay, 60% MTTR reduction | `resume.txt:58-59`, `blackbox-experience.md` point 20 | High |
| Secure multi-tenant infrastructure on Kubernetes + Azure with VNet isolation and identity boundaries | `resume.txt:87-89`, `microsoft-experience.md` point 7,10,11 | High |
| AutoML job orchestration at 15M+ jobs/month with both SDK and UI surfaces | `resume.txt:90-92`, `microsoft-experience.md` point 11,13,15 | Supporting |
| QUIC + Rust + identity rotation across 1M+ compute instances (transferable to secure connector fabric) | `resume.txt:97-98`, `microsoft-experience.md` point 20 | Supporting |

## Assumptions

- **Scale target**: 1M registered users, 100K weekly actives, 10K agents created, peak ~5K concurrent agent runs. Anchored on a B2C platform pattern; not a resume number, marked as assumption.
- **Geographic footprint**: Single primary region (us-east-1) at launch with a read-replica in eu-west-1 for EU users. Cross-region writes deferred to v2.
- **Models**: At launch, route across Claude (Sonnet, Haiku), GPT-4o, Gemini Pro. Resume anchor mentions Claude/GPT/Grok; we substitute Gemini for Grok here because it's more commonly used in consumer products.
- **Cost target**: Average cost per agent run < $0.05 at p50. Not a resume number, marked as assumption.
- **Compliance**: SOC-2 Type II within 12 months of launch, GDPR from day one. Resume anchor: BlackBox SOC-2 work.
- **Skill execution model**: Claude skills are markdown files with frontmatter + optional scripts. Scripts run in a WASM sandbox derived from the BlackBox pattern. Resume anchor: WASM sandbox plane.
- **Memory cost**: Each user costs ~50 MB of memory storage at steady state (vectors + episodic snapshots + procedural). Marked as assumption with arithmetic in 02-design-estimates.

## Pack Layout

This is an agentic pack with knowledge base. File set:

- `00-question-and-context.md` (this file)
- `01-executive-summary.md`
- `02-design-estimates.md` — includes 20-point agentic checklist
- `03-architecture.md` — end-to-end + LB chain
- `04-api-and-contracts.md`
- `05-low-level-design.md`
- `06-scaling-and-capacity.md`
- `07-security-and-isolation.md` — infrastructure security
- `08-reliability-observability-and-failures.md`
- `09-tradeoffs-and-alternatives.md`
- `10-cross-questions.md`
- `11-cheat-sheet.md`
- `12-agentic-graph-structure.md` — Layer 1 + Layer 2
- `13-memory-layer-design.md` — 15-point memory rubric
- `14-ingestion-pipeline.md` — 15-point ingestion rubric
- `15-guardrails.md` — 15-point guardrail rubric (behavioral safety)
- `16-challenges-by-stage.md` — Chain-of-Thought stage challenges
