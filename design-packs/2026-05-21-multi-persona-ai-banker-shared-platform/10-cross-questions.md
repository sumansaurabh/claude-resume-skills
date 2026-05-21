# Cross-Examination — Multi-Persona AI Banker on Shared Platform

This is the pressure-test pass: 25 questions a sharp interviewer (or staff/principal engineer panel) will throw at the design, why they ask them, the strongest defensible answer, and the one trap to avoid. Anchor where possible to BlackBox, Microsoft, and the resume; otherwise label as assumption.

---

## Architecture pushback

### 1. Why not three independent agents — it would be cleaner per persona, easier to ship?

**Why they're asking.** They want to see if you understand the TCO of multi-product platforms and whether you're hiding behind the word "shared" without justification.

**Best answer.** Three independent agents triples ops cost, triples the telemetry surface (three OTel pipelines, three Langfuse projects, three eval harnesses), and fragments the compliance posture so RBI now audits three control planes. The persona-specific logic is roughly 15% of the system — prompts, tool allow-lists, calc profiles, HITL thresholds — and that 15% belongs in a persona policy bundle, not in three forks of an orchestrator. At BlackBox we ran 10K+ agent runs/day on a single LangGraph runtime with durable execution (resume.txt:51-54); branching that into three runtimes per workload class would have killed our replay determinism and our 60% MTTR cut (resume.txt:58-59). What we keep separated is the data plane — per-tenant memory namespaces, per-persona context shapers, per-persona prompt templates — not the orchestration substrate.

**Trap to avoid.** Saying "for code reuse" — that's a junior-engineer answer. Lead with operational surface, compliance, and shared learning, not DRY.

---

### 2. Why LangGraph and not Temporal / Cadence for durable execution?

**Why they're asking.** They're checking that you've thought about workflow engines vs LLM-native orchestrators and didn't just default to LangGraph because it's trendy.

**Best answer.** Temporal solves general-purpose long-running workflows; LangGraph solves LLM-shaped graphs where every node is "call a model, possibly with tools, possibly with conditional edges based on parsed output." We use LangGraph because the graph nodes are LLM-or-tool nodes, edges encode reAct/router-style branching natively, and checkpointing is integrated with the conversational state — not bolted on. Underneath LangGraph we still need a durable store; we use Postgres as the checkpointer for graph state and Redis Streams for the event bus, which is the same shape we ran at BlackBox for 10K+ runs/day (resume.txt:51-54). Temporal would force us to wrap every LLM call in an activity and rebuild the prompt+state plumbing — that's a rewrite, not a substrate. If we ever outgrow LangGraph's scheduler we'd put Temporal underneath it, not instead of it.

**Trap to avoid.** Don't dismiss Temporal — concede it's the right answer for non-LLM workflows like payments or KYC orchestration, which we explicitly call out as out-of-scope in this design.

---

### 3. Why a shared orchestrator when SME and CFO workflows are wildly different?

**Why they're asking.** They want to see whether your "shared" pitch survives contact with the diverging workflows.

**Best answer.** The workflows differ in *content*, not in *shape*. Every persona's graph is: ingest event → load persona policy → load memory → reason → call tool(s) → calc-or-not → confidence-score → route to HITL or auto-execute → notify → write audit. Retail's tools are P2P transfer and bill nudge; CFO's tools are runway projector and scenario simulator. Both call into the same Tool Router, the same WASM sandbox (resume.txt:49-50), the same Calc Service. The supervisor node in LangGraph just selects which specialist subgraph to enter; the specialist subgraphs are 80% inherited topology and 20% persona-specific nodes. This is the same pattern as Microsoft AutoML which served Vision, NLP, and Forecasting from one orchestrator handling 15M+ jobs/month (resume.txt:91-92) — different content, identical machinery.

**Trap to avoid.** Don't claim the workflows are "basically the same" — they're not. Claim that the *graph topology and infrastructure* are shared while persona-specific *content* lives in versioned policy bundles.

