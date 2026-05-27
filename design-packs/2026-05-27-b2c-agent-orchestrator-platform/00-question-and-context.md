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

## Assumptions

- **Scale target**: 1M registered users, 100K weekly actives, 10K agents created, peak ~5K concurrent agent runs. Anchored on a B2C platform pattern; not a resume number, marked as assumption.
- **Models**: At launch, route across Claude (Sonnet, Haiku), GPT-4o, Gemini Pro. 
- **Cost target**: Average cost per agent run < $0.05 at p50.
- **Compliance**: SOC-2 Type II within 12 months of launch, GDPR from day one.
- **Skill execution model**: Claude skills are markdown files with frontmatter + optional scripts. Scripts run in a WASM + Docker + Firecracker sandbox.
- **Memory cost**: Each user costs ~50 MB of memory storage at steady state (vectors + episodic snapshots + procedural).