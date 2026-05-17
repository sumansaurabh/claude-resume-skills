# Critical Agent Approval

**Pack:** `design-packs/2026-05-17-ai-banker-smb-cashflow-agent`
**Date:** 2026-05-17
**Skill:** `/critical-agent --fix`

## Phase 1: Critic Verdict

Four independent critic sub-agents evaluated four scoped rubrics in parallel; a synthesizer aggregated their verdicts.

### Agentic Layer (20-point rubric)
- **Result (pre-fix):** 18 PASS, 2 PARTIAL, 0 FAIL
- **Result (post-fix):** 20 PASS, 0 PARTIAL, 0 FAIL
- **Scale gate (pre-fix):** 4 / 5 axes passed (Observability PARTIAL — no explicit MTTD SLO)
- **Scale gate (post-fix):** 5 / 5 axes passed

### Memory Layer (15-point rubric)
- **Result:** 15 PASS, 0 PARTIAL, 0 FAIL

### Guardrails (15-point rubric)
- **Result:** 15 PASS, 0 PARTIAL, 0 FAIL

### Ingestion Pipeline (15-point rubric)
- **Result:** 15 PASS, 0 PARTIAL, 0 FAIL
- Embedding-model consistency between ingestion §3 and memory §6 verified: `text-embedding-3-large` (3072 dim) on both sides; `bge-large-en-v1.5` named as cohort fallback in both.

### PARTIAL Items — Remediated In-Place via `--fix`

All three Phase 1 PARTIAL items were patched into the pack before Phase 2 ran. The PE review below covered the patched files.

**Agentic #9 — Tool failure handling.**
- *Original gap:* generic "retry 3x exp backoff" was stated; no per-tool retry/backoff/circuit-breaker table; no enumerated breaker thresholds.
- *Remediation:* `12-agentic-graph-structure.md` §1.5.1 added a five-class tool taxonomy (`read_idempotent_fast`, `read_idempotent_slow`, `write_with_idempotency_key`, `write_no_idempotency`, `mutating_external_irreversible`) with per-class retry budget, backoff curve, per-call timeout, breaker thresholds (open / probe / close), and on-final-failure behavior. Adds cross-cutting rules: per-`(tenant_id, tool_name)` breaker keying, retry-storm cost circuit-breaker, mandatory idempotency-key reuse on retries, and `evidence_freshness=stale` tagging when a cached fallback satisfies a node.

**Agentic #20 — Supervisor bottleneck mitigation.**
- *Original gap:* supervisor named as bottleneck at 10K RPS with no queue-depth ceiling, backpressure policy, or shed strategy on saturation.
- *Remediation:* `02-design-estimates.md` §5.1 row 20 added a five-stage backpressure ladder: (a) Redis Streams input queue hard-capped at 20K depth (2× steady-state); (b) admission shed of non-priority intents at 70% depth with HTTP 503 + Retry-After; (c) shed all but P0 (payments/HITL resumes) at 90% depth; (d) HPA trigger at 60% CPU for 90s OR queue-depth > 12K for 60s, +50% pod scale-out; (e) circuit-open returns a cached "service degraded — retry in 60s" reply, never enqueues silently.

**Scale-gate Observability axis — MTTD SLO.**
- *Original gap:* OTel traces and per-node spans present, but no stated MTTD SLO for a stuck/looping run.
- *Remediation:* `02-design-estimates.md` §5.1 row 19 added explicit **60s p95 MTTD SLO** via two stateless ClickHouse query alarms (`time_in_node > 30s` per-node stall; `hop_counter_rate == 0 for 45s` graph-level stall), both wired to PagerDuty SEV-3 with run_id deep-link to the Grafana trace view.

## Phase 2: Principal Engineer Verdict

**APPROVED**

