# 09 - Cross-Questions

40 hard interviewer pushbacks with crisp rebuttals. Anchor codes from `00-question-and-context.md`.

Format per question: ***Q*** · *Why they're asking* · **Rebuttal**.

---

## A. Architecture and scale (Q1–Q10)

### Q1
***Why not just put everything on AWS API Gateway WebSockets and skip the gateway service?***
*They want to know if you've considered the "cheap path" and rejected it for real reasons, not NIH.*

**Rebuttal:** API Gateway WS works for simple notification fan-out and tops out fast for anything stateful. Per-connection cost is high, message-size limits are tight (32 KB), and we'd lose control of session bind / resume tokens / sticky-by-userId routing. For Alpha with low concurrency, API Gateway WS is a fine wedge - but I'd not bet 1M users on it. We build a thin Go gateway from week 4, behind ALB. That's the same shape that made TunDRA at Microsoft scale to 1M+ Compute Instances (A-MS1) - the secret was that the gateway is small, stateless, and easy to scale, not that the cloud-managed service was magic.

### Q2
***Slack scaled to millions on a much simpler stack - defend your fanout topology.***
*Probing whether you over-engineer.*

**Rebuttal:** Slack publicly walked through their fanout work - they evolved from per-user channel subscriptions to "Flannel" (edge cache + thin push) precisely because their original simpler design hit ceiling. We are designing for the eventual ceiling now: workspace-sharded fanout topics, per-thread Redis Streams for hot subscribers, gateway holding only subscription metadata. If we shipped *only* what we need at Alpha, we'd repeat their migration two years from now. The pattern is more sophisticated; the components are not - Kafka, Redis, ALB. Same building blocks I used at ShareChat for 40M DAU ad serving (A-SC1, A-SC2).

### Q3
***Kafka is overkill for messaging - defend it.***
*Pressure-testing a major dependency.*

**Rebuttal:** I don't deploy Kafka because it's "the" messaging system; I deploy it because (a) we need durable replay for deterministic AI debugging - anchor BlackBox 50M spans/day mesh (A-BB5); (b) we need ordered partitions per `(workspace, thread)`; (c) we need 7-day retention for late-joining AI runs and audit. NATS JetStream is a credible alternative and I'd revisit it at a smaller forecasted scale. Kafka becomes "overkill" only if we don't need any of those three properties. We do.

### Q4
***How do you avoid the Slack 'noisy channel' fanout problem?***
*Concrete real-world pain - checking if you've thought about hot subscribers.*

**Rebuttal:** A noisy channel is a hot Kafka partition + N gateway pods all consuming. Two layers: (1) per-thread Redis Stream that the gateways tail instead of consuming Kafka directly for the top-N hot threads (auto-promoted by subscriber count); (2) gateway-side coalescing of presence / typing events so a 5K-subscriber channel doesn't multiply 500 typing events into 2.5M deliveries. The math: 50K events/s on a hot thread × 5K subscribers = 250M event-deliveries/s if naive. With coalescing + tail-Redis, that drops by 100x. Same engineering pattern as ShareChat's RTB hot-DSP path (A-SC2).

### Q5
***What breaks first at 1M users?***
*Looking for an honest answer about your weakest link.*

**Rebuttal:** Postgres on the messages table. Specifically the `messages.workspace_id, thread_id` composite-index write amplification combined with `read_receipts` write rate. Hot Postgres ceiling shows up around 5 TB; we'll see it at ~250–500K users with our message-volume assumption. Mitigation: logical sharding by workspace-hash at month 6, with the migration tested in staging before then. The second thing to break is the per-AI-provider rate limit cliff during a viral moment - mitigated by the multi-provider router (A-BB4) and per-workspace AI quotas.

### Q6
***How does this design behave during an India regional internet brownout?***
*India-specific reality check - ISP issues are common.*

**Rebuttal:** Two failure modes. First, intermittent packet loss for end users on mobile: clients use jittered exponential reconnect with resume tokens, message dedup via clientMessageId, and presence coalescing - sessions ride through. Second, full ap-south-1 internet brownout for our infrastructure: read traffic shifts to a US East replica via Route53 health-check failover (degraded latency but service-up); writes are paused for the duration with a banner. RPO 5 min via cross-region replication. We'd not promise active-active write at v1 - that's an honest tradeoff (see `08`). I lived this at ShareChat where ISP-level brownouts in tier-2 cities were a weekly event (A-SC1).

