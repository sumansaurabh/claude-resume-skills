# 08 - Tradeoffs and Alternatives

## Isolation Approach Comparison

| Approach | Isolation Strength | Startup Latency | Memory Overhead | Network Isolation | Multi-tenant Safety | Why Chosen / Rejected |
|---|---|---|---|---|---|---|
| **WASM (Wasmtime/Wasmer/wazero)** | Strong - capability model, linear memory bounds, no shared address space | **Sub-10ms** (warm, AOT-cached) / 50-200ms (cold) | Low - ~5MB per instance overhead | Total - WASI has no socket API; sock_* imports blocked at linker level | High - each instance has isolated linear memory; instance discard on completion | **Chosen.** Sub-10ms warm start fits agent loop budget; capability model maps cleanly to zero-trust; any language compiling to WASM; no CGo attack surface |
| **Docker / OCI containers** | Medium - Linux namespaces, cgroups, seccomp; shared kernel | 500ms–2s (image pull + container start) | Medium - ~50MB base image | Configurable - requires explicit network namespace setup; `--network=none` not default | Medium - container breakout CVEs (runc CVE-2019-5736, containerd escapes) are real | **Rejected** for per-execution use. Image pull overhead too slow; shared kernel namespace; not designed for sub-100ms per-request execution |
| **gVisor (runsc)** | Very strong - syscall interception via Go userspace kernel; kernel surface dramatically reduced | 100–500ms (ptrace mode), 50–200ms (KVM mode) | High - full userspace kernel running per workload | Strong - gVisor's network stack is userspace; filtered | High - no shared kernel; ptrace/KVM isolation | **Hybrid candidate.** Best for long-running sandboxed workloads. Startup latency is too high for zero-shot agent-loop executions; operationally complex at our scale |
| **Firecracker microVMs** | Strongest - hardware VM isolation; separate kernel per VM | 125ms (with snapshots), 1–2s (cold) | High - full minimal kernel per VM (~50MB) | Strong - separate virtual NIC per VM | Highest - full VM boundary | **Rejected.** AWS Lambda uses it to amortize the overhead across long-lived invocations. At 1M+/day with sub-100ms budget per execution, the 125ms+ cold start even with snapshotting does not fit; operational complexity is disproportionate |
| **Kata Containers** | Strong - VM-level via QEMU/KVM under OCI interface | 500ms–1s (VM boot) | Very High - QEMU overhead | Strong - VM-level network isolation | High - VM boundary per container | **Rejected.** VM-level startup cost eliminates the performance argument; QEMU attack surface reintroduces complexity we wanted to avoid |
| **nsjail (Google)** | Medium-high - Linux namespaces (PID, mount, net, IPC, user) + seccomp | ~10–50ms | Low - process-level | Strong - network namespace with no routes | Medium - shared kernel; seccomp bypasses possible | **Viable alternative** for C/C++ workloads compiling natively. Does not give language-agnostic isolation; seccomp profile maintenance is fragile; no formal capability model comparable to WASI |
| **V8 Isolates (Cloudflare Workers approach)** | Strong - V8 heap isolation; structured clone boundary between isolates | **<1ms** (warm) | Very Low - shared V8 heap with isolate boundaries | Strong - no native socket in V8; Fetch API polyfill only if granted | High - isolate boundaries enforced by V8 | **Rejected** for our use case. JavaScript/TypeScript only. We need Python (NumPy, pandas) and eventually Rust/Go. V8 Isolates cannot run arbitrary compiled-to-WASM code without trusting the WASM module's interaction with V8 internals |

---

## Why WASM Was Chosen for AI Code Execution

WASM satisfies four constraints simultaneously that no other option does at our operating point.

**Sub-10ms warm start.** AI agent loops operate in 200–500ms round-trip budgets. Code execution is one step inside that loop. Even gVisor (KVM mode) at 50ms on the fast path adds 25% of the entire budget for a single sandbox spin-up. WASM with AOT-compiled module caching keyed by code hash achieves cold start in 50–200ms and warm-pool dispatch in under 10ms. At 1M+ executions/day - roughly 12 per second average with 80/s peaks - only WASM can absorb peak load without queueing.

