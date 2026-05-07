# 09 — Cross-Questions and Rebuttals

## Architecture and WASM

### Q1: WASM sandboxes are not hardware VM isolation. Is WASM "real" isolation for enterprise SOC-2?

**Trap:** Testing whether WASM isolation is security theater or genuine.

**Best answer:** WASM provides a strong, formally specified isolation model that is more demonstrable than many alternatives. The WASM memory model guarantees that code can only address its own linear memory — there's no WASM instruction that can read another process's memory or the host process heap. The WASI capability model guarantees that code can only access host resources (filesystem, network, env vars) that are explicitly granted — and we grant none for user code. For SOC-2, what auditors need is a demonstrable, enforceable control, not just policy. WASM gives us that in a way that's simpler to reason about than "we used seccomp profiles and dropped capabilities in Docker." That said, WASM is a trust boundary in software — a zero-day in the wazero runtime could hypothetically break isolation. We layer Linux namespaces on the worker process as defense in depth, and we keep wazero updated.

---

### Q2: Why not just use Docker containers with gVisor? That's what Google and AWS use.

**Trap:** Testing whether you can defend against a "bigger company does it differently" challenge.

**Best answer:** gVisor/Firecracker is the right answer when you're building a general-purpose serverless compute platform (AWS Lambda, Cloud Run) where the cold start cost can be amortized across many function invocations. For our use case — interactive zero-shot code execution inside an agent loop — the cold start budget is 50-200ms. gVisor adds 100-500ms startup overhead even with snapshotting. Docker is worse: 500ms-2s. WASM with pre-warmed instances delivers 50ms warm starts, which is 10× faster. The SOC-2 compliance story with WASM is also cleaner to explain to auditors: "here are exactly the capabilities granted; everything else is denied by the capability model" is simpler than "here's our seccomp profile, AppArmor policy, and capability drop list."

---

### Q3: WASM linear memory is bounded per instance, but what stops a malicious Python script from allocating a massive list and exhausting the worker's OS memory before the WASM memory limit kicks in?

**Trap:** Testing whether you understand the difference between WASM memory limits and OS memory limits.

**Best answer:** The WASM memory limit (`WithMemoryLimitPages(n)`) is enforced at the WASM runtime level — any WASM instruction that tries to grow the linear memory beyond the cap causes a trap immediately, before OS memory is allocated beyond the limit. Python's memory allocator (inside Pyodide's WASM module) uses `wasm_memory_grow` instructions to request more memory from the WASM runtime. Those instructions are blocked by our limit. So `python -c "x = [0] * 10**9"` would trap inside WASM when it tries to allocate 8GB, not allocate 8GB from the host OS. The worker's OS memory usage is bounded by the WASM memory limit. We also set `resources.limits.memory` on the Kubernetes pod as a belt-and-suspenders fallback.

---

### Q4: What happens if user code in Python spawns a subprocess with `subprocess.Popen()`?

**Trap:** Testing whether you understand how Python/WASM executes system calls.

**Best answer:** `subprocess.Popen()` in Python calls `fork()` and `execve()` at the OS level — those are POSIX process creation system calls. Inside a WASM module running under WASI, there are no process creation APIs in the WASI preview1 spec. Pyodide's WASM build does not link the system's `fork()` — it has no access to the host OS's process table. The Python `subprocess` module, when running inside Pyodide, either raises `NotImplementedError` or the underlying WASM instruction for the syscall trap when it tries to call an unimplemented WASI function. The user sees an OSError like "Function not implemented" in their stderr — a clear signal that process creation is not available.

---

## Pre-Warming and Scheduling

### Q5: You said Python Pyodide takes 800ms cold. If you pre-warm 200 workers, what happens during a traffic spike when all 200 are busy?

**Trap:** Testing capacity reasoning and backpressure design.

**Best answer:** When all warm workers are busy, new executions enter a Redis queue and clients receive a `QUEUED` SSE event with their position and estimated wait time. The autoscaler detects pool saturation (`warm == 0`) and immediately begins spawning new workers. New workers take ~1s to warm up (800ms Pyodide load + 200ms instantiation). During that 1s window, queued executions wait. At 80 exec/s peak with 180 concurrent needed, if we start from zero warm workers it would take 180 seconds to fill the pool — clearly unacceptable. The key is never letting the pool drain: the autoscaler triggers at 80% utilization, not 100%. Pre-provisioning 20% headroom means the pool is typically 40+ warm workers ahead of actual demand, giving the autoscaler time to respond before queue wait becomes user-visible.

---

### Q6: How do you handle a worker that is "warm" but whose Pyodide interpreter has somehow corrupted state from a previous execution?

**Trap:** Testing whether you've thought about subtle isolation failures.