### Q7
***Why three different stores (Postgres, Qdrant, OpenSearch)? Sounds like a maintenance burden.***
*Probing whether you'd consolidate.*

**Rebuttal:** Each does one job better than the others would. Postgres is system of record for transactional truth + tenant isolation via RLS. Qdrant does ANN at scale; pgvector starts to lose at >50M vectors, which we hit by Public Launch. OpenSearch handles BM25 + ranking - Postgres FTS doesn't compete at this scale. The maintenance is real but predictable: the AI plane and search team owns Qdrant + OpenSearch, the data team owns Postgres. We could consolidate at Alpha (pgvector + Postgres FTS); we'd hit the migration by month 9. Doing it once now is cheaper than doing it under launch pressure.

### Q8
***You're talking about a lot of services - what stops this from being a microservices nightmare for a 6-engineer team?***
*Critical pushback - small teams should not have many services.*

**Rebuttal:** Six logical services, but at Alpha we run **two** deployable units: the **edge** (gateway + REST API + ws routing in one binary) and the **worker** (everything async - bus consumers, AI orchestrator, search indexer). Logical service boundaries inside the binary, deployable boundaries on the cluster. We split deployables only when scaling demands it (post-Public Launch). I learned this lesson the expensive way at ClipboardHealth migrating to microservices (A-IND1) - the right unit is "deploy boundary," not "code boundary."

### Q9
***What's the latency budget end-to-end for sending a message and seeing it on three other devices?***
*Forces you to do the math live.*

**Rebuttal:** Target: p95 < 300ms wall-clock. Budget breakdown:
- Client → Edge ALB: ~30ms (RTT in-region).
- Edge → Gateway pod: ~5ms.
- Gateway → Message Service (gRPC): ~5ms + ~10ms DB write (Postgres) + ~5ms outbox publish to Kafka.
- Kafka commit: ~10ms p95.
- Fanout consumer → recipient gateway pods: ~15ms.
- Gateway → recipient devices: ~30ms RTT.
- **Total: ~110ms** p50; ~200–300ms p95 with jitter.
That's the budget. Where it'll bite: hot Kafka partition rebalance, GC pause on a gateway pod, slow regional replica. All in the runbook.

### Q10
***How do you handle a single workspace with 100K members posting in one channel?***
*Stress test for the sharding model.*

**Rebuttal:** That workspace's Kafka topic gets 64 partitions instead of 8 (per-tier sizing). The hot channel gets a dedicated Redis Stream tailed by gateway pods so we don't fan out 100K-way through Kafka consumer groups. Postgres `messages` rows for that workspace shard to their own partition by hash. Gateway pods that hold > 5K subscribers for one thread get their fanout work bulkheaded so they don't starve other tenants. Per-workspace WS-conn cap as a final guardrail - at 100K members we expect maybe 30K concurrent online; capacity is sized for that. If a 100K-member workspace decides to live-broadcast, we treat it like a Slack #announcements rollout - pre-flag, dedicated capacity.

---

## B. AI plane (Q11–Q20)

### Q11
***How do you know your model router beats just calling GPT-4o for everything?***
*Tests whether you have empirical signal, not vibes.*

**Rebuttal:** Two signals. First, a held-out eval set per task type (summary, draft, search, agent action) scored against quality rubrics - capability-aware routing should match GPT-4o-only within 2 quality points on hard tasks and dominate on cost (60% cheaper). Second, online: A/B route 5% of traffic to "GPT-4o always" and measure user-visible regret signals (regenerate clicks, copy-edit rate). Anchor: at BlackBox we used this same eval-plus-A/B loop for the router (A-BB4). The router only earns its keep if measured.

### Q12
***Prompt injection - concretely, what stops a malicious message from owning my AI?***
*Live-fire security question; you should sound calm.*

