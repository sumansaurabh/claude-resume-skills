# 08 - Tradeoffs and Alternatives

The interviewer wants to know that the choices were *chosen*, not defaulted.
This file walks the major forks and why I'd defend each one.

## LangGraph vs alternatives - for the orchestrator

| Option | Strengths | Weaknesses | Why not chosen / chosen |
| - | - | - | - |
| **LangGraph (chosen)** | Native typed state, checkpointer hooks, growing community, fits ReAct natively, low ceremony to ship | Python-only; executor is in-process; durability is bolt-on; couples graph IR to runtime | Right fit at 10K runs/day; team is Python-first; checkpointer hooks are the load-bearing feature; we wrap the executor anyway |
| **Temporal / Cadence** | Battle-tested durable execution, language SDKs, history-based replay | Workflows are imperative code, not graphs; LLM-shaped reasoning (loops, critic re-entry) is awkward; cost of running Temporal clusters | Considered; would have given us replay for free but at the cost of making the planner/coder loops painful to express. Right answer for *workflow* tools, wrong answer for *agent* loops |
| **Inngest / Trigger.dev** | Hosted durable functions, ergonomic | Hosted means cross-cloud egress + SOC-2 vendor review; less control over scheduler | Vendor risk wasn't worth the ergonomics |
| **LangChain AgentExecutor** | Lower learning curve | One-process, no checkpointing, no graph topology, no fan-in | Hard pass - we explicitly need DAG semantics and resumability |
| **Hand-rolled state machine + queue** | Maximum control, no library churn | We'd rebuild LangGraph poorly; node typing, message reducers, checkpoint hooks all hand-written | Considered for v2; the right answer if we hit 100K runs/day or if LangGraph's executor becomes a bottleneck |
| **CrewAI / AutoGen** | Multi-agent abstractions out of the box | Heavy framework opinion, less mature, harder to plumb durability and security | Wrong abstraction level - too high-level |

**The honest principal-engineer point**: LangGraph gives us a graph IR and a
checkpointer protocol - the two things we actually want. Everything else
(executor, retry semantics, tool registry, policy) we own. If we ever
outgrew LangGraph, we'd keep our graph IR and write a new executor; the rest
of the platform doesn't change.

## WASM vs other sandbox technologies - for code execution

| Option | Cold start | Isolation | Network | Fit for AI-generated code |
| - | - | - | - | - |
| **WASM (chosen)** | ~30 ms warm, ~500 ms cold | Strong: linear memory, no syscalls without host import | Brokered; no kernel networking | Excellent: deny-by-default, language-portable, dense packing |
| **Firecracker microVM** | ~125 ms | Kernel-strong | Full | Overkill for short script runs; great for long-lived workloads |
| **gVisor** | ~100 ms | User-space kernel; strong | Full | Slow on some syscalls; doesn't beat WASM on density |
| **Docker (runc, pre-pulled image)** | ~50–200 ms warm, ~1 s with image pull | Weak (shared kernel) | Full | Fast enough on the hot path, but shared-kernel isolation is the dealbreaker for untrusted AI-generated code |
| **Kata Containers** | ~500 ms | VM-strong | Full | Mature but heavier ops than Firecracker |

This is covered in depth in `design-packs/2026-05-06-wasm-sandbox-platform`
and `design-packs/2026-05-07-wasm-sandbox-security-isolation`.

The agent-layer point is: **WASM's structural network limitation is a
feature**. The egress proxy is now the single chokepoint for AI-generated
network access, so the audit story collapses to "show me the egress proxy
log" - exactly what SOC-2 reviewers want.

## ReAct vs alternatives - for the agent reasoning loop

| Loop pattern | Where it wins | Where it loses |
| - | - | - |
| **ReAct (chosen)** | Tight tool integration, observation-driven reasoning, easy to debug | Can loop on same tool; needs guard rails |
| **Plan-Execute** (plan once, then run) | Lower latency, less back-and-forth | Brittle if plan is wrong; no mid-run learning |
| **Tree-of-Thought** | Better for hard reasoning problems | Heavy token cost, harder to checkpoint |
| **Reflexion** | Self-corrects on failures | Slow, expensive, hard to bound |
| **Hybrid: Plan + ReAct (what we actually use)** | Plan critic before any tool execution + ReAct inside each milestone | More moving parts |

