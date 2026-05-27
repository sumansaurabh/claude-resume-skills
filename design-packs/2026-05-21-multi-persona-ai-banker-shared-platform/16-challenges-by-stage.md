# 16 - Stage-Scoped Engineering Challenges

> **Methodology.** This file is a chain-of-thought enumeration of the pain this platform will inflict on the team that builds and runs it, organized by lifecycle stage. We walk **Build → Launch → Scale → Operate → Evolve**, four-to-five challenges per stage, each rated on **S/F/D** (Severity, Frequency, Difficulty A–F). We end with a Top-10 leaderboard scored as `S*3 + F*2 + D` (A=4, B=3, C=2, D=1, F=0). The exercise is deliberately pessimistic - we want a list of the places this platform will hurt *before* it hurts, so the team knows which corners deserve extra rigor on day one rather than discovering them at 3am on day 400. Every challenge is grounded in concrete components from `03-architecture.md`, `12-agentic-graph-structure.md`, `13-memory-layer-design.md`, `14-ingestion-pipeline.md`, and `15-guardrails.md` - generic "scale your cache" advice does not appear here.

---

## Stage 1 - Build

The platform has no users yet, but the architectural commitments made here are the ones that compound for the next three years. The challenges are not "shipping the code"; they are **defending the load-bearing invariants** - the deterministic boundary, persona-as-parameter, HITL-as-control-plane - against the daily pressure of "can't we just have the LLM do it" shortcuts.

### B1. Holding the Deterministic Boundary Under PM Pressure

**What it is.** The `CalcInvoker` node and the Calculation Service are a hard wall: the LLM never produces a number that appears in a user response (`03-architecture.md` §7). The first time a PM asks "can the agent just say 'about 7 weeks of runway'?", the boundary is under attack - because letting the LLM say "about 7 weeks" is one prompt-injection away from "about 70 weeks" with no audit trail.

**Why it bites in this system specifically.** Every Specialist subagent (`CashflowForecaster`, `PayrollReadinessAgent`, `TreasuryAdvisor`) has a ToolCaller and a CalcInvoker side-by-side. The temptation to skip CalcInvoker and let the LLM "estimate" is constant - especially when the Calc Service hop adds 30–50ms. The post-validation rule (any numeric in the assistant draft that does not trace back to a `calc_results` entry triggers a regeneration) has to be wired in CI on day one, not later.

| S | F | D |
|---|---|---|
| A | B | C |

**Mitigation sketch.** Land the numeric-grounding linter in CI before any Specialist ships - it parses the assistant draft for digit sequences, currency symbols, and percentage signs and asserts every match has a matching `calc_results[*].output` entry with the same value. Make the CalcInvoker contract pure-function, idempotent, schema-validated, sub-50ms p95 (same discipline as the AutoML state machine at 15M+ jobs/month, `resume.txt:91-92`). Document the rule as a Principal-level architectural law in `CLAUDE.md` and make rule violations a release-blocker, not a code-review nit.

---

### B2. Persona-as-Parameter Without It Becoming Persona-as-Fork

**What it is.** The pack's strongest claim is that persona is metadata, not a code branch (`01-executive-summary.md`, `03-architecture.md` §6). In practice, the first SME-only feature will land with a sneaky `if persona == "SME"` somewhere in a Specialist, and within six months the orchestrator will have eight of them.

**Why it bites in this system specifically.** The graph itself is *compiled per persona* (`12-agentic-graph-structure.md` §2) - a Retail compile literally does not contain an edge to `PayrollReadinessAgent`. But the Specialists themselves are shared code. The pressure point is the Specialist body, the Critic rule set, and the Tool Router allow-list. A creeping `if` ladder turns the graph-layer RBAC story into theatre.

| S | F | D |
|---|---|---|
| B | A | B |

**Mitigation sketch.** Enforce a lint rule that bans `persona ==` / `persona in {...}` outside three explicit chokepoints: the graph compiler, the Tool Router allow-list, and the OPA policy bundle. All persona-conditional behavior must be expressed as **registered persona profiles** (tone, default time horizon, allowed_tools, risk thresholds) loaded by the `ContextManager`. Add a graph-compile diff test in CI that asserts only the registered injection points differ across persona compiles - any other source diff fails the build.

---

### B3. Memory Schema and Tenant Isolation From the First Migration

**What it is.** The four-tier memory layer (`13-memory-layer-design.md`) - Redis session, Postgres long-term with pgvector, ClickHouse warm + S3 cold, Neo4j org graph - has tenant isolation enforced at four different stores via four different mechanisms (Redis ACL + key prefix, Postgres RLS, ClickHouse projection filter, Neo4j per-tenant subgraph). Get the schema wrong at migration #1 and the cleanup cost is multiplied across all four stores.

**Why it bites in this system specifically.** Cross-tenant memory leakage in a banking agent is not a P1 bug - it is a regulator-notifiable incident under DPDP and RBI. The schema has to bake `tenant_id` into every primary key, every Redis namespace, every Neo4j subgraph root, and the RLS policy has to be enforced as a default-deny `FORCE ROW LEVEL SECURITY` (not the easy-to-bypass non-FORCE variant). Most teams discover the FORCE distinction only after a near-miss.

| S | F | D |
|---|---|---|
| A | C | A |