**Rebuttal:** Layered. (1) System prompt isolation - system instructions are role-separated and the model is fine-instructed to treat user content as data, not commands. (2) Tool capability gating per tenant - a calendar agent literally cannot call the email tool, enforced at dispatch. (3) Output validation - every tool-call argument schema-validated and policy-checked before execution. (4) No re-prompting with parsed instructions from message content. (5) For indirect injection (URL fetch, attachment text), wrap as `<untrusted-content>` blocks. (6) Output safety classifier blocks display of secrets / hate / leaked PII. (7) Per-workspace token + tool-call rate limits cap blast radius if all of the above somehow fail. Full detail in `06-security-and-isolation.md`. None of these are theoretical - they're the same controls I built around the BlackBox WASM sandbox plane (A-BB1).

### Q13
***If we ship E2E encryption, doesn't that kill the AI moat?***
*Hard tradeoff - they want a thoughtful answer, not a slogan.*

**Rebuttal:** Yes, fully E2E and fully server-side AI on the same content are mutually exclusive. The honest posture: server-side encrypted (with per-workspace KMS, optional BYOK) by default with full AI features - that's what 95% of enterprise customers actually want. Add an opt-in **Confidential Mode** per channel for E2E with on-device-only AI (smaller models, no cross-device search). Be loud in the UI when it's on. Don't promise both for the same content - that's the answer that fails the security review six months later. Same kind of tradeoff I had to make explicit during the BlackBox SOC-2 work (A-BB1).

### Q14
***Defend the cost - at 1M users, what's the AI bill?***
*They want a number with reasoning.*

**Rebuttal:** ~$110K–$180K/mo at 1M users (math in `05-scaling-and-capacity.md`). Levers that bring it down: capability-aware routing (40–60% saving), prompt caching (30–50% on input tokens), context summarization, per-workspace hard budget (kills runaway scenarios), embedding cache. Anchor: BlackBox served 1B+ tokens/month with these levers in place (A-BB4). The unit economics target I'd hold us to: AI cost per DAU < $0.05/mo at the 1M milestone. Anything above that is a margin conversation with the founders.

### Q15
***Why DAG and not just function calls?***
*Tests depth on agent runtimes.*

**Rebuttal:** Function calls are a primitive, not a workflow. Agents do multi-step plans where each step depends on the previous, may take 30s, may need to be paused for user approval, may fail and need to retry without redoing the rest. A DAG with checkpoint-after-each-node gives us: durable resume after pod death (anchor A-BB3), idempotent tool retry, human-in-the-loop pause points, deterministic replay, and clear cost attribution per step. A linear function-call loop gets you a demo; a DAG gets you to production.

### Q16
***Hallucinations at scale - what's your strategy?***
*Real production problem.*

**Rebuttal:** Three layers. (1) Ground responses with retrieval - every claim that can be backed by a thread reference is cited with the messageId; UI shows the citation. (2) Structured outputs where possible - the model returns JSON conforming to a schema, which the orchestrator validates; bad schemas trigger retry with a different model. (3) Eval harness in CI - held-out questions with expected behaviors, run on every router config change. Hallucinations don't go to zero, but the user sees citations and structured answers; the worst category - confidently wrong factual claims with no source - gets caught by output validation.

### Q17
***How do you measure if AI features actually work?***
*Product-engineering pushback.*

**Rebuttal:** Four signals. (1) Usage retention - % of DAU using each AI feature > 1x/week, week-2 retention. (2) User satisfaction signal - regenerate-rate, edit-after-accept rate, explicit thumbs. (3) Task completion lift - A/B test users with vs without the feature on time-to-complete-thread. (4) Quality eval against held-out set with rubric scoring per release. The first two come for free from telemetry (anchor A-BB5 mesh); the second two are work I'd staff a small AI ops eng for by Public Launch.

### Q18
***What if a model provider deprecates a model you depend on?***
*Vendor risk question.*

**Rebuttal:** The router abstracts model identity. We pin model versions per route, monitor deprecation calendars (Anthropic, OpenAI, Bedrock all publish), test the next version against our eval suite before flipping. For unannounced deprecation we have the multi-provider failover ladder. Worst case (one provider goes dark): we route to alternates with a quality-degradation banner and a 1-week SLA to re-tune routes. This is the same risk I managed at BlackBox across Claude / GPT / Grok (A-BB4).

### Q19
***Why not let the user pick the model directly?***
*Product question disguised as architecture.*