---

### 4. Where does the persona boundary actually live — at the orchestrator or earlier?

**Why they're asking.** They're checking the cleanliness of your mental model.

**Best answer.** The boundary lives at the edge gateway: a persona resolver runs *before* the orchestrator, attached to the JWT/tenant claim. It produces a `PersonaContext{tenant_id, persona, policy_bundle_version, tool_allowlist, hitl_thresholds}` that travels with the request as immutable context. The orchestrator never recomputes persona; it consumes it. This matters because (a) we want persona switches to be auditable (a Retail customer cannot ever silently become an SME), (b) we want eval harnesses to be able to fix persona without faking JWTs, and (c) we want regulators to be able to point to a single resolution moment. If the orchestrator did persona resolution, every node would have to defensively re-check, which is exactly the kind of diffuse trust boundary that fails SOC-2 like we hardened against at BlackBox (resume.txt:49-50).

**Trap to avoid.** Don't say "the LLM figures out the persona from the conversation" — that's a hijack vector.

---

### 5. Why not let the LLM do the routing instead of a Tool Router?

**Why they're asking.** They want to see if you understand the cost-and-blast-radius math of LLM-as-router.

**Best answer.** LLM-as-router works fine until it's wrong, and "wrong" here means routing a Retail customer's bill-pay request to the CFO scenario simulator and burning a 30k-token reasoning chain before failing. The Tool Router is a deterministic capability map keyed by `(persona, intent, risk_tier)` that returns a tool handle in <5ms; the LLM proposes the intent, the router enforces it. This also lets the policy engine veto a tool call before any execution — at BlackBox the model router pattern with capability-aware routing across Claude/GPT/Grok was what kept 1B+ tokens/month from being spent reasoning about tools the caller didn't have access to (resume.txt:55-56). LLMs still pick *which* tool; routers enforce *whether* and *how*.

**Trap to avoid.** Don't frame it as "LLMs can't route" — they can. Frame it as separation of proposing vs enforcing.

---

## Deterministic vs probabilistic boundary

### 6. Modern LLMs can do arithmetic if you give them a Python code interpreter — why not skip the Calc Service?

**Why they're asking.** They want to see whether you can defend determinism in the era of code-interpreter LLMs.

**Best answer.** Code interpreter solves arithmetic, but it doesn't solve auditability, reproducibility, or domain rules. The Calc Service is a versioned, unit-tested library where "runway months" or "DSCR" has exactly one implementation, signed off by Finance, and reproducible from a recorded input. A Python-in-LLM run is opaque, non-deterministic in floating point (different libc, different numpy versions), and the LLM might silently choose `mean` when policy says `weighted_median`. We also need every advisory number to be queryable by audit: "show me every CFO advisory where projected_runway_months < 3 was emitted, grouped by calc-service version" — that's a SQL query against `calc_invocations`, not a regex over LLM transcripts. The WASM sandbox we built at BlackBox (resume.txt:49-50) is great for *user-defined* code; bank-grade math is the opposite — closed, versioned, deterministic.

**Trap to avoid.** Don't say "LLMs can't do math" — that's outdated. Say bank math is regulated math, and regulated math wants versioning and proofs.

---

### 7. How do you stop the LLM from making up numbers when summarizing calc output?

**Why they're asking.** This is the hallucination-with-numbers problem and it's the failure mode regulators care about most.

**Best answer.** Three layers. (1) The calc output is passed in a structured envelope `CalcResult{id, value, unit, confidence, calc_version}` and the prompt template explicitly forbids paraphrasing the numeric value — only echoing. (2) A post-LLM numeric-fidelity guardrail runs a regex+parse pass over the LLM output, extracts every number, and verifies each is present verbatim (within unit conversion) in the source `CalcResult`s. Any mismatch downgrades confidence to "blocked" and routes to HITL. (3) Audit log records both the calc result and the LLM-rendered text side-by-side in the `agent_audit` table, so a reviewer can spot drift retroactively. The numeric-fidelity guardrail is the same pattern we used at BlackBox to catch JSON-schema drift before it reached customers, which contributed to the 60% MTTR cut (resume.txt:58-59).