**Deterministic memory model.** WASM's linear memory is an isolated byte array whose growth is explicitly metered via `wasm_memory_grow` instructions. The runtime can cap it precisely (e.g., 128MB = 2048 pages × 64KB) and trap synchronously before any OS-level allocation happens. This is not analogous to cgroup memory limits, which are enforced at page-fault time after allocation and may OOM-kill asynchronously. WASM's model means a tenant allocating 10GB in Python traps inside the WASM runtime deterministically, with zero host OS memory cost beyond the cap.

**Language-agnostic.** Any language with a WASM compilation target (C, C++, Rust, Go via TinyGo, Python via Pyodide, JavaScript via QuickJS) runs inside the same sandbox infrastructure. The isolation guarantees do not change by language. Docker or gVisor would require separate base images per runtime; Firecracker requires separate kernel configurations. WASM decouples the runtime choice from the isolation mechanism.

**Capability-based security model maps to zero-trust.** WASI's design principle is explicit grant: a WASM module can only access host resources that the host explicitly passes in as handles. We pass exactly three: stdin, stdout, stderr. There is no filesystem handle, no socket handle, no environment variable table. This is not a seccomp deny-list (enumerate what to block); it is an allowlist at the API surface level. For SOC-2 Type II auditors, demonstrating "the filesystem API literally does not exist inside the sandbox" is a stronger control than "we have a seccomp profile that blocks 150 syscalls."

---

## Why Docker Alone Is Not Enough

Docker containers were the incumbent isolation pattern but fail on three axes for per-execution AI code sandboxing.

**Startup latency.** Even with a pre-pulled base image and no network, `docker run` cold start is 500ms–2s due to OCI layer extraction, namespace setup, and cgroup initialization. With pre-warmed container pools (a la AWS Fargate), cold starts fall to ~200ms - still 4–20× slower than WASM warm dispatch.

**Shared kernel namespace risks.** Docker containers share the host Linux kernel. Every kernel CVE is a potential container escape. The threat is not theoretical: runc CVE-2019-5736 allowed a malicious container process to overwrite the host runc binary through `/proc/self/exe`, giving the attacker full host access. containerd CVE-2020-15257 allowed privilege escalation via the host's abstract socket namespace. At 1M+ AI-generated code executions per day, the adversarial surface is enormous. We are explicitly executing untrusted code at scale.

**Not designed for sub-100ms per-request execution.** Docker's architecture assumes long-lived workloads: containers that start once and serve many requests. Running a new container per code execution wastes most of the startup budget on container lifecycle rather than user code. The OCI model does not have a built-in "pre-warmed instance with clean state on demand" primitive - you build that yourself at significant complexity cost, and you still inherit the shared kernel risk.

---

## Tradeoff: Fuel-Based CPU Metering vs OS-Level cgroup CPU Quota

These are the two available mechanisms to enforce CPU resource limits on sandboxed code execution. They have fundamentally different semantics.

### Fuel (Wasmtime / wazero)

Fuel is a per-instruction token budget assigned before execution begins. Each WASM instruction consumes one or more units of fuel; when the budget is exhausted, the runtime raises a synchronous trap and terminates execution immediately.

**Advantages:**
- Per-instruction granularity. Fuel counts executed instructions, not elapsed wall time. A tight loop of `i64.add` instructions burns fuel at a predictable rate regardless of how many cores the host has.
- Language-runtime aware. Fuel metering happens inside the WASM runtime, after JIT compilation. It is aware of every branch, every memory access, every arithmetic op.
- Instant kill. When fuel is exhausted, the WASM module traps synchronously. There is no scheduling quantum to wait for. The host goroutine gets control back immediately.
- No shared kernel state. Fuel metering requires no kernel resources - no cgroup creation, no namespace, no syscall. This is why it scales to 1M+/day without meaningful per-execution overhead.

**Disadvantages:**
- Not wall-clock time. Fuel measures instruction count, not real-world compute. A module that calls a WASM-native math operation (e.g., `f64.sqrt`) may consume 1 fuel but take 100ns; a loop of `i32.const` instructions may consume 1000 fuel but take 1 microsecond. Calibrating the fuel budget to a time limit requires benchmarking the specific workload mix.
- Requires calibration per language runtime. Pyodide's Python interpreter emitting WASM instructions is very different from a Rust-compiled tight loop. A Python `for i in range(10**6): pass` burns orders of magnitude more fuel per second than the equivalent Rust loop. The fuel budget must be set per language runtime type.
- Native WASM is faster than interpreted. A Rust binary compiled to WASM runs much faster per fuel unit than an interpreted Python loop inside Pyodide WASM. Attackers who can control the WASM compilation might craft maximally fuel-efficient computation.