**Rebuttal:** For 95% of users, picking a model is friction without insight. The router picks better than they would because it knows context length, tool needs, latency budget. For power users (admins, devs), expose model preference per workspace as an override. For the model-religious user, expose a per-message override. Default to smart, allow opt-out.

### Q20
***How do you handle PII in prompts you send to providers?***
*Compliance + reality check.*

**Rebuttal:** Live API call carries the message content (we have to - it's the question). The **stored** copy in our telemetry mesh is PII-scrubbed via a redactor at the SDK boundary so we don't multiply exposure (anchor BlackBox telemetry mesh A-BB5). Provider DPAs include "no training on our data." Workspace-level toggle for stricter mode (smaller redacted context). DPIA per AI feature. For Confidential Mode workspaces, content never leaves the device. Don't pretend the live API call has zero exposure - it doesn't, and the customer should know. Honest beats clever.

---

## C. Reliability and security (Q21–Q30)

### Q21
***What's your worst-case outage scenario?***
*Forces you to think about the tail.*

**Rebuttal:** Multi-failure: ap-south-1 internet brownout + AI provider 1 down + a poison message in Kafka that crashes the consumer. Each alone is recoverable; combined, the system is in a degraded mode for 30–60 min. Mitigation: regional read failover handles the brownout; provider router handles the AI; consumer poison-pill handling routes to DLQ + alert + auto-restart. Drilled quarterly in gameday. The honest worst-worst case: full ap-south-1 outage longer than 1h with writes blocked - communicate, accept the SLA hit, post-mortem.

### Q22
***Walk me through how you'd hit SOC-2 by Public Launch with this team size.***
*Practical leadership question.*

**Rebuttal:** Week 2 gap analysis with a Drata/Vanta-style platform. Month 1 wire up evidence collection (access reviews, change mgmt, vuln scans, encryption attestations). Month 2 close top 10 control gaps. Month 3 begin the observation period for Type II. Type I attestation in hand at Public Launch (sufficient for most enterprise procurement). Type II report at month 12. Anchor: I helped unblock SOC-2 at BlackBox via the WASM sandbox isolation work (A-BB1) - same playbook applies, scaled to messaging.

### Q23
***What's the deepest you've worked on multi-tenant isolation?***
*Direct experience question.*

**Rebuttal:** At Microsoft I led the design of secure multi-tenant ML infrastructure on Kubernetes + Azure (A-MS2), including VNet-level isolation, namespace boundaries, identity-bound storage access, secret isolation, and quota enforcement - for AutoML workloads serving 200K+ users (A-MS3). At BlackBox I architected the WASM sandbox plane that isolated 1M+ daily code executions and unblocked SOC-2 (A-BB1). The principle that worked both times: `tenantId` is propagated and verified at every layer, with enforcement teeth (RLS, ACLs, integration tests) - not just hoped-for at the API.

### Q24
***How do you debug an agent loop that wasted $5K in tokens last night?***
*Hands-on AI ops scenario.*

**Rebuttal:** Open the AI plane dashboard, sort by token spend per workspace + per run for the affected window. Pull the runId, replay it via deterministic replay (anchor A-BB5). The replay shows the DAG tree - usually an agent that hit a tool error, retried, was re-instructed, retried again, in a cycle. Patch: tighter step ceiling on that workflow, tool-error → terminal-failure rule, refund the customer if they got value=0. This exact sequence cut MTTR by 60% at BlackBox (A-BB5).

### Q25
***Why should I trust your replay system?***
*Probing for a non-handwavy answer.*

**Rebuttal:** Three properties. (1) Every input to a non-deterministic step is captured: prompt, model+version, seed, tool args, tool results, retrieval doc IDs and content hashes. (2) Provider responses are cached for 7 days, so the replay is byte-equivalent for that window. (3) The DAG executor runs in the same code path on replay; differences come only from non-determinism we couldn't pin (provider sampling without seed). When that happens, replay shows a diff, not silence - we'd see "first call returned X, replay returned Y." Same approach in the BlackBox mesh that ingested 50M spans/day for replay (A-BB5).

### Q26
***An employee leaves - how fast can you revoke?***
*Insider risk question.*

**Rebuttal:** SCIM-driven deprovisioning propagates to OIDC IdP within 60 seconds; access tokens have 10-min TTL so worst-case live-token window is 10 min. Refresh tokens are revoked at IdP (single-use rotation). For privileged access (production read, prod deploy, KMS), break-glass workflow logs every grant with an expiration; revocation is immediate. AWS console / SSH access via SSO - revoked at the IdP. Audit log captures everything; we'd review post-departure within 24h.

### Q27
***What if a contractor accidentally pulls a customer database to their laptop?***
*Real risk in early-stage.*

**Rebuttal:** Tooling routes through bastion + ephemeral analysis environments (e.g., temporary Athena query workspace), not direct DB access from laptops. DB credentials don't exist on laptops. Pulls > N rows trigger an audit event + alert. Customer data on a laptop is a Sev1 incident - IR runbook starts immediately, legal looped in, customer notified per DPA. Prevention is the right answer; the tooling closes the path.

### Q28
***How do you detect cross-tenant data leakage?***
*Critical multi-tenant question.*

**Rebuttal:** Three layers. (1) Postgres RLS - queries without `app.workspace_id` set fail closed. (2) CI lint that fails on any new SQL in tenant-scoped repos lacking a `workspace_id` predicate. (3) Quarterly red-team explicitly targeting tenant escape, with a bonus tied to it. Plus per-request log assertion: every tenant-scoped request must have one `workspaceId` value across all spans; mismatches alert. Same playbook from Microsoft secure multi-tenant ML infra (A-MS2).

### Q29
***Walk me through your incident response in the first 5 minutes of a Sev1.***
*Operational reality check.*

**Rebuttal:** PagerDuty pages on-call. On-call ack within 5 min, opens incident channel, declares Sev1, IC role assigned (often me at this stage), Operations Lead jumps in. First 5 min: contain (drain bad pod, flip feature flag, route around bad provider), preserve evidence (capture logs, snapshot state), open status page, page legal if data-related. Comms within 1 hour to customers. War-room runs until mitigated. Post-mortem in 3 business days. Anchor: this is the cadence we ran at Microsoft (A-MS5).

### Q30
***What's your stance on bug bounties and responsible disclosure?***
*Security-mature org question.*

**Rebuttal:** Public security@qale email + GPG key from day one. PGP-signed advisories. Bug bounty program (HackerOne or Bugcrowd) by Public Launch, scoped to in-scope assets, with a defined safe-harbor clause and clear payout matrix. Internal SLA: ack within 1 business day, triage within 3, fix-or-mitigate per severity. Public CVE for any vulnerability we patch. This is table stakes for an enterprise-targeting product.

---

## D. Leadership and execution (Q31–Q40)

### Q31
***You've never been Head of Engineering - why us?***
*The question.*

**Rebuttal:** I've been the *function* of a Head of Engineering at Principal level: at BlackBox I led architecture for a 6+ engineer agentic platform end-to-end (A-BB2); at Microsoft I mentored 8 engineers and ran 30+ architecture reviews across cross-org teams (A-MS4, A-MS5); at ShareChat I built an ad team from scratch and shipped infra to $20M revenue in a year (A-SC2). The work is what I've been doing; the title is the lagging indicator. What you're paying for is execution and judgment, not a job title - and the JD itself says "this is not a purely managerial role."

### Q32
***How do you stay hands-on without being the bottleneck?***
*The builder-leader paradox.*

**Rebuttal:** Time-budget: ~50% leadership/people/process, ~50% in-code. Hands-on contributions are concentrated in the connection-plane hot path, the AI orchestrator, and code reviews on hard PRs. I am explicitly *not* in the critical path for product work - pods own product features. The day I can't pull a PR for the connection gateway is the day Qale has the wrong head of engineering. I'd track this with a measurable: I should be merging code at least 1x/week, on-call 1 week/quarter, and never the only one who knows a system.

### Q33
***First 30 / 60 / 90 day plan?***
*Concrete leadership question.*

**Rebuttal:**
- **0–30:** read the code, run the load test myself, "Top-10 risks" doc, set engineering standards (CI, code review SLO, design-doc template), on-call rotation.
- **31–60:** connection-gateway sharding, idempotent message send, AI-plane budget enforcer, basic telemetry mesh, hire 3–4 engineers.
- **61–90:** SOC-2 gap analysis, multi-region read path, SLO/SLA published, regional canary, Hyderabad team to ~10.

Detail in `14-leadership-and-business-framing.md`.

### Q34
***How do you hire 15 engineers in Hyderabad in 6 months without lowering the bar?***
*Real practical question.*

**Rebuttal:** Sources first: Microsoft Hyderabad alumni networks (I have one), Razorpay, PhonePe, Swiggy, Postman alumni, IIIT-H + BITS targeted referrals. Targeted poaching of 5–10 senior engineers from chat / real-time / AI infra backgrounds. Inbound from a strong engineering blog by month 2. Loop: 4 rounds (system design, coding, AI/realtime depth, leadership-and-judgment), me on the panel for the first 10 hires. Calibration meeting after every loop. Comp: top-of-market with real equity. Bar: "would I want this person on-call with me?" If not, no hire. Better to be 3 hires short than 1 wrong hire - every wrong hire costs 6 months of org energy.

### Q35
***How do you handle disagreement with the CEO on architecture?***
*Cultural fit question.*

**Rebuttal:** Disagree-and-commit, with the disagreement written down. If it's a high-stakes architectural call, I write a one-page RFC laying out the tradeoffs, the evidence on each side, and my recommendation. If after that the CEO still wants the other path, I commit fully and execute. The escape hatch is "if I think the call meaningfully risks the company or my ability to execute, I say so explicitly." I would not stay quiet to keep the peace. Anchor: this is the same way I worked with senior PMs and security leads on cross-org calls at Microsoft (A-MS5).

### Q36
***What's the on-call structure?***
*Operational maturity.*

**Rebuttal:** Primary + Secondary, weekly rotation, per-pod (so the AI plane on-call understands AI failures, etc.) with a cross-pod incident commander rota for Sev1. SLA: ack within 5 min Sev1, 15 min Sev2. Compensation: time-back during the next sprint. Engineers do not deploy on the day they go on call. New engineers shadow for 4 weeks before primary. I take a primary slot 1 week per quarter - non-negotiable.

### Q37
***What if your stack choice is wrong?***
*Humility check.*

**Rebuttal:** I'd find out within 90 days because I'm running the load test, on-call, and code-reviewing the hot paths. Each major dependency (Kafka, Postgres, Qdrant, AI router) is behind a thin internal interface so swapping is a quarter of work, not a rewrite (see `08-tradeoffs-and-alternatives.md` migration paths). The expensive mistake to avoid is doubling down past the evidence - I'd rather eat a 3-week refactor at month 4 than a 6-month migration at month 18.

### Q38
***When do you fire someone?***
*Hard but expected.*

**Rebuttal:** Clear performance-improvement-plan after sustained miss against expectations, with explicit criteria, weekly check-ins, and a 30–60 day window. If they hit the bar, we celebrate; if not, we part. Conduct issues (harassment, dishonesty, security violation) are immediate. The principle: if I'm not surprised, the engineer should not be surprised. PIPs are not "managed-out" code words - I've seen people turn around and become great with the right feedback.

### Q39
***What's your relationship to the frontend lead?***
*Probing the React-leadership half of the JD.*

**Rebuttal:** Honest: my deepest claims on the resume are backend-leaning; React at scale is the lane I'd hire a strong tech lead for and partner closely with - not delegate-and-forget. I'd be in their PRs on the connection-plane integration, the optimistic UI, the WebSocket client. They lead component architecture, design system, performance budgets. We co-own the user-perceived latency SLO. I expect to learn from them; I bring full-stack judgment and a backend that doesn't make their life hard.

### Q40
***What's the one thing you'd do in week 1 that nobody else would?***
*Differentiator question.*

**Rebuttal:** I'd run the load test myself against the existing Alpha codebase and write a 1-page "what breaks first" memo, before any architecture proposal. Most new heads-of-eng spend week 1 in 1:1s and meet-the-team. I'd do those too - but the load test tells me what's true about the code, not what people remember about the code. I'd then share that memo with the team in week 2 - that single artifact establishes both the technical bar and that I'm a builder, not a meeting-runner. It's the same first move I made joining BlackBox to architect the WASM sandbox plane (A-BB1) - measure first, then propose.
