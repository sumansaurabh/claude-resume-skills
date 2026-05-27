# 09 — Tradeoffs and Alternatives

This document captures the major architecture and product decisions we explicitly considered and rejected, the crossroads decisions we landed on, and the bets we're making. The goal is for a future reader (engineering, product, or a critic) to be able to reconstruct *why* we picked what we picked without re-deriving the entire decision tree.

Resume and experience anchors used throughout:

- WASM sandbox plane and SOC-2 isolation work `(resume.txt:49-50)`, `(blackbox-experience.md points 2, 3, 4, 5)`
- LangGraph / LangChain ReAct + DAG orchestration `(resume.txt:51-52)`, `(blackbox-experience.md points 7, 8, 12, 13)`
- Model router across Claude / GPT / Grok with capability-aware routing `(resume.txt:55-56)`, `(blackbox-experience.md points 16, 17, 18)`
- Cross-org architecture reviews and roadmap alignment at Microsoft `(microsoft-experience.md points 12, 19)`
- Threat modeling and secure-by-design discipline `(microsoft-experience.md point 18)`
- Leading 6+ engineers on the same problem shape `(blackbox-experience.md point 6)`, `(resume.txt:51)`

---

## Section 1 — Rejected major options

| Option | What we'd do | Why we rejected | When we'd revisit |
| --- | --- | --- | --- |
| **Build on top of OpenAI Custom GPTs / GPT Store** | Skip the orchestrator entirely; ship a thin UX wrapper that creates and lists Custom GPTs in OpenAI's store. | Hard lock-in to one provider, no MCP support, no memory persistence we can introspect, no portability for users, no monetization control, no enterprise data plane. The product becomes a marketing site for someone else's catalog. | Never as the primary product. We may publish "import from GPT Store" as a one-way migration utility for v2. |
| **Anthropic Projects + Claude Skills directly with no orchestrator** | Tell users to use claude.ai Projects and skills natively; we only build the catalog and connector recipes. | Same lock-in problem, just to a different provider. We lose the multi-LLM routing thesis from `(resume.txt:55-56)` and the memory-layer differentiator. We also can't enforce per-user token budgets or do cost arbitrage. | Never as the primary product. We do plan to make our skills format Anthropic-compatible so users can export. |
| **Single-LLM lock-in (one provider)** | Pick Claude (or GPT) and hard-wire every call site to it. Saves an entire subsystem. | The BlackBox work demonstrated that capability-aware routing across Claude / GPT / Grok was a 1B+ tokens/month differentiator `(resume.txt:55-56)`. Outages, price changes, and capability gaps (long context vs cheap classification vs tool-use accuracy) all force a router. Locking in also kills our cost story: cheap models for cheap steps is the largest single lever on COGS. | Only if a single provider hits 95%+ of jobs at the best price/quality for 3 consecutive quarters. Unlikely. |
| **Stateless agent runtime (no memory)** | Treat every agent invocation as a fresh chat. No persisted memory, no consolidation, no recall. | A B2C agent without memory is a chat thread. The whole point of "your agent that knows you" requires persistence. Our positioning against Custom GPTs *is* memory depth. | Never; we may offer a stateless mode as a privacy SKU. |
| **Docker container sandbox for skill scripts** | One container per skill execution; cgroups + seccomp + read-only rootfs. | At 1M+ daily executions `(resume.txt:49-50)`, Docker cold-start (~hundreds of ms) destroys our latency budget for interactive turns. SOC-2 isolation is achievable but harder to argue than the WASM kernel boundary `(blackbox-experience.md points 2, 3)`. Per-execution overhead in CPU and memory is 5–10x WASM. | If users demand running arbitrary native binaries (e.g. ffmpeg, headless Chromium) we add a "heavyweight skill" tier on Firecracker, not Docker. |
| **Synchronous run API only** | Single HTTP call, block until the agent finishes, return final answer. | Agent runs are long-tailed: median 3 s, p99 over 60 s with tool calls. Holding HTTP connections at consumer scale is wasteful and breaks behind load balancers / CDNs. We need SSE/WebSocket for "thinking..." UX anyway. | Never. We do keep a sync convenience wrapper for short runs (<10 s budget) for SDK ergonomics. |
| **Single vector DB for all memory types** | One collection holds episodic + semantic + procedural + RAG document chunks. | Different memory types have different recall semantics, retention policies, and access patterns. Mixing them collapses recall quality and makes deletion / GDPR right-to-forget a nightmare (you can't selectively forget "what the user told you about themselves" without nuking RAG context). | If a future embedding model + filter language genuinely beats per-type indexes on quality and ops cost. Not on the horizon. |
| **Self-hosted Pinecone / Weaviate / Milvus** | Run a dedicated managed or self-hosted vector DB cluster. | At consumer-scale launch volumes, we already run Postgres for users / billing / catalog. Adding a second stateful system with its own ops surface, replication story, and IAM model is unnecessary tax. Pinecone managed is fine technically but ties us to one vendor's pricing curve and one region story. | We will revisit when any single tenant crosses ~50M vectors or when query latency on pgvector p99 crosses 200 ms — whichever comes first. |
| **Workflow engine: pure Temporal** | Use Temporal as the agent workflow engine; activities are LLM calls and tool calls. | Temporal is excellent for durable workflows, but it doesn't natively model the agent loop (reason → tool → observe → next-step) as a graph the way LangGraph does `(resume.txt:51-52)`. Forcing ReAct loops into Temporal activities means we re-build the graph semantics on top of it and lose LangGraph's checkpointing / branching primitives. | If LangGraph ever stops being maintained or its checkpointing model fails at our scale, Temporal is the most credible fallback. |
| **Workflow engine: AWS Step Functions** | Express each agent as a state machine in Step Functions. | Vendor lock to AWS, expensive at our event volume (per-state-transition pricing on 10K+ runs/day `(blackbox-experience.md point 11)`), poor local-dev story, and the JSON DSL is not how agent authors think. | If we ever go all-in on AWS-only deployment for a specific enterprise SKU. |
| **Workflow engine: in-house DAG from scratch** | Build our own engine, no LangGraph dependency. | We already did similar DAG-orchestration work at BlackBox `(blackbox-experience.md points 7, 8, 12)`, so the knowledge exists. But: building a workflow engine *and* an agent platform in the same 360 days dilutes both. LangGraph gets us 70% of what we need on day one. | Re-evaluate at 18 months once we know which LangGraph extensions we keep monkey-patching. |
| **Catalog as separate service** | Spin up a dedicated CatalogAPI that owns publishing, search, ratings, fork tracking. | At v0 / v1 scale the catalog is just metadata + assets attached to the same agent objects the OrchestratorAPI already owns. Splitting it doubles the auth surface and forces sync between two databases for fork lineage and version pinning. | When catalog read traffic dominates orchestrator traffic by 10x+ (i.e. browsing >> running), we split out a read-optimized CatalogAPI in front of a CQRS projection. |
| **Token-based connector model only (no MCP)** | Implement only OAuth/token-based native connectors. Ship Gmail, Slack, Notion, GitHub natively and stop. | We lose the long tail. MCP is the bet that there will be a connector standard; if it pans out, we get hundreds of integrations free `(see Section 4 bets)`. Token-only also means every new connector is engineering work. | If MCP stalls as a standard for 18 months we deprecate first-class MCP support and keep only the native connectors. |

---

## Section 2 — Big crossroads decisions

### Decision: Workflow engine

**Context.** Agent runs are non-trivial graphs: reason, choose tool, call tool, observe, branch, retry, suspend for human approval, resume hours later. At BlackBox we ran 10K+ agent runs/day on LangGraph-based ReAct + DAG orchestration `(resume.txt:51-52)`, `(blackbox-experience.md points 7, 8, 11, 12, 13)`, and we know the failure modes. The question is whether to repeat that choice for a B2C product that has to be cheap, fast on the happy path, and operable by a small team.

**Options compared:**
- **LangGraph + a custom durable layer.** Use LangGraph for graph definition + ReAct primitives, add our own checkpoint store, retry semantics, and resume API on top.
- **Temporal.** Industrial-strength durable workflow engine; we'd model agents as workflows and tool calls as activities.
- **AWS Step Functions.** Managed state machines; very durable, very expensive per-transition, very AWS-locked.
- **In-house DAG engine.** Build the whole thing. We have the experience to.
- **Inngest / Trigger.dev.** Newer durable-execution products with friendlier developer ergonomics.

**What we picked.** LangGraph + a custom durable layer.

**Why:**
- LangGraph's graph + ReAct primitives are the natural shape of agent code, and we already have institutional muscle there `(resume.txt:51-52)`.
- The custom durable layer is small (checkpoint store on Postgres, retry policy, resume API) compared to building a full workflow engine, and it gives us deterministic replay for trace-based debugging — the same pattern that cut MTTR by 60% at BlackBox `(resume.txt:58-59)`.
- We avoid vendor lock-in to AWS and we keep local-dev story tight (LangGraph runs in a single process for tests).

**Downside accepted:**
- **LangGraph maturity risk.** It's a fast-moving open-source project; we will absorb breakage on minor versions and may fork or patch.
- **In-house ops burden.** We own the durable layer end-to-end (replication, backups, the resume-from-checkpoint semantics). That's a few engineers' headspace forever.

---

### Decision: Memory store

**Context.** Memory is per-user, mostly small (hundreds to low-thousands of vectors per active user), heavily read at agent-start, and security-sensitive (cross-tenant leakage is unacceptable). We already operate Postgres for users / billing / catalog. RAG document chunks for popular catalog agents could push total vectors into the 100M–1B range over a couple of years.

**Options compared:**
- **pgvector on our existing Postgres.** Single stateful system, transactional with the rest of user data, deletion = SQL DELETE.
- **Pinecone (managed).** Best-in-class managed vector DB; pay per pod-hour.
- **Weaviate (self-hosted or managed).** Hybrid search built-in; richer schema.
- **Milvus.** Cassandra-style scale ceiling, more operationally heavy.
- **Qdrant.** Used adjacent at Microsoft `(resume.txt:101)`; good defaults.

**What we picked.** pgvector on the existing Postgres fleet, with HNSW indexes per tenant-scoped table partition.

**Why:**
- One stateful system, one auth boundary, one backup story. Reduces ops to one team for the first 18 months.
- Transactional consistency: user deletion (GDPR right-to-forget) is a transaction, not a two-phase coordination across two systems.
- pgvector's HNSW has matured and is good enough for consumer-scale recall, and BM25 + HNSW hybrid retrieval (the same pattern from BlackBox `(resume.txt:61)`) sits naturally next to text search in Postgres.

**Downside accepted:**
- **Scale ceiling around 1B vectors.** Beyond that, sharding pgvector across multiple Postgres clusters starts to hurt — query fan-out, index maintenance, vacuum windows. We have a documented migration plan to Qdrant or Pinecone once any single tenant or the global catalog index crosses the threshold, but we accept that the migration is real work.

---

### Decision: Skill sandbox

**Context.** Skills are user-written or catalog-installed scripts that execute as part of an agent run. They may be untrusted (catalog) or semi-trusted (the user's own). At BlackBox the equivalent system isolated 1M+ daily zero-shot code executions on a Golang-backed WASM sandbox plane `(resume.txt:49-50)`, `(blackbox-experience.md points 2-5)`, and that work unblocked SOC-2 compliance. We need the same shape here, sized for consumer load.

**Options compared:**
- **WASM (wasmtime / wasmer with WASI snapshot preview2).** Per-request sandbox spun up in microseconds, memory-safe by construction, no syscall surface unless we grant it.
- **Docker containers.** Familiar, native binaries, but slow cold-start and a much larger trusted attack surface.
- **Firecracker microVMs.** True microVM isolation, KVM-backed; the AWS Lambda model.
- **gVisor.** Userspace kernel intercept; mid-tier isolation, mid-tier cost.
- **No sandbox, run in a constrained Node.js VM context.** Cheap, fast, demonstrably unsafe.

**What we picked.** WASM as the primary sandbox, Firecracker as a "heavyweight skill" tier for cases needing native binaries.

**Why:**
- Cold start under 10 ms versus hundreds of ms for Docker / Firecracker — critical because we expect dozens of skill calls per agent run on the median path, and a slow sandbox destroys interactive UX.
- The SOC-2 isolation story is the cleanest with WASM: no syscalls by default, capability-based WASI gating, no shared kernel attack surface. This is the exact story that unblocked enterprise SOC-2 at BlackBox `(blackbox-experience.md point 5)`.
- Memory and CPU overhead per execution is 5–10x cheaper than container approaches, which matters at consumer scale and aggressive free-tier limits.

**Downside accepted:**
- **Language ecosystem is narrower than Docker.** Today: JavaScript, Python (via Pyodide), Rust, Go all work in WASM. C extensions, native libraries (ffmpeg, headless Chrome, OpenCV) do not, or work poorly. The Firecracker tier exists exactly to cover this gap, but it costs more per execution and is gated behind a paid plan.

---

### Decision: Model routing strategy

**Context.** We will run 3+ LLM providers from day one `(resume.txt:55-56, blackbox-experience.md points 16, 17)`. Every agent step needs a model picked for it, balancing capability (long context, tool use, structured output, multimodal), cost, latency, and reliability. The routing decision can be made by static rules or by a learned router.

**Options compared:**
- **Static capability-aware rules table.** Hand-authored decision tree: "step type X + context length Y + tool-use needed Z → model A; fallback B."
- **Learned router (small classifier).** Train a model on labelled examples of (request, best model) and use it to predict at runtime.
- **LLM-as-router.** Ask a cheap LLM to pick the model for each step.
- **Round-robin / cheapest-first.** No routing logic, just price ordering.
- **Per-agent declared preference.** Agent author hard-codes the model.

**What we picked.** Static capability-aware rules **plus** an online evaluation feedback loop that flags rule cells where the chosen model under-performs.

**Why:**
- Static rules are debuggable and auditable. When a user asks "why did my agent slow down today?" we can point at a row in a table, not a model output. This is the same operational posture that institutionalized telemetry-driven debugging at BlackBox `(resume.txt:58-59)`.
- The feedback loop closes the gap: when a rule cell shows quality regression in online evals or in user thumbs-down rates, ops can iterate on the rule. We don't need a learned router to start; we need a tight feedback loop.
- Cold-start is zero. New providers slot into the rules table immediately.

**Downside accepted:**
- **Rules table grows.** Combinatorial growth in cells (step-type x context-length x tool-need x latency-budget x cost-tier). We accept that the table will need pruning passes every quarter. The right time to swap in a learned router is when the table grows past human-maintainable (~50 cells), not before.

---

### Decision: Connector model

**Context.** Agents need to talk to the outside world: Gmail, Slack, Notion, GitHub, Drive, calendars, CRMs, the user's own APIs. The industry is converging on MCP (Model Context Protocol) but the ecosystem is uneven. We could pick one of: native-only, MCP-only, or both.

**Options compared:**
- **Native integrations only.** We write and maintain OAuth + API wrappers for each connector.
- **MCP-only.** We expose only MCP and depend on the ecosystem to provide servers.
- **Both, with native for the top 20 and MCP for the long tail.** Native quality where it matters; MCP for breadth.
- **Zapier / Pipedream as a backend.** Outsource connectors to an existing iPaaS.

**What we picked.** Both — native integrations for the top 20 connectors (Gmail, Slack, Notion, GitHub, Drive, Calendar, Linear, Jira, HubSpot, Salesforce, Zendesk, Discord, Telegram, X/Twitter, LinkedIn, Asana, Trello, Figma, Stripe, Airtable), MCP as a first-class peer for everything else and for power-user / self-hosted servers.

**Why:**
- The top 20 connectors are where 80% of user value lives; native lets us tune retry, rate-limit, OAuth refresh, scope minimization, and structured output for each. Generic MCP cannot match a hand-tuned Gmail connector for the most common Gmail flows.
- MCP as a peer means we don't bet the company on whether the standard wins. If MCP becomes the standard, we already speak it; if it doesn't, our top 20 carry the product.
- This mirrors the multi-provider pattern that worked at BlackBox `(resume.txt:55-56)` — bet on heterogeneity, never bet on one ecosystem.

**Downside accepted:**
- **Native integrations are maintenance forever.** Every API change at Google or Slack is a ticket. We budget a "connectors on-call" engineer permanently in the team plan, and we expose a public connector-status page so degradation is honest.

---

### Decision: Persona model

**Context.** Every agent has a persona. Users expect "make my agent friendly and concise" to work. Power users expect to write a system prompt. Both groups should get what they want, and we should be able to *evaluate* persona drift programmatically (does the agent still sound like itself after 50 turns?).

**Options compared:**
- **Free-form system prompt only.** A textarea; whatever the user writes is the persona.
- **Structured fields only.** Name, tone (dropdown), style (dropdown), verbosity (slider), domain knowledge tags. No raw prompt.
- **Structured fields with an extensible system-prompt section.** Both: structured fields render into a canonical block, plus a free-form section for power users.
- **Persona as a separate fine-tuned model per agent.** Heaviest option; we don't believe the cost is justified.

**What we picked.** Structured fields plus an extensible system-prompt section.

**Why:**
- Structured fields give us programmatic handles for persona drift evaluation (we can score agent outputs against the declared tone / style / verbosity using cheap LLM judges).
- The free-form section keeps power users productive without forcing everyone into a prompt textarea.
- We can A/B persona renderings: change how "tone=warm" is templated globally, measure the delta. With free-form-only, we can't.

**Downside accepted:**
- **UX is harder for power users.** Someone who wants very specific persona behavior may find the structured fields constraining and have to fight them with the free-form section. We accept this in exchange for the eval lever.

---

### Decision: Catalog moderation

**Context.** A public catalog of user-authored agents is an obvious abuse surface: prompt injection, malware-laden skills, deceptive personas, copyright violations, sexual / harmful content. We must pick a moderation model that scales to consumer publish volume without throttling the catalog.

**Options compared:**
- **Pre-publish human review.** Every agent goes through a queue.
- **Pre-publish automated scanning + selective human review on flagged.** Static analysis, embedding similarity, hashed-content checks, LLM classifier, all before publish.
- **Post-publish automated scanning + takedown on detection.** Agents publish immediately; scans run continuously and over user-report queues.
- **Pure user-report moderation.** No proactive scanning.

**What we picked.** Post-publish + continuous automated scanning + user reports + human review on flagged.

**Why:**
- Pre-publish review at consumer scale either throttles the catalog or costs more than the product makes.
- Automated scanning catches the vast majority of clear-cut abuse (malicious skill code via WASM static analysis, harmful prompts via classifier, copyright via hashed-content checks).
- The compliance posture we want — SOC-2 Type II + GDPR — does not require pre-publish review; it requires *evidence* of moderation, which we can show via scan logs.

**Downside accepted:**
- **Reactive on bad-faith uploads.** A motivated bad actor can ship an agent that goes live for minutes to hours before takedown. We mitigate by aggressive quarantining (new accounts ship with lower trust and tighter scan thresholds for 7 days) but we accept that high-profile incidents will happen and we will need an incident response playbook.

---

### Decision: Memory write triggers

**Context.** When does the agent write to long-term memory? Every turn writes too much noise and inflates cost. Writing only on explicit user request misses the value. We need a middle ground.

**Options compared:**
- **Every turn.** Every assistant turn produces an embedding + memory record.
- **Importance-scored writes.** A cheap heuristic (length, novelty, presence of declarative facts, user-corrected information) scores each turn; only above threshold gets written, plus periodic LLM-judged consolidation.
- **Explicit user request only.** "Remember this" button.
- **Tool-driven only.** The agent decides via a `remember()` tool call.

**What we picked.** Importance-scored writes with cheap heuristics, plus a periodic (e.g. every N turns or once per session-end) LLM-judged consolidation pass that summarizes and promotes short-term memory to long-term.

**Why:**
- Heuristic-first is cheap and lets us reject obvious noise (small-talk, repeated questions, tool failures).
- The LLM-judged consolidation pass catches what the heuristic misses, and amortizes its cost across many turns.
- This is the same pattern as memory compaction at BlackBox `(blackbox-experience.md point 18)` — cheap filter early, expensive judgment in batch.

**Downside accepted:**
- **Tunable hyperparameter.** Importance threshold, consolidation frequency, summarization aggressiveness all need ongoing calibration as user behavior changes. We commit to a quarterly memory-quality review with offline eval sets.

---

## Section 3 — Leadership and business framing

**Product strategy and the why.** OpenAI's GPT Store and Anthropic's Projects already exist. Building yet another "create your agent" product only makes sense if there is a defensible gap, and there is one: **open MCP standard support + connector breadth + agent portability and forking + memory persistence depth**. Each of those, alone, is a feature. Together they're a moat. A proprietary store can ship one connector at a time and call memory "uploaded files"; a multi-LLM, MCP-first, fork-friendly platform with first-class persisted memory is something none of the incumbents will ship without breaking their own product structure. We're betting that the next generation of users wants agents they *own* — that they can edit, fork, move, and export — rather than agents that live as one row in someone else's database. The principal-engineer judgment from running heterogeneous LLM orchestration at BlackBox `(resume.txt:55-56)` is that the heterogeneity wins.

**Roadmap shape.**

- **v0 — 90 days, private alpha.** Persona model + 5 native connectors (Gmail, Slack, Notion, GitHub, Drive) + memory layer (pgvector) + Claude as the single LLM provider + WASM skill sandbox behind a feature flag. Goal: end-to-end works for 100 invited users. No catalog yet.
- **v1 — 180 days, public launch.** MCP support as a first-class peer + 3 LLM providers (Claude, GPT, Grok — same set as BlackBox `(resume.txt:55-56)`) + public catalog with post-publish moderation + free tier with per-user token budgets + 15 more native connectors.
- **v2 — 360 days, monetization and enterprise.** Creator monetization (rev share on agent installs/runs) + per-tenant dedicated runtime tier for power users / small teams + GDPR-EU region active + SOC-2 Type II audit completed. The Type II window is roughly 6 months of observation, so we start the SOC-2 evidence collection in v1.

**Team and execution.** Building this is approximately **8 engineers** split across: (1) Orchestrator runtime / workflow engine, (2) Memory and RAG, (3) Native connectors and MCP, (4) Skill sandbox (WASM + Firecracker tier), (5) Model router and capability eval, (6) LLMOps telemetry, (7) Frontend, (8) Platform / billing / catalog. This is the same shape and headcount as the agentic platform I led at BlackBox `(resume.txt:51, blackbox-experience.md point 6)` — six engineers carried the agentic platform; we add frontend and a dedicated catalog/billing engineer for the consumer surface. Hiring posture mirrors the Microsoft ML platform hiring model `(microsoft-experience.md point 16)`: senior IC bias, secure protocol design literacy as a baseline for the runtime, sandbox, and connector hires.

**Cost discipline.** LLM provider spend is the dominant cost line, period — at 1B+ tokens/month scale `(resume.txt:55-56)` the second-largest line (compute, storage, network combined) is an order of magnitude smaller. Four strategies stack:

- **Capability-aware routing** pushes cheap models for simple steps (classification, routing, function-name selection) and reserves expensive models for hard reasoning. This is the lever that worked at BlackBox.
- **Memory compaction** reduces token spend on long-running agents — without it, every turn re-pays for the whole session history.
- **Cache hits on common retrievals** in RAG (and on common prompt prefixes via prompt caching where the provider supports it) cuts effective tokens-per-turn.
- **Per-user token budgets with visible UX** prevents the worst case: a user accidentally writing an agent that calls itself in a loop and discovering it on a bill. The budget is a UX feature *and* a cost cap.

**Compliance posture.** Targeting **SOC-2 Type II within 12 months** and **GDPR from day one**. The unusual call for a B2C startup is to pull compliance earlier than typical — most consumer products defer SOC-2 until enterprise sales force it. Our reasoning: this product exposes us to enterprise data through the back door, because an employee can connect their work Gmail or work Slack to a personal agent. The blast radius of an incident is enterprise-grade even when the customer is consumer-grade. This is the same threat-model discipline that drove secure-by-design at Microsoft `(microsoft-experience.md point 18)` and that built the WASM-isolation story at BlackBox `(blackbox-experience.md points 5, 7)` — both required treating "the next tier of customer" as already present, and engineering for them.

**Stakeholder alignment.** The principal engineer for this platform is responsible for landing decisions across at least four organizations: **runtime** (where do we burn engineering time?), **security** (what compliance commitments can we make and keep?), **growth** (what does the catalog UX surface to the user?), and **finance** (what is COGS per agent run, per user, per month, and how does it bend?). This is the same cross-org architecture-review posture that I ran 30+ times at Microsoft Azure ML for AutoML and Fine-tuning `(microsoft-experience.md points 12, 19)`. The principal-engineer job is not to pick the right answer alone; it is to make the tradeoffs in this document legible to all four groups and to land decisions they can defend back to their own leadership.

---

## Section 4 — Risks and bets

We are explicitly making the following bets. Each bet has a stated invalidator — the observation that would force us to change strategy.

- **Bet:** MCP becomes a meaningful ecosystem standard within 18 months. We treat it as a first-class peer to native connectors from v1.
  **Invalidator:** MCP server counts stay below 100, no major SaaS vendor ships official MCP support, and our usage data shows <5% of agent tool calls go through MCP after 12 months of GA.
  **Response if invalidated:** Deprecate MCP from the connector hierarchy and lean into native + a connector SDK.

- **Bet:** Memory persistence is a real consumer differentiator. Users will choose our product over Custom GPTs because their agent remembers them across sessions.
  **Invalidator:** A/B tests show no engagement or retention lift from memory features versus a stateless mode. Users mostly want ephemeral chat with strong tools.
  **Response if invalidated:** Reposition memory as a power-user / paid-tier feature and de-emphasize it in onboarding.

- **Bet:** Skill scriptability appeals beyond power users. Median users will install and run skills from the catalog; some will fork and edit.
  **Invalidator:** 95% of catalog skills are template-installed without edit, the long tail of community-authored skills is empty, and skill-fork events make up <1% of catalog interactions.
  **Response if invalidated:** Reduce skill-sandbox investment (the WASM plane stays for security but we stop investing in the skill-authoring UX), and pour that engineering into native connector breadth and persona quality instead.

- **Bet:** Provider price compression continues. The cost per token on equivalent capability halves roughly every 12–18 months, and that helps our unit economics enough to fund a generous free tier.
  **Invalidator:** Provider prices flatten or rise for 18 months, and our token-cost-per-active-user does not decrease.
  **Response if invalidated:** Tighten free-tier limits, push routing harder toward cheap models, accept higher friction at sign-up, or move some free-tier traffic to a self-hosted open-weights backend (this is the contingency that makes the multi-provider router worth its complexity even if the prices don't compress).

---

*End of 09-tradeoffs-and-alternatives.md.*