### OS-Level cgroup CPU Quota

cgroup v2 `cpu.max` enforces a CPU bandwidth quota: the process receives at most `quota` microseconds of CPU time per `period` microseconds. Exceeding the quota causes the process to be throttled (not killed) until the next period.

**Advantages:**
- Kernel-enforced. The scheduler itself enforces the quota. It is not bypassable from within the process.
- Accurate wall-clock CPU. The cgroup scheduler measures real CPU time consumed, accounting for actual instruction latency including memory stalls, cache misses, and branch mispredictions.

**Disadvantages:**
- Scheduling quantum granularity (~10ms). The kernel scheduler operates on scheduling quanta, typically 4–20ms. A process that exhausts its quota may not be throttled for up to one quantum after the limit is hit.
- Can't kill immediately. cgroup CPU quota throttles - it does not kill. A process that hits its quota is paused until the next period. To terminate it, you need a separate watchdog that detects the throttle and sends SIGKILL. This adds latency between limit-hit and termination.
- Per-process, not per-WASM-instance. In our model, a single worker process may serve many WASM executions sequentially. Applying cgroup quota at the process level mixes all executions' CPU usage together. Applying it per-execution requires forking a new process per execution - which reintroduces the startup latency we eliminated.

### Resolution

Use **fuel for soft CPU enforcement** inside the WASM sandbox (immediate, per-execution, no kernel overhead) and **cgroup cpu.max at the worker process level** as a hard ceiling against a compromised runtime or JIT bug that bypasses fuel. Fuel is the primary control; cgroup is the defense-in-depth backstop.

---

## Tradeoff: Pre-Warmed Pool vs Fresh Instantiation Per Execution

### Pre-Warmed Pool

A pool of N WASM instances is kept alive between executions. Each instance has completed JIT compilation and module initialization. On dispatch, the scheduler assigns the execution to an idle instance.

**Advantages:**
- Lower latency. JIT compilation is the dominant cold-start cost (50–200ms for complex modules like Pyodide). A pre-warmed instance skips this entirely; dispatch-to-execution latency is under 10ms.
- Predictable tail latency. Warm pool dispatch has low variance. Cold starts cause latency spikes proportional to module complexity.

**Disadvantages:**
- State leakage risk. If the WASM linear memory is not fully reset between executions, residual data from execution A could be visible to execution B. This must be proven, not assumed.
- Memory pressure. N warm instances each holding 128MB of linear memory consume N × 128MB of host memory even when idle. At 200 warm workers, that is 25.6GB of reserved memory.

**Mitigation for state leakage:** The correct model is not to reuse the same instance but to keep the JIT-compiled module (immutable bytecode) cached and create a **fresh instance** from the cached module for each execution. `wazero.CompiledModule` (and the equivalent in Wasmtime/Wasmer) is thread-safe and immutable; `InstantiateModule` creates a new linear memory from scratch. Pre-warming means keeping N goroutines ready with an instantiated module, not reusing the module instance's memory across executions.

### Fresh Instantiation Per Execution

Each execution compiles the WASM module from scratch and creates a new instance.

**Advantages:**
- Strongest isolation guarantee. There is no shared state by construction. No analysis required to prove memory cleanliness.

**Disadvantages:**
- JIT compilation cost per execution. For Pyodide (8MB WASM bytecode), JIT takes 150–800ms cold depending on hardware. This is unacceptable at 80 executions/second.

### Resolution

**AOT compilation cache keyed by content hash + pre-warm pool with fresh instantiation.**

1. When a WASM module binary arrives, compute its SHA-256 hash.
2. Look up the AOT-compiled artifact in a local cache (disk or in-process `CompiledModule` map) keyed by hash.
3. If found, skip compilation - use the cached `CompiledModule` directly.
4. Call `InstantiateModule` on the cached module to create a **fresh instance** with clean linear memory.
5. Return the instance to the pre-warm pool.

This gives warm dispatch latency (step 4 is ~5ms) while maintaining the isolation guarantee of fresh-instance semantics. The pool holds warm goroutines ready to call `InstantiateModule`, not reused instance state. Memory pressure is still O(pool_size × max_linear_memory), but the isolation argument is trivially provable: linear memory is freshly allocated per instance.
