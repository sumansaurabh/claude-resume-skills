# 14 - Leadership and Business Framing

The half of the role that the JD is *most* explicit about: hands-on builder leadership, hire and grow the Hyderabad team, set engineering standards, ship Qale Alpha → Public Launch → 1M users.

Anchor codes from `00-question-and-context.md`.

## 1. The leadership thesis

> I am a Principal Engineer who is now ready to lead - not a manager who used to code.

The difference matters. A manager-who-used-to-code optimizes for process, headcount, and meeting throughput. A Principal-who-leads optimizes for shipped systems, architectural clarity, and the engineering bar. Qale at Alpha needs the second.

What I have already done at the function level:
- **6+ engineers led** at BlackBox on the agentic AI platform - architecture, code review, technical direction, sprint cadence (A-BB2).
- **8 engineers mentored** at Microsoft on secure protocol design; **30+ architecture reviews** run across AI Fine-tuning + AutoML (A-MS4, A-MS5).
- **ShareChat ad team built from scratch** to $20M revenue in a year (A-SC2) - same shape as Qale's Alpha → Public-Launch motion.
- **Cross-org design reviews** for AutoML evolution at Microsoft (A-MS3) - the coordination muscle for working with PMs, security, infra, and SDK teams.

The JD says *"this is not a purely managerial role…we are looking for someone who is deeply technical, execution-focused, and comfortable building under pressure."* That is the role I am applying for.

## 2. First 30 / 60 / 90 days

The plan is concrete deliverables, not themes. Each item has a named output an interviewer or founder can later check.

### Days 0–30 - Land and audit

| Output | What it is |
| --- | --- |
| **Code read-through doc** | 5–10 page write-up of the Alpha codebase: components, hot paths, smell list, technical debt inventory |
| **Live load-test report** | I personally run a load test against the Alpha system and write the "what breaks first" memo (the week-1 differentiator from `09-cross-questions.md` Q40) |
| **Top-10 risks doc** | Delivery, scale, security, AI-cost risks ranked by likelihood × impact (mirrors `15-risk-register.md`) |
| **Engineering standards v1** | Trunk-based dev, PR review SLO 1 business day, design-doc template, on-call rota, post-mortem template |
| **CI baseline** | CodeQL + Dependabot + image signing wired into every repo (anchor A-MS4) |
| **On-call rota v1** | Even with a small team, primary + secondary, weekly rotation |
| **1:1 with every engineer** | 30 min each, listening more than talking |
| **Founder alignment doc** | What I heard about product vision, what I propose for the next 90 days, where we agree/disagree |

### Days 31–60 - Alpha hardening

| Output | What it is |
| --- | --- |
| **Connection gateway sharding** | Stateless Go gateway sized to 75K conns/pod, sticky-by-userId, sharded fanout topics |
| **Idempotent message send** | `Idempotency-Key` server-side dedup, clientMessageId on the wire, monotonic per-thread sequence |
| **AI-plane budget enforcer** | Per-workspace token budget; hard cap before call leaves the queue (anchor A-BB4) |
| **Telemetry mesh v1** | OTel SDK in every service, OTel collector → Kafka → ClickHouse, basic Grafana dashboards (anchor A-BB5) |
| **First 3–4 hires** | Senior backend (real-time), senior frontend (React-at-scale), SRE, ideally one AI engineer |
| **Threat model per surface** | Auth, message bus, AI plane, attachments, admin (anchor A-MS4) |
| **Runbook starter set** | Top-5 incident runbooks documented and drilled |

### Days 61–90 - Public-launch readiness

| Output | What it is |
| --- | --- |
| **SOC-2 gap analysis** | Drata/Vanta-style platform onboarded; top 10 control gaps closed (anchor A-BB1) |
| **Multi-region read** | Read failover to a US East replica via Route53 health-check |
| **SLO/SLA published** | Internal SLOs and customer-facing SLA per surface |
| **Regional canary** | New release flows: dev → staging → 5% canary → 100% with auto-rollback |
| **Hyderabad team to ~10** | Two pods staffed (Real-Time + AI), Frontend & Growth pod forming |
| **AI eval harness** | Held-out eval set running on every router config change |
| **Public engineering blog post** | Two posts: "Building Qale's connection plane" + "Our AI router". Recruiting + inbound signal |