**Trap to avoid.** Don't claim "we prompt the LLM not to hallucinate" — interviewers know that's a vibe, not a control.

---

### 8. Where does the boundary blur — e.g., "estimate runway given uncertainty in collections" — is that math or LLM?

**Why they're asking.** They're probing for over-confident dogma.

**Best answer.** Both, in two stages. The Calc Service runs a Monte Carlo over a `CollectionsDistribution{p10, p50, p90, ...}` and emits a `RunwayDistribution` — that is deterministic given the same RNG seed and version. The LLM then takes that distribution and writes the *narrative* — "you have an 80% chance of staying above 2 months runway through Q3" — which is interpretation, not math. The seam is: structured numeric output crosses the boundary, and the LLM is forbidden to introduce *new* numbers. If the user asks "what if collections drop another 20%?", that's a new calc invocation, not the LLM extrapolating. This is the same pattern as Microsoft AutoML — the search algorithm decides hyperparameters deterministically, and a generated explanation describes the choice (resume.txt:91-92).

**Trap to avoid.** Don't pretend the boundary is perfectly clean — admit the seam and show you've engineered it.

---

## Memory and context

### 9. With 4 memory tiers, retrieval latency multiplies — how do you keep p99 under budget?

**Why they're asking.** They want to see actual numbers and a parallelism plan, not architecture-handwave.

**Best answer.** The four tiers (session, episodic, semantic, persona profile) are queried in parallel from the Context Manager node — a single fan-out with a hard wall-clock budget of 120ms p99. Each tier has its own SLO: session (Redis, <5ms), episodic (Postgres + recent index, <40ms), semantic (Qdrant HNSW, <80ms), persona profile (cached in Redis with 60s TTL, <2ms). The Context Manager is timeout-tolerant: if semantic memory misses its budget we proceed with the other three tiers and log a `partial_context=true` flag on the run. Total p99 stays under 150ms because we're bounded by the slowest of four parallel calls, not the sum. This is the same fan-out-with-timeout pattern from BlackBox's LLMOps mesh, which ingested 50M spans/day under tight latency budgets (resume.txt:58-59).

**Trap to avoid.** Don't say "we use a cache" without naming what's in it and what the TTL is.

---

### 10. Cross-persona memory — an SME owner is also a Retail customer. How do you avoid privacy bleed?

**Why they're asking.** This is the killer multi-tenant question; the regulator-facing answer.

**Best answer.** Memory is namespaced by `(tenant_id, persona, subject_id)`, never by `subject_id` alone. The same human acting as a Retail customer and an SME promoter has two completely disjoint memory namespaces — `memory:retail:user_42` and `memory:sme:org_7:promoter_42` — and the Context Manager refuses to cross-join them at query time. The persona resolver at the gateway (see Q4) is the single moment we know which namespace is in scope. Cross-persona linking, if ever needed, goes through an explicit consent flow with an audit row in `consent_grants`, and even then it's surfaced only as a flag to the LLM, never as raw memories. We borrowed this multi-tenant isolation discipline from Microsoft's secure multi-tenant ML infrastructure where we enforced tenant boundaries at scheduling, storage, and network layers (resume.txt:88-89).

**Trap to avoid.** Don't say "row-level security in Postgres" alone — that's necessary but not sufficient. The namespace boundary must exist in the query API too.

---

### 11. What stops a poisoned memory entry from hijacking the agent on retrieval?

**Why they're asking.** Indirect prompt injection via memory is a known attack and they want to see if you've thought about it.