**Best answer:** Each execution gets a **fresh module instance** from `InstantiateModule`, not a reused one. The module instance has its own fresh linear memory — the Python interpreter (Pyodide's CPython inside WASM) starts from its initialized state on every execution. The "warm" part means the WASM module bytecode has already been JIT-compiled and the wazero runtime is running, but the linear memory is re-allocated fresh. So there's no way for state from execution A's Python objects to persist into execution B — they have separate linear memory spaces. The pre-warm optimization only caches the JIT compilation result, not the interpreter heap.

---

### Q7: SSE is unidirectional. What if the client wants to send additional input to a running execution mid-stream?

**Trap:** Testing whether you understand SSE's constraints.

**Best answer:** SSE is server-to-client only — the client cannot push data back to the server on the same connection. For the zero-shot code execution use case, this isn't a limitation: code runs with a fixed stdin, produces output, and terminates. There's no interactive "REPL" style execution in the design. For a future interactive mode where users send additional stdin mid-execution, we'd upgrade to WebSockets, which are full-duplex. The API is designed with this upgrade in mind: the `POST /execute` + SSE stream pattern can be replaced with a WebSocket connection at the same endpoint without changing the event schema.

---

## Security

### Q8: WASM prevents network access — but what if a user encodes an HTTP request in their computation result? For example, printing the output of a database query result that contains private data?

**Trap:** Testing whether you understand that data exfiltration via computation result is a different threat model.

**Best answer:** You're describing a covert channel via the legitimate stdout path. This is a valid threat model but it's a different category: the user is using the computation result as an intentional information disclosure channel, not breaking WASM isolation. Our controls here are: (1) rate limiting on execution volume (you can't run 10,000 database-exfiltrating queries in a minute); (2) output size limits (stdout is capped at 1MB — limits the amount of data per execution); (3) the Copilot product's access controls determine what data the LLM-generated code can compute over in the first place (the sandbox doesn't give users access to data they don't already have). The WASM sandbox prevents the unauthorized access (reading other tenants' memory, calling internal APIs) — it doesn't prevent you from doing computation on data you legitimately have.

---

### Q9: Your execution audit log stores code_hash, not the code itself. How do you handle a subpoena or legal request for the actual executed code?

**Trap:** Testing whether you've thought through the legal/compliance implications of the data retention design.

**Best answer:** The hash design was a deliberate legal and compliance decision, not just a storage optimization. Storing user code creates data retention obligations and potentially IP ownership questions. By storing only the hash, we can verify "was this specific code executed?" without retaining the code. For legal requests: we respond that we store a hash for verification purposes but do not retain the code itself — the code retention period is limited to what's in our execution memory during the run (cleared after). This design was reviewed with legal before finalization. If a compliance regime required code retention (which I haven't encountered for this use case), we'd encrypt it at rest with a customer-managed key and apply a strict retention policy.

---

## Observability

### Q10: You emit 50M+ spans/day at BlackBox across all products. How do you avoid trace storage becoming a bottleneck?

**Trap:** Connecting the telemetry mesh claim from the resume to the WASM sandbox specifically.

**Best answer:** The LLMOps telemetry mesh at BlackBox (50M spans/day, 2.5TB+/month) was designed for high-throughput span ingestion from day one. For the WASM sandbox specifically: at 1M executions/day, each execution emits ~3 spans (dispatch, instantiate, run) = 3M spans/day from the sandbox alone. The OTel collector batches these before writing to Clickhouse in bulk inserts — Clickhouse is purpose-built for high-throughput column-store ingestion (billions of rows/day is normal). The key design choice was sampling: agent reasoning spans are sampled at 1% (there are many and they're long); code execution spans are unsampled at 100% (they're needed for the SOC-2 audit trail). Not all spans are equal — the sampling policy reflects the audit vs. debugging purpose of each span type.

---

## Leadership

### Q11: This was a founding-team-level architecture decision at BlackBox. What was the hardest alignment problem in getting WASM adopted?

**Trap:** Testing Principal Engineer behavior — not just design, but cross-team influence.

**Best answer:** The hardest alignment was convincing the frontend/product team that WASM's constraints (no network, no filesystem) wouldn't cripple the feature. Their mental model of "code execution" was based on the prior subprocess approach where code could do anything. The reframe I used was: "the sandbox executes the code the LLM generates, and the LLM generates code appropriate for the sandbox it's told about." We updated the LLM's system prompt to describe the sandbox's capabilities — including what it can't do — and gave the LLM examples of how to express network requests as tool calls rather than as code inside the sandbox. Once the product team saw that the LLM adapted cleanly (it just called the HTTP tool instead of writing requests in Python), the concern evaporated. The technical architecture aligned with the product design: the sandbox runs computation, tool calls handle I/O.