## 3. Hiring plan in Hyderabad

The team grows from ~5 (today, assumption) to ~25–30 by 1M users. Three pods.

### Team shape evolution

| Milestone | Headcount | Pod structure |
| --- | --- | --- |
| Today (assumption) | ~5 | One pod, all-rounder |
| Day 90 | ~10 | Real-Time pod (4) + AI pod (3) + Frontend & Growth (3) - me playing tech-lead in two until leads land |
| Public Launch (~6 mo) | ~15 | Three pods with named tech leads, one SRE, one security/compliance |
| 1M users | ~25–30 | Three pods (5–6 each) + SRE (3) + Security (2) + Data/AI ops (2) |

### Pods

**Real-Time Plane pod** - connection gateway, message service, fanout, presence, notifications, transport evolution. Owns the message-send SLO.

**AI Plane pod** - model router, agent runtime, RAG, embeddings, AI ops, eval harness. Owns AI quality + cost.

**Frontend & Growth pod** - React app shell, mobile (PWA → native later), onboarding, retention surfaces, design-system. Owns user-perceived latency.

**SRE / Platform** - Kubernetes, IaC, observability, on-call tooling. Embedded liaison in each pod.

**Security & Compliance** - threat models, SOC-2, audit, incident response. Cross-cuts.

### Roles to hire in priority order (next 6 months)

1. **Senior Backend Engineer (Real-Time)** - Go, distributed systems, WS/Kafka. Must have shipped sub-second-latency systems.
2. **Senior Frontend Engineer (React at scale)** - virtualized lists, optimistic UI, WebSocket clients, performance budgets. Likely a tech lead candidate for FE pod.
3. **Senior AI Engineer** - LLM systems, RAG, eval, prompt engineering. Bonus: agent runtimes.
4. **SRE Lead** - EKS at scale, observability, IaC. The first systematic operator.
5. **Backend Engineer (Storage)** - Postgres at scale, sharding, search.
6. **Frontend Engineer (Mid)** - React, design-system, accessibility.
7. **Backend Engineer (AI plane)** - orchestrator, durable execution.
8. **Security Engineer** - threat modeling, SOC-2 evidence.
9. **Platform Engineer (Bus)** - Kafka, schema registry, replay tooling.
10. **AI Ops Engineer** - eval, telemetry analysis, cost ops.

### Sourcing strategy

- **Microsoft Hyderabad alumni**: I have direct network from A-MS1..5; very strong distributed-systems pool.
- **Razorpay, PhonePe, Swiggy, Postman, Postman alumni**: real-time + scale experience.
- **IIIT-H, BITS, IISc**: targeted referrals; intern → return-offer pipeline by month 6.
- **Targeted poaching of 5–10 senior engineers** from chat / messaging / collaboration / AI infra backgrounds (Slack-like, Discord-like, Postman, Twilio, AWS).
- **Inbound from engineering blog**: month 2 onward.

### Interview loop

| Round | Focus | Interviewer |
| --- | --- | --- |
| Phone screen | Resume, motivation, salary calibration | Recruiter |
| System design | Real-time messaging or AI-plane scenario | Senior eng |
| Coding | Pairing on a small real-world problem (2 hrs) | Senior eng |
| Domain depth | Real-time / AI / FE depending on role | Tech lead |
| Leadership & judgment | Past projects, conflict, judgment calls | Me (first 10 hires); tech lead later |
| Reference call | 2 references, structured questions | Me |

**Calibration meeting after every loop.** No silent "no hires."

**Bar question:** "would I want this person on-call with me?" If not, no hire.

**Comp:** top of market for Hyderabad senior. Equity-heavy with 4-yr vest, 1-yr cliff, accelerator on change-of-control.

**Diversity & seniority mix:** target 30% women in eng by year 1 (intentional sourcing pipelines). Seniority mix: ~40% senior, ~50% mid, ~10% junior at Public Launch - too senior-heavy slows velocity, too junior-heavy slows quality.

## 4. Engineering standards (set in week 1)

