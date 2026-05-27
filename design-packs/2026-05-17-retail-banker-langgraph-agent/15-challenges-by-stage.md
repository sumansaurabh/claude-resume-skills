# 15 - Challenges From Inception To Frontier (Rated)

A stage-by-stage walk through the hard problems that show up when you
actually build a retail-banking LangGraph agent at consumer scale, not
the demo path. The orchestration spine is the same one we ran at
BlackBox for 10K+ agent runs/day (`resume.txt` L51-54); the banking
domain adds compliance, money risk, and human consequences that the
BlackBox surface didn't carry.

Each challenge is rated on three axes:

- **Severity (1-10):** how badly it bites if you get it wrong.
  10 = product can't ship / regulator pulls the plug; 1 = paper cut.
- **Frequency (1-10):** how often the team actually hits it.
  10 = daily; 1 = once in the program's life.
- **Difficulty (1-10):** how hard it is to *correctly* solve, not just
  hack around. 10 = open research; 1 = read the manual.

Composite **Pain** = `Severity × Frequency × Difficulty / 10`, capped
at 100, rounded to one decimal. Above 50 = top-tier; below 10 = paper
cut.

The stages map to the life of the program, not the life of a single
turn:

1. Inception (weeks 0-12)
2. Early scale (months 3-9, first cohort)
3. Production hardening (months 6-18)
4. Multi-tenant scale (months 12-30; multi-bank / multi-region)
5. Frontier / next-platform (months 18+)

---

## Stage 1: Inception (weeks 0-12)

**Stage truth:** every Day-1 *contract* you skip - typed state, tool
registry, PII tokenization, deterministic/LLM seam - compounds into
multi-quarter rework. Product intent surface is fuzzy and that's OK.
*Contracts* are not allowed to be fuzzy.

### C1.1 Choosing the deterministic-vs-LLM seam wrong

- **Severity: 10** - go-live compliance blocker; a wrong ₹ visible to
  RBI is a different conversation than a wrong word.
- **Frequency: 1** - architectural decision made once.
- **Difficulty: 7** - the demo-week temptation is "let the LLM do
  it"; the discipline to push back without slowing demos is the hard
  part.
- **Pain: 7.0**

If the prototype lets the LLM emit ₹ amounts and you cite that
prototype in the leadership review, you spend month 4-6 prying it
back out. The right answer from week 1: numbers come from
calculators; LLM only narrates calculator outputs.

### C1.2 Tool registry contract before the 4th tool exists

- **Severity: 8** - every node breaks every time a tool is added;
  LLM JSON schemas leak inconsistencies.
- **Frequency: 7** - every PR that adds or touches a tool.
- **Difficulty: 4** - the technology is a decorator + Pydantic; the
  *discipline* is the hard part.
- **Pain: 22.4**

Without a single `@tool` decorator that owns input/output schemas, OTel
spans, side-effect flags, and JSON-schema export, you get four
engineers inventing four shapes. The same lesson came up at BlackBox
LangGraph tool-calling infrastructure (`resume.txt` L51-54): typed
registries are not premature optimization for an agent platform; they
are the *first* line of code.

### C1.3 PII tokenization at egress, Day 1 not Day 60

- **Severity: 10** - DPDP / RBI compliance gate.
- **Frequency: 1** - architectural decision made once.
- **Difficulty: 6** - token-vault lifetime, re-detokenization
  ordering, and ensuring tool outputs *also* flow through the
  tokenizer are subtle.
- **Pain: 6.0**

Same shape as the Microsoft "workload identity on Day 1, not as a
retrofit" lesson (`microsoft-experience.md` + `resume.txt` L88-89
secure multi-tenant ML infra) and the SOC-2 work on the WASM sandbox
plane (`resume.txt` L49-50). The temptation in week 2 is "we'll redact
later"; the cost in month 6 is rewriting every prompt template, every
tool serializer, and the evals.

### C1.4 `BankerState` shape before you have all intents

- **Severity: 8** - every node refactors when state shape changes.
- **Frequency: 1** - once.
- **Difficulty: 6** - over-shape it and writes thrash; under-shape it
  and you can't replay.
- **Pain: 4.8**

The state object is the load-bearing artifact of the graph. Get it
right and unit tests are one-line; get it wrong and the test suite
fights you for six months. Anchor to BlackBox graph workflow engine
with DAG execution + memory persistence (`resume.txt` L52-54):
durable workflows live or die by their state object.

### C1.5 Building the reflection node existence (not "later")

