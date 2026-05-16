# 05 - Scaling and Capacity

## Throughput Model

**Starting facts:**
- 1M+ daily zero-shot code executions
- Average execution: 500ms wall time, 50ms CPU time, 32MB memory peak
- Burst pattern: AI assistant usage peaks 9am–6pm workdays; burst = ~4x average sustained

```
1M executions / 86400 seconds = 11.6 req/sec average

Burst planning (4x average during peak window, with headroom):
  average:  11.6 req/sec
  burst:    50 req/sec  (4.3x; covers double-peak without queuing)
```

---

## Worker Fleet Sizing

**Concurrency per worker:** A single worker handles one execution at a time (no internal
parallelism; wasmtime is single-threaded per instance). To serve N concurrent requests
without queuing, we need N workers.

```
Concurrent executions at average load:
  11.6 req/sec × 0.5 sec/req = 5.8 concurrent  →  ceil = 6 workers minimum

At burst (50 req/sec):
  50 req/sec × 0.5 sec/req = 25 concurrent      →  25 workers minimum

With 20% headroom:
  burst workers = 25 × 1.2 = 30 workers

Fleet recommendation:
  Min (steady state):  8 workers  (6 + 33% safety margin)
  Target warm pool:   30 workers  (burst-ready at all times)
  Max (HPA ceiling):  80 workers  (covers 2× burst spike)
```

Language split for the warm pool (based on typical AI codegen traffic):
- Python: 60% → 18 workers
- JavaScript: 30% → 9 workers
- Other (Go, Rust, Java WASM): 10% → 3 workers

---

## Fuel Units Calibration

Fuel is the primary CPU enforcement primitive in wasmtime. 1 fuel unit = 1 WASM instruction.

**Empirical calibration (benchmark loop on 3 GHz x86-64):**

| Workload | Instructions/sec | Fuel for 500ms |
|----------|-----------------|----------------|
| Tight numeric loop (pure WASM) | ~2B/sec | 1B |
| Pyodide (CPython bytecode in WASM) | ~800M/sec | 400M |
| QuickJS (JS bytecode in WASM) | ~1.2B/sec | 600M |
| Mixed data processing | ~600M/sec | 300M |

**Tier quotas:**

| Tier | Max fuel units | Approximate wall-clock budget | Max memory | Fs quota | Concurrent/tenant |
|------|---------------|------------------------------|-----------|---------|------------------|
| Free | 500M | ~250ms Python / ~400ms JS | 64 MB | 16 MB | 1 |
| Pro | 2B | ~1s Python / ~1.5s JS | 128 MB | 64 MB | 5 |
| Enterprise | 10B | ~5s Python / ~7s JS | 512 MB | 256 MB | 50 |

The fuel limit is a hard ceiling independent of wall clock. A computationally cheap but
long-sleeping program (time.sleep) burns no fuel; the wall-clock deadline catches it instead.
Both limits fire independently.

---

## Memory Capacity Model

**Per-worker memory breakdown:**

| Component | Memory |
|-----------|--------|
| Go worker goroutine stack | ~64 KB |
| wasmtime runtime overhead | ~2 MB |
| Compiled WASM module (shared, CoW across workers) | ~50 MB total (amortized ~0 per worker) |
| WASM linear memory - pre-allocated pages | up to config.MaxMemoryPages × 64 KB |
| Pipe buffers (stdout/stderr) | ~128 KB |
| FsGuard tmpdir (tmpfs, not RAM unless written) | quota-bounded |
| **Per-worker overhead (excluding linear memory)** | ~3 MB |
| **Per-worker at 32 MB avg execution memory** | ~35 MB |

**30-worker warm pool:**
- Overhead: 30 × 3 MB = 90 MB
- Execution memory: 30 × 32 MB avg = 960 MB
- Shared compiled modules: ~150 MB (Python + JS + others, shared)
- **Total warm pool: ~1.2 GB RAM**

**80-worker HPA ceiling (full burst):**
- 80 × 35 MB + 150 MB shared = ~2.95 GB
- Runs comfortably on a 16 GB node; 32 GB recommended for headroom + OS + Go runtime.

---

## WASM Module Compilation: JIT Cost and Mitigation

Module compilation (WASM bytecode → native machine code) is the single largest latency
contributor. Pyodide's bytecode is ~30 MB; JIT compilation takes 600–800 ms.

**Mitigation: Ahead-of-Time (AOT) compilation + cache**

