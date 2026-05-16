# 05 - Scaling and Capacity

## Throughput Model

**Starting facts:**
- 1M+ daily zero-shot code executions

### Back-of-Envelope

```
1M executions/day
= 41,667 executions/hour
= 694 executions/minute
= ~12 executions/second average

Peak multiplier (traffic follows Copilot usage patterns: 9am-6pm workdays):
  average:  12 exec/s
  peak:     ~80 exec/s (8× average, concentrated 2-3h window)
```

**Execution duration distribution (assumed):**

| Type | % of traffic | Avg duration | Concurrency at 80 exec/s peak |
|---|---|---|---|
| Fast (math, string ops) | 60% | 200ms | ~10 concurrent |
| Medium (data processing) | 30% | 2s | ~50 concurrent |
| Long (heavy computation) | 10% | 15s | ~120 concurrent |
| **Total concurrent at peak** | 100% | - | **~180 concurrent** |

**Worker pool sizing:**
Target: 200 workers minimum (covers 180 concurrent peak with 10% headroom).
Language split: 140 Python, 50 JavaScript, 10 others.

---

## Bottleneck Analysis

| Layer | Bottleneck | Symptom | Mitigation |
|---|---|---|---|
| **Pre-warm pool** | All workers busy during traffic spike | Execution queuing; increased p99 latency | Autoscaler: when busy > 80%, spawn new workers; target 20% warm headroom |
| **Cold start (Python/Pyodide)** | 800ms module compilation on cold start | p99 latency spikes when pool drains | Module cache pre-compiles WASM bytecode; instantiation = 50ms, not 800ms |
| **WASM memory allocation** | OS memory pressure at 200× 128MB workers | OOM kill of worker process | 200 × 64MB avg = 12.8GB RAM; use large-memory instances (32GB+); workers share compiled module code |
| **SSE connection backlog** | Too many open SSE connections per API server | File descriptor exhaustion | Configure `ulimit -n 65535`; use multiple API server replicas; each connection is a goroutine (Go goroutines are cheap at 8KB stack) |
| **Redis rate limiter** | High QPS on token bucket increment | Redis latency spikes | Use Redis Cluster; pipeline INCR+EXPIRE in Lua script; Redis handles 100K+ ops/sec easily |
| **Clickhouse audit log** | High write throughput at 1M exec/day | Clickhouse write latency | OTel collector batches spans; Clickhouse is optimized for high-throughput insert workloads; 1M rows/day is trivial |
| **Output buffering** | Long-running execution with large stdout | Memory pressure in Stream Manager | Limit stdout buffer to 1MB per execution; if exceeded, send `STDOUT_TRUNCATED` event and stop buffering (streaming still works) |

---

## Memory Capacity Model

**Per-worker memory:**

| Component | Memory |
|---|---|
| Go worker goroutine stack | ~64KB |
| wazero runtime overhead | ~2MB |
| WASM compiled module (shared) | ~50MB (shared via CoW across all workers) |
| WASM linear memory (per execution) | Up to 128MB cap |
| Pipe buffers (stdout/stderr) | ~64KB |
| **Total per active worker** | ~5MB overhead + up to 128MB execution memory |

**200 workers at peak:**
- Overhead: 200 × 5MB = 1GB
- Execution memory: 200 × 64MB avg (half the cap) = 12.8GB
- Shared compiled modules: ~150MB (shared across all workers)
- **Total: ~14GB RAM** for the execution plane

A 32GB instance leaves comfortable headroom. For 1M daily executions at current scale, 3-4 replicas of the execution service provide redundancy and geographic distribution.

---

## Cold Start Problem

**Python/Pyodide cold start timeline:**

```
WASM bytecode load from disk/object storage:  ~100ms
JIT compilation (bytecode → native code):     ~700ms
Module instantiation (fresh linear memory):   ~50ms
Python interpreter init (within WASM):        ~150ms
Total cold start:                             ~1000ms
```

**With module cache (pre-compiled):**
```
JIT compilation:                               0ms (cached CompiledModule)
Module instantiation:                         ~50ms
Python interpreter init:                      ~150ms
Total warm start:                             ~200ms
```

**With pre-warmed pool (interpreter already init'd):**
```
All initialization already done in background: 0ms
Inject code + run:                            <50ms
Total pre-warmed start:                       <50ms
```

The pre-warm pool is what delivers sub-50ms p99 for the steady-state case. Cold starts (new worker spawn) show up as ~1s latency spikes - visible to users as the progress indicator being slow to start.

**Mitigation for cold start spikes:** Over-provision warm pool by 20% beyond predicted peak. The autoscaler pre-emptively spawns workers when `warm_count / total_workers < 0.3` for 30 seconds (before the pool actually drains).

---

## Autoscaling Logic

```go
func (pm *PoolManager) adjustPoolSize() {
    warmCount := pm.countWarmWorkers()
    busyCount := pm.countBusyWorkers()
    totalCount := warmCount + busyCount
    
    utilizationRatio := float64(busyCount) / float64(totalCount)
    
    if utilizationRatio > 0.8 {
        // Spawn workers to bring utilization down to ~0.6
        workersToAdd := int(float64(busyCount)/0.6) - totalCount
        pm.spawnWorkers(min(workersToAdd, 50))  // cap at 50 per cycle
    }
    
    if utilizationRatio < 0.2 && totalCount > pm.minPoolSize {
        // Scale down: drain excess warm workers
        excessWorkers := totalCount - int(float64(busyCount)/0.4)
        pm.drainWorkers(min(excessWorkers, 20))  // drain at most 20 per cycle
    }
}
```

Scale-down is conservative (drain max 20/cycle every 5s) to avoid thrashing. Scale-up is aggressive (add up to 50/cycle) to respond quickly to traffic spikes.

---

## Cost Model

| Resource | Config | Monthly cost (estimate) |
|---|---|---|
| Execution service (3× 32GB instances) | 3 × 8-core, 32GB | ~$300-500/month (cloud) |
| Redis (rate limits + execution state) | Standard 4GB | ~$100/month |
| Clickhouse (audit log, 1M rows/day) | 2-node cluster, 500GB | ~$200/month |
| Object storage (WASM bytecode cache) | <1GB | ~$5/month |
| **Total execution plane** | - | **~$600-800/month** |

At 1M executions/day, that's ~$0.00002-0.00003 per execution (2-3 hundredths of a cent). The cost is dominated by the always-on worker pool, not per-execution resources.

**Cost optimization levers:**
1. Spot/preemptible instances for execution workers (executions are short; instance preemption is rare)
2. Scale warm pool down to minimum at night (0-6am, 30% of normal traffic)
3. Limit cold starts by smarter pre-warming based on predicted traffic curves