- **Severity: 9** - discovery via prod = a wrong-₹ incident in week 12.
- **Frequency: 1** - once.
- **Difficulty: 5** - the comparator itself is simple; the prompt
  templating that marks `exact` vs `approx` slots is what makes it
  reliable.
- **Pain: 4.5**

The reflection node is a small piece of code that closes a large
class of bugs. Skipping it in inception saves a week and costs a
month later when the first hallucinated number ships.

### C1.6 Intent classifier model choice without a golden set

- **Severity: 6** - wrong routing → wrong sub-agent → wrong answer.
- **Frequency: 3** - every router change.
- **Difficulty: 6** - frontier model is too expensive at 290 turns/s;
  small model accuracy lower; need eval set you don't have yet.
- **Pain: 10.8**

Decision: ship with a frontier Haiku-class model, build the golden
set from the first 4 weeks of real traffic, then evaluate a
quantized in-VPC small model as a replacement. Same migration arc
from the BlackBox model router across Claude/GPT/Grok (`resume.txt`
L55-56).

---

## Stage 2: Early scale (months 3-9, first cohort)

**Stage truth:** the architecture survives but operational behavior
breaks the moment more than one customer uses it concurrently. Bursts
are the new enemy.

### C2.1 Salary-day / EMI-day burst on Core Banking

- **Severity: 9** - Core Banking throttles → `context_fetch` times
  out → degraded answers across the bank, on the days customers most
  want answers.
- **Frequency: 5** - twice a month, 6 months = ~12 times in the
  stage.
- **Difficulty: 7** - pre-warming caches needs prediction; circuit
  breaker thresholds need careful tuning; balance-freshness rules
  conflict with cache hits.
- **Pain: 31.5**

Anchor: AutoML at Microsoft, 15M+ jobs/month with bursty submission
patterns (`resume.txt` L91-92) taught the same lesson - peak design
is a different problem from average design. Mitigation: pre-warm
top-decile balance cache 30 minutes before predicted salary windows;
per-tool circuit breaker that returns `degraded` instead of cascading.

### C2.2 Long-tail intents the router misclassifies

- **Severity: 6** - wrong intent → wrong sub-agent → confused user.
- **Frequency: 7** - every novel phrasing.
- **Difficulty: 6** - needs telemetry-driven re-prompting + new
  golden examples per misclass.
- **Pain: 25.2**

"Can I afford to buy a house" routes to `emi_affordability` when the
customer actually wants `savings_advice`. Rule-engine discipline
from ShareChat ad-targeting on 22 user attributes for 40M DAU
(`resume.txt` L109-114) applies here: the long tail is not solved
by "smarter prompts" - it is solved by labeled telemetry and
deliberate rule additions.

### C2.3 Cross-customer cache leak via missing key prefix

- **Severity: 10** - SEV-1; regulator-facing.
- **Frequency: 1** - caught in a test or once in prod.
- **Difficulty: 7** - the fix is trivial; *catching it before prod*
  is where the engineering goes (chaos test that issues
  cross-customer reads and asserts denial).
- **Pain: 7.0**

Anchor: secure multi-tenant ML infrastructure across Kubernetes and
Azure (`resume.txt` L88-89). The lesson there: tenant isolation is
not a feature; it's an invariant, and it must be *tested
adversarially* in CI, not assumed.

### C2.4 Action idempotency under client retry storms

- **Severity: 7** - duplicate tickets, duplicate notifications;
  CSAT damage.
- **Frequency: 6** - happens daily once you have flaky mobile
  networks.
- **Difficulty: 5** - idempotency keys + 24h dedup window solve
  it; the difficulty is ensuring *every* write tool uses the
  pattern.
- **Pain: 21.0**

Durable execution at BlackBox (`resume.txt` L52-54): idempotency is
how durable workflows stay safe under retry. The same key shape
(`sha256(turn_id || tool || canonical(args))`) generalizes.

### C2.5 Memory write coalescing under per-turn fact writes

- **Severity: 7** - Postgres connection saturation = whole DAG
  blocks.
- **Frequency: 8** - every active session.
- **Difficulty: 4** - buffer + debounce per session, flush on
  session close.
- **Pain: 22.4**

Anchor: agent memory persistence work at BlackBox (`resume.txt`
L54). Naive memory write per turn is the most common way to take
down the memory store. Coalesce or you die at the second cohort.

### C2.6 Eval set drift as intents are added

- **Severity: 6** - new intent passes eval but fails on
  uncovered phrasing in prod.
