# 02 — Design Estimates: AI Banker for SMB Owners

Cashflow intelligence agent that behaves like a real SMB banker — answers Q&A, runs forecasts, executes payment actions with HITL gates, and pulls multi-source financial data. Target: 1M SMBs.

---

## 1. Use case and problem statement

SMB owners in India and global emerging markets lack a CFO or banker partner. Cashflow decisions are made ad-hoc from spreadsheets, WhatsApp screenshots, and a bookkeeper's WhatsApp PDF. The downstream cost is brutal: **40–50% of SMB failures cite cashflow management as root cause** — surprise payroll shortfalls, 90+ day receivables, missed GST deadlines, over-leveraged working-capital loans. None of the existing apps (Khatabook, Tally, RazorpayX) act like a banker; they're books or rails, not advisors. We are building a conversational agent that consolidates bank + accounting + payroll + tax + lender data and takes action under approval gates. Reuses the agentic platform pattern shipped at BlackBox: LangGraph ReAct runtime, durable DAG, model router, telemetry mesh (`resume.txt L51-54`, `blackbox-experience.md #6-15`).

---

## 2. Users and access patterns

| Persona | First/Third-party | Operations | Cadence | Auth |
|---|---|---|---|---|
| SMB founder/owner (primary) | First-party (mobile, web) | Morning cashflow check, ad-hoc Q&A, approve payments | Daily AM (8–10:30), spiky | OTP + biometric |
| Accountant / finance assistant | First-party (web) | Invoice tagging, vendor approval, reconciliation | Weekday business hours | SSO + role |
| Lender / credit partner | Third-party (REST + consent) | Underwriting read view, KFS pull | Sub-daily polling per active loan | mTLS + per-request consent token |
| Auditor | First-party (web, read-only) | Audit trail download | Quarterly bursts | SSO + scoped role |
| Background ingestion | First-party (workers) | Bank webhook events, accounting sync, OCR for paper invoices | Continuous | Service identity (SPIFFE) |
| AA (Account Aggregator) | Third-party data source | Pulls bank statements via FIU consent | Per-tenant consent-driven | RBI AA framework |
| GST/IT portal | Third-party data + action | Filing reminders, return status | Monthly + quarterly cycles | OAuth via partner |

Access pattern shape: 80% reads (Q&A, dashboards), 15% ingestion writes, 5% high-stakes action writes (payment, reminder, filing).

---

## 3. Existing options

| Option | What it does | Gap |
|---|---|---|
| Khatabook / OkCredit / Vyapar | Mobile bookkeeping ledgers | Bookkeeping, not advisory; no cashflow forecast; no actions |
| Tally / Zoho Books / QuickBooks | Source-of-truth accounting | No agentic intelligence; reports require human interpretation |
| RazorpayX Payroll, Razorpay Capital | Payroll rails, lender | Vertical-specific; no consolidated cashflow view across banks |
| Open / FinFloh / Bahi-Khata | Cashflow dashboards | Dashboards, not conversational; no proactive HITL action |
| Generic ChatGPT + spreadsheet | DIY Q&A | No real-time data, no tool actions, no audit trail, no tenant isolation |
| Brex / Ramp / Mercury (US) | Bundled bank + spend mgmt | Tied to their own bank; doesn't work across existing SMB bank accounts |

**Distinct wedge:** conversational + agentic + cross-source + actionable + audit-grade. No incumbent covers all five.

---

## 4. Why we are building it

- **Agentic action surface, not just reports.** Banker behavior = "send the reminder", "delay this payment", "draft the loan ask" — actions, not PDFs. Built on the ReAct + DAG pattern shipped at BlackBox (`blackbox-experience.md #7-13`).
- **Cross-source consolidation.** Bank + accounting + payroll + GST + lender in one tenant graph; no vertical incumbent owns the join.
- **Audit-grade explainability.** Every recommendation has a trace: source records, retrieved memory, model used, prompt hash, tool calls. Re-uses the deterministic-replay telemetry pattern from BlackBox 50M spans/day (`resume.txt L58-59`, `blackbox-experience.md #20`).
- **Multi-tenant agent infra at scale.** BlackBox runs 10K agent runs/day across enterprise tenants today; the same primitives scale horizontally to 1M SMBs (`resume.txt L51-52`).

---

## 5. Capacity and load estimates

### 5.1 Agentic checklist — load-bearing answers

The 20 points were reasoned through to set capacity. The load-bearing decisions:

| # | Decision | Capacity implication |
|---|---|---|
| 1 | Durable: graph state, run cursor, conversation history (Postgres). Ephemeral: LLM scratch. | Drives Postgres write IOPS, see §5.4 |
| 2 | Write tools (`initiate_payment`, `send_reminder`, `file_return`) carry idempotency-key UUIDs, dedup at tool-gateway for 24h | Redis dedup table sized in §5.4 |
| 3 | Max 15 hops/run, max 5 tool calls/node; ReAct loop dup (same tool+args within 3 hops) → halt-to-human | Caps per-run token/cost worst-case |
| 4 | Fan-out to AR / AP / Payroll subagents; all-of join, 30s soft deadline, partial-result OK | Drives 3x specialist worker count |
| 5 | Supervisor routing = structured-output classifier + rule table, not free-form LLM | Routing latency bounded; sized at 800ms p99/node |
| 6 | HITL gates: payment > ₹50K, loan acceptance, GST filing, any irreversible write. Checkpoint to Postgres on pause; resume by injecting `human_decision` into state | Pause-states retained 7d; sized below |
| 7 | Short-term = Redis run state; long-term = Postgres business profile; episodic = pgvector summaries | Triple-store, three sizing rows |
| 8 | Tool allow-list per agent node, enforced at tool-gateway not in prompt | Hard tenant + capability isolation |
| 9 | Read fail: retry 3x exp backoff → cached fallback w/ staleness banner. Write fail: only retry if idempotent; else halt + alert | Caps tail-latency blast radius |
| 10 | Agent↔agent via shared LangGraph state object per run; cross-run via Postgres event log; no direct RPC | Single Postgres write per node, see §5.4 |
| 11 | Each run = Postgres row with tenant_id RLS; workers stateless K8s pods, claim run; tenant scope enforced at every tool call | Workers horizontally scalable |
| 12 | Per-hop p99 = 800ms (LLM 400 + tool 200 + state-write 200); simple Q&A p95 = 6s, forecast p95 = 30s | Slot-occupancy math in §5.3 |
| 13 | Checkpoint after every node into Postgres `run_state` + WAL; resume by loading state | Drives ~5 Postgres writes per run |
| 14 | Graph definitions semver-versioned; in-flight runs pinned to start-time version | Migration-safe; no capacity cost |
| 15 | tenant_id propagated via signed run context; gateway enforces on every external call; vector store namespaced per tenant | Per-tenant pgvector partitioning |
| 16 | Sanitization between tool output and next prompt: strip control sequences, length-cap 4KB, injection-classifier; quarantine flagged | Adds ~50ms per tool call |
| 17 | Per-run token budget = 50K (configurable); 80% → compaction mode; hard cap → halt + summary | Bounds worst-case LLM cost |
| 18 | Saga pattern for write tools: every side-effect tool has compensation (`refund_initiated_payment`, `recall_invoice_reminder`); coordinator invokes on failure | Adds saga-log writes in Postgres |
| 19 | OTel trace per run, span per node, hop-counter metric, time-in-node histogram; **MTTD SLO for stuck/looping run = 60s p95** via two alarms: `time_in_node > 30s` (per-node stall) and `hop_counter_rate == 0 for 45s` (graph-level stall), both wired to PagerDuty SEV-3 with run_id deep-link to the Grafana trace view | ClickHouse spans sized in §5.4; alarms are stateless ClickHouse queries on the span stream |
| 20 | Peak = 50K concurrent runs (5% of 1M MAU in 30-min peak); fan-out 3 (supervisor → ~3 specialists); supervisor concurrency = bottleneck; size for 10K supervisor RPS. **Backpressure ladder:** (a) supervisor input queue (Redis Streams) hard-capped at 20K depth (2× steady-state); (b) at 70% depth → admission-controller starts shedding non-priority intents (proactive alerts, memory-only Q&A) with HTTP 503 + retry-after; (c) at 90% depth → shed all but P0 (payments/HITL resumes); (d) HPA triggers a +50% supervisor pod scale-out at 60% sustained CPU for 90s OR queue-depth > 12K for 60s, whichever fires first; (e) circuit-open on supervisor returns a cached "service degraded — please retry in 60s" reply to user, never enqueues silently | Drives full fleet in §5.4; admission-controller is a 50-line sidecar on the supervisor pod |

### 5.2 Subscriber funnel and run volume