| Standard | What | Why | Enforcement |
| --- | --- | --- | --- |
| Trunk-based dev | Short-lived branches; merge to main daily | Velocity + small PRs | Branch-protection rule |
| PR review SLO | 1 business day | Avoid stale PRs, block-and-move | Slack reminder bot, weekly metric |
| Design doc | Required for any change crossing a service boundary | Shared understanding, debate before code | Repo template, review by tech lead |
| CI required-green | Tests + CodeQL + Dependabot + Trivy + lint | Catch regressions, vulns, secrets | Branch-protection |
| On-call rota | Primary + secondary, weekly | No heroic-IC | PagerDuty schedule |
| Weekly architecture review | 60 min, async-prepared docs | Cross-pod alignment | Calendar standing |
| SLO ownership per service | Each service has owner + SLO + dashboard | Reliability is process, not heroics | Service catalog |
| Runbook required | Service can't go to prod without one | Incident speed | Deploy gate |
| Post-mortem | Sev1 in 3 BD, Sev2 in 5 BD | Learning culture | Calendar reminder, PM sign-off |
| Security review | Required for any new external surface | Protect the SOC-2 path | Security pod review |
| Code-style + linting | Per-language; enforced in CI | Less bikeshed in review | Lint checks |
| Secrets policy | Never in env vars; rotated quarterly | Prevent silent exposure | Pre-commit + CI scan |

Anchor: this is a synthesis of the Microsoft secure-CI/CD + threat-model standards (A-MS4) and the BlackBox engineering practices on a young agentic platform (A-BB2).

## 5. Delivery cadence and rituals

| Ritual | Cadence | Purpose |
| --- | --- | --- |
| Standup | Daily 15 min, per pod | Unblock |
| Sprint planning | 2-week sprints | Plan |
| Sprint demo | Friday end-of-sprint | Show, don't tell |
| Sprint retro | Per sprint | Process improvement |
| Architecture review | Weekly 60 min | Cross-pod design alignment (anchor A-MS5) |
| Eng all-hands | Monthly 60 min | Broader announcements + Q&A |
| OKR planning | Quarterly | Set quarterly goals |
| Tech-bar tea | Bi-weekly informal | Shared learning, paper club |
| Incident review | Weekly 30 min | Discuss past week's incidents, action items |

Anti-rituals: no daily all-engineer standup, no weekly status meeting where people read out their Jira, no recurring "is this still on track" meeting that should be a Slack message.

## 6. How I stay hands-on as Head of Engineering

Explicit time budget:

| Bucket | % | Examples |
| --- | --- | --- |
| Coding & code review | 30% | Hot-path PRs in connection gateway, AI orchestrator; review hard PRs in any pod |
| Architecture & design | 20% | Design docs, RFCs, prototyping new directions |
| People (1:1s, hiring, mentoring) | 25% | 30 min/week per direct, hiring loops, career growth |
| Cross-functional (CEO, Product, Sales, Security) | 15% | Weekly sync with founders, quarterly enterprise customer calls |
| On-call & incident | 5% | One week per quarter primary; available for Sev1 always |
| Process / planning | 5% | OKRs, retros, hiring plan, budget |

The day I can't pull a PR for the connection gateway is the day Qale has the wrong head of engineering.

**Concrete commitments:**
- Merge code at least 1x / week.
- Take a primary on-call slot at least 1 week / quarter.
- Never be the only person who knows a system - bus-factor of 1 is a bug.
- Run the load test myself before every major release.

## 7. Decision-making model

**For high-impact technical decisions:** RFC. One page minimum, longer if needed. Tradeoffs, evidence, recommendation. Open for comment 3 BD. Any objection that lands gets a written reply. Final call: by RFC owner unless I escalate or a founder vetoes.

**For low-impact decisions:** lazy consensus. Engineer proposes in PR or Slack; if no objection in 24h, it ships.

**For blocked decisions:** if a thread is stuck > 48h with no path forward, I make the call and write down why. Disagree-and-commit.

**For founder-disagreement on architecture:** RFC + 1:1 with the disagreeing founder. If still unresolved, I commit and execute, with the disagreement in writing for the post-mortem if it goes wrong.

## 8. Cross-functional partnership

