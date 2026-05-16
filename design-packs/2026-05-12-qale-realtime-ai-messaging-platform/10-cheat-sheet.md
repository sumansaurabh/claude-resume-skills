# 10 - Cheat Sheet

One page of talking points for live delivery. Read this before you walk into the interview.

## The opener (60 seconds)

> "Qale is replacing email with a real-time, AI-native message bus. The whole architecture has to assume two things at once: every interaction is a sub-100ms WebSocket event, and the AI plane is *inline* with that bus, not a separate service the user clicks into. I've shipped each half of that - the BlackBox model router and telemetry mesh on the AI side, the Microsoft TunDRA QUIC protocol for 1M+ secure compute instances on the transport side, the ShareChat real-time ad infra at 40M DAU on the high-throughput backend side. The job at Turium is to put those halves together and lead the Hyderabad team that builds it."

## The architecture, in 6 bullets

- **Edge:** ALB / Cloudflare → stateless **Connection Gateway** (Go or Node) holding 50–100K WebSocket connections per pod, sharded by `userId`.
- **Bus:** Kafka (or NATS JetStream for lower-ops) as the system of record for events; topics partitioned by `workspaceId` then `threadId`.
- **Domain services:** Message, Thread, Presence, Notification, Search, AI Orchestrator. Stateless, autoscaled, all consume from the bus.
- **Storage:** Postgres (metadata, threads, messages-recent), S3 (attachments, message-cold), Redis (presence, fanout cursors), Qdrant/pgvector (semantic search), ClickHouse (telemetry + analytics).
- **AI plane:** Model router (Claude / GPT / open) with capability-aware routing + token budgeter; DAG agent runtime for multi-step actions; streams via SSE-over-WS back to the same socket.
- **Observability:** OpenTelemetry → Kafka → ClickHouse, with Langfuse-style LLM spans for deterministic replay.

## Numbers to have memorized

| Thing | Number | Source |
| --- | --- | --- |
| Target users | 1M+ | JD |
| Estimated DAU | ~200K | A6 (15–25% of MAU) |
| Peak concurrent WS | ~150K | A6 |
| Connections per gateway pod | ~75K | Standard WS sizing |
| Gateway pods at peak | ~2–3 + headroom = 6 | Math |
| Messages / second peak | ~5–10K | 200K DAU × ~3 msgs/min × peak factor 2 |
| AI requests / day | ~150–300K | ~1.5 AI ops / DAU |
| Token spend / month | ~150–500M tokens | BlackBox-style mix; budgeter in front |
| Telemetry spans / day | ~30–80M | Comparable to BlackBox 50M (A-BB5) |
| Hot storage Postgres | ~2–5 TB | 90-day window of messages |
| Cold storage S3 | grows 30–80 TB / yr | Long tail |

## The 5 anchors I'll cite by name

1. **TunDRA, Microsoft** - QUIC protocol in Rust, 1M+ Compute Instances, 50% data-transfer improvement (A-MS1). → Connection plane scale credibility.
2. **Model router, BlackBox** - Claude/GPT/Grok, capability-aware, 1B+ tokens/month (A-BB4). → AI plane and cost story.
3. **LLMOps telemetry mesh, BlackBox** - 50M spans/day, deterministic replay, 60% MTTR cut (A-BB5). → Observability and AI debug story.
4. **ShareChat ads** - 40M DAU, RTB sub-100ms, $20M revenue in a year (A-SC1, A-SC2). → Hard-real-time backend at consumer scale.
5. **AutoML at Microsoft** - 15M+ jobs/month, 200K+ users, founding member (A-MS3). → Operating an evolving platform under live load.

## The 5 lines to use when pushed

| When they say... | I say... |
| --- | --- |
| "Why not just use Stream / Sendbird?" | "For Alpha, that's a fine wedge if we want to skip the connection plane. But if Qale's moat is AI inline with messaging, the message bus *is* our product. Outsourcing it makes the AI integration second-class. I've built the equivalent for ShareChat ads at 40M DAU - the cost and risk of building it ourselves is less than people assume." |
| "Why WebSocket, not SSE?" | "We need bidirectional. Typing indicators, presence, AI streaming, and outbound message send all want one socket. SSE is a fine fallback for restrictive networks. WebTransport over QUIC is where I'd want us in 18 months - same shape as TunDRA at Microsoft." |
| "How do you keep AI cost from blowing up?" | "Three layers: capability-aware routing so 80% of calls go to the cheap model; per-workspace hard token budgets enforced before the call leaves the queue; aggressive context summarization with cached embeddings. That's the BlackBox playbook at 1B+ tokens/month." |
| "How do you not turn into a manager?" | "I time-box leadership work to 50% in the first six months. The other 50% is on-call, design docs, code in the hot path of the connection plane and the AI orchestrator. The day I can't pull a PR for the connection gateway is the day Qale has the wrong Head of Engineering." |
| "Why should we hire you for *Head of Engineering* if you've never been a Head of Engineering?" | "I've been a Principal who led architecture for a 6-engineer agentic platform at BlackBox, mentored 8 engineers and ran 30+ architecture reviews at Microsoft, and built ShareChat's ad team from scratch to $20M revenue in a year. The shape of the work is identical. The title is the lagging indicator." |

## The risks I'll volunteer (don't wait for them to ask)

- **WebSocket sprawl on cheap mobile networks.** Need backoff, resumable sessions, message dedup.
- **AI cost runaway** if a workspace uses the agent runtime in a tight loop. Budgeter + per-tool rate limit.
- **Search index drift** between Postgres and the vector store. Outbox pattern + reconciler.
- **SOC-2 audit pressure** before we have the headcount. Start the gap analysis in week 2.
- **Hiring quality in Hyderabad.** I run the loop personally for the first 10 hires, no exceptions.

## The close (45 seconds)

> "If I take this role, the first 30 days are spent reading the code and running load tests myself. Days 31–60 are about hardening the connection gateway and the AI budgeter. Days 61–90 are about being publicly launchable: SLOs, multi-region read, SOC-2 gap analysis, the team at ~10. By the time we hit 1M users, the architecture has not changed shape - it has just had its shards multiplied. That predictability is what real-time AI infrastructure has to be designed for, and it's what I've shipped before."
