# 00 — Question and Context

## Original Question

> "You say you architected a Golang-backed WASM sandbox plane for 1M+ daily code executions. Walk me through the full architecture: request intake, scheduling, sandbox creation, execution, isolation, logging, result streaming, and cleanup."

---

## Scope

This is a **10/10 principal-engineer system design question** testing:

- System design for a high-throughput, low-latency execution engine
- Security isolation design (SOC-2 compliance motivation)
- WASM runtime depth — not just "we used WASM" but how it works
- Control plane vs. execution plane separation
- Streaming output design
- Resource management and cleanup at 1M+ executions/day
- Scale, cost, and operational depth

---

## Assumptions

1. **BlackBox Copilot** is an AI-powered no-code/low-code platform where users write prompts or instructions and the Copilot generates and executes code on their behalf. The WASM sandbox is the execution layer for that generated code.
2. **Zero-shot execution** means each code snippet runs without a persistent execution environment — no shared state across executions, no long-running processes per user.
3. **Golang-backed** refers to the orchestration, scheduling, and runtime management layer written in Go. The WASM runtime itself is embedded via Go bindings.
4. **Primary languages supported:** Python (via Pyodide compiled to WASM), JavaScript (via QuickJS or Deno compiled to WASM), possibly Go itself and Bash subsets. Multi-language support is an assumption — confirm with "the platform targeted Python and JavaScript initially, with others on the roadmap."
5. **wazero** (pure-Go WASM runtime, no CGo) was the runtime choice for security and deployment simplicity. Alternatively, Wasmtime-Go bindings could have been used.
6. **WASI (WebAssembly System Interface)** provides the capability-based host interface — stdin/stdout/stderr allowed; filesystem and network denied by default.
7. **SOC-2** compliance specifically required: tenant isolation (no cross-execution data leakage), audit logging of all executions, resource limits, and network egress controls.

---

## Resume Anchors Used

| Claim | Source |
|---|---|
| Architected Golang-backed WASM sandbox plane | BlackBox bullet 1 |
| Isolating 1M+ daily zero-shot code executions | BlackBox bullet 1 |
| Unblocking Enterprise SOC-2 compliance for core Copilot product | BlackBox bullet 1 |
| LangGraph/LangChain-based reAct agents, tool-calling | BlackBox bullet 2 |
| DAG orchestration, durable execution, 10K+ agent runs/day | BlackBox bullet 2 |
| LLMOps telemetry mesh, 50M spans/day, 2.5TB+/month traces | BlackBox bullet 5 |
| Technologies: Sandbox, OpenTelemetry, Clickhouse, Langfuse, Guardrails | BlackBox tech stack |
| Language: Golang | Resume skills |

---

## Platform Context

The WASM sandbox plane sits inside a larger agentic AI platform:

```
User prompt
    │
    ▼
LangGraph ReAct agent (tool-calling)
    │
    ├── LLM call (Claude/GPT/Grok) ← model router
    │
    └── Tool: "execute_code" ← THIS IS WHERE THE WASM SANDBOX LIVES
              │
              ▼
        WASM Sandbox Plane (Go)
              │
              ▼
        Result returned to agent → next reasoning step
```

The sandbox is a **tool** in the agentic system. The agent generates code, calls the `execute_code` tool, the WASM sandbox runs it in isolation, and the result feeds back into the agent's reasoning loop. This context is important for understanding the latency requirements (agent waiting for result), the streaming design (user sees output incrementally), and the security requirements (untrusted LLM-generated code runs in the sandbox).

---

## Classification

**System design** with significant **security isolation architecture**, **API design**, **LLD**, and **scaling** depth required.
