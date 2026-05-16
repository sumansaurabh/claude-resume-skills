# 00 - Question and Context

## The question (as posed by Turium AI)

Turium AI is building **Qale** - a real-time, AI-native communication platform designed to replace legacy email and reset global messaging. Approaching Alpha. Hiring a hands-on Head of Engineering to lead Alpha → Public Launch → Scale (1M+ users).

Key responsibilities pulled from the JD:

- Own system architecture and delivery across frontend, backend, infrastructure.
- Design and scale real-time systems (WebSockets, event-driven architecture).
- Build and optimize high-performance React applications.
- Ensure low latency, high concurrency, reliability.
- Establish engineering standards, code quality, delivery velocity.
- Hire and grow a high-performing team in Hyderabad.

Tech environment: React + modern JS, event-driven distributed backend, WebSockets / real-time pipelines, cloud-native deployments, high-volume real-time data processing.

So the implicit interview question is:

> "Walk us through how *you* would build Qale: end-to-end architecture, the real-time layer, the AI layer, how you scale it from Alpha to 1M+ users, what your first 90 days look like, and how you'd hire."

## Scope

**In scope:**

- End-to-end architecture: client → edge → real-time gateway → message plane → AI plane → storage.
- Real-time backbone: WebSocket gateway, fanout, presence, delivery semantics.
- AI plane: model router, retrieval, agent runtime, streaming responses, cost control.
- Frontend: React at scale, virtualized lists, optimistic UI, offline, accessibility.
- Scale plan to 1M+ users: capacity model, sharding, regional topology.
- Security: auth, tenant isolation, E2E discussion, SOC-2 path.
- Reliability and observability: telemetry mesh, LLM tracing, deterministic replay.
- Leadership: hiring, standards, roadmap, on-call.