| Stage | Value | Derivation |
|---|---|---|
| MAU | 1,000,000 SMBs | Target |
| DAU | 300,000 | 30% DAU/MAU (typical SaaS-with-daily-utility) |
| Peak concurrent runs (30-min window) | 50,000 | 5% of MAU active in peak; ASSUMPTION (morning cashflow check is the spike) |
| Runs per SMB per month | 8 | 5 Q&A + 2 alerts + 1 action; ASSUMPTION |
| Total runs / month | 8,000,000 | 1M × 8 |
| BlackBox baseline | 10K runs/day = 300K/month | `resume.txt L52` |
| **Scale multiple vs BlackBox** | **~27×** | Flag as growth-target ASSUMPTION |

### 5.3 Throughput, token, storage, bandwidth math

**LLM throughput.**
- 50,000 concurrent × avg 5 hops × 1 LLM call/hop = **250,000 LLM calls / 30 min peak**
- = 250,000 / 1,800s = **~140 LLM RPS sustained peak** (provision for 2× burst = 280 RPS)
- Avg 3K tokens/call × 250K calls = 750M tokens / 30 min
- Hourly: 750M × 2 = 1.5B tokens/hour at peak; averaged over month: ~18B tokens/month
- BlackBox baseline: 1B tokens/month (`resume.txt L55-56`). **18× scale** — flag as ASSUMPTION.

**Storage growth per SMB per day.**

| Component | Per SMB/day |
|---|---|
| Conversation turns: 10 × 5KB state | 50 KB |
| Vector store: 20 embeddings × 1.5KB | 30 KB |
| Bank/invoice ingest: 50 records × 2KB | 100 KB |
| **Total** | **~180 KB/SMB/day** |
| At 300K DAU | 300K × 180KB = **~54 GB/day raw** |
| Hot retention (90 days) | 54 × 90 = ~5 TB |
| Annual retained-hot (with 7yr regulatory retention archived) | **~20 TB/year hot, ~140 TB cold** |

**Bandwidth.**
- Ingestion peak: bank webhooks + AA + accounting sync = ~100 Mbps peak
- LLM egress (provider HTTPS): 250K calls × 3KB avg payload = ~50 Mbps peak
- Total egress + ingress: ~5 TB/month bandwidth

### 5.4 Per-tier fleet sizing (m8g reference)

Anchor prices (AWS US-East On-Demand): m8g.2xl ~$0.32/hr, m8g.4xl ~$0.64/hr, m8g.8xl ~$1.28/hr, m8g.16xl ~$2.56/hr. r8g.4xl ~$0.96/hr, r8g.8xl ~$1.92/hr, c8g.4xl ~$0.57/hr, g6.xl ~$0.81/hr. Fleet sized with **1.5× headroom**.

| Tier | Instance | Count | vCPU total | RAM total | Reasoning | Monthly $ |
|---|---|---|---|---|---|---|
| API gateway / BFF (Node/Go) | m8g.2xlarge | 20 | 160 | 640 GB | Stateless; 10K RPS peak; ~500 RPS/pod | ~$4,600 |
| Supervisor agent workers (Python) | m8g.4xlarge | 40 | 640 | 2.56 TB | 50K hop-slots/sec, ~50 hops/sec/pod → ~1000 pods worth of work but compressed by 10:1 (await-heavy I/O) | ~$18,400 |
| Specialist agent workers (Python) | m8g.4xlarge | 80 | 1,280 | 5.12 TB | 3× supervisor fan-out (AR/AP/Payroll) | ~$36,900 |
| Tool gateway (Go) | m8g.2xlarge | 30 | 240 | 960 GB | mTLS-heavy, 30K RPS, conn-pooled to external (banks/AA/GST) | ~$6,900 |
| Forecast engine (Python+numpy) | c8g.4xlarge | 10 | 160 | 320 GB | CPU-bound numeric; **deviation from m8g** (compute-optimized lower RAM cost) | ~$4,100 |
| Ingestion workers (parse/normalize) | m8g.4xlarge | 20 | 320 | 1.28 TB | Burstable; bank statements, accounting CSV, JSON webhooks | ~$9,200 |
| OCR workers (paper invoices) | g6.xlarge | 4 | 16 | 64 GB | GPU for layout-aware OCR | ~$2,300 |
| Postgres (Aurora — run state + biz data) | r8g.4xlarge | 6 | 192 | 1.5 TB | 3 writer regions + 3 read replicas; **deviation: memory-bound** | ~$4,100 |
| Redis (run cache, idempotency, session) | m8g.2xlarge | 6 (cluster) | 48 | 192 GB | 6-shard cluster, 1 replica each | ~$1,400 |
| Vector store (pgvector / Qdrant) | r8g.8xlarge | 8 | 512 | 4 TB | io2 NVMe; tenant-namespaced; 18B vectors/yr addressable | ~$11,000 |
| Kafka (event bus) | m8g.4xlarge | 9 | 144 | 576 GB | 3 brokers × 3 AZ; ingestion + saga + telemetry topics | ~$4,100 |
| ClickHouse (telemetry) | m8g.16xlarge | 6 | 384 | 1.5 TB | Anchored on BlackBox 50M spans/day pattern (`blackbox-experience.md #20`); SMB peak ~80M spans/day | ~$11,000 |
| **Compute + storage subtotal** | | | | | | **~$114,000 / month** |
| LLM inference (managed Claude/GPT, mixed) | — | — | — | — | 18B tokens × ~$20/M tokens blended | **~$360,000 / month** |
| **Grand total at 1M MAU peak** | | | | | | **~$475K / month** |