**Mitigation sketch.** Write the tenant-isolation harness *first*: a pytest fixture that opens two tenant sessions and asserts every read from tenant A returns zero rows for tenant B across all four stores. Use `FORCE ROW LEVEL SECURITY` on every Postgres table (not just `ENABLE`). Lock the Redis namespace to `tenant:{tid}:persona:{persona}:*` and reject any key that does not match in a Redis Lua script wrapper. Bake the Neo4j tenant-root-node check into the driver - every Cypher query must traverse from `(:Tenant {id: $tid})` or be rejected. Borrow the Microsoft secure-multi-tenant ML discipline (`resume.txt:88-94`) that survived 200K+ users.

---

### B4. HITL State Machine That Survives Pod Loss and Days-Long Pauses

**What it is.** The `HITLGate` node interrupts the run, persists state, emits `approval.requested.v1`, and resumes when an approval token arrives - which may be hours later for SME or *days* for a CFO's multi-approver chain (`12-agentic-graph-structure.md` §2.4; `03-architecture.md` §4.3). Building this correctly on day one is the difference between a recoverable run and a corrupted ledger.

**Why it bites in this system specifically.** The orchestrator is stateful per run (`03-architecture.md` §10). Checkpointing is to Postgres (5KB deltas) + S3 (50KB snapshots every N transitions). A HITL pause must survive: pod death, orchestrator deploy, Postgres failover, and idempotent resume even if the approval token is replayed. The Core Banking adapter validates the approval token against the Approval Service before any ledger mutation - but only if the orchestrator correctly resumes with the *exact* state at interrupt.

| S | F | D |
|---|---|---|
| A | C | A |

**Mitigation sketch.** Treat HITL as a **two-phase commit at the graph layer**: phase one writes the checkpoint + approval request atomically (Postgres transaction wrapping both); phase two consumes the approval token, advances state, and writes the ledger mutation with the token as the idempotency key. Wire a chaos test that kills the orchestrator pod *between* HITL pause and approval arrival, then asserts the run resumes correctly on a different pod with byte-identical state. Borrow the durable-execution pattern from BlackBox's 10K+ runs/day LangGraph engine (`resume.txt:51-54`).

---

### B5. Ingestion Pipeline DLQ and Quarantine Discipline Before First Document Lands

**What it is.** The ingestion pipeline (`14-ingestion-pipeline.md`) has seven distinct DLQ classes (schema fail, OCR fail, embedding 5xx, chunking error, filter infra error, tenant quota, index write fail) plus a separate quarantine path for policy-violating content. Without the DLQ topology built in from day one, the first batch of malformed regulator PDFs poisons the index silently.

**Why it bites in this system specifically.** The pipeline runs `bge-large-en-v1.5` (1024-dim) on a GPU pool fronting pgvector. A single malformed RBI rulebook with embedded macros or a corrupt OCR result that produces 100K zero-vectors will silently degrade retrieval quality across every tenant on that index. The WASM sandbox (`resume.txt:49-50`) catches the obvious exploits but content-quality failures need DLQ + replay.

| S | F | D |
|---|---|---|
| B | B | B |

**Mitigation sketch.** Provision seven Kafka DLQ topics (`ingestion.dlq.schema`, `.ocr`, `.embed`, `.chunk`, `.filter`, `.quota`, `.index`) before the first document ingests. Build the replay tool with per-class backoff (DLQ entries are not equally retryable - a quota fail retries cheaply, an embedding 5xx needs GPU capacity). Land the dedup gate (`sha256` + MinHash + cosine threshold) as the *last* check before pgvector write so replay can be idempotent. Mirror the durable-step pattern from BlackBox's graph engine (`resume.txt:52-54`).

---

## Stage 2 - Launch

Retail-first dark-launch into a small cohort, with HITL plumbing exercised even on low-risk actions for warm-up. The challenges shift from "is the architecture sound" to "do the operational seams hold under real traffic, with real ops humans on the other end of the alert."

### L1. Cold-Start for Brand-New Users Without Memory Anchors

**What it is.** A first-day user has empty Redis session memory, empty long-term Postgres memory, empty financial history, and no org graph. The `ContextBuilder` returns a sparse context block; the LLM responds bland or generic; the user churns. The pack acknowledges this tradeoff explicitly (`01-executive-summary.md` "What I Would Concede").

**Why it bites in this system specifically.** Persona-default templates + onboarding context is the documented fallback, but the cold-start path crosses every memory tier (all return empty), every retrieval tier (KB hits will be generic), and the model router (default to higher-capability model to compensate for sparse context, raising cost). At 10M MAU target, 1% daily new-user rate is 100K cold starts/day, all of which preferentially route to the expensive model.

| S | F | D |
|---|---|---|
| C | B | C |

**Mitigation sketch.** Pre-populate a `cold_start_context_v1` template per persona at signup, written synchronously to Redis session memory before the first chat opens. Use the `RetrievalAgent` to pull the top-3 most-common persona-keyed FAQ chunks as a context warm-up. Route cold-start runs through the cheaper-model tier (Haiku-class) for the first 3 turns; the model router (`resume.txt:55-56`) gates the upgrade on detected complexity, not on user identity. Measure cold-start session length vs warm and pre-commit to a 60% retention bar before scaling beyond Retail.

