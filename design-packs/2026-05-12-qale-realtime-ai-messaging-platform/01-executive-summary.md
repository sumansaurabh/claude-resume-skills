# 01 - Executive Summary

The 3-minute version of how I'd build Qale and run engineering for it.

## The product, in one sentence

Qale is a real-time, multi-tenant communication platform where threads - not emails - are the unit of work, and an AI plane sits *inline* with the message bus so that triage, drafts, summaries, and agent actions happen at the same speed as typing.

## The architecture, in one paragraph

A thin React PWA (and later mobile clients) holds a single persistent **WebSocket** connection - preferably **WebTransport / QUIC** behind a Layer-7 edge - to a stateless **Connection Gateway**. The gateway authenticates, attaches a session, and forwards client intents onto an internal **event bus** (Kafka or NATS JetStream). A small set of stateless **domain services** (Message, Thread, Presence, Notification, Search, AI Orchestrator) consume from the bus, write to **Postgres + Redis + an object store + a vector index**, and publish derived events back. **Fanout** is workspace-sharded: each shard owns its own subset of users and pushes events back to the gateways via a **fanout topic per shard**. The **AI plane** is a separate, autoscaled pool of workers running a **DAG-based agent runtime** behind a **model router** across Claude / GPT / open models, with a **token budget enforcer** and **streaming back to the client over the same WebSocket**. Everything emits **OpenTelemetry spans** into a **ClickHouse-backed telemetry mesh** so a single thread, AI run, or message can be replayed deterministically.

That paragraph maps almost directly onto things I've shipped: the **TunDRA QUIC protocol for 1M+ Compute Instances at Microsoft** (A-MS1), the **BlackBox model router consuming 1B+ tokens/month with capability-aware routing** (A-BB4), the **BlackBox LLMOps telemetry mesh ingesting 50M spans/day** (A-BB5), and the **ShareChat real-time ad infra serving 40M DAU with sub-100ms RTB** (A-SC1, A-SC2).

## The five things that decide whether Qale wins technically

1. **The connection plane scales linearly to 1M+ users.** Stateless gateways, sharded fanout, sticky-by-userId routing. Anchored on TunDRA at 1M+ instances (A-MS1).
2. **AI feels inline, not bolted on.** AI requests are first-class events on the bus, streamed back over the same socket, with deterministic replay for every run. Anchored on BlackBox model router (A-BB4) and telemetry mesh (A-BB5).
3. **Token cost stays sub-linear vs. user growth.** Tiered context strategy (cache + summarize + retrieve), capability-aware routing to cheaper models for simple tasks, hard budget per workspace. Anchored on BlackBox 1B+ tokens/month context optimization (A-BB4).
4. **The React app stays under 1.5s TTI on a mid-tier Indian Android Chrome.** Route-level code splitting, virtualized message lists, IndexedDB cache, optimistic local writes, RUM SLO. (Hands-on full-stack background; honest that this is the lane I'd hire a strong frontend lead for.)
5. **The bar is durable engineering hygiene, not heroics.** CodeQL + GHAS in CI, threat models per surface, SOC-2 Type II by Public Launch. Anchored on Microsoft secure CI/CD work (A-MS4) and BlackBox SOC-2 work (A-BB1).

## The leadership story, in one paragraph

I am not a manager who used to code. I'm a Principal Engineer who is now ready to lead. At BlackBox I led 6+ engineers on the agentic platform (A-BB2); at Microsoft I mentored 8 engineers and ran 30+ architecture reviews (A-MS4, A-MS5); at ShareChat I led the team-from-scratch build of an ad-infra that hit $20M revenue in a year (A-SC2). For Qale's Hyderabad team, the plan is: ship Alpha with a **tight 6-engineer pod** (1 frontend lead, 2 backend, 1 AI/infra, 1 SRE, me on the keyboard), then scale to ~15 by Public Launch and ~25–30 by 1M users - staffed against three pods (Real-Time Plane, AI Plane, Frontend & Growth). Engineering standards land in the first 30 days: trunk-based development, mandatory design docs for any change crossing a service boundary, on-call rotation from week one, weekly architecture review.

## The 90-day plan, at a glance

| Window | Theme | Concrete output |
| --- | --- | --- |
| Days 0–30 | Land + audit | Read the code, run the load tests myself, file a *Top-10 risks* doc, set engineering standards (CI, code review SLOs, design-doc template), on-call rota |
| Days 31–60 | Alpha hardening | Connection gateway sharding, idempotent message send, AI-plane budget enforcer, basic telemetry mesh, hire 3–4 |
| Days 61–90 | Public-launch readiness | SOC-2 gap analysis, multi-region read path, SLO/SLA published, regional canary, Hyderabad team to ~10 |

## What I would *not* do, and would push back on in the interview

- I would **not** build a custom chat protocol from day one. WebSocket framing + JSON is fine through Public Launch. QUIC/WebTransport is the *next* step, not the *first*.
- I would **not** roll our own LLM serving for core features at Alpha. Use the model router pattern across hosted providers (the BlackBox model - A-BB4) and only invest in self-hosted inference once unit economics demand it.
- I would **not** hire 25 engineers in the first quarter. Pre-Public-Launch, six builders that I trust outship fifteen that I'm still onboarding.
- I would **not** promise E2E encryption *and* server-side AI on the same content without an explicit, opted-in workspace setting. That tradeoff has to be honest.

The rest of the pack is the depth behind each of these claims.