Compute fits the predicted "$80K–$120K compute + $300K–$500K LLM tokens" envelope. LLM tokens dominate ~3:1 — first-order optimization target is router + compaction (BlackBox model router pattern, `resume.txt L55-56`).

---

## 6. Functional and non-functional requirements

### 6.1 Functional

- **Conversational Q&A** over cashflow, AR/AP, payroll, taxes, runway, vendor history.
- **Proactive alerts** — cash-low threshold, invoice 30/60/90 day overdue, payroll T-3 risk, GST/TDS due, credit line utilization.
- **Action execution with approval gates** — initiate payment, send reminder, draft loan ask, file GST return; HITL on irreversible / high-value.
- **Forecast and scenario simulation** — "if I delay this payment 2 weeks", "if collection cycle improves 10 days".
- **Lender connectivity** for working-capital loan applications with consented underwriting data pull.
- **Multi-source ingestion** — bank (direct + AA), accounting (Tally/Zoho/QuickBooks), payroll (RazorpayX), tax/GST portals.
- **Per-business memory and personalization** — vendor relationships, seasonal patterns, owner risk preference.
- **Audit trail** — every recommendation and action has full lineage: source records, model, prompt hash, retrieved context, tool calls.

### 6.2 Non-functional

| Dimension | Target |
|---|---|
| Latency — simple Q&A | p50 2s, p95 6s, p99 12s |
| Latency — forecast | p95 30s |
| Latency — action confirmation | p99 5s |
| Availability — control plane | 99.9% |
| Availability — read APIs | 99.95% (degraded-read mode if writes down) |
| Durability — transactional store | 99.999999999% (Aurora) |
| Durability — object store | 11 9s |
| RTO | 15 min |
| RPO | 5 min |
| Compliance | SOC-2 Type II, ISO 27001, RBI data localization (India), DPDP (India), GDPR (EU) |
| Tenant isolation | Gateway tenant header + Postgres RLS + per-tenant vector namespace + per-tenant K8s namespace for noisy-neighbor cap |
| Token budget per run | 50K hard cap; 80% warn-then-compact |
| Hop cap per run | 15 hops; same-tool-same-args within 3 hops → halt |

### 6.3 Out of scope (explicit)

- **Holding customer funds.** Not a bank, not a PPI; payments routed via partner PA/PG.
- **Credit underwriting decision.** Underwriting delegated to partner lenders; we only assemble & forward the underwriting packet under consent.
- **Tax filing for non-India.** India GST/TDS first; US/EU tax filings deferred to phase 2.
- **Investment / wealth advice.** Cashflow only, no securities recommendations (SEBI scope avoidance).

---

## ASSUMPTIONS (called out)

1. 1M MAU target — extrapolated from BlackBox 10K runs/day baseline (`resume.txt L52`); 27× scale.
2. DAU/MAU = 30%, concurrent-peak = 5% MAU — typical SaaS-with-daily-utility; needs validation in beta.
3. 8 runs/SMB/month — pre-launch guess; could be 3× higher if proactive alerts dominate.
4. Avg 5 hops/run, 3K tokens/call — pattern from BlackBox runtime; SMB queries may be simpler.
5. LLM blended cost $20/M tokens — assumes Sonnet-class default, Haiku-class for classification; will swing 2× with router quality.
6. Compute headroom 1.5× — standard; HA + spike + canary deploys consume the rest.