---

### L2. Model Evals That Actually Catch Hallucinated Money

**What it is.** Pre-launch eval suite must catch the case where the LLM bypasses CalcInvoker and asserts a balance, runway, or DTI number that does not appear in `calc_results`. Off-the-shelf eval harnesses do not test for this; you have to build it.

**Why it bites in this system specifically.** Every Specialist subagent has a CalcInvoker contract and a post-validation rule, but the eval suite has to *adversarially probe* the LLM to bypass it - prompts that frame numbers as narrative ("the user has roughly 23K dirhams"), prompts that re-introduce numbers in the persona-adapter re-toning step, prompts that smuggle numbers through KB-retrieved chunks. The LLMOps mesh (`resume.txt:58-59`) gives us the replay surface, but the *eval set* has to be hand-curated and grown weekly.

| S | F | D |
|---|---|---|
| A | B | B |

**Mitigation sketch.** Stand up an `eval/numeric_grounding/` corpus with 500+ adversarial prompts per persona, each labeled with the calculation that should be invoked and the expected `calc_results.output`. Run nightly against every model in the router (Claude/GPT/Grok variants). Track **numeric-bypass rate** as a top-line metric, not a buried dashboard chart. Block any model promotion in the router if numeric-bypass exceeds 0.1% on the eval set. Reuse the deterministic replay infra from BlackBox (`resume.txt:58-59`) to re-run real production traces against challenger models.

---

### L3. HITL Reviewer Workflow Validation Under Real Latency

**What it is.** The Approval Service queues medium/high-risk actions to human reviewers (`03-architecture.md` §4.3). Pre-launch, reviewers are eager and queue depth is zero; at launch the first reviewer goes on lunch break and the queue depth balloons. The UX of "your transfer is awaiting review" needs to be tested under realistic reviewer-side latency, not synthetic.

**Why it bites in this system specifically.** The `ApprovalCoordinator` Specialist drives multi-step approval chains for SME and CFO, but Retail launch already exercises medium-risk gates (account closure, beneficiary add, high-value EMI commitment). The Notification Orchestrator must keep the user informed without spamming. The Approval Service's SLA tracking has to fire escalations before the user gives up and calls the call centre.

| S | F | D |
|---|---|---|
| B | B | C |

**Mitigation sketch.** Shadow-launch HITL with a forced 8-minute median reviewer delay for the first cohort, even on actions that would auto-approve, to surface UX gaps. Wire SLA-tier escalations (reviewer at 5min → team lead at 15min → on-call at 30min) and validate every escalation hop fires a real notification with an audit trail. Build a "reviewer queue depth × persona × risk-tier" dashboard before launch, not after; queue depth is the leading indicator of approval-related NPS collapse.

---

### L4. Regulatory Pre-Launch Sign-Off with Replay as the Evidence Pack

**What it is.** RBI / DPDP / SOC-2 pre-launch review will ask "show me ten arbitrary decisions and explain why the system did what it did." The answer is the LLMOps mesh's deterministic replay (`resume.txt:58-59`) - but only if it actually replays cleanly on day one.

**Why it bites in this system specifically.** Replay requires every span (`run_id`, `tenant_id`, `persona`, `node_id`) plus every Calc Service input/output, every retrieved chunk, every model-router decision, every policy verdict. Missing one of those breaks the replay story and the regulator notices. The 50M-spans/day mesh built at BlackBox already proved this works at scale; here it has to work from span #1.

| S | F | D |
|---|---|---|
| A | D | B |

**Mitigation sketch.** Lock the span schema before launch (`run_id`, `tenant_id`, `persona`, `node_id`, `calc_provenance`, `retrieval_provenance`, `policy_decision_id`, `model_router_choice`). Build a `replay-verify` CLI that picks a random 100 production runs nightly and asserts every one can be replayed to byte-identical Calc results. Make replay coverage a launch gate at 99.5% across all run types. Borrow the OTel + ClickHouse + replay topology from `resume.txt:58-59` end-to-end, not piecemeal.

---

### L5. On-Call Readiness Without Burning Out the First Three Engineers

**What it is.** Launch-week on-call sees novel paging patterns: hallucination escalations, queue-depth spikes, model router fallback storms, and the inevitable first false-positive proactive nudge. The runbook coverage has to match the actual signal-to-noise of the alerts.

**Why it bites in this system specifically.** Five core control surfaces (Orchestrator, Policy Engine, Approval Service, Notification Orchestrator, Model Router) plus four memory tiers and seven ingestion DLQ classes equal ~16 page sources. Without runbook templates per source, the first three engineers eat every page personally. The supervisor backpressure ladder and per-tool retry/circuit-breaker policies (recently landed per `git log`) help, but only if their failure modes are documented.

| S | F | D |
|---|---|---|
| B | A | C |

**Mitigation sketch.** Write one runbook per page source before launch (16 docs, each with: symptoms, dashboards, top three causes, mitigations, rollback). Use the supervisor backpressure ladder as the auto-mitigation for orchestrator overload - page only at the third rung. Tier alerts: P1 (money moved incorrectly), P2 (user-visible degradation), P3 (eventually-consistent backlog). No P3 pages during launch month - they go to a queue. Borrow the 60% MTTR cut discipline from the BlackBox LLMOps mesh (`resume.txt:58-59`).

