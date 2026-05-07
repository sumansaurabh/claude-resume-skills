Below is the BlackBox-specific read of your resume, based on the **Principal Engineer, BlackBox** section in your uploaded resume. 

# 1. BlackBox experience summarized in 20 technical points

1. You worked as a **Principal Engineer at BlackBox from Sep 2025 to Apr 2026**, focused on a **No-Code AI platform**.

2. Your core ownership was around **agentic AI infrastructure**, not just application-level AI features.

3. You architected a **Golang-backed WASM sandbox plane** for executing AI-generated or user-generated code safely.

4. The sandbox plane isolated **1M+ daily zero-shot code executions**, which is a major distributed runtime and isolation problem.

5. Your sandbox work directly supported **Enterprise SOC-2 compliance**, so the architecture had security, auditability, and isolation requirements.

6. You led architecture for an **agentic AI platform with 6+ engineers**, showing Principal-level technical leadership, not just IC implementation.

7. You designed **LangGraph / LangChain-based ReAct agent runtimes**, meaning the platform supported reasoning-action loops, tool calls, and multi-step AI workflows.

8. You worked on **DAG orchestration** for agents, where agent execution is represented as a graph of dependent steps rather than a single linear prompt-response flow.

9. You designed **tool-calling infrastructure**, meaning agents could invoke external systems, APIs, code execution environments, retrieval systems, or internal services.

10. You supported **durable execution** for AI agents, which means long-running workflows could survive crashes, retries, restarts, and partial failures.

11. The agent runtime supported **10K+ agent runs per day**, giving you scale credibility around AI workflow orchestration.

12. You designed a **graph workflow engine** with DAG execution, checkpointing, and retry semantics.

13. Your workflow engine enabled **long-running resumable agents**, which is an important AI infra problem because LLM workflows are nondeterministic, expensive, and failure-prone.

14. You built or led **memory persistence** for agents, allowing state to survive across workflow steps and possibly across sessions.

15. You designed **fault-tolerant execution across distributed environments**, meaning you dealt with retries, worker failures, partial progress, state recovery, and execution consistency.

16. You led **model router orchestration across Claude, GPT, and Grok**, so you handled heterogeneous LLM backends instead of depending on one provider.

17. Your model router used **capability-aware routing**, meaning the system selected models based on context length, tool support, reasoning ability, cost, latency, reliability, or provider behavior.

18. You worked on **context optimization**, which likely involved prompt compaction, memory selection, retrieval, context window allocation, token budgeting, and avoiding unnecessary token spend.

19. The model orchestration layer consumed **1B+ tokens per month**, which gives you strong credibility around cost control, rate limits, observability, and provider reliability.

20. You institutionalized an **LLMOps telemetry mesh**, ingesting **50M spans/day** and managing **2.5TB+ monthly trace data** for deterministic replay, reducing MTTR for AI logic anomalies by **60%**.

# 2. 40 Principal Engineer-level interview questions for your BlackBox experience

Rating scale:

**10/10** = very likely / very Principal-level / directly tied to resume
**9/10** = strong system-design depth
**8/10** = important supporting topic
**7/10** = useful but more specialized

