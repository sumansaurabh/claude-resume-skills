# 01 — Executive Summary

## The One-Paragraph Answer

At BlackBox, I architected the WASM sandbox plane — the execution layer that runs LLM-generated code safely inside the Copilot product. The system processes 1M+ zero-shot code executions daily with sub-200ms p99 cold-start latency. The architecture separates a **control plane** (a Go API server that receives execution requests, validates them, routes to the scheduler, and manages result streaming) from an **execution plane** (a pool of Go worker processes, each embedding a wazero WASM runtime). Each execution gets a fresh WASM module instance with WASI capabilities locked to stdin/stdout/stderr only — no filesystem access, no network access, no inter-execution shared memory. The pre-warmed worker pool keeps p99 cold start under 50ms. Resource limits (memory cap at 128MB, CPU timeout at 30s) are enforced by the WASM runtime before execution starts. Results stream back to the caller via server-sent events. After execution, the WASM linear memory is zeroed and the module instance discarded — no residual state crosses execution boundaries. Execution events (start, finish, exit code, resource usage, duration) are emitted as OpenTelemetry spans to Clickhouse, providing the audit trail required for SOC-2.

---

## The 60-Second Verbal Answer

> "The WASM sandbox was the security foundation that unblocked our enterprise Copilot sales. The SOC-2 requirement was simple: LLM-generated code must run in complete isolation — no access to other customers' data, no ability to exfiltrate environment variables or secrets, no persistent state between runs.
>
> Here's how it works end to end. A user submits code via the Copilot UI or the agent's tool-call interface. The request hits a Go API server — we validate the payload, check the caller's rate limit, assign an execution ID, and route to the execution scheduler. The scheduler picks a pre-warmed worker from a pool. The worker embeds a wazero runtime instance — that's a pure-Go WASM runtime with no CGo dependency, which matters for security because CGo attack surfaces are larger.
>
> The worker compiles or loads the WASM module for the requested language — Python via Pyodide compiled to WASM, JavaScript via QuickJS. It configures WASI with only stdin/stdout/stderr allowed: no filesystem mounts, no network sockets, no environment variables except an explicit allowlist. It sets memory to 128MB max and execution timeout to 30 seconds, then runs the module.
>
> Stdout and stderr are captured in real time and streamed back to the caller via SSE. When execution finishes, the module instance is discarded — we don't reuse module instances across executions because WASM linear memory accumulates state. The worker resets and picks up the next execution.
>
> For observability, every execution emits an OpenTelemetry span with execution ID, tenant, language, exit code, memory peak, CPU time, and duration. These land in Clickhouse for the SOC-2 audit log and in our operational dashboards for real-time alerting.
>
> At 1M executions per day — about 12 per second average, 50-80 at peak — the main engineering problem is pre-warming. WASM module startup for Python/Pyodide takes 800ms cold. We pre-warm a pool of 200 workers and use a weighted round-robin dispatch to stay within warm pool capacity. When the pool drains, we accept cold starts and autoscale workers."

---

## Strongest Resume Anchors

| Signal | Claim | Why it matters |
|---|---|---|
| Golang-backed | Go is the orchestration layer | Suggests deep Go systems programming, not just glue code |
| WASM sandbox plane | Built the isolation layer, not just used it | Architecture-level ownership |
| 1M+ daily executions | High-throughput constraint | Not a toy demo |
| SOC-2 compliance unblocked | Business impact of security architecture | Connects tech to revenue |
| Zero-shot execution | No persistent state, cold-start problem | Tests whether you've solved the pre-warming problem |
| wazero (pure Go WASM runtime) | No CGo dependency = smaller attack surface | Security reasoning depth |

---

## What Makes This a Principal Engineer Answer

A junior engineer says "we ran code in Docker containers." A senior engineer says "we used WASM for isolation." A principal engineer explains:
- **Why WASM over Docker** at this throughput (sub-50ms vs. 500ms+ container startup)
- **What WASI is** and exactly which capabilities are granted
- **How memory isolation works** at the WASM level (linear memory, module instance lifecycle)
- **How streaming output works** without blocking the worker
- **What the pre-warming architecture looks like** and how it handles capacity pressure
- **What SOC-2 specifically required** and how each architectural decision maps to a control