```
Build time:
  wasm bytecode (Python runtime)  →  [wasmtime AOT]  →  .cwasm native cache file

Runtime:
  worker startup: mmap .cwasm into process (no JIT, ~50ms)
  per-execution:  InstantiateModule() from pre-compiled module (~5ms, just memory setup)
```

```go
// At build time (CI pipeline):
engine := wasmtime.NewEngine()
module, _ := wasmtime.NewModule(engine, wasmBytes)
aotBytes, _ := module.Serialize()
os.WriteFile("/cache/python.cwasm", aotBytes, 0644)

// At worker startup:
aotBytes, _ := os.ReadFile("/cache/python.cwasm")
compiled, _ := wasmtime.NewModuleDeserialize(engine, aotBytes)
// compiled is shared (immutable) across all workers of this language.
```

**Code hash-based cache for user-submitted WASM:**
Some users submit pre-compiled WASM directly (e.g., Rust-compiled binaries). These are
cached by SHA-256 of the bytecode:

```go
type ModuleCompilationCache struct {
    lru *lru.Cache  // bounded by entry count, not memory
    mu  sync.RWMutex
}

func (mc *ModuleCompilationCache) GetOrCompile(
    ctx context.Context,
    engine *wasmtime.Engine,
    codeHash string,
    wasmBytes []byte,
) (*wasmtime.Module, error) {
    mc.mu.RLock()
    if mod, ok := mc.lru.Get(codeHash); ok {
        mc.mu.RUnlock()
        return mod.(*wasmtime.Module), nil
    }
    mc.mu.RUnlock()

    // Compile - CPU-intensive; do under write lock to avoid stampede.
    mc.mu.Lock()
    defer mc.mu.Unlock()
    // Double-check after acquiring write lock.
    if mod, ok := mc.lru.Get(codeHash); ok {
        return mod.(*wasmtime.Module), nil
    }
    mod, err := wasmtime.NewModule(engine, wasmBytes)
    if err != nil {
        return nil, err
    }
    mc.lru.Add(codeHash, mod)
    return mod, nil
}
```

Cache hit rate target: >95% for the language runtime modules (static, change only on deploy),
~40–60% for user code (high diversity of AI-generated snippets).

---

## Memory Pool: Pre-Allocated Linear Memory Pages

WASM linear memory grows in 64 KB pages via `memory.grow`. Every `memory.grow` call is a
kernel allocation (`mmap` or sbrk) if memory is not pre-allocated. At 11.6 req/sec this
is a non-trivial kernel interaction rate.

**Mitigation: pre-allocate minimum pages at warm-up**

```go
// When pre-warming a WASMInstance, set both min and max pages identically.
// wasmtime allocates the max upfront, avoiding runtime kernel calls for grow.
wasiCfg := wasmtime.NewWASIConfig()
// In the module's memory section, set min = expected working set, max = hard limit.
// Example for Python/Pyodide: min=128 pages (8 MB), max=1024 pages (64 MB)
// wasmtime maps max bytes at instantiation; pages beyond min are demand-paged.
```

This trades instantiation cost (one-time mmap of 64 MB) for zero `memory.grow` syscalls
during execution. For pre-warmed instances the mmap happens in the background.

---

## Autoscaling: HPA on Queue Depth

Kubernetes HPA target: `execution_queue_depth` custom metric, emitted by the pool manager
every 10 seconds.

```
Scale-out trigger:  queue_depth > 5  for 30s  →  add ceil(queue_depth / 5) replicas
Scale-in trigger:   warm_ratio > 0.7 for 5min  →  remove 1 replica per cycle

Min replicas:  2  (one active, one standby for rolling deploy)
Max replicas:  16 (covers 10× burst; each replica runs 5 workers)
```

**Cold-start mitigation for new replicas:**
A new replica begins warming its pool in parallel with being added to the load balancer.
The readiness probe only passes when `warm_workers >= min_warm_per_replica`. This prevents
new replicas from receiving traffic before they have any warm instances.

```go
// Readiness check: block until at least minWarm instances are ready.
func (sm *SandboxManager) Ready() bool {
    for _, pool := range sm.pool {
        if pool.WarmCount() < sm.config.MinWarmPerReplica {
            return false
        }
    }
    return true
}
```

---

## Per-Tenant Throttling

Throttling is enforced at two independent layers.

### Layer 1: API Gateway - token bucket per tenant