**Best answer.** Memory entries are written as structured records, not free text — `{kind, subject, value, source_event_id, provenance, created_at}` — and the prompt template renders them through a typed renderer that strips/escapes control sequences and never inlines raw user input as instructions. We also tag each entry with a `provenance` score (high for system-generated, medium for confirmed user statements, low for inferred); low-provenance entries are rendered with a "user-claimed, unverified" wrapper. At retrieval time a guardrail scans for instruction-like patterns ("ignore previous", "you are now", role-name attempts) and quarantines the entry into `memory_quarantine` for review. This is the same input-sanitization discipline that backed BlackBox's WASM sandbox guarantees (resume.txt:49-50) — assume every input is hostile, then prove it isn't.

**Trap to avoid.** Don't say "we trust our memory store" — that's the attack.

---

### 12. How is the context window budget allocated across persona profile + retrieved memories + tool outputs + system prompt?

**Why they're asking.** They want to see whether you treat context as a budget with policy, not a free-for-all.

**Best answer.** We treat context as a four-segment budget enforced by the Context Manager before the LLM call: system+persona policy (~20%), persona profile + recent session (~20%), retrieved semantic memories (~30%), tool outputs (~30%). Each segment has a hard cap in tokens; the segment-specific summarizer compresses overflow into bullet form rather than truncating mid-sentence. Tool outputs are the most likely to blow the budget (think a calc result with 200 line items), so they're chunked and we feed the LLM a header + a `tool_output_id` it can request expansion on via a follow-up tool call. This is the context-optimization discipline we ran at BlackBox at 1B+ tokens/month — without budgets you don't ship at scale (resume.txt:55-56).

**Trap to avoid.** Don't say "we use a long-context model" — the budget question is about behavior, not capacity.

---

## HITL and policy

### 13. How do you keep the HITL approval loop from becoming the bottleneck for SME and CFO at scale?

**Why they're asking.** They're testing whether HITL is your scaling cliff.

**Best answer.** Risk tiering. Low-risk actions (read-only, advisory, sub-threshold transactions) auto-execute with confidence ≥ 0.85 and post-hoc sampling for QA. Medium-risk (parameter changes, small transfers) go to a single approver queue per tenant with a 5-minute SLO. High-risk (large transfers, scenario commits) require an approver chain and we explicitly tell the user "this will take a human review, here's the queue position." We size the queue with a `hitl_queue` table partitioned by risk-tier and ops staffing modeled per-tenant. The 80/15/5 split (auto/queued/chain) keeps the human path from ever being the bottleneck for the bulk of actions. This is risk-stratified routing, the same shape as Microsoft AutoML where 15M+ jobs/month flowed through tiered scheduler queues without humans in the hot path (resume.txt:91-92).

**Trap to avoid.** Don't say "we hire more reviewers" — interviewers hate non-engineering answers to scaling questions.

---

### 14. How does the policy engine learn — or does it always need a human to update rules?

**Why they're asking.** They want to know if you've thought about policy evolution.

**Best answer.** Policies are declarative bundles versioned in git, deployed via a control-plane API to the policy engine (think OPA-shaped). They're not learned by the agent — that would be an audit nightmare. What *is* automated is *suggestion*: a nightly job over `agent_audit` and `hitl_decisions` finds patterns (e.g., "approver overrode the model 92% of the time when X+Y") and files a policy-change PR with the evidence link. A human reviews and merges. This keeps the audit trail intact: every policy decision is traceable to a signed-off bundle version. Microsoft compliance work taught me to never let policy evolve implicitly — the threat-modeling discipline we standardized there (resume.txt:93-94) is the same principle here.

**Trap to avoid.** Don't say "the agent updates its own policies" — that's the worst possible answer in a banking context.

---

### 15. Walk me through what happens if the approver is unavailable for 24 hours.

**Why they're asking.** They're probing the failure-mode of HITL specifically.