---

## Stage 3 - Scale

From launch cohort to 1M MAU, then 10M. Throughput bottlenecks emerge in predictable places (pgvector, model router, Redis session memory) and unpredictable ones (Kafka partition skew, HITL queue tail latency, observability ingest backpressure). Cost control is now a board-level conversation.

### S1. pgvector HNSW Hot-Shard at the Top-Tier Tenant

**What it is.** At 1M+ MAU, a single large SME tenant's long-term memory + KB ingestion can dominate a pgvector shard's working set, pushing recall latency for that tenant from p95 80ms to p95 600ms while other tenants on the same shard are unaffected.

**Why it bites in this system specifically.** The memory layer (`13-memory-layer-design.md`) uses pgvector with per-tenant RLS but **shared HNSW indexes** for cost. A whale SME with 10M chunks (5 years of contracts, invoices, OCR'd statements) skews the HNSW graph and evicts cold-tenant entries from the OS page cache on every query. The dedicated-index escape hatch exists ("dedicated index for top-tier") but kicks in only after the pain is felt.

| S | F | D |
|---|---|---|
| B | B | B |

**Mitigation sketch.** Track per-tenant pgvector working-set size weekly; auto-promote any tenant exceeding 1M chunks or 5GB index footprint to a dedicated index on a separate Postgres replica. Use `pg_partman` to partition the `chunks` table by `tenant_id` hash, with the top 1% of tenants getting their own partition. Pin hot partitions to dedicated read replicas with HNSW rebuild on promotion. Pre-warm OS page cache on replica promotion via a `pg_prewarm` job during off-peak.

---

### S2. Model Router Cost Curve Bending Wrong at 1B Tokens/Month

**What it is.** The model router (Claude/GPT/Grok across `resume.txt:55-56`'s 1B-token/month envelope) selects per-call. If the capability heuristic mis-routes 5% of low-complexity Retail turns to a high-capability model, the monthly bill grows 30%+ for zero quality gain.

**Why it bites in this system specifically.** Persona-default templates already lean cheaper for Retail, but the router's "detected complexity" heuristic is the weak link. Cold-start traffic (L1) preferentially routes expensive. Proactive nudges (which are bursty and synchronous-feeling) preferentially route expensive. The 1B-token baseline becomes 1.5B with this drift, and CFO finance asks why.

| S | F | D |
|---|---|---|
| B | A | B |

**Mitigation sketch.** Instrument **per-(persona × intent × model) cost-per-resolved-conversation** in the observability mesh (`resume.txt:58-59`). Run a weekly counterfactual replay: take the last 7d of traces, re-route through the cheaper model, score against the Critic verdict and user-feedback signal, surface the delta. Pin Retail cold-start to Haiku-class for the first 3 turns regardless of detected complexity. Build a kill switch per (persona, model) that the on-call can flip during a cost spike without a deploy.

---

### S3. Redis Session Memory Hot-Key on Persona-Switch Bursts

**What it is.** When a user switches persona (SME → Retail, common at end-of-day), the platform ends the SME session and opens a new Retail session, which rehydrates from the Retail Redis shard. Mass persona switches (a payroll-day burst across SME tenants) hot-spot the Retail rehydration shard.

**Why it bites in this system specifically.** Persona switches are session boundaries by design (`03-architecture.md` §11) - we *cannot* blend Retail and SME context. That choice is correct for regulators but bad for Redis: every switch forces a fresh session-key creation under the persona-namespaced prefix `tenant:{tid}:persona:{persona}:session:{sid}`. At end-of-month payroll day, 100K+ SME owners flip to Retail to check their personal accounts, all within 30 minutes.

| S | F | D |
|---|---|---|
| C | B | C |

**Mitigation sketch.** Run Redis Cluster with `{tenant_id}` as the hash tag (curly-brace constraint) so a tenant's keys colocate, but spread tenants across slots via a consistent-hash that weights by historical session-open rate. Pre-warm the Retail Redis shard with a templated session payload on persona switch via a Lua script - single round-trip, atomic. Add per-shard rate limiters to fail-soft to "ephemeral session, no memory" rather than queuing.

---

### S4. Kafka Partition Skew on Tenant-Keyed Topics

**What it is.** Kafka topics are partitioned by `tenant_id` for ordering guarantees (`03-architecture.md` §10). A whale tenant with 100× the average event rate fills its partition while neighbours sit idle; the consumer group is bottlenecked on that one partition.

**Why it bites in this system specifically.** Domain events (`txn.posted`, `balance.changed`) flow through MSK to the Trigger Evaluator, ingestion pipeline, and audit. A whale CFO tenant with high-frequency treasury operations can push one partition to 80MB/s while peers are at 800KB/s. The Trigger Evaluator's consumer lag becomes per-tenant - fine for peers, catastrophic for the whale (proactive nudges fire 20min late).

| S | F | D |
|---|---|---|
| B | B | B |

**Mitigation sketch.** Move whale tenants to their own topic (`events.tenant.{tid}`) above a daily-volume threshold; the producer uses a lookup table updated daily. For non-whale tenants stay on the shared topic. Run a partition-skew detector that flags any partition exceeding 4× the topic median for >10min and auto-files a migration ticket. Mirror the real-time event topology from ShareChat at 40M DAU (`resume.txt:109-114`).

---

### S5. Observability Ingest Backpressure at 50M+ Spans/Day

**What it is.** At 10M MAU each producing ~5 spans per chat turn × ~3 turns/day × specialist fan-out = >150M spans/day. The mesh ingest can backpressure into the orchestrator, raising p95 latency or dropping spans silently - which kills the replay story (L4) for regulator audits.

**Why it bites in this system specifically.** The BlackBox mesh handled 50M/day (`resume.txt:58-59`); we are sized for 3× that. OTel exporters with buffered queues drop on overflow by default. A dropped Calc Service span is a regulator-grade defect because replay can no longer reconstruct the run.

| S | F | D |
|---|---|---|
| A | C | B |

**Mitigation sketch.** Run OTel collector with a persistent-queue backend (Kafka, not in-memory) so backpressure flows to disk rather than drop. Tier spans by criticality: **must-keep** (`calc_provenance`, `policy_decision`, `tool_call`, `model_router_choice`) are never dropped; **best-effort** (planner deliberation, low-level retries) drop first under pressure. Audit the drop rate per tier weekly; any must-keep drop triggers P1 paging. Scale ClickHouse + OpenSearch hot tier with predicted-volume headroom of 2.5× rather than 1.5× - the cost is small relative to a missed audit.

---

### S6. HITL Queue Tail Latency Becoming the Product Bottleneck

**What it is.** As volume grows, the HITL queue depth grows linearly while reviewer headcount grows step-wise. Tail latency (p99) for medium-risk approvals creeps from 4min to 40min before anyone notices, and SME owners start abandoning approval flows.

**Why it bites in this system specifically.** The Approval Service is stateful Postgres (`03-architecture.md` §10) with vertical-first scaling. The `ApprovalCoordinator` Specialist's multi-step approval flows compound - a CFO action with three approvers means three queue waits in series. The proactive nudge fatigue limits make it hard to surface "you have a pending approval" reminders aggressively.

| S | F | D |
|---|---|---|
| B | A | C |

**Mitigation sketch.** Model queue depth against persona mix monthly (acknowledged in `03-architecture.md` §13). Pre-hire reviewers against a 30d trailing forecast with a 1.5× safety factor. Skill-route approvals: small-amount approvals to a generalist pool, CFO multi-approver flows to a specialist pool with shorter SLAs. Build a "fast lane" for repeat-pattern approvals (same vendor, same amount class, within 30d) that uses a lightweight rules-based pre-approval with full audit, gated by the OPA policy bundle.

---

## Stage 4 - Operate

Steady state at 10M MAU. The questions shift from "can we handle the load" to "can we handle the *anomalies* without burning out the team." This stage is where the platform's observability investment pays back - or doesn't.

### O1. Hallucination Triage Without a Backlog

**What it is.** Even with the CalcInvoker boundary and the numeric-grounding eval, ~0.05% of responses will have a hallucination-flavored complaint (wrong rationale, fabricated counterparty, misattributed memory). At 10M MAU × 3 chats/day = 30M chats/day, that is 15K flagged conversations weekly. Triage cannot be one-by-one.

**Why it bites in this system specifically.** The replay infra (`resume.txt:58-59`) lets us reconstruct any single run, but triage at scale needs *clustering* - group complaints by retrieved-chunk fingerprint, by model+prompt-template signature, by Specialist+intent pair. Without clustering, the team plays whack-a-mole and the same root cause re-fires monthly.

| S | F | D |
|---|---|---|
| B | A | B |

**Mitigation sketch.** Build a hallucination-triage pipeline that consumes flagged conversations and emits clusters keyed by (Specialist, intent, model, top-3 retrieved-chunk IDs, policy-bundle version). Surface the top-10 clusters weekly with one-click drilldown to the replay. Mitigation routes: prompt-template edit, retrieval-filter tweak, OPA bundle update, model swap - each with its own rollback path. Borrow the 60% MTTR-cut pattern from BlackBox's LLMOps mesh (`resume.txt:58-59`).

---

### O2. False-Positive Proactive Nudges Eroding Trust

**What it is.** The `ProactiveAuthor` Specialist drafts nudges from trigger events (balance dip, payroll T-3, FX move). A false positive (nudging a user about a "shortfall" that is actually expected) erodes trust faster than a missed nudge. At 10M MAU, even a 1% false-positive rate is 100K disgruntled users monthly.

**Why it bites in this system specifically.** The trigger evaluator runs deterministic rules (`03-architecture.md` §4.2), but the *deterministic rule itself* may be wrong (e.g., not knowing the user always tops up on Friday). The cooldown gate prevents spam but not wrongness. Persona-aware fatigue limits exist; persona-aware *truthiness* checks do not - yet.

| S | F | D |
|---|---|---|
| B | B | C |

**Mitigation sketch.** Per-user **trigger calibration**: every nudge writes an outcome ("was it useful" feedback + objective signal like "did the predicted shortfall actually happen"). Recalibrate trigger thresholds per user weekly via a simple logistic on the last 12 outcomes. Add a confidence floor: nudges with model confidence below 0.7 or trigger calibration below 0.6 go to a digest, not a push. Borrow the AutoML pipeline pattern from `resume.txt:91-92` for the calibration loop.

---

### O3. Persona Misresolution and the Cross-Persona Blame Vortex

**What it is.** The Persona Resolver uses a three-signal vote (user choice, URL prefix, token claim) and returns the *intersection* on conflict (`03-architecture.md` §11). Edge cases - an SME owner using a Retail mobile app while logged in via SSO from their work IdP - surface as the agent responding in the wrong tone with the wrong tools available, generating support tickets.

**Why it bites in this system specifically.** Multi-persona users are common in MENA SMB and the platform is designed for them. The resolver's intersection-on-conflict is the safe default, but the user experience of "you asked an SME question and got a Retail answer" looks like a bug even when it is policy. The cross-persona memory boundary (intentionally narrow per the pack's tradeoff statement) makes it worse - the agent does not even know the user has an SME identity.

| S | F | D |
|---|---|---|
| C | B | D |

**Mitigation sketch.** When the resolver returns an intersection (i.e., conflict detected), inject a one-line clarifier into the assistant's first turn: "I see you have both Retail and SME access - I'm answering from your Retail context on this surface; switch personas in the menu if you meant SME." Audit-log every intersection event. Build a persona-mismatch detector that flags conversations where the user's question intent clearly belongs to a persona other than the one resolved, and surface to product weekly.

---

### O4. Drift in Retrieval Quality as the KB Grows

**What it is.** The pgvector HNSW recall at top-k degrades silently as the index grows (more near-duplicates, more vocabulary spread, more cross-domain pollution). Six months in, the same query returns subtly worse chunks; the Specialists' grounding gets sloppy; hallucination triage volume creeps.

**Why it bites in this system specifically.** Ingestion runs across regulatory docs, contracts, OCR'd invoices, transaction streams (`14-ingestion-pipeline.md`). Heterogeneous content classes share embedding space (`bge-large-en-v1.5`, 1024d). Without per-class recall monitoring, regulatory-rulebook queries start retrieving contract chunks and nobody notices until the Critic rejection rate climbs.

| S | F | D |
|---|---|---|
| C | B | C |

**Mitigation sketch.** Maintain a per-class **golden query set** (50 queries each for regulatory, contract, invoice, statement, market-data). Run nightly recall@10 against pgvector; alert on any class with >5% recall drop week-over-week. Re-rank top-k with BM25 hybrid (already in `03-architecture.md` §3) tuned per class. Quarterly: HNSW rebuild with new `ef_construction` and `M` parameters informed by per-class recall metrics. Consider per-class namespace separation in pgvector once a class exceeds 50M chunks.

---

### O5. Replay-Based Debugging When the Model Version Has Changed

**What it is.** A user complains about a response from 5 days ago. The team replays - but the model router has since promoted Claude N+1, and the replay gives a different answer. Now the debug is two-headed: was the original wrong, or is the replay just different?

**Why it bites in this system specifically.** The model router (`resume.txt:55-56`) versions providers and the OPA bundle versions policies, but the *model weights* are opaque. Anthropic / OpenAI / xAI version bumps happen weekly. The replay needs to **pin the exact model snapshot** at the time of the original call, not the current default.

| S | F | D |
|---|---|---|
| B | B | C |

**Mitigation sketch.** Make `model_id` in the span schema include provider, family, version (e.g., `anthropic/claude-4.5-20260315`), not just `claude-4.5`. Pin replay to the recorded `model_id`; if the provider no longer serves that snapshot, fall back to the closest preserved version with an explicit `replay.degraded=true` flag in the output. Keep an internal "model-snapshot freeze" of the top-3 routed models for 90d via self-hosted weights on the bare-metal H100 fleet (`03-architecture.md` §9). Borrow the BlackBox replay discipline (`resume.txt:58-59`).

---

### O6. On-Call Burnout from the Long Tail

**What it is.** Steady state has a long tail of low-severity pages (ingestion DLQ backlogs, retrieval recall alerts, HITL queue creep, cost-curve warnings). Individually they are P3; collectively they wake the on-call at 2am every other night.

**Why it bites in this system specifically.** 16+ page sources (L5), each with its own runbook, each independently within SLA but collectively chewing pager time. The supervisor backpressure ladder and per-tool circuit-breakers handle the orchestrator; everything else fires its own page.

| S | F | D |
|---|---|---|
| C | A | C |

**Mitigation sketch.** Quarterly on-call retro with explicit "what did we get paged for that we should not have" list. Promote auto-mitigations: anything that paged twice in a quarter and was resolved by the same runbook step becomes a scripted auto-remediation. Tier alerts strictly: P3 goes to a Slack channel reviewed daily, not to the pager. Track **pages per on-call shift** as a north star; cap at 2 per shift on a 30d rolling average and escalate to engineering leadership if breached.

---

## Stage 5 - Evolve

CFO persona launches after SME has stabilized. New jurisdictions, new tools, new regulators. The graph compiles diverge further; backward-compatibility across in-flight HITL approvals becomes a real concern; deprecating a tool that 3% of users still call requires a careful migration.

### E1. Graph Versioning Without Breaking In-Flight HITL Runs

**What it is.** Adding the CFO persona means recompiling the graph with new specialists (`TreasuryAdvisor`, multi-approver `ApprovalCoordinator` extensions). In-flight runs paused at HITLGate may have been checkpointed against graph version `v1.7`; the new deploy is `v1.8` with renumbered nodes.

**Why it bites in this system specifically.** Run-state durability (`03-architecture.md` §10) writes Postgres + S3 checkpoints keyed by `node_id`. A graph-version bump that renumbers nodes breaks checkpoint restore. With HITL pauses lasting hours-to-days, there is *always* an in-flight cohort during a deploy.

| S | F | D |
|---|---|---|
| A | C | A |

**Mitigation sketch.** Treat the graph as a **versioned artifact**: every compiled graph carries an immutable `graph_version`; every checkpoint records the version; resume always loads the version the checkpoint was written against, even if no longer the default. Keep the last 3 graph versions live in the orchestrator process. Forbid in-place node renumbering - node IDs are append-only. Run a chaos test that deploys `v1.8` while 1000 runs are paused at HITLGate under `v1.7` and asserts every one resumes correctly.

---

### E2. A/B-ing a New Policy Bundle Without Disparate-Impact Risk

**What it is.** A new OPA policy bundle (e.g., tightening cross-border thresholds for CFO) needs canary rollout. But policy decisions affect what actions humans can take - disparate impact across tenants is both a fairness and regulatory concern.

**Why it bites in this system specifically.** Policy bundles are signed and loaded from S3 with a 5-min TTL (`15-guardrails.md`). The platform supports canary (some tenants on new bundle, others on old) but the *measurement* of canary impact is non-trivial - you cannot just compare conversion rates because tenant mix differs. Regulators will ask "why did tenant A get a different decision than tenant B for the same action."

| S | F | D |
|---|---|---|
| B | C | B |

**Mitigation sketch.** A/B at the **decision class** level, not the tenant level: take 100% of cross-border-transfer decisions for SME tenants, route 5% through the new bundle, log both bundles' decisions side-by-side (the new one is shadow-evaluated even when not authoritative). Compare verdict distributions, escalation rates, and reviewer agreement. Promote the bundle only when shadow-vs-live agreement exceeds 99% on safe-region decisions and reviewer agreement holds on the new-region decisions. Audit-log every shadow evaluation.

---

### E3. Retiring a Deprecated Tool with Live Users Still Calling It

**What it is.** Six months after launch, the v1 `card.activate_offer` tool is deprecated in favor of `card.activate_offer_v2` with a different schema. The Tool Router's per-persona allow-list points to v1 for 3% of users on a legacy tier. Retirement breaks their flows.

**Why it bites in this system specifically.** The Tool Router (`03-architecture.md` §3, `12-agentic-graph-structure.md` §9) does compile-time RBAC, but tool version pinning is per-allow-list. Without explicit tool-version lifecycle, a "deprecate v1" deploy silently breaks Specialists that emit v1 schema. The Critic catches some breakage; the rest surfaces as user complaints.

| S | F | D |
|---|---|---|
| C | B | C |

**Mitigation sketch.** Treat each tool as a versioned API with a documented lifecycle: `active` → `deprecated` (logs a warning on call, still serves) → `sunset` (returns 410 with a structured error) → `removed`. Tool versions live in the Tool Router with a per-tenant override map; a tenant cannot be silently downgraded without a written migration ticket. Build a per-tool-version usage dashboard; nothing moves to `sunset` until 30d at <0.1% of calls.

---

### E4. Ingesting a New Regulatory Rulebook Without Index Poisoning

**What it is.** A new RBI circular drops; ingest pipeline starts processing. If the chunker emits 100K low-quality chunks from a poorly formatted PDF, retrieval quality degrades for every tenant whose policy questions were previously answered well.

**Why it bites in this system specifically.** The ingestion pipeline (`14-ingestion-pipeline.md`) uses structure-aware chunking and a dedup gate, but a new document class (a new circular template) may bypass dedup (no near-duplicate exists yet) and degrade recall (chunks are too long, or section headers leak into chunk bodies). The KB serves all tenants from shared pgvector indexes (S1) - one bad ingest hits everyone.

| S | F | D |
|---|---|---|
| B | C | B |

**Mitigation sketch.** Stage new document classes via a **shadow index** first: ingest into a parallel pgvector namespace, run the golden query set (O4) against it, compare recall@10 vs the live index. Promote only on no-regression. For trusted-source regulatory docs (RBI, DPDP, GST), add a manual review gate on the first ingest of each new circular template. Maintain a per-source freshness SLA; new circulars must be queryable within 24h of publish, with quality bar.

---

### E5. Cross-Region Replication When the Second Region Lights Up

**What it is.** Going from single-region to multi-region (e.g., adding an EU footprint for GDPR-residency CFO clients) means replicating Postgres, Redis, pgvector, ClickHouse, Neo4j, and Kafka - each with different consistency semantics. Done wrong, a tenant's data ends up in the wrong region.

**Why it bites in this system specifically.** Memory layer isolation is per-tenant (`13-memory-layer-design.md`), but residency is per-region. A tenant flagged as `region=EU` must have *all* memory writes go to EU stores; the cross-region replication topology has to enforce this at the storage layer, not the application layer. One misrouted write is a GDPR violation.

| S | F | D |
|---|---|---|
| A | D | A |

**Mitigation sketch.** Use **region-locked tenant routing**: the API Gateway resolves the tenant's region from the identity record and routes all subsequent traffic to that region's stack. No application-layer replication of tenant data across regions. Kafka topics are per-region; cross-region only for non-tenant data (telemetry aggregates, policy bundles). Audit every write with a `region_written_to` tag; nightly job asserts no `tenant.region=EU` write landed outside EU stores. Borrow the Microsoft secure multi-tenant boundary discipline (`resume.txt:88-94`).

---

### E6. CFO Multi-Approver Chains and Backward-Compat for SME

**What it is.** CFO launch adds N-of-M multi-approver workflows (e.g., 2-of-3 board approval for >5M AED treasury moves). The Approval Service schema grows new columns. SME flows that were single-approver must still work without migration.

**Why it bites in this system specifically.** The `ApprovalCoordinator` Specialist drives both flows; the Approval Service stores both. A schema change without backward-compat strands SME approvals in-flight. The HITL audit log (immutable, append-only) means migrations are forward-only - you cannot rewrite history.

| S | F | D |
|---|---|---|
| B | C | B |

**Mitigation sketch.** Model the approval schema as **N-of-M from day one**, with SME flows being the trivial 1-of-1 case. New columns are nullable with documented defaults. Run a backward-compat test suite that opens 100 SME approvals on the old code, deploys the new schema, and asserts they all resolve correctly. Audit-log writes are versioned (`schema_version` in every row); the replay/export tool reads any version.

---

## Top-10 Leaderboard

Scoring: `S*3 + F*2 + D` with A=4, B=3, C=2, D=1, F=0. Max possible = 24.

| Rank | Challenge | Stage | S | F | D | Score | Why this rank |
|---|---|---|---|---|---|---|---|
| 1 | **B1. Deterministic Boundary Under PM Pressure** | Build | A | B | C | 4*3 + 3*2 + 2 = **20** | Highest-severity invariant; constant pressure; gets harder to enforce as Specialists multiply. |
| 2 | **B4. HITL State Machine Surviving Pod Loss + Long Pauses** | Build | A | C | A | 4*3 + 2*2 + 4 = **20** | A bug here corrupts ledger state; complex distributed state machine; design-time choices lock in for the platform's life. |
| 3 | **E5. Cross-Region Replication and Residency Lock** | Evolve | A | D | A | 4*3 + 1*2 + 4 = **18** | GDPR-grade severity; one misrouted write is a regulator-notifiable event; rare but devastating; multi-store topology is hard. |
| 4 | **B3. Memory Schema + Tenant Isolation from Migration 1** | Build | A | C | A | 4*3 + 2*2 + 4 = **18** | Cross-tenant leak in banking is regulator-grade; four stores to get right; cleanup cost grows with every later migration. |
| 5 | **E1. Graph Versioning vs In-Flight HITL Runs** | Evolve | A | C | A | 4*3 + 2*2 + 4 = **18** | Breaks in-flight runs; happens every deploy once CFO ships; node-renumber bugs are subtle and slow to surface. |
| 6 | **L2. Eval Suite That Catches Hallucinated Money** | Launch | A | B | B | 4*3 + 3*2 + 3 = **21** | Production hallucinated currency is brand-ending; medium frequency without eval; building the adversarial corpus is real work. |
| 7 | **S5. Observability Ingest Backpressure at 150M+ Spans/Day** | Scale | A | C | B | 4*3 + 2*2 + 3 = **19** | Dropped spans kill replay; replay is the regulator-audit story; eventual at scale; needs Kafka-backed OTel queue redesign. |
| 8 | **L4. Replay as the Regulatory Evidence Pack** | Launch | A | D | B | 4*3 + 1*2 + 3 = **17** | Without it, regulator launch sign-off slips; rare but binary outcome; rebuilding span schema late is expensive. |
| 9 | **B2. Persona-as-Parameter Without Becoming Persona-as-Fork** | Build | B | A | B | 3*3 + 4*2 + 3 = **20** | Constant daily pressure; very high frequency; once it forks, refactor cost grows linearly with Specialists. |
| 10 | **S6. HITL Queue Tail Latency as Product Bottleneck** | Scale | B | A | C | 3*3 + 4*2 + 2 = **19** | Hits every day at scale; non-linear with persona mix; reviewer-headcount lever is slow. |

**Honorable mentions outside the top 10**: O1 (hallucination triage) and O2 (false-positive nudges) both score 17 - they hit constantly at steady state and are the daily texture of operating the platform; S1 (pgvector hot-shard) and S2 (model router cost drift) score 17–18 and dominate the scale-stage finance conversation. The pattern across the top 10: **the deterministic boundary, the HITL state machine, the tenant/region isolation, and the replay story are the four invariants that, if they go wrong, do not have a quick fix**. Everything else is mostly tuning. Build for those four like your job depends on it - because at a financial-services agent platform, it does.

---

*End of 16-challenges-by-stage.md. Cross-references: `03-architecture.md` for the load-bearing architectural choices, `12-agentic-graph-structure.md` for the graph topology and Specialist roster cited throughout, `13-memory-layer-design.md` for the four-tier memory and tenant-isolation primitives, `14-ingestion-pipeline.md` for the DLQ/quarantine topology, `15-guardrails.md` for the guardrail node behavior referenced in B1, L2, O1, and O2.*