```
Algorithm: token bucket
Bucket capacity:  tier.ConcurrentExecutions × 2  (burst capacity)
Refill rate:      tier.RequestsPerMinute / 60 tokens/sec

On each request:
  if tokens available → consume 1 token → allow
  else → 429 Too Many Requests (Retry-After header set)
```

Redis Lua script (atomic token bucket):
```lua
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])   -- tokens per second
local now = tonumber(ARGV[3])    -- unix ms

local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1]) or capacity
local last = tonumber(bucket[2]) or now

local elapsed = (now - last) / 1000   -- seconds
local refill = elapsed * rate
tokens = math.min(capacity, tokens + refill)

if tokens >= 1 then
    tokens = tokens - 1
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
    redis.call('PEXPIRE', key, 60000)
    return 1   -- allowed
else
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
    redis.call('PEXPIRE', key, 60000)
    return 0   -- throttled
end
```

### Layer 2: SandboxManager - concurrent execution cap per tenant

```go
type tenantSemaphore struct {
    mu   sync.Mutex
    sem  map[string]chan struct{}   // tenantID → counting semaphore
}

func (ts *tenantSemaphore) Acquire(tenantID string, limit int) bool {
    ts.mu.Lock()
    if _, ok := ts.sem[tenantID]; !ok {
        ts.sem[tenantID] = make(chan struct{}, limit)
    }
    ch := ts.sem[tenantID]
    ts.mu.Unlock()

    select {
    case ch <- struct{}{}:
        return true     // slot acquired
    default:
        return false    // at concurrent limit
    }
}

func (ts *tenantSemaphore) Release(tenantID string) {
    ts.mu.Lock()
    ch := ts.sem[tenantID]
    ts.mu.Unlock()
    <-ch
}
```

---

## Cost Attribution and Billing

Every execution emits a resource usage record to the telemetry mesh:

```go
type ExecutionBillingRecord struct {
    TenantID        string
    ExecutionID     string
    Language        string
    WallClockMs     int64
    CPUMs           int64    // derived from fuel consumed + calibration constant
    MemoryMBPeak    int32
    FsWriteBytes    int64
    Tier            string
    Timestamp       time.Time
}
```

**CPU-ms derivation from fuel:**
```
cpu_ms = (fuel_consumed / calibration_rate[language]) × 1000
```
Where `calibration_rate[language]` is the measured instructions-per-second for that runtime
(from the fuel calibration table above). This gives a language-normalized CPU cost that is
comparable across Python, JavaScript, and native WASM.

**cgroup CPU accounting (host-level validation):**
Each worker process is placed in a dedicated cgroup. `cpu.stat` is read after each execution
for cross-validation against fuel-derived CPU-ms. Discrepancies > 20% trigger an alert -
possible fuel calibration drift after a wasmtime upgrade.

---

## Bottleneck Summary

| Bottleneck | Symptom | Mitigation |
|-----------|---------|------------|
| WASM JIT compilation | p99 latency spike on cold replica start | AOT compile at build time; cache by code hash |
| Linear memory `memory.grow` syscalls | Kernel CPU overhead at high QPS | Pre-allocate max pages at warm-up (one-time mmap) |
| Worker pool saturation | Queue depth grows; execution p50 latency rises | HPA on queue depth; pre-emptive scale-out at warm_ratio < 0.3 |
| Redis rate limiter | 5–10ms latency added per request | Lua atomic script; Redis pipelining; Redis Cluster for sharding |
| FsGuard tmpdir creation | Syscall overhead for os.MkdirTemp | Use tmpfs mount; keep base dir in RAM |
| SSE connection count | File descriptor pressure on API servers | ulimit -n 65535; multiple API replicas; goroutine-per-connection (cheap in Go) |
| OTel collector backpressure | Span drops at 50M spans/day | Collector runs as DaemonSet; uses async export with 10MB buffer per worker |

---

## Quota Tier Reference Card

| Parameter | Free | Pro | Enterprise |
|-----------|------|-----|-----------|
| Max fuel units | 500M | 2B | 10B |
| Approx compute budget (Python) | ~250ms | ~1s | ~5s |
| Max wall-clock time | 5s | 30s | 300s |
| Max memory | 64 MB | 128 MB | 512 MB |
| Max filesystem write | 16 MB | 64 MB | 256 MB |
| Concurrent executions | 1 | 5 | 50 |
| Requests/minute | 10 | 60 | 600 |
| Result retention | 1h | 24h | 7d |