**Best answer.** Each HITL queue has an SLO and an escalation ladder defined per tenant: T+5min escalate to backup approver, T+1hr page on-call ops, T+4hr auto-decline the action with a customer notification, T+24hr trigger a tenant-level incident review. The `hitl_queue` table has `enqueued_at`, `slo_breach_at`, `escalation_state` columns and a sweeper job runs every minute. Customers are notified at each escalation step so silence is never a state. For CFO-tier tenants we explicitly require a primary+backup approver pair at onboarding, and the system refuses to admit a tenant without one. This SLO-with-sweeper pattern is what we used at BlackBox to keep durable execution honest at 10K+ runs/day (resume.txt:51-54) — no work item should silently age out.

**Trap to avoid.** Don't say "the action just waits" — interviewers will dig until you fail.

---

## Model router and provider risk

### 16. What happens when Anthropic, OpenAI, and xAI all have outages simultaneously?

**Why they're asking.** They want to see if you have a real degradation plan, not just a fallback list.

**Best answer.** Three layers of degradation. (1) The model router has health checks per provider and a circuit-breaker that drains in <30s on error-budget burn; we route to whichever provider is healthy with capability-aware fallback (Claude→GPT→Grok in order of capability match, not preference). (2) If all three are down, we switch to a self-hosted small model (Llama-class) for *retrieval-only* personas — Retail FAQ-style — and explicitly disable high-stakes personas (SME, CFO) with a banner "advanced advisory temporarily paused." (3) Read-only paths (balance, transactions, advisory replay) stay up because they don't need any LLM. The point is that LLM unavailability degrades the *agent surface*, not the *bank surface*. We ran this exact router pattern at BlackBox at 1B+ tokens/month across three providers (resume.txt:55-56) and the circuit-breaker plus self-hosted fallback was the safety net.

**Trap to avoid.** Don't say "we fail over to another provider" without admitting capability differences.

---

### 17. How do you ensure consistent persona tone across heterogeneous model backends?

**Why they're asking.** They've used Claude vs GPT and know the tonal divergence is real.

**Best answer.** Persona tone is owned by the persona policy bundle, not the model. The bundle includes (a) a tone style guide, (b) few-shot exemplars per persona, and (c) a model-specific system prompt header tuned per backend. A tone-eval harness runs nightly against a fixed set of persona prompts and scores tone-conformance per backend; backends that drift get either a prompt-template revision or a router weight reduction. We don't pretend the tones are *identical* across backends — we set a "tonal envelope" and reject backend outputs that fall outside it via a final guardrail pass. The model router at BlackBox treated this as a first-class concern with capability-aware routing tuned for behavior consistency across heterogeneous LLMs (resume.txt:55-56).

**Trap to avoid.** Don't claim tone is identical — claim it's bounded and measured.

---

### 18. Token spend at 100B+/month — what's your concrete plan to keep cost flat?

**Why they're asking.** They want a CFO-grade cost answer.

**Best answer.** Four levers, ranked by impact. (1) Aggressive prompt caching with provider-side reusable prefixes — system+persona policy chunk doesn't change per request, that's a 60-70% cache hit ratio in steady state. (2) Tiered model selection — route Retail intent classification to a small/cheap model, CFO scenario reasoning to a frontier model. The router decides per-step, not per-conversation. (3) Context budget enforcement (Q12) prevents context-window inflation, which is where token costs hide. (4) A per-tenant `token_budget_daily` quota with a soft cap (degrade verbosity) and hard cap (deny non-essential requests). At BlackBox 1B+ tokens/month (resume.txt:55-56) became affordable specifically because the router did tiered selection — it's the single highest-leverage cost control.

**Trap to avoid.** Don't say "we'll negotiate with the providers" — that's a procurement answer, not an engineering one.

---

## Failure and observability

### 19. Walk me through debugging an anomalous CFO advisory that ended up wrong — what do you actually look at?

**Why they're asking. **They want to see your debug muscle in production AI systems.

