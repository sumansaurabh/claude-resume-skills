# 02 - Design Estimates

## Use case and problem statement

A retail bank wants every customer to have a **personal banker in their
pocket** — someone who can answer "where did my money go", "can I afford this
EMI", "is this charge fraud" in seconds, at any hour, in the customer's
language, without queuing for a human. Branch bankers cost ~₹150-300 per
interaction and don't scale to 200M+ customers; IVR menus cap at trivial
flows. The cost of *not* building this is twofold: (1) the bank loses the
relationship to fintech super-apps that already do this, and (2) high-margin
products (FD, mutual funds, personal loans) lose their natural in-context
distribution channel.

The architectural shape is anchored in the user's BlackBox experience:
**LangGraph DAG, durable execution, tool-calling, model routing, replayable
traces** — the same primitives that supported 10K+ agent runs/day at BlackBox
(`resume.txt` L51-54), now applied to a regulated banking domain.

## Users and access patterns

| Persona | Operations | Cadence | Latency sensitivity |
|---|---|---|---|
| **Retail customer (primary)** | Conversational Q&A in app or WhatsApp: balance, spend, EMI, fraud, savings | 3-8 turns/session, 2-4 sessions/week per active user | Hard p95 < 3s for "look-up" questions; < 15s for "analyze my spending" |
| **Premium / wealth customer** | Same as above + investment what-ifs, FD sweeps, multi-account view | 5-15 turns/session, daily | Soft p95 < 4s; richer reasoning budget allowed |
| **Joint-account dependent (spouse, child)** | Read-only view-of-self, alerts | low | Same |
| **Branch banker (assisted)** | Uses agent as a co-pilot during in-branch interactions | bursty | < 2s — needs to be invisible in conversation |
| **Fraud ops (internal)** | Reads agent's flagged-transaction stream, escalates true positives | streaming | n/a (queue) |
| **Compliance / audit (internal)** | Replays agent runs, exports evidence for RBI / DPDP audits | weekly batch | n/a (offline) |
| **Core Banking System (callee)** | Owns truth: accounts, ledger, cards, deposits — agent reads via API | every call | < 200ms per call (agent budget depends on it) |

Cadence assumption: 10M MAU on the bank app → ~3M DAU → average 1.5
sessions/day → ~4.5M sessions/day → ~25M agent turns/day at steady state.
Peak (1st-of-month salary day, EMI day) is ~3x average.

## Existing options and build-vs-buy

| Option | Shape | Gap |
|---|---|---|
| **Off-the-shelf IVR / chatbot (Kore.ai, Yellow.ai)** | Intent classifier + scripted flows | No multi-step reasoning; no deterministic calculator integration; weak explainability; no first-class memory; provider lock-in for prompts |
| **Plain ChatGPT / Claude with banking RAG** | Single LLM call over retrieved docs | Will *invent numbers*; no deterministic guarantee; no audit trail; no action plane; no checkpointing |
| **LangChain agent (single-agent ReAct)** | One ReAct loop with all tools exposed | No structural separation between deterministic and LLM steps; hard to bound tool use; observability is opaque; this is what we replaced at BlackBox in favor of LangGraph (`resume.txt` L51-52) |
| **Pure rules engine (Drools, internal)** | Decision tables only | Cannot personalize, cannot explain in natural language, cannot handle paraphrased questions |
| **Build on LangGraph + Pydantic + OTel** | DAG of typed nodes, deterministic + LLM hybrid | Closes all gaps above; matches our team's existing competence |

## Why we are building it

- **Regulatory defensibility.** Every customer-visible number must be
  reproducible from ledger + a deterministic formula. Off-the-shelf
  LLM products do not guarantee this; we have to own the deterministic
  plane.
- **Auditability for DPDP / RBI.** Each session must be replayable, each
  tool call logged with input/output, each LLM call captured with model
  version + prompt hash. We already do this at 50M spans/day at BlackBox
  (`resume.txt` L58-59); the same telemetry pattern lifts cleanly.