**Out of scope (called out so I don't get pulled in):**

- Specific UI mocks or pixel design - Qale isn't public yet.
- Deep WebRTC voice/video stack - JD lists it as *preferred*; I'll touch it as an extension lane, not the core product.
- Email-protocol bridging (SMTP/IMAP) - possible inbound migration path, but not core architecture.

## Assumptions (explicitly labeled)

| # | Assumption | Why it's reasonable |
| --: | --- | --- |
| A1 | Qale is conversation-first, not document-first; threads + channels + DMs replace email threads. | "Replace legacy email" + "real-time AI-native communication" framing. |
| A2 | AI features include: smart inbox triage, draft compose, thread summarization, agent actions on threads, semantic search. | Standard AI-native messaging surface; matches BlackBox agentic platform skills. |
| A3 | Multi-tenant SaaS with workspaces (à la Slack), not consumer-only. | "Global messaging" + enterprise framing common to email replacement. |
| A4 | Cloud-native - assume AWS as primary (most common in India SaaS); design is cloud-agnostic. | JD says "cloud-native deployments." |
| A5 | Mobile clients exist (iOS/Android), but launch wedge is web (React). | JD emphasizes React. |
| A6 | 1M+ users means ~150–250K DAU at launch, scaling. Peak concurrent WebSockets ~100–200K. | Standard 15–25% DAU/MAU ratio for messaging products. |
| A7 | Token budget for AI is a meaningful business constraint, not infinite. | BlackBox 1B+ tokens/month experience says cost control matters at this scale. |

I will revisit these in `05-scaling-and-capacity.md` and `14-leadership-and-business-framing.md`.

## Resume anchors used

These are the bullets I'll lean on in the interview. Any claim about my own work in this pack is grounded to ≥2 of these unless explicitly labeled an assumption.

### BlackBox (Principal Engineer, Sep 2025 – Apr 2026)

- **A-BB1:** "Architected Golang-backed WASM sandbox plane, isolating 1M+ daily zero-shot code executions and unblocking Enterprise SOC-2 compliance for the core Copilot product." → SOC-2 path, multi-tenant isolation, 1M+ daily ops.
- **A-BB2:** "Led architecture for agentic AI platform with 6+ engineers, designing LangGraph/LangChain-based ReAct agent runtimes with DAG orchestration, tool-calling, and durable execution supporting 10K+ agent runs/day." → Agent runtime for Qale's AI features; engineering leadership at Qale's team scale.
- **A-BB3:** "Designed graph workflow engine (DAG execution, checkpointing, retry semantics) enabling long-running, resumable agents with memory persistence." → Durable workflow engine for AI threads / async drafts.
- **A-BB4:** "Led model router orchestration (Claude, GPT, Grok) with capability-aware routing and context optimization, ensuring consistent behavior across heterogeneous LLM backends consuming 1B+ tokens per month." → Direct anchor for Qale's AI plane and cost control.
- **A-BB5:** "Institutionalized a high-throughput LLMOps telemetry mesh, ingesting 50M spans/day and managing 2.5TB+ of monthly trace data for deterministic replay; cut org-wide MTTR for complex AI logic anomalies by 60%." → Direct anchor for Qale's observability and AI debugging.

### Microsoft OpenAI / Azure ML (Senior SWE, Oct 2020 – Aug 2025)

- **A-MS1:** "Co-developed TunDRA, a secure QUIC-based communication protocol in Rust powering over 1 million Compute Instances with 50% improvement in secure data transfer." → Direct experience scaling secure, low-latency transport to 1M+ endpoints - very close to Qale's WebSocket/QUIC connection plane.
- **A-MS2:** "Led design of secure multi-tenant ML infrastructure across Kubernetes and Azure, including GPU scheduling, cost-aware resource allocation, and isolation strategies." → Multi-tenant SaaS infrastructure muscle.
- **A-MS3:** "Co-architected and led cross-org design reviews and roadmap planning for AutoML Job evolution… supports 15M+ jobs per month… 200K+ global users." → Operating at the relevant scale; experience evolving a platform under live customer load.
- **A-MS4:** "Mentored 8 engineers on secure protocol design; integrated CodeQL and GitHub Advanced Security into CI/CD pipelines; standardized threat modeling." → Engineering standards, secure CI/CD, the kind of bar I'd set at Qale.
- **A-MS5:** "Led Scrum execution and 30+ architecture reviews for AI Fine-tuning and AutoML." → Cross-team architecture governance - the "Head of Engineering" coordination muscle.

### ShareChat (Team Lead, Jul 2019 – Oct 2020)

- **A-SC1:** "Built targeted advertisement platforms that segment over 40 million daily active users on 22 different user attributes." → Real consumer-scale (40M DAU) experience and event-driven segmentation.
- **A-SC2:** "Architected Real-Time bidding infrastructure to facilitate auction between OpenRTB-compliant DSPs… revenue from 20M $ in span of one year." → Hard real-time, low-latency, high-throughput backend with strict SLAs (RTB is <100ms end-to-end). Same shape as a chat backend.
- **A-SC3:** "Technologies Used: … MongoDB, Redis, PubSub, Kubernetes, Docker, Prometheus, Grafana, OpenTelemetry." → The exact stack a real-time messaging platform needs.

### HomeLane (SWE, May 2015 – Apr 2016)

- **A-HL1:** "Developed a P2P communication platform between using WebRTC api and OpenTok service." → Hands-on WebRTC for the *preferred* voice/video extension lane.

### Independent / Freelance

- **A-IND1:** "ClipboardHealth - Led end-to-end migration of Clipboard Health's Payments service to microservices using NestJS, Terraform, and AWS, reducing deployment time by 34%, engineering effort by 20%." → Concrete service-decomposition + IaC + AWS pattern I'd reuse.

## Grounding confidence

**High** - for AI plane, telemetry, real-time transport at scale, multi-tenant security posture, leadership structure: backed by ≥2 strong anchors each.

**Medium** - for React-specific implementation choices: I have full-stack experience but my deepest claims on the resume are backend-leaning. I'll be honest about that and frame how I'd partner with a strong frontend lead while still being hands-on.
