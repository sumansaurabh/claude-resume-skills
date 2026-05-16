# 10 - Interview Cheat Sheet

## The 30-Second Hook

> "I architected the WASM sandbox execution plane at BlackBox - the isolation layer that lets the Copilot AI run LLM-generated code safely. 1M+ executions/day, sub-50ms warm start, pure-Go wazero runtime, and the control that unblocked our SOC-2 certification."

---

## The 5-Step Flow (Say This First)

1. **Request intake:** `POST /execute` + SSE stream; JWT auth; rate limit via Redis token bucket
2. **Schedule:** Pre-warm pool of 200 Go workers; weighted round-robin dispatch; cold start if pool empty
3. **Sandbox creation:** Worker calls `wazero.InstantiateModule()` - fresh linear memory, WASI with **only stdin/stdout/stderr**, no filesystem, no network, 128MB memory cap
4. **Execution:** WASM module (Pyodide for Python, QuickJS for JS) runs code with 30s CPU timeout; stdout/stderr stream back as SSE chunks
5. **Cleanup:** `module.Close()` frees linear memory; worker resets and returns to pool in ~50ms

---

## The 3 Isolation Claims (Always Cite All Three)

1. **WASM linear memory** - each instance has separate, bounded memory; no WASM instruction addresses host or other instances' memory
2. **WASI capability model** - no filesystem, no network, no env vars exposed; the only channel is stdin/stdout/stderr
3. **Instance discard** - module instance is closed and freed after each execution; no state crosses execution boundaries

---

## Why WASM Over Docker (The Comparison They'll Ask)

| | WASM (wazero) | Docker |
|---|---|---|
| Warm start | ~50ms | 500ms-2s |
| Cold start | ~800ms (Python) | 500ms-2s |
| Isolation model | Capability-based (formal spec) | Namespace/seccomp/capabilities |
| SOC-2 story | Simpler to demonstrate | More configuration surface |
| Go implementation | Pure Go, no CGo | CGo for Docker client |

---

## Why wazero Over Wasmtime/Wasmer

- **No CGo** → no C-memory vulnerability surface in the runtime itself
- Embeds as a single Go binary - no shared library deployment complexity
- Goroutine-safe - multiple workers share one compiled module safely

---

## Scale Numbers

| Metric | Value |
|---|---|
| Executions/day | 1M+ |
| Peak exec/second | ~80 |
| Warm pool size | 200 workers |
| Warm start latency | <50ms |
| Cold start (Python) | ~800ms (mitigated by pre-warming) |
| Memory per worker | ~5MB overhead + up to 128MB execution |
| Audit spans/day (all products) | 50M (Clickhouse) |

---

## SOC-2 Connection (The Business Anchor)

> "WASM's capability model gave auditors a demonstrable, enforceable isolation control. The prior approach (subprocess with restricted user) failed the SOC-2 audit because a Python jailbreak could still read /proc/self/environ. With WASI, there's no /proc to read - the filesystem API literally doesn't exist inside the sandbox."

---

## Common Traps

| Trap | Best answer |
|---|---|
| "Is WASM real isolation?" | Formally specified, demonstrable capability model; defense-in-depth with Linux namespaces on worker process |
| "What about subprocess.Popen()?" | WASI has no process creation API; Python raises OSError: Function not implemented |
| "What about malloc() exhausting OS memory?" | WASM memory growth uses `wasm_memory_grow`; blocked by `WithMemoryLimitPages`; traps before OS allocation |
| "Why not Docker?" | 10× faster warm start; simpler capability model for SOC-2 |
| "Can user code reach Redis?" | WASI has no socket API; even if WASM escaped, worker is in a Linux network namespace with no routes |
| "SSE is one-way, can users send input mid-execution?" | Fixed stdin; zero-shot model. WebSocket upgrade path for future interactive mode |
| "Why not reuse module instances?" | Python interpreter accumulates global state in linear memory; fresh instance per execution is the safe model |