The pack's architecture is *Plan-then-ReAct*. The planner emits milestones
with acceptance criteria; the ReAct loop is bounded *per milestone*. That
gives us plan-level transparency (the user can see the milestones before
expensive work starts) and milestone-scoped failure containment.

## Memory: vector-only vs hybrid

| Option | Strengths | Weaknesses |
| - | - | - |
| Vector only | Easy to set up | Misses exact-match patterns (file paths, error strings) |
| BM25 only | Great for code search | Misses semantic similarity |
| **Hybrid BM25 + HNSW + cross-encoder rerank (chosen)** | Best recall + precision tradeoff | Higher latency, more infra |

Anchored on the resume tech list: *"Embeddings, VectorDB, Cross-encoder,
HNSW, bm25, Clickhouse."* Cross-encoder rerank is the differentiator -
it cuts hallucinated retrieval results by an order of magnitude.

## Multi-model router: single-model vs multi-model

| Option | Strengths | Weaknesses |
| - | - | - |
| Single provider (Claude or GPT) | Simpler routing; easier prompt engineering; lower cost | Provider risk; rate-limit ceiling; no cost optimization |
| **Multi-model router (chosen)** | Cost optimization, failover, capability arbitrage, business resilience | Capability drift; prompt portability cost; routing complexity |

The 1B-tokens/month scale makes the case airtight: single-provider would
mean accepting whatever rate-limit and outage profile that vendor has.
Multi-model is the right answer.

The cost: **capability drift**. Claude's tool-use JSON looks different from
GPT's tool-use JSON; we have per-model adapters and a test matrix that
ensures every tool's output schema parses the same on all three providers.
This is real engineering cost, not free.

## Checkpoint storage: Postgres-only vs Postgres + S3

| Option | Strengths | Weaknesses |
| - | - | - |
| Postgres-only | Single source of truth | Row width blows up with long `messages`; expensive cold storage |
| **Postgres + S3 (chosen)** | Cheap blob storage, fast hot reads, content-addressed dedup | Two systems to keep consistent |
| Pure event-sourcing (Kafka log of state deltas) | Maximal replayability | Operational complexity; harder to query |

The chosen split - small typed state in Postgres, large blobs in S3 keyed
by content hash - is the standard "log + lakehouse" pattern adapted to
agent state. It's boring and right.

## Streaming: SSE vs WebSocket vs gRPC-web

| Option | Strengths | Weaknesses |
| - | - | - |
| **SSE (chosen)** | Simple, works through proxies, auto-reconnect with Last-Event-ID, one-way | One-way only |
| WebSocket | Bidirectional | More complex; load-balancer friction; auto-reconnect is DIY |
| gRPC-web | Strong typing | Browser support pain; harder for partner ecosystem |

The client side of an agent run is overwhelmingly one-way (server pushes
events). The handful of bidirectional moments (approval, cancel) go over
plain HTTP `POST /actions`, which avoids the entire WebSocket complexity.

## Open questions / rejected ideas worth revisiting

| Idea | Why we didn't do it | When to reconsider |
| - | - | - |
| Move the graph executor to Go | Python is fine at 10K runs/day; team is Python-first | Above 100K concurrent runs |
| Per-tenant Kafka topic for events | Overkill at our scale | At 1M runs/day if multi-tenant fanout pressure rises |
| Use OpenAI Assistants API for stateful threads | Vendor lock-in; we already own checkpointing | Never - we'd lose replay |
| Use LangSmith instead of self-hosted Langfuse + ClickHouse | Vendor data residency concern | If LangSmith adds enterprise data controls |
| Replace LangGraph with custom IR | Premature | If executor becomes the bottleneck |

## The meta-tradeoff

Every choice above is biased toward **structural control over ergonomic
convenience**. That bias is correct for an enterprise platform where SOC-2,
replay, and multi-tenant isolation are existential. It would be the wrong
bias for an early prototype, where time-to-first-working-demo dominates.
The fact that BlackBox runs at 10K runs/day across enterprise customers is
what justifies the trade.