**Best answer.** Start with the `run_id` (returned to the user and stored in audit). In Langfuse-style trace UI I'd pull the full span tree: persona resolution → context retrieval (which memories were pulled, scores) → LLM call (model, temperature, system prompt version, full prompt) → tool calls (calc service version + inputs + outputs) → guardrail decisions → notification. Then I'd kick a deterministic replay against the captured span — same inputs, same prompts, same calc version — and see if the bug reproduces. If yes, it's a logic bug in calc or prompt; if no, it's a model nondeterminism issue and we adjust temperature/sampling for that persona+intent. This is the exact replay pattern that cut MTTR by 60% at BlackBox across 50M spans/day (resume.txt:58-59). The `agent_audit` table joined with the `calc_invocations` table gives me a single-query answer to "did the LLM lie or did the calc lie?"

**Trap to avoid.** Don't say "we look at logs" — name the table and the span structure.

---

### 20. How do you detect a notification fatigue regression before it shows up in user churn?

**Why they're asking. **They want to see if you have leading indicators, not lagging ones.

**Best answer.** Three leading indicators tracked per-persona in a `notification_metrics` rollup: (1) notifications-per-active-user-per-day, with a per-persona ceiling (Retail: 1.5, SME: 3, CFO: 5); (2) open-and-act rate — the ratio of notifications opened to those resulting in a user action within 24h; (3) explicit "not helpful" feedback rate. We trigger an automated rollback of any notification policy bundle that pushes any of these out of band for >24h, gated by a regression test on a held-out cohort. Each notification carries a `policy_version` tag so we can attribute regressions. This kind of leading-indicator discipline is what made BlackBox's telemetry mesh actionable, not just a span dump (resume.txt:58-59).

**Trap to avoid.** Don't say "we A/B test" without explaining the rollback mechanism.

---

### 21. What's the worst-case data loss scenario for an in-flight agent run during a region failover?

**Why they're asking.** They want to see if you've thought about durable execution under failure.

**Best answer.** Worst case is: the LangGraph checkpointer (Postgres) commits node N, the agent crashes before emitting the notification for node N. On region failover, the standby Postgres has node N's state, the supervisor resumes from the checkpoint, and we re-execute node N+1 (notification emission). The notification consumer is idempotent on `run_id+node_id`, so the customer sees one notification, not two. Tool calls are wrapped in a per-tool idempotency key so re-execution doesn't double-charge a transfer. The cost is a few seconds of latency on failover — never a lost run, never a duplicate transfer. This is exactly the durable-execution pattern from BlackBox's LangGraph at 10K+ runs/day (resume.txt:51-54): checkpoint-and-resume, idempotent side effects, deduplication keys.

**Trap to avoid.** Don't say "we replay from logs" — interviewers will ask "what if the side effect already happened?" Idempotency keys are the answer.

---

## Scale and rollout

### 22. You say Retail-first. What's the exit criteria from Retail before you let SME in?

**Why they're asking.** They want to see crisp release gates.

**Best answer.** Six specific gates, every one of them measured: (1) Retail p99 latency under budget for 4 consecutive weeks; (2) hallucination-on-numbers rate <0.05% on the audit sample; (3) HITL approval rate stable, with median time-to-decision <5min for medium-risk; (4) zero P0 incidents for 30 days; (5) at least one regulator-style audit drill executed and passed; (6) cost-per-active-user trending flat or down. Only when all six green do we admit one SME pilot tenant, then ramp. Each gate ties to a dashboard query, not a vibe. The discipline of staged rollout with measurable gates is what we did at Microsoft AutoML to go from internal preview to 200K+ users (resume.txt:91-92) — never ship to the next ring without the gates.

**Trap to avoid.** Don't say "when it feels stable" — give numbers.

---

### 23. At 30M MAU, what's your new bottleneck — be specific.

**Why they're asking.** They want to see if you can predict your own next failure.