- **Frequency: 5** - every intent addition.
- **Difficulty: 6** - backfilling golden examples is human-cost;
  LLM-generated examples drift from real users.
- **Pain: 18.0**

The LLMOps team can scale eval automation faster than the product
team can pretend they don't need it. The 50M spans/day BlackBox
telemetry mesh (`resume.txt` L58-59) is the supply of real examples
to mine for eval growth.

---

## Stage 3: Production hardening (months 6-18)

**Stage truth:** the product works for the median user; reliability,
edge cases, and the rare-but-painful bugs dominate. New features
slow down; debugging speeds up.

### C3.1 Numerical drift in streamed narration before reflection runs

- **Severity: 8** - user sees wrong number in stream, even if final
  response is correct.
- **Frequency: 4** - happens on a few percent of streamed turns at
  rare moments.
- **Difficulty: 7** - reflection runs at end of explainer; streaming
  doesn't wait.
- **Pain: 22.4**

Mitigation: stream only the `headline` *after* the canonical number
is locked from `calc.*`; stream drivers/recommendation tokens as
the LLM produces them. Trade-off: 200-400ms perceived-latency hit on
streamed turns for numerical safety.

### C3.2 Provider outage failover causes voice drift

- **Severity: 7** - users perceive "the agent feels different
  today"; CSAT dips.
- **Frequency: 2** - provider outages are rare but real.
- **Difficulty: 8** - failover model needs to be voice-matched to
  primary, which requires shared style guide + eval per model.
- **Pain: 11.2**

Anchor: BlackBox multi-model routing across Claude/GPT/Grok
(`resume.txt` L55-56). Failover by capability *class* is solved;
failover by *voice* is the harder problem. Mitigation: each
explainer prompt template is calibrated per model; router prefers
within-provider model swap (Sonnet→Opus) before cross-provider.

### C3.3 Tool-data prompt injection becomes a real attack

- **Severity: 10** - successful injection that causes a fake action
  is a front-page story.
- **Frequency: 2** - red-team finds; in-wild attempts rare but rising.
- **Difficulty: 8** - defense-in-depth requires every layer to hold.
- **Pain: 16.0**

Anchor: SOC-2 work on the WASM sandbox plane for 1M+ daily zero-shot
executions (`resume.txt` L49-50). Same multi-layer defense pattern:
runtime allowlist (architectural), tagged tool data (prompt-level),
policy gate + HITL (execution-level). No single layer can hold; all
three must.

### C3.4 HITL queue aging when ops team is understaffed

- **Severity: 7** - customer asked 4 hours ago, no answer = agent
  failure narrative.
- **Frequency: 6** - recurs every weekend / holiday.
- **Difficulty: 5** - solved by tiered escalation + proactive
  customer notification.
- **Pain: 21.0**

Often misclassified as "ops problem, not engineering"; the right
framing is "the agent product owns the customer experience including
the HITL path". The eng team builds aging metrics + proactive
customer status updates so the product doesn't appear broken.

### C3.5 Replay fixtures diverge from live schema after months

- **Severity: 8** - 6-month-old replay can't be reconstructed
  cleanly; dispute investigation stalls.
- **Frequency: 2** - handful of customer disputes a quarter that go
  back this far.
- **Difficulty: 7** - every schema migration must be backward-
  compatible for replay, which constrains evolution.
- **Pain: 11.2**

