# 08 — Tradeoffs and Alternatives

The choices that define the architecture, what was rejected, and what would change my mind. Anchor codes from `00-question-and-context.md`.

Each tradeoff uses the same shape: **Decision · Chose · Rejected · Why · What changes my mind · Migration path.**

---

## TR-1: Build vs buy the chat infrastructure

**Decision:** Build it.

**Chose:** in-house WebSocket gateway + Kafka bus + Postgres-backed message store + custom fanout.

**Rejected:** Stream Chat, Sendbird, TalkJS, PubNub, Ably-as-app.

**Why:**
- Qale's moat is **AI inline with the message bus**. If the bus is a vendor, the AI plane sits on the slow side of an HTTP webhook and we lose the latency story.
- Token economics — we want full control over what goes into the model context, when, and at what cost. Vendor abstractions hide that.
- Anchor: I built the equivalent for ShareChat ads at 40M DAU (A-SC1, A-SC2) — RTB latency budget was tighter than Qale's, and we built it; cost and risk of building were less than people assumed once we had the right primitives.

**What would change my mind:** if 6-month time-to-market is non-negotiable for an existential customer, buy the bus, eat the latency, plan to migrate within 12 months.

**Migration path off vendor (if we ever start there):** vendor for connection plane, our own service-side webhook receivers from day one, then swap connection plane behind same internal contract.

---

## TR-2: Transport — WebSocket vs SSE vs WebTransport vs custom QUIC

**Decision:** WebSocket now, WebTransport over QUIC at month 12–18, never custom QUIC.

**Chose:** WebSocket (RFC 6455) with JSON framing for v1.

**Rejected:** SSE (server-only); WebTransport (still maturing in browsers — assumption); custom QUIC protocol for v1.

**Why:**
- WS is bidirectional, mature, every CDN supports it, every browser supports it.
- SSE is fine for AI streaming alone, but we need bidirectional for typing, presence, message send.
- WebTransport is the right next step (multi-stream, drop unreliable typing indicators on UDP, keep messages on reliable streams). Anchor: TunDRA at Microsoft was QUIC-based for 1M+ Compute Instances (A-MS1) — I know the tradeoffs.
- Custom QUIC is *premature* for Qale; TunDRA solved a problem WebSocket genuinely could not (bidirectional secure session inside Azure VNets at compute-instance scale). Qale's connections are ordinary browser sockets — WS wins on simplicity.

**What changes my mind:** sustained mobile-network packet loss complaints from > 5% of users; or measurable latency benefit > 30% from QUIC in production A/B.

**Migration path:** abstract the client transport behind a `Transport` interface; flip to WebTransport per-region behind a feature flag.

---

## TR-3: Bus — Kafka vs NATS JetStream vs Redis Streams vs RabbitMQ

**Decision:** Kafka for durable backbone, NATS for low-volume internal request/reply.

**Chose:** Apache Kafka (or AWS MSK, then self-hosted later) as the durable bus.

