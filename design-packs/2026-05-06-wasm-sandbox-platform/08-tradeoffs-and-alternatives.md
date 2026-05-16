# 08 - Tradeoffs and Alternatives

## Sandbox Technology Alternatives

| Option | Cold Start | Isolation Strength | Throughput | SOC-2 Story | Decision |
|---|---|---|---|---|---|
| **WASM (wazero)** | 50ms (warm) / 800ms (cold) | Strong (capability model, memory safety) | High (goroutine-per-exec) | Excellent (demonstrable capability-based model) | Chosen |
| **Docker containers** | 500ms-2s | Strong (namespace isolation) | Medium (container startup overhead) | Good (common, well-understood) | Rejected (too slow for interactive use) |
| **gVisor (runsc)** | 200-500ms | Very strong (syscall interception) | Lower than WASM | Excellent | Rejected (complex infra; overkill at this scale) |
| **Firecracker microVMs** | 125ms (warm) | Strongest (hardware VM isolation) | Medium | Excellent | Rejected (overkill; used by AWS Lambda; complex setup) |
| **subprocess / Python exec()** | <10ms | Weak (same OS, same filesystem) | Highest | Unacceptable (no isolation) | Rejected (failed SOC-2 audit pre-WASM) |
| **V8 Isolates (Cloudflare Workers model)** | <1ms | Strong (V8 sandbox) | Highest | Good | Viable alternative for JS-only; doesn't support Python |

**Why WASM over Docker:** For interactive use inside an agent loop, 500ms+ container cold starts are too slow - users see the Copilot "thinking" pause extend noticeably. WASM's 50ms warm start with pre-pooling fits naturally in the <200ms agent loop budget.

**Why WASM over subprocess:** The previous implementation used Python subprocess in a restricted user account. This failed SOC-2 because: (1) a jailbreak in the Python interpreter could still access the host filesystem, (2) environment variables were visible via `/proc/self/environ`, (3) no enforceable memory limits without cgroup setup complexity.

---

## Go Runtime Alternatives for WASM

| Runtime | Pure Go | Performance | WASI Support | Decision |
|---|---|---|---|---|
| **wazero** | Yes | Good (JIT for amd64/arm64) | Preview 1 | Chosen: no CGo = no C-memory vulnerability surface |
| **Wasmtime-Go** | No (Rust via CGo) | Excellent (Cranelift JIT) | Preview 1 + preview 2 | Viable alternative; CGo boundary was the concern |
| **Wasmer-Go** | No (Rust via CGo) | Excellent | Preview 1 | Same concern as Wasmtime |
| **WasmEdge** | No (C++ via CGo) | Good | Preview 1 + WASI-NN | Rejected; less community support |

---

## Language Runtime Alternatives for Python in WASM

| Option | WASM binary size | Cold start | Python version | Decision |
|---|---|---|---|---|
| **Pyodide** | ~8MB | ~800ms cold, ~50ms warm | 3.11 | Chosen: most complete Python stdlib, NumPy support |
| **RustPython** | ~4MB | ~200ms cold | 3.x (incomplete) | Rejected: incomplete stdlib (no `os.path`, limited `json`) |
| **CPython + Emscripten** | ~30MB | ~2s cold | 3.11 | Rejected: too large; slow cold start |
| **MicroPython** | ~300KB | ~20ms cold | subset | Rejected: missing too much stdlib for user code |

**Pyodide's tradeoff:** Pyodide is large (8MB WASM bytecode) and slow to compile cold. The pre-compilation cache and pre-warm pool make this acceptable. If we needed to support Python for serverless (no warm pool), we'd look at RustPython when its stdlib coverage improves.

---

## Streaming Alternatives

| Option | Latency to first byte | Complexity | Reconnect support | Decision |
|---|---|---|---|---|
| **SSE (Server-Sent Events)** | Low (HTTP streaming) | Low | Yes (Last-Event-ID) | Chosen: native HTTP, works through proxies |
| **WebSocket** | Low (full-duplex) | Medium | Manual (reconnect logic) | Viable; more complex for one-way streaming |
| **Long polling** | High (wait for completion) | Low | Simple | Rejected: no streaming output |
| **gRPC server streaming** | Low | Medium | Via retry policies | Viable for agent-to-platform communication |

SSE was chosen because: (1) browser clients support it natively without a library, (2) it works through HTTP proxies and CDNs without protocol negotiation, (3) `Last-Event-ID` provides reconnect semantics built-in. The Copilot UI is a browser application, so SSE's simplicity wins.

---

## Scheduling Alternatives

| Option | Latency | Complexity | Decision |
|---|---|---|---|
| **In-process Go channel (chosen)** | <1ms dispatch | Low | No external queue dependency; all in memory |
| **Redis queue (LPUSH/BRPOP)** | ~1ms + Redis RTT | Low | Would work; adds external dependency |
| **Kafka / SQS** | 5-50ms | High | Overkill; too much latency for interactive use |
| **gRPC to separate execution service** | ~1ms + gRPC RTT | Medium | Would enable separate scaling; adds network hop |

In-process Go channels were chosen for dispatch because the scheduler and workers are in the same process. The tradeoff: you can't scale the scheduler and workers independently. If we needed to run the scheduler on a different machine from the workers (e.g., for multi-region), we'd move to Redis LPUSH/BRPOP or gRPC.

---

## The One Design Decision I'd Change with Hindsight

**Worker language affinity.**

Today, each worker is pre-loaded with a single language runtime (Python or JavaScript). A Python worker cannot execute a JavaScript request without reloading the module - a ~200ms overhead. This creates scheduling inflexibility: if Python workers are busy but JS workers are idle, JS workers can't help.

**What I'd design instead:** Universal workers that can switch languages. The `ModuleCache` is already shared across workers (it's a shared `CompiledModule`). A worker could call `InstantiateModule` with a different language's compiled module on each execution. The ~200ms cost is only for module instantiation, not recompilation. This would allow the pool to be language-agnostic and eliminate the need for language-specific sizing.

**Why we didn't do it initially:** The pre-warm optimization requires the module to be fully instantiated with a running Python/QuickJS interpreter between executions. If a worker switches languages, it needs to re-initialize the interpreter on every switch - losing the pre-warm benefit. The language-affinity model kept the warm path fast. In hindsight, the right design is a two-tier pool: a small "language-agnostic" overflow pool that handles bursts when the primary pool saturates, and a large pre-warmed primary pool with language affinity.