| Function | What I expect | What they should expect |
| --- | --- | --- |
| **CEO / Founders** | Clear product priorities, room to push back on scope, freedom on architecture, not micro-managed on team decisions | Honest status (good and bad), no surprises, eng-cost transparency, willingness to land hard tradeoffs together |
| **Product** | Prioritized roadmap, clear customer signal, willingness to cut scope | Eng feasibility input early, tech-debt transparency, design-partner empathy |
| **Design** | Sketches early, design-system co-ownership | Eng craft on FE, faithful implementation of design |
| **Sales** | Pipeline visibility, customer-segment clarity | SOC-2 timeline, security responses for RFPs, proof-of-concept support within reason |
| **Security / Compliance** | Risk appetite, regulatory horizon | Threat models, runbooks, audit support |
| **Finance** | AI/infra cost forecast, headcount plan | Monthly cost variance, savings opportunities |

## 9. Hiring rubric examples

### Senior Backend Engineer (Real-Time)

| Signal | Strong | Weak |
| --- | --- | --- |
| Distributed systems | Has scaled WS / TCP / QUIC server beyond 50K conns; can reason about GC tail latency | Knows theory, hasn't shipped at scale |
| Concurrency | Comfortable with goroutines / async / locking; reasons about backpressure | Has used but not designed |
| Failure modes | Talks naturally about retries, idempotency, dedup, ordering | Treats failure as edge case |
| Code quality | Writes small, testable units; chooses simplicity over cleverness | Over-abstracts |
| Communication | Explains tradeoffs without ego | Defends every choice |

### Senior Frontend Engineer (React at scale)

| Signal | Strong | Weak |
| --- | --- | --- |
| Performance | Has shipped React app with measurable performance budget (TTI, TBT) | Vibes-based "felt fast" |
| State management | Understands when to lift, when to colocate, when to use server state | Always reaches for Redux |
| Real-time UI | Has built optimistic UI with rollback; understands WS reconnection UX | Webhook-only experience |
| Accessibility | Builds with screen readers, keyboard nav as defaults | Treats as "we'll add later" |
| Design partnership | Pushes back on bad design with reasons; co-creates solutions | Either compliant or combative |

### Senior AI Engineer (LLM systems)

| Signal | Strong | Weak |
| --- | --- | --- |
| Production AI | Has shipped LLM features at scale, knows the failure modes (cost, hallucination, drift) | Has notebook experience only |
| Eval discipline | Talks about held-out sets, rubric scoring, A/B harness | "We tested it manually" |
| Prompt + system design | Treats prompts as code; versions, tests, monitors | Magic-string prompts in app code |
| Tool / agent design | Has built tool-calling agents; knows the safety risks | Not aware of prompt injection |
| Cost reasoning | Talks tokens, caching, routing, fallback | "It's cheap" |

### SRE Lead

| Signal | Strong | Weak |
| --- | --- | --- |
| Operations | Has run prod for a multi-tenant system at > 100K users | Theory + tutorial |
| Observability | Has stood up an OTel pipeline; reasons about sampling | "We have Datadog" |
| Incident leadership | Has been IC for Sev1 incidents, written post-mortems | Hasn't been on-call meaningfully |
| IaC | Terraform / Pulumi at scale; module design | Cut-and-paste |
| Cost ownership | Has driven a cost-reduction initiative end-to-end | "Cost is finance's job" |

## 10. Performance management

**Levels:** E3 (mid), E4 (senior), E5 (staff), E6 (principal), E7 (distinguished). Promotion bar is delivery + scope + impact, not tenure. Calibration committee per cycle (twice a year).

**PIP policy:** clear performance plan after sustained miss against expectations, weekly check-ins, 30–60 day window with explicit success criteria. If they hit, we celebrate publicly. If not, we part respectfully. PIPs are not "managed-out" code words - they are a real chance.

**Conduct:** harassment, dishonesty, security violations are immediate.

**Calibration discipline:** I read every promo packet personally for the first year. The bar must hold even at growth.

## 11. Engineering culture

Written principles (one page, in repo, every new hire reads):