**Rejected:** RabbitMQ (operational pain at scale, partition story weak); Redis Streams (no replication story strong enough for system-of-record); NATS-only (great ergonomics, but JetStream's tiered storage and tooling lag Kafka at our scale target).

**Why:**
- Kafka's partitioning model maps cleanly onto `(workspaceId, threadId)` ordering needs.
- 7-day retention gives us free deterministic replay and cross-service rewind.
- Tooling ecosystem (Schema Registry, Connect, Streams, kSQL, Kafka Mirror) means we can lean rather than build.
- Anchor: ShareChat used Pub/Sub (A-SC3) — Kafka is the AWS-native equivalent with stronger ordering.

**What changes my mind:** if we stay sub-100K users for > 18 months, NATS JetStream is meaningfully cheaper to operate.

**Migration path:** all bus access through a thin internal client library — provider swap is a library change.

---

## TR-4: Storage — Postgres vs Cassandra vs DynamoDB for messages

**Decision:** Postgres + logical sharding, with cold tier in S3/Parquet.

**Chose:** Postgres (RDS or Aurora) with later Citus / Vitess for horizontal scaling.

**Rejected:** Cassandra (operational complexity, weak ergonomics for product velocity); DynamoDB (proprietary, hot-partition footguns, expensive at write-heavy scale).

**Why:**
- At 1M users we are still in Postgres's comfort zone with sharding (~5–10 TB hot per shard).
- SQL + RLS gives us the multi-tenant isolation invariant cheaply.
- Anchor: Microsoft AutoML scaled job metadata in a Postgres-style relational store (A-MS3); the lesson was *shard before forced, evolve through versioned schemas, don't rewrite to NoSQL just because traffic grows*.

**What changes my mind:** > 50K msg/s sustained writes, or workload becomes truly key-value with no relational queries.

**Migration path:** introduce a `MessageStore` interface; implementations can be Postgres, Postgres+Vitess, or Cassandra. Migrate per shard.

---

## TR-5: Search — OpenSearch vs Postgres FTS vs hybrid with vector

**Decision:** Hybrid: OpenSearch (lexical) + Qdrant (vector) with a small reranker.

**Chose:** OpenSearch for BM25/keyword, Qdrant for semantic; combined via Reciprocal Rank Fusion or a cross-encoder reranker.

**Rejected:** Postgres FTS only (workable to ~100K users, ceiling visible); pure vector (terrible at name/ID lookup); Algolia / vendor (cost at message scale).

**Why:**
- Search-by-keyword and semantic-search-by-meaning are different jobs; pretending one tool does both produces bad results in the other.
- The cross-encoder reranker cost is small (~50ms p95) for a meaningful relevance lift.
- Anchor: BlackBox vector + RAG work (A-BB2) used the same hybrid pattern.

**What changes my mind:** demonstrated relevance from vector-only at our scale + a dramatic cost win.

**Migration path:** route through a single `Search` API; can swap engines underneath.

---

## TR-6: AI — hosted providers vs self-hosted vLLM

**Decision:** Hosted via model router for v1; revisit self-hosted at scale.

**Chose:** model router across Claude / GPT / Grok (or open via OpenRouter / Bedrock) — the BlackBox playbook (A-BB4).

**Rejected:** self-hosted vLLM as the primary serving path at v1.

**Why:**
- At 100K–1M users we don't yet have the volume to amortize GPU fleet ownership.
- Model quality moves monthly; being provider-flexible captures that.
- Anchor: BlackBox served 1B+ tokens/month entirely through hosted providers with capability-aware routing (A-BB4); same shape works for Qale.
- Anchor: I know vLLM well from Microsoft IPP fine-tuning (A-MS1) — and that experience tells me self-host pays off only when (a) workload is steady, (b) volume amortizes, (c) you can tolerate model-version control. Not v1.

**What changes my mind:** hosted spend > $250K/mo with steady workload + a specific small model dominating traffic where self-host pays back in 6 months.

**Migration path:** the router already abstracts provider — adding a `local` provider is a config change, not a rewrite.

---

## TR-7: Agent runtime — LangGraph vs Temporal vs in-house DAG

**Decision:** Thin in-house DAG with Temporal-style durability primitives.

**Chose:** Internal lightweight DAG executor with checkpoint-after-each-node, idempotent tool dispatch, run-step ledger.

**Rejected:** raw LangGraph (great prototyping, weak production controls); raw Temporal (powerful but adds a heavy dependency for our specific shape); pure code (no replay, no resume).

**Why:**
- Anchor: this is the exact shape I led at BlackBox — DAG execution, checkpointing, retry semantics, durable resumable agents (A-BB3).
- We need full control over checkpoint format because deterministic replay and SOC-2 audit depend on it.
- LangGraph is great for the *agent definition DSL*; we keep that and write our own executor underneath.

**What changes my mind:** Temporal pricing or an open-source equivalent matures with first-class LLM support.

**Migration path:** the executor exposes a `WorkflowRunner` interface; alternative implementations are isolated.

---

## TR-8: Telemetry — vendor (Datadog) vs in-house ClickHouse mesh

**Decision:** in-house OpenTelemetry → Kafka → ClickHouse mesh.

**Chose:** OTel SDK in every service, OTel collector → Kafka → ClickHouse with rollup tiers; Grafana on top.

**Rejected:** Datadog as the primary store (cost prohibitive for AI tracing volume; vendor lock-in on the data we care most about).

**Why:**
- Anchor: BlackBox telemetry mesh ingested 50M spans/day, 2.5TB+ monthly trace data; in-house at ClickHouse cost a fraction of vendor (A-BB5).
- AI debugging needs custom queries (replay by prompt-hash, route distribution per workspace) that don't fit vendor UIs.
- We keep Sentry for client errors and ad-hoc product analytics — vendor is fine for those.

**What changes my mind:** team time to maintain the mesh exceeds vendor cost — we're not there at < 30 engineers.

**Migration path:** OTel SDK is vendor-neutral; can dual-export during migration.

---

## TR-9: Frontend — SPA vs SSR vs PWA

**Decision:** SPA app shell + PWA features, with SSR only for marketing/login/share pages.

**Chose:** Next.js for marketing + auth flows (SSR for SEO, fast first paint); React SPA shell with route-level code splitting for the app; PWA install + Service Worker for offline read.

**Rejected:** full SSR for the app (state hydration cost is huge for a real-time app where every render needs a live socket).

**Why:**
- Real-time apps don't benefit from SSR after the first frame — the value is the live connection, which only works post-hydration.
- PWA gives us "feels like an app" on mobile web — important wedge for India/global before native apps land.

**What changes my mind:** mobile native app priority shifts; or framework consensus moves decisively to RSC for live apps.

**Migration path:** Next.js + React SPA shell coexist already.

---

## TR-10: State management — Redux Toolkit vs Zustand vs Jotai vs custom

**Decision:** Zustand for local UI state, RTK Query (or TanStack Query) for server state, IndexedDB cache for offline.

**Chose:** Zustand (small, simple, no boilerplate); TanStack Query for fetch+cache+invalidation; IndexedDB via idb-keyval for the cold cache.

**Rejected:** Redux Toolkit as the primary store (verbose for our size); Jotai (great for atoms but bus integration costs more than wins).

**Why:**
- Real-time WebSocket apps want a small store with explicit subscriptions; Zustand fits.
- TanStack Query handles the read API cleanly; we don't need Redux for that.

**What changes my mind:** team grows and the conventions become hard to enforce — RTK's structure may pay off then.

**Migration path:** any of these can coexist behind hooks.

---

## TR-11: Monorepo vs polyrepo

**Decision:** Monorepo with Turborepo (or Nx).

**Chose:** Single repo, package boundaries enforced by lint, shared TS types end-to-end, per-service Dockerfile.

**Rejected:** polyrepo (lose end-to-end type safety, version-pin hell).

**Why:**
- 6→25 engineers in 12 months; one repo keeps refactoring across boundaries cheap.
- Shared protobuf/TS types between FE and BE catch contract drift at compile time.
- Anchor: ShareChat ad codebase was a single repo; cross-team refactors stayed cheap (A-SC1).

**What changes my mind:** clear bifurcation between platform and product teams with no shared types — splits become reasonable.

**Migration path:** straightforward via Turborepo workspace splits.

---

## TR-12: Cloud — AWS vs GCP vs Azure

**Decision:** AWS primary, multi-cloud-ready abstractions where cheap.

**Chose:** AWS — broadest service catalog, strongest India presence (ap-south-1, ap-south-2), best market hire-ability in Hyderabad (most engineers know it).

**Rejected:** Azure (despite my Microsoft background — A-MS2) and GCP, for hiring and cost reasons.

**Why:**
- Hyderabad hiring pool: AWS skills are most common. We optimize for the team.
- Bedrock gives us a clean way to add hosted models behind the router.
- IRSA + KMS + RDS + EKS patterns are well-trod.

**What changes my mind:** a strategic AI partnership with Microsoft or Google that includes meaningful credit + dedicated support.

**Migration path:** Terraform modules + cloud-agnostic service interfaces (S3 → ObjectStore, RDS → Postgres, etc.) for the things that matter; accept lock-in for things that don't (KMS, IRSA).

---

## TR-13: Service mesh — Istio vs Linkerd vs none yet

**Decision:** None at < 10 services; Linkerd at ~10+.

**Chose:** application-level mTLS + HTTP client retries until ~10 microservices; then Linkerd for transparent mTLS, retries, observability.

**Rejected:** Istio at v1 (operational complexity, control plane is its own infra to run).

**Why:**
- Premature mesh = early-stage death. We don't need the features at 4 services.
- Linkerd is simpler than Istio with 80% of what we need.

**What changes my mind:** a feature only Istio has becomes critical (e.g., complex traffic shaping for canary).

**Migration path:** Linkerd injection per namespace; rolled per service.

---

## TR-14: Sync vs async AI invocation

**Decision:** Async event-driven primary; sync wrapper for short interactive prompts.

**Chose:** AI runs are events on the bus; the orchestrator picks them up; results stream back over the same WebSocket. For short prompts (autocomplete), a sync gRPC call from the gateway is acceptable with a hard latency budget.

**Rejected:** all-sync (couples gateway to AI provider latency; one bad provider = sad gateway).

**Why:**
- Async lets us scale the orchestrator independently and apply per-workspace quotas centrally.
- Streaming back over WS gives the same UX as sync.
- Anchor: BlackBox agent runtime was async-event-driven (A-BB2, A-BB3) for the same reasons.

**What changes my mind:** UX research shows the bus latency is felt; mitigate by colocating orchestrator with gateway.

**Migration path:** the gateway holds a `submitRun(thread, prompt)` interface — sync or async wired underneath.

---

## Decisions I'd defer past Public Launch

Explicit list so the founders know what is *not* in v1, and so I get pushback now if any of these are non-negotiable:

| Deferred | Reason | Likely revisit |
| --- | --- | --- |
| Federation across Qale instances (Matrix/XMPP-style) | Adds protocol complexity for a v2 audience we don't have yet | Year 2+ |
| Voice / video / WebRTC | Strong but separate engineering surface; HomeLane WebRTC experience (A-HL1) means I can lead it when we get there | Post-launch quarter |
| Custom transport (QUIC / WebTransport) | WebSocket meets v1 SLOs | Month 12–18 |
| Fully self-hosted LLM serving | Provider router cheaper at our scale | Year 2 |
| On-prem / air-gapped deployment | No customer demand expected at launch | Year 2 enterprise |
| Per-tenant fine-tuning | Heavy infra; small fraction of customer ROI | Year 2 |
| Real-time collaborative document editing (CRDT) | Different product surface | Probably never inside Qale; integrate Notion-likes |
| End-to-end Confidential Mode with full crypto | Hard tradeoffs (see `06`) | v2 opt-in |
| Native iOS/Android apps | PWA carries us through Public Launch | Month 6+ |

The rule I bring from BlackBox and Microsoft: be loud about what you are *not* doing. Half-finished surfaces are the most expensive thing in a launch quarter.