**Best answer.** Three candidates and the data I'd track to confirm. (1) Vector store retrieval latency — Qdrant HNSW at billions of vectors becomes the long tail; we'd shard by tenant earlier than expected and consider tiered embeddings (cheap encoder for hot, expensive for cold). (2) Postgres checkpoint write throughput on the LangGraph store — at 30M MAU and event-driven proactivity, that's potentially 100k+ checkpoint writes/sec. We'd partition the checkpointer by `tenant_id` and consider shifting to a log-structured store. (3) LLM provider rate limits — even at 1B+ tokens/month (resume.txt:55-56) we were near provider ceilings; 30M MAU pushes us into multi-region multi-account routing. The bottleneck I'd *bet* on is checkpoint writes, because event-driven proactive personas amplify writes far more than reads.

**Trap to avoid.** Don't say "we'll scale horizontally" — name the actual service that breaks.

---

### 24. How do you handle the very first power-user CFO tenant — what's special about their onboarding?

**Why they're asking.** They're checking your customer-zero discipline.

**Best answer.** Customer-zero gets a dedicated cell — isolated Postgres schema, isolated Qdrant collection, isolated LangGraph runtime — and a per-tenant feature flag namespace. Their HITL queue has dedicated reviewers, their model router has a pinned model version (not the floating "latest"), and we instrument the entire stack with extra-verbose tracing for 30 days. We also build a per-tenant eval set from their actual workflows, gated by their consent, so we can regression-test before any deployment hits their cell. This is the "first ring" discipline from Microsoft AutoML where the earliest enterprise customers got bespoke isolated environments (resume.txt:88-89). After 30 days of clean operation we collapse them into the shared cell, keeping the per-tenant eval set as a CI gate.

**Trap to avoid.** Don't say "we treat them like any other tenant" — the answer is the opposite.

---

## Compliance and regulator

### 25. How do you defend this architecture to RBI when they ask "where exactly is the AI making decisions about money?"

**Why they're asking.** This is the question. If you can't answer this you can't deploy in India.

**Best answer.** The AI never decides — it proposes. The architecture has three hard properties I can show on a single slide. (1) Every money-moving action passes through the deterministic Calc Service and Policy Engine; the LLM only generates a structured proposal which is *enforced* by deterministic gates. (2) Every above-threshold action requires HITL approval recorded in `hitl_decisions` with the human's identity, timestamp, and the model output they approved. (3) Every action emits an `agent_audit` row joinable to the LLM trace and the calc invocation, retained for the regulatory retention window. So the regulator's answer is: "The AI generates suggestions; the bank's deterministic systems and human approvers make the decisions, and we have one queryable audit table that proves it for any given transaction." This is exactly the SOC-2 control posture we built at BlackBox around the WASM sandbox (resume.txt:49-50) — sandbox the probabilistic component, expose deterministic seams to auditors.

**Trap to avoid.** Don't say "the LLM is constrained by guardrails" — guardrails are probabilistic too. The defensible answer is "the LLM doesn't sit on the money path; deterministic gates do."

---

## Surviving objections to escalate later

Three objections that even the best answers don't fully resolve and that an honest interviewer will probably keep pushing:

- The persona policy bundle, while versioned, is still authored by humans and is the soft underbelly of "the AI didn't decide" — a bad policy bundle is effectively the AI deciding by proxy. We mitigate with PR review, staging environments, and replayable eval sets, but it's a real risk.
- The numeric-fidelity guardrail catches outright fabrication but not subtle paraphrase ("approximately $5,000" when calc said $4,872) — we currently downgrade those to HITL but the rule set is incomplete.
- Cross-persona memory namespaces protect privacy at the storage layer, but a sufficiently determined LLM can still leak via implicit context (e.g., tone, knowledge of common facts). We have no quantitative bound on this — only empirical eval. Worth flagging in a follow-up design pack.