1. **Hands-on leadership.** Senior people stay close to the code.
2. **Ship and measure.** Belief is not evidence. Telemetry tells the truth.
3. **Post-mortems are blameless.** Systems and decisions, not people.
4. **No heroics.** A system that needs heroes is a broken system.
5. **Honest beats clever.** State what you actually know vs. assume.
6. **Build for the next person.** Design docs, runbooks, comments where it matters.
7. **Disagree and commit.** Once decided, we go in together.
8. **Bias to delete.** Less code is the goal, not more.
9. **Customer pain ranks first.** Internal preferences come second.
10. **Take the time to do it right.** But not longer.

**Psychological safety:** explicit anti-bullying, anti-public-shaming. Mistakes are post-mortemed, not punished. Anti-burnout: no expectation of weekend work; on-call comp time off; mental health day no-questions policy.

**Learning budget:** $1500/yr per engineer for books, courses, conferences. Conference travel sponsored at 1/yr senior + occasional speaker slot. Internal paper club bi-weekly.

## 12. Business framing - engineering choices → business outcomes

The engineering decisions in this pack ladder up to specific business outcomes. This matters because the JD is "Head of Engineering," and engineering at this level *is* a business function.

| Engineering choice | Business outcome |
| --- | --- |
| Capability-aware AI router (anchor A-BB4) | AI cost / DAU < $0.05 - protects gross margin |
| Per-workspace token budget enforcer | Eliminates "$5K-overnight" AI cost incidents - protects runway |
| Sub-250ms message-send p99 | Retention; users feel Qale faster than Slack |
| LLMOps telemetry mesh + replay (anchor A-BB5) | -60% MTTR - fewer outage hours, larger SLA credits avoided |
| SOC-2 Type II by Public Launch +6mo (anchor A-BB1) | Unlocks enterprise tier (8x deal size assumption) |
| Multi-tenant isolation discipline (anchor A-MS2) | Required for any enterprise sale |
| Region-pinning for data residency | EU + India enterprise customers buy |
| Engineering blog + open-source bits | Inbound recruiting + developer reputation |

The business numbers I'd hold us to at 12 months:
- 1M+ MAU, 200K+ DAU.
- AI cost / DAU < $0.05.
- Gross margin > 70% on the AI plane.
- < 4 production incidents per quarter (Sev2+).
- > 90% engineer retention.
- 1 SOC-2 Type II report.

Anchors that ground the financial framing: ShareChat ad team grew to **$20M revenue in a year** under my leadership (A-SC2); Microsoft AutoML platform contributed to **$100M+ in business value** with 200K+ users (A-MS3); BlackBox SOC-2 work directly **unblocked enterprise deals** (A-BB1).

## 13. What I'd ask the founders for

Stated explicitly so it's a deal point, not a surprise:

1. **Capex envelope for AI tokens** - pre-approved monthly ceiling that scales with users; no scrambling to justify the bill in a board meeting.
2. **Permission to push the launch date** if SLO gates aren't met. A bad launch is worse than a delayed one.
3. **Final say on architecture** - I'll bring debates to the table, but the architecture call is mine after RFC and discussion.
4. **Hiring bar ownership** - the bar is mine. Founders can challenge it, but the loop is mine to run.
5. **Two trusted senior engineers as my first hires** - not negotiable. Day-1 trust matters more than perfect rubric fit.
6. **Direct line to the security and compliance person we hire** - not routed through anyone else, given SOC-2 timeline.
7. **Quarterly board engineering update** - I present, not a relay through the CEO.

In return: I commit to delivery, the SLOs, the cost envelope, and the team I build.

## 14. What success looks like at 12 months

Concrete:
- 1M+ users.
- p99 message-send < 250ms in-region.
- AI plane unit economics positive (gross margin > 70%).
- SOC-2 Type II report in hand.
- ~25-engineer org in Hyderabad with three pods + SRE + security.
- < 10% regrettable attrition.
- < 4 Sev2+ production incidents per quarter.
- An engineering brand strong enough that we get >50% of senior hires inbound by month 12.

If we hit the first six, the company is positioned to do the next round at a meaningfully higher valuation, and the team is set up to sustain past 1M.

If we miss two of those six, I'd expect a hard conversation with the founders - and I'd want to be the one initiating it, not waiting for it.