- **Data sovereignty.** Customer transaction data cannot leave the bank's
  cloud boundary. A managed vendor solution that ships prompts to a US-
  hosted LLM is a compliance blocker. We need a sanitization+tokenization
  layer in our own VPC.
- **Latency budget.** Sub-3-second conversational answers require fan-out,
  parallel tool calls, and tight prompt sizes — possible only when we
  control the orchestrator.

## Capacity and load estimates

**User base (assumption — bank-dependent):** 10M MAU → 3M DAU.

**Sessions:**
- DAU × 1.5 sessions/day = **4.5M sessions/day**.
- 5.5 turns/session (avg) = **~25M agent turns/day** ≈ **290 turns/sec** avg,
  **~900 turns/sec** peak.

**Tool calls per turn:** average 3 (1 fetch + 1 calculator + 1 LLM explainer);
deep-analysis turns may issue 8-12.
- Steady-state tool calls: **~75M/day** ≈ **870/sec** avg.
- Core-Banking API hit rate: ~40% of tool calls → **~30M/day** to core, well
  within typical bank read traffic — but spikes need budget headroom.

**Token volume:**
- Avg turn: 1.5k input tokens (system + user + 2 tool outputs trimmed) + 400
  output tokens = ~1.9k tokens/turn.
- 25M turns/day × 1.9k = **~47B tokens/day** ≈ **~1.4T tokens/month**.
- This is on the order of our BlackBox 1B tokens/month router experience
  (`resume.txt` L55-56), but ~1000x. Implies aggressive caching, prompt
  compaction, and tiered model routing (Haiku for routing, Sonnet for
  explanation, Opus only for escalations).

**Cost ceiling at scale:**
- Blended ~$0.5/M tokens with caching + Haiku-dominant routing → ~$700K/day
  → ~$21M/month for inference alone. This is the load-bearing reason we
  cannot use one big model for every turn; the router decision is a
  cost decision.

**Storage:**
- Per-turn trace: ~12 KB (prompts, tool I/O, scores). 25M × 12 KB = **~300
  GB/day** raw → ~9 TB/month → **~110 TB/year** before compression.
  ClickHouse + zstd brings ~10x reduction; analogous to BlackBox's
  2.5 TB/month trace mesh (`resume.txt` L58-59).

**Memory store:**
- ~200 KB per active user (goals, profile, embedding-indexed summaries).
- 10M users × 200 KB = **~2 TB**. Postgres + pgvector tier.

## Functional requirements

- Answer balance, spend, fraud, EMI, savings, FD, due-date questions.
- Issue structured explanations with *citations* to which transactions /
  rules were used.
- Reflect / self-correct when calculator vs LLM disagree (numerical drift
  > 1% triggers re-explain with the deterministic number).
- Execute safe actions: set reminder, mark transaction disputed (ticket),
  raise support ticket, push notification.
- Refuse / escalate: anything that moves money, anything outside the
  trained intent set, anything where calculator confidence is low.
- Speak Hindi + English (MVP), tone adapts per locale.

## Non-functional requirements

| NFR | Target |
|---|---|
| Conversational latency p95 | < 3s |
| Deep-analysis latency p95 | < 15s |
| Availability | 99.95% (read path); 99.9% (action path) |
| Durability of transactions/audit | 11 nines (object-store backed, immutable) |
| Numerical correctness | 100% match with core ledger for any displayed ₹ amount |
| Recovery time (RTO) | < 5 min for stateless nodes; < 30 min for memory store |
| Recovery point (RPO) | 0 for ledger-derived data; < 5 min for memory |
| Tenant isolation | Per-customer row-level; cross-customer leak = SEV-1 |
| PII redaction | Account numbers, PAN, Aadhaar tokenized before LLM egress |
| Audit retention | 7 years (RBI), trace-level, replayable |

## Out of scope

- Money movement (NEFT, IMPS, UPI initiation) — agent surfaces the intent,
  customer initiates in the standard payment flow.
- KYC / onboarding — separate compliance flow.
- Investment advisory beyond "education" — needs SEBI-registered advisor.
- Cross-bank account aggregation (Account Aggregator integration) — Phase 2.