|  # | Question                                                                                                                                                                                                                                     | Rating |
| -: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: |
|  1 | You say you architected a Golang-backed WASM sandbox plane for 1M+ daily code executions. Walk me through the full architecture: request intake, scheduling, sandbox creation, execution, isolation, logging, result streaming, and cleanup. |  10/10 |
|  2 | Why did you choose WASM for sandboxing instead of Docker, gVisor, Firecracker, or Kata Containers?                                                                                                                                           |  10/10 |
|  3 | What isolation guarantees does WASM provide, and where is it weaker than container or microVM isolation?                                                                                                                                     |  10/10 |
|  4 | How would you prevent malicious AI-generated code from escaping the sandbox or abusing CPU, memory, filesystem, or network access?                                                                                                           |  10/10 |
|  5 | How would you design resource limits for 1M+ daily sandbox executions: CPU time, memory, wall-clock timeout, stdout size, file size, network egress, and concurrency?                                                                        |  10/10 |
|  6 | How would you design multi-tenant isolation for a code execution platform used by enterprise customers?                                                                                                                                      |  10/10 |
|  7 | How would you make a sandbox execution platform SOC-2 ready? What controls, audit logs, access policies, and evidence would you build?                                                                                                       |   9/10 |
|  8 | How would you design deterministic replay for code execution and agent workflows when LLM calls are nondeterministic?                                                                                                                        |  10/10 |
|  9 | You mention 10K+ agent runs/day. Design the distributed agent runtime that supports this scale reliably.                                                                                                                                     |  10/10 |
| 10 | What is the difference between a simple LLM chat loop and a production-grade ReAct agent runtime?                                                                                                                                            |  10/10 |
| 11 | How does ReAct work internally: reasoning, tool selection, tool invocation, observation, next step, and termination?                                                                                                                         |   9/10 |
| 12 | Where do LangGraph and LangChain help, and where do they become limiting at Principal Engineer scale?                                                                                                                                        |   9/10 |
| 13 | How would you design an agent workflow engine using DAG execution, checkpointing, retry semantics, and durable state?                                                                                                                        |  10/10 |
| 14 | How do you decide whether an agent workflow should be modeled as a DAG, a state machine, an event stream, or a queue-driven worker system?                                                                                                   |  10/10 |
| 15 | What does durable execution mean in agentic systems, and how is it different from just retrying a failed API call?                                                                                                                           |  10/10 |
| 16 | How would you handle partial failure in a long-running agent workflow where some tools already executed side effects?                                                                                                                        |  10/10 |
| 17 | How would you design idempotency for tool calls made by AI agents?                                                                                                                                                                           |  10/10 |
| 18 | How would you prevent an agent from repeatedly calling the same expensive or dangerous tool in a loop?                                                                                                                                       |  10/10 |
| 19 | How would you enforce policy gates before high-risk agent actions such as deleting data, changing infra, sending emails, or executing code?                                                                                                  |  10/10 |
| 20 | How would you design human-in-the-loop approval for production-grade agent workflows?                                                                                                                                                        |   9/10 |
| 21 | You built memory persistence for agents. What should be stored in short-term memory, long-term memory, vector memory, and execution state?                                                                                                   |  10/10 |
| 22 | How would you prevent memory poisoning, cross-tenant memory leakage, or retrieval of sensitive information by the wrong agent?                                                                                                               |  10/10 |
| 23 | How would you design a model router across Claude, GPT, and Grok? What signals determine routing?                                                                                                                                            |  10/10 |
| 24 | How do you route requests based on model capability: context length, tool-use support, structured output, latency, cost, safety, and reliability?                                                                                            |  10/10 |
| 25 | How would you handle provider outages, rate limits, degraded latency, or sudden model behavior changes?                                                                                                                                      |  10/10 |
| 26 | How would you design fallback logic without causing quality regression, duplicate tool calls, or inconsistent user-visible behavior?                                                                                                         |  10/10 |
| 27 | What is context optimization in a 1B+ tokens/month platform, and how would you reduce token cost without hurting answer quality?                                                                                                             |  10/10 |
| 28 | How would you design prompt compaction, retrieval filtering, context budgeting, and memory summarization?                                                                                                                                    |   9/10 |
| 29 | How would you measure model-router quality? What offline and online metrics would you track?                                                                                                                                                 |   9/10 |
| 30 | How would you design cost attribution per tenant, user, model, workflow, and tool call?                                                                                                                                                      |   9/10 |
| 31 | You mention an LLMOps telemetry mesh ingesting 50M spans/day. Design the telemetry architecture.                                                                                                                                             |  10/10 |
| 32 | What should an LLM span contain: prompt hash, model, latency, tokens, tool calls, retrieval context, safety events, errors, and output metadata?                                                                                             |  10/10 |
| 33 | How would you store and query 2.5TB+ monthly trace data cost-effectively?                                                                                                                                                                    |  10/10 |
| 34 | How would you design trace sampling for LLM workflows without losing rare but important failures?                                                                                                                                            |  10/10 |
| 35 | How would you debug an AI logic anomaly using traces, deterministic replay, tool-call history, model inputs, and retrieved context?                                                                                                          |  10/10 |
| 36 | How would you reduce MTTR for agent failures by 60%? What exact observability and replay features matter most?                                                                                                                               |  10/10 |
| 37 | How would you design structured event serialization for deterministic replay of agent runs?                                                                                                                                                  |   9/10 |
| 38 | What are the hardest distributed systems problems in agentic AI platforms compared to normal microservices?                                                                                                                                  |  10/10 |
| 39 | How would you design a production deployment pipeline for agent runtimes, sandboxes, model routers, and telemetry services?                                                                                                                  |   9/10 |
| 40 | As a Principal Engineer, how would you balance security, model quality, latency, cost, developer velocity, and enterprise compliance in this platform?                                                                                       |  10/10 |

# The 10 highest-priority questions to prepare first

These are the ones most likely to expose whether your BlackBox experience is truly Principal Engineer-level:

1. **Design the WASM sandbox plane for 1M+ daily AI-generated code executions.**
2. **Compare WASM vs Docker vs gVisor vs Firecracker vs Kata for secure code execution.**
3. **Design a distributed ReAct agent runtime with durable execution.**
4. **Explain DAG orchestration, checkpointing, retries, and resumability for long-running agents.**
5. **Design idempotency and side-effect control for agent tool calls.**
6. **Design a model router across Claude, GPT, and Grok.**
7. **Explain context optimization for a 1B+ tokens/month platform.**
8. **Design an LLMOps telemetry mesh ingesting 50M spans/day.**
9. **Explain deterministic replay for nondeterministic AI workflows.**
10. **Threat model an enterprise agentic AI platform with code execution, memory, tools, and multi-tenant isolation.**

Your BlackBox experience should be framed like this:

> “At BlackBox, I led Principal-level architecture for an enterprise agentic AI platform: secure WASM-based code execution, durable ReAct agent runtimes, DAG workflow orchestration, multi-model routing across Claude/GPT/Grok, context optimization at 1B+ tokens/month, and high-volume LLMOps telemetry for deterministic replay and faster incident resolution.”