Anchor: deterministic replay at BlackBox (`resume.txt` L58-59,
`blackbox-experience.md` #20). Lesson learned: replay is not free;
it is a constraint on every schema change. Document this trade-off
or pay for it later.

### C3.6 Telemetry storage cost outruns growth

- **Severity: 6** - finance pushes back on retention; you can't
  cut without breaking the 7-year audit promise.
- **Frequency: 7** - every quarterly cost review.
- **Difficulty: 6** - tiered storage (hot 30d ClickHouse, warm 1y
  Parquet on S3, cold 7y Glacier) works; the *predicate-pushdown*
  to make warm tier queryable is the engineering.
- **Pain: 25.2**

Anchor: BlackBox 50M spans/day, 2.5TB monthly (`resume.txt` L58-59).
The cost equation is solved; the *queryability* of the cold tier
under a regulator audit is the new problem at multi-year retention.

---

## Stage 4: Multi-tenant scale (months 12-30; multi-bank / multi-region)

**Stage truth:** policy, isolation, and governance dominate. Most
remaining technical problems are well-understood; the new pain is
organizational and regulatory.

### C4.1 Per-bank policy bundle drift

- **Severity: 7** - each bank tunes its own OPA policies → eval set
  per-bank → release engineering complexity explodes.
- **Frequency: 7** - every bank's compliance team requests its own
  rule.
- **Difficulty: 7** - needs a policy-bundle versioning + per-bank
  CI + golden-policy diff in the review.
- **Pain: 34.3**

The lesson hidden here: a multi-tenant agent platform is also a
multi-tenant *policy* platform, and the policy story has to be
first-class. No equivalent from BlackBox single-tenant product;
this is a *Microsoft AutoML*-style multi-tenant lesson (`resume.txt`
L91-92).

### C4.2 Regional regulatory divergence

- **Severity: 9** - one country's regulator changes a rule → all
  banks in that country must comply by a deadline.
- **Frequency: 4** - major changes a few times a year per region.
- **Difficulty: 8** - DPDP vs GDPR vs RBI vs MAS - one agent code,
  four policy regimes, four data-residency stories.
- **Pain: 28.8**

Anchor: secure multi-tenant ML infrastructure across regions
(`resume.txt` L88-89). The architectural answer: pluggable
policy + residency + audit modules, selected per `tenant.region`.
The organizational answer: a regulatory liaison per region who
owns the policy bundle.

### C4.3 Cross-bank LLM provider quota contention

- **Severity: 8** - one bank's noisy day starves another bank's
  customers; cross-tenant SLA violation.
- **Frequency: 4** - happens during one tenant's seasonal spike.
- **Difficulty: 7** - per-tenant LLM quota reservation + burst
  budget + fair-share routing.
- **Pain: 22.4**

Anchor: BlackBox model router across Claude/GPT/Grok at 1B
tokens/month (`resume.txt` L55-56). Per-tenant quota in a shared
provider pool is the lesson that comes after "we have multi-provider
failover". Both are needed.

### C4.4 Per-tenant fine-tuning vs shared base model

- **Severity: 6** - banks want "model trained on our voice"; we
  don't want N fine-tunes to maintain.
- **Frequency: 3** - comes up in every enterprise sales cycle.
- **Difficulty: 8** - fine-tuning per tenant means N eval sets,
  N drift stories, N rollback plans.
- **Pain: 14.4**

Anchor: fine-tuning experience from Microsoft AI Fine-tuning on
IPP, 20B+ tokens annually (`resume.txt` L73-74). Lesson learned:
per-tenant fine-tunes are *operationally* expensive in ways the
sales pitch doesn't capture. Default answer: shared base + per-
tenant prompt customization + per-tenant LoRA adapters only when
the value is provable.

### C4.5 Cross-region trace correlation when sessions roam

- **Severity: 5** - customer uses in-app (region A) then WhatsApp
  (region B) in same session; trace stitches poorly.
- **Frequency: 4** - common for travelers and multi-device users.
- **Difficulty: 7** - distributed trace IDs across region clusters
  with residency rules.
- **Pain: 14.0**

Anchor: BlackBox telemetry mesh (`resume.txt` L58-59) - single-
region. Multi-region trace stitching is the upgrade.

---

## Stage 5: Frontier / next-platform (months 18+)

**Stage truth:** ambition outpaces governance. New ambitions (proactive
agent, voice, in-house fine-tuned sub-agents, Account Aggregator) each
re-open settled assumptions. The organization, not the architecture,
is the bottleneck.

### C5.1 Proactive-agent notification you didn't ask for

- **Severity: 9** - wrong proactive ping = customer trust event;
  could be regulatory if "advice".
- **Frequency: 3** - happens during early proactive feature rollout
  on a non-trivial subset of triggers.
- **Difficulty: 8** - needs an entire consent + opt-out + frequency-
  governance system the reactive agent didn't need.
- **Pain: 21.6**

The shift from reactive ("user asked") to proactive ("agent decides
to ping") is a *product* shift that re-opens half the policy
decisions. Don't do this until the reactive product has been clean
for 6 months.

### C5.2 Voice channel forcing a new latency budget

- **Severity: 7** - voice needs sub-700ms first-token; current p95
  is 3s. Mismatch = unusable.
- **Frequency: 5** - recurs on every voice-feature design review.
- **Difficulty: 8** - streaming pipeline + smaller routing model +
  pre-computed common responses; rebuilds the explainer for
  partial-output mode.
- **Pain: 28.0**

The DAG shape survives voice but the *streaming contract* changes
fundamentally. Plan the streaming primitive in the DAG from the
start (we did: `WS /v1/conversations/.../stream`), or pay to
retrofit it.

### C5.3 In-house fine-tuned sub-agents drift from frontier explainer

- **Severity: 6** - sub-agent fine-tune Q1, explainer is frontier-
  current Q3 → tone/fact mismatch users feel.
- **Frequency: 5** - every frontier model release.
- **Difficulty: 7** - re-train cadence + paired eval + tone
  calibration.
- **Pain: 21.0**

Anchor: BlackBox model router orchestration across Claude/GPT/Grok
(`resume.txt` L55-56). Migrating cheap paths to in-house models is
the right *cost* answer; the *quality* answer requires paired-eval
discipline.

### C5.4 Account Aggregator (AA) integration

- **Severity: 7** - cross-bank view is the value prop, but consent
  flow is regulator-defined and brittle.
- **Frequency: 3** - every AA partner integration.
- **Difficulty: 8** - consent lifetimes, residency, multi-bank
  trust boundary, sandboxed agent reasoning on data from another
  FI's account.
- **Pain: 16.8**

No direct resume anchor - this is the kind of frontier-scale
problem the architecture must *accommodate* without being designed
for it from Day 1.

### C5.5 LLMOps team can't keep up with intent growth

- **Severity: 7** - product wants 5 new intents/month; eval set +
  replay + policy bundle can't keep pace.
- **Frequency: 8** - every product planning cycle.
- **Difficulty: 6** - solved by tooling (LLM-generated eval scaffold
  reviewed by humans) + ratio-discipline (1 LLMOps engineer per
  ~10 customer-facing intents).
- **Pain: 33.6**

This is the *organizational* analogue of the technical scaling
story. Most frontier-scale agent platform pain is organizational by
month 24, not technical. Same lesson surfaced in the BlackBox
agentic platform with 6+ engineers (`resume.txt` L51-52,
`blackbox-experience.md` #6) - staffing the eval and observability
function is the hard part.

---

## Top-10 leaderboard (sorted by Pain)

| Rank | ID | Stage | Title | S | F | D | Pain |
|---:|---|---:|---|---:|---:|---:|---:|
| 1 | C4.1 | 4 | Per-bank policy bundle drift | 7 | 7 | 7 | **34.3** |
| 2 | C5.5 | 5 | LLMOps team can't keep up with intent growth | 7 | 8 | 6 | **33.6** |
| 3 | C2.1 | 2 | Salary-day / EMI-day burst on Core Banking | 9 | 5 | 7 | **31.5** |
| 4 | C4.2 | 4 | Regional regulatory divergence | 9 | 4 | 8 | **28.8** |
| 5 | C5.2 | 5 | Voice channel forcing a new latency budget | 7 | 5 | 8 | **28.0** |
| 6 | C3.6 | 3 | Telemetry storage cost outruns growth | 6 | 7 | 6 | **25.2** |
| 7 | C2.2 | 2 | Long-tail intents the router misclassifies | 6 | 7 | 6 | **25.2** |
| 8 | C1.2 | 1 | Tool registry contract before the 4th tool | 8 | 7 | 4 | **22.4** |
| 9 | C2.5 | 2 | Memory write coalescing | 7 | 8 | 4 | **22.4** |
| 10 | C3.1 | 3 | Numerical drift in streamed narration | 8 | 4 | 7 | **22.4** |

## What this ranking tells you

- **The top 5 live in Stage 4-5.** The hardest problems on this
  platform are *organizational and governance* problems - policy
  drift across tenants, regulator pace, eval team scaling, voice-
  channel latency budget. These rank above any single technical
  bug because they recur across hundreds of decisions instead of
  being a one-shot fix.
- **The most painful technical problem is operational, not
  architectural.** C2.1 (salary-day burst) is #3 - the architecture
  is correct, the operational margin is too thin. This is the
  kind of pain you only see at production scale; designing for it
  from Day 1 looks like over-engineering until it isn't.
- **Stage 1 contracts (C1.2 tool registry) bleed into the top-10
  not because the inception cost is high - it isn't - but because
  the *compounding* cost of skipping them in week 4 is felt every
  month for two years.** This is the strongest argument for
  contract discipline in inception even when it slows the demo.
- **No row in the top-10 is a "make the model better" problem.**
  Every top-10 challenge is solved by *engineering around the
  model*, not by upgrading it. This validates the deterministic-
  vs-LLM seam in [03-architecture.md](03-architecture.md): if the
  hardest problems were "the LLM got it wrong", the answer would
  be a different model. The hardest problems are not.