This is a genuinely production-ready design pack for an MVP at 1M users. The agentic graph is implementable without ambiguity — node IDs are consistent with `03-architecture.md`, every node has a typed state shape with explicit durability classes, every edge has a pure-function predicate (including the critical `hop<4 AND state_changed` back-edge guard), and join policies are named and timeout-bound. The memory layer is fully specified: pgvector + Postgres + Redis with explicit shard math (600 GB at year 3, re-shard trigger at 1 TB/shard), tenant isolation via four defense-in-depth layers (namespace + RLS + query-builder lint + Redis ACLs), and a credible 40 ms p99 retrieval budget. Guardrails cover the entire pipeline (input, output, tool gateway, cross-agent envelopes, tool-output as the highest-risk injection surface) with a correctly asymmetric fail-closed-on-writes / fail-degrade-on-cosmetic policy. The ingestion pipeline closes the loop with the read path: the same `text-embedding-3-large` 3072-dim model is enforced by a shared `EmbeddingService` abstraction with CI assertion, the dual-index re-embedding plan is sound, and 1K events/sec sustained / 5K peak sizes correctly through 64-partition Kafka. The three remediated PARTIAL items are credible: §1.5.1's per-tool-class retry/breaker matrix is the right shape (five classes, per-tenant breaker keys, idempotency-key reuse, irreversible class with manual-close-only), §5.1 row 19's 60s p95 MTTD with two specific alarms is testable, and §5.1 row 20's five-stage backpressure ladder is a real production pattern, not hand-waving. The combined design shows a credible end-to-end path: 50K concurrent runs, ~$475K/month at 1M MAU with 3:1 LLM-to-compute ratio, tenant isolation as a graph invariant, and durable HITL as first-class graph nodes.

### Remaining Concerns for Implementation Team

These are PE-raised issues that did not block approval but must be addressed before GA.

- **Aurora write hot-spot risk.** §5.4 sizes Aurora at 6× `r8g.4xl` for run-state + biz data, but the durable checkpoint model writes on every node entry/exit for HITL/joins. At 50K concurrent runs × ~10 hops × 2 writes/hop the IOPS envelope is tight — validate with a load test before launch and consider sharding `agent_checkpoint` by `tenant_id` early.
- **Cross-encoder rerank capacity is not sized in §5.4.** Memory layer claims 25 ms p99 for rerank on 10 pairs, but at 80K runs/day × multiple retrievals/run there's no dedicated reranker fleet line item. Add it explicitly or co-locate with supervisor pods.
- **Embedding API single-vendor concentration risk.** OpenAI is primary; `bge` fallback exists but no SLO on cutover time during a multi-hour outage. Specify the failover trigger and verify dual-write to the `bge` index from day one for at least a sampled cohort.
- **OPA per-tenant package count at 1M tenants.** Guardrails §12 caps at 50 custom rules/tenant but doesn't bound total OPA bundle memory across the fleet. At 1M tenants × ~5 KB/bundle = 5 GB of policy in memory — confirm OPA lazy-load + LRU eviction is implemented, not just "cached in Redis 5-min TTL."
- **HITL timeout at scale.** 24h payment timeout × peak-day approval volume means a large rolling backlog of `hitl_waiting` runs holding durable rows indefinitely. Confirm the durable store can carry the steady-state population without index bloat, and that the reminder cron at `reminder_count ≤ 3` doesn't thunder-herd the notification fleet.
- **Saga compensation tested in chaos drills.** §1.11 declares Temporal saga + compensation steps but the document doesn't show a periodic chaos drill verifying `refund_initiated_payment` actually executes end-to-end against real partner APIs. Add as a launch-blocking quarterly drill.
- **CRITIC back-edge regenerate-rate budget.** OUT_GUARD regenerate-rate alert exists (>20% → page) but there is no comparable budget on the CRITIC back-edge rate to SUP. At peak this loop adds 2× latency and 2× LLM cost when it fires; instrument and alarm explicitly.

## Approval Status

This agentic design pack has cleared the `/critical-agent` gate. Downstream work (implementation, detailed LLD, handoff to engineers) may proceed. The seven PE concerns above are tracked obligations — they are not optional.

**Approved by:** `/critical-agent` skill (automated gate, not a human sign-off)
