---
name: resume-design-pack
description: |
  Build a multi-file principal engineer design pack from a concrete interview question
  using `resume.txt` and the experience markdown files in this repo, with explicit
  API design and low-level design coverage when relevant.
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
  - Bash
triggers:
  - build a design pack
  - create a markdown interview pack
  - generate system design files
---

## When To Use

Use this skill when the user already has a concrete question and wants a file-backed answer
pack written into the repo.

The generated pack must follow a supported archetype from `design-packs/README.md` and
must include `manifest.json`.

## Required Inputs

- `resume.txt`
- the most relevant `*-experience.md` files
- the question itself

If the user supplied a target folder, use it. Otherwise create one in
`design-packs/YYYY-MM-DD-short-topic-slug/`.

Only update an existing pack when the folder is explicit or its manifest `questionHash`
matches the normalized prompt exactly.

## Grounding Standard

- Use at least two concrete anchors when claiming architecture specifics or impact.
- If the source material is thin, lower confidence and label assumptions explicitly.

## Mandatory Deliverables

Write `manifest.json` first (with `schemaVersion: 2` for any new pack), then
the archetype-specific required files.

For `system-design` at `schemaVersion: 2`, write at least these files:

- `README.md`
- `manifest.json`
- `00-question-and-context.md`
- `01-executive-summary.md`
- `02-design-estimates.md`
- `03-architecture.md`
- `04-api-and-contracts.md`
- `05-low-level-design.md`
- `06-scaling-and-capacity.md`
- `07-security-and-isolation.md`
- `08-reliability-observability-and-failures.md`
- `09-tradeoffs-and-alternatives.md`
- `10-cross-questions.md`
- `11-cheat-sheet.md`
- `15-challenges-by-stage.md` (generated via the Chain-of-Thought Challenge Generation procedure below; this file is required for `system-design`, not optional)

For `security-review`, write the required files listed in `design-packs/README.md`.

Add extra files when the question calls for them, especially around state machines,
data models, protocol design, control plane and data plane separation, or cross-exam.

Place extended challenge material under `cross-exam/`, not in the numbered root file sequence.

Packs created before 2026-05-17 used `schemaVersion: 1` (no design-estimates;
architecture at `02`, challenges at `14`). Do not produce new v1 packs.

## Design Estimates

`02-design-estimates.md` is the interviewer's "frame the problem" expectation
and must come before architecture. The file must include, in this order:

1. **Use case and problem statement** - what is being solved and the business
	 cost of not solving it. Anchor to the resume where possible.
2. **Users and access patterns** - personas (developers, internal services,
	 end users, automated pipelines, security reviewers) with operations and
	 rough cadence per persona.
3. **Existing options** - short comparison table of open source, commercial,
	 and adjacent internal systems, with the specific gap that disqualifies each.
4. **Why we are building it** - load-bearing reasons custom beats the
	 alternatives (compliance, isolation, scale, cost, latency, integration).
5. **Capacity and load estimates** - back-of-envelope arithmetic for users,
	 peak QPS, payload size, storage growth, bandwidth, fan-out. Show the math.
	 Mark assumptions explicitly when the resume does not pin the number.

	 **Instance sizing - always include a fleet estimate anchored on m8g.**
	 For every service tier, show: chosen instance size, instance count, total
	 vCPU, total RAM, total EBS/network throughput, and a monthly cost anchor
	 (On-Demand $/hr × fleet × 730 hr/month).

	 *m8g family reference (AWS Graviton 4 / Arm Neoverse V2 - general purpose,
	 ~4 GiB RAM per vCPU, EBS-optimized by default):*

	 | Size | vCPU | RAM | EBS bandwidth | Network | Local storage |
	 |---|---|---|---|---|---|
	 | m8g.xlarge | 4 | 16 GiB | up to 10 Gbps (burst) | up to 12.5 Gbps | EBS only |
	 | m8g.2xlarge | 8 | 32 GiB | up to 10 Gbps (burst) | up to 12.5 Gbps | EBS only |
	 | m8g.4xlarge | 16 | 64 GiB | up to 10 Gbps (burst) | up to 25 Gbps | EBS only |
	 | m8g.8xlarge | 32 | 128 GiB | 10 Gbps (sustained) | up to 25 Gbps | EBS only |
	 | m8g.16xlarge | 64 | 256 GiB | 20 Gbps (sustained) | 37.5 Gbps | EBS only |
	 | m8g.48xlarge | 192 | 768 GiB | 60 Gbps (sustained) | 100 Gbps | EBS only |
	 | m8g.metal-24xl | 96 | 384 GiB | 30 Gbps (sustained) | 50 Gbps | local NVMe SSD |
	 | m8g.metal-48xl | 192 | 768 GiB | 60 Gbps (sustained) | 100 Gbps | local NVMe SSD |

	 *Key configuration notes:*
	 - **EBS burst write**: sizes ≤ m8g.4xlarge have a burst EBS throughput bucket
	   (burst is typically 3× the sustained floor for up to 30 min); state burst vs
	   sustained separately when write spikes matter.
	 - **What m8g is optimized for**: balanced CPU/memory ratio; strong price-per-vCPU
	   on Graviton 4; well-suited for API servers, coordinators, metadata planes, and
	   stateless worker fleets. It is *not* storage-optimized - local NVMe is only
	   present on metal-24xl and metal-48xl.
	 - **EBS-attached NVMe (io2 Block Express)**: when low-latency durable writes are
	   needed on standard m8g sizes, attach an io2 volume; supports up to 256,000
	   provisioned IOPS and 4,000 MiB/s throughput, sub-millisecond latency, and
	   99.999% durability SLA.
	 - **Fleet count formula**: `ceil(peak_resource / per_instance_resource × headroom)`
	   where headroom = 1.3–1.5 for stateless tiers, 1.5–2.0 for stateful tiers.

	 *When to deviate from m8g:*
	 | Workload profile | Better family | Reason |
	 |---|---|---|
	 | Write-heavy NVMe (>1 GB/s sequential) | i4i | NVMe-backed, up to 7.5 GB/s sequential write, 1M+ IOPS |
	 | Memory-bound (>8 GiB/vCPU) | r8g | 8 GiB/vCPU ratio, Graviton 4 |
	 | CPU-bound, low memory (<2 GiB/vCPU) | c8g | Highest vCPU density, Graviton 4 |
	 | Dense warm storage (HDD) | d3en | Up to 336 TB local HDD per instance |
	 | ML inference | inf2 / trn2 | Inferentia2 / Trainium2 accelerators |
6. **Functional and non-functional requirements** - functional ops the system
	 must support; non-functional targets for p50 / p99 latency, availability,
	 durability, RTO / RPO, security posture, and explicit out-of-scope items.

Keep it short and dense. Tables and bullets over prose. This file does not
duplicate `05-low-level-design.md` or `06-scaling-and-capacity.md`; it sets the
target those later files must hit.

## Load Balancer Configuration

Whenever the architecture includes a load-balancing tier - cloud, on-prem, or
hybrid - `03-architecture.md` must include a dedicated **Load Balancer
Configuration** subsection covering all applicable types below. State which
combination the design uses and why. Do not leave LB configuration implicit
in a box diagram.

### NLB - AWS Network Load Balancer (Layer 4)

*Optimized for*: raw TCP/UDP throughput, ultra-low latency (<1 ms added),
static Elastic IPs, TLS passthrough, and PrivateLink endpoints.

Key configuration knobs to document:
- **Listener**: protocol (TCP / TLS / UDP / TCP_UDP), port, default action.
- **Target group**: target type (instance | IP | ALB), protocol, health-check
  protocol and threshold, deregistration delay (connection draining; default
  300 s - tune down to 30–60 s for short-lived jobs).
- **Cross-zone load balancing**: disabled by default on NLB (enable for
  uneven AZ capacity; incurs inter-AZ data charges).
- **TLS termination vs passthrough**: terminate at NLB for mutual TLS or
  certificate pinning; pass through when the backend owns the certificate.
- **Flow hash**: 5-tuple (protocol, src/dst IP, src/dst port) - sticky per
  connection; document when this matters (WebSocket, gRPC streams).
- **Preserve client IP**: enabled by default for instance targets; use proxy
  protocol v2 for IP targets behind a NAT.
- **Static IPs / Elastic IPs**: one static IP per AZ - required when
  downstream firewalls whitelist by IP.

### ALB - AWS Application Load Balancer (Layer 7)

*Optimized for*: HTTP/HTTPS/HTTP2/gRPC/WebSocket routing, content-based
routing rules, WAF integration, and OIDC/Cognito authentication offload.

Key configuration knobs to document:
- **Listener rules**: evaluated in priority order; conditions include host
  header, path pattern, HTTP header, query string, source IP, HTTP method.
  State which rules the design relies on.
- **Target groups**: target type (instance | IP | Lambda), protocol
  (HTTP | HTTPS | gRPC), health-check path and matcher (e.g., `200-399`),
  slow-start duration for warming up new targets.
- **Sticky sessions**: duration-based (ALB cookie, 1 s–7 days) or
  application-based (custom cookie); note tradeoff with even distribution.
- **Idle timeout**: default 60 s; increase for long-lived uploads or gRPC
  streams; decrease to shed idle connections faster.
- **gRPC routing**: requires HTTP/2 on the listener and target group; supports
  routing by gRPC service/method header.
- **WAF association**: attach AWS WAF Web ACL to the ALB ARN for rate
  limiting, IP reputation, and managed rule groups.
- **Access logs**: enable to S3; include requester IP, latency, matched rule.
- **Connection multiplexing**: ALB reuses backend connections; backend
  keep-alive timeout must exceed the ALB idle timeout.

### MetalLB - Kubernetes Bare-Metal Load Balancer

*Optimized for*: exposing `LoadBalancer`-type Kubernetes Services on bare-metal
or on-prem clusters where no cloud LB controller is present.

Key configuration knobs to document:
- **IP address pool** (`IPAddressPool` CR): CIDR or range MetalLB can assign
  to Services; must be routable from the client network. Separate pools per
  environment (prod vs staging).
- **Mode - Layer 2 (ARP/NDP)**:
  - One node per Service acts as "speaker leader" (elected via member-list).
  - Gratuitous ARP/NDP on failover; failover time ~10 s by default.
  - No ECMP - all traffic enters via the leader node (single-node bottleneck).
  - `L2Advertisement` CR selects which pools to advertise and eligible nodes.
- **Mode - BGP**:
  - MetalLB peers with upstream BGP routers (`BGPPeer` CR); requires
    BGP-capable ToR switches.
  - ECMP across all nodes - traffic distributed per flow at the router.
  - `BGPAdvertisement` CR controls community strings, local-preference,
    aggregation length.
  - FRR (Free Range Routing) is the recommended MetalLB BGP backend; document
    AS numbers, peer IPs, hold-timer, and graceful-restart behavior.
- **Speaker DaemonSet**: runs on every eligible node; exclude control-plane
  nodes unless explicitly required.

### Combination Patterns

State the combination in use in `03-architecture.md` and justify it:

| Pattern | When to use | Key wiring detail |
|---|---|---|
| **NLB → backend pods** | Pure TCP/gRPC, static IPs, PrivateLink | NLB target type = IP; disable cross-zone unless AZ skew is large |
| **ALB → backend pods** | HTTP/HTTPS microservices, path routing, WAF | ALB target type = IP; security group allows ALB SG |
| **NLB → ALB → pods** | Static IPs + L7 routing; WAF + PrivateLink | NLB target type = ALB (native chaining); note dual-hop latency (~0.5 ms) |
| **ALB → MetalLB → pods** | Cloud ALB fronts on-prem cluster via DX/VPN | ALB targets = MetalLB VIP IPs; firewall allows ALB health-check CIDR |
| **NLB → MetalLB → pods** | PrivateLink / static IP into bare-metal cluster | MetalLB VIP is the NLB target; route via Direct Connect or VPN |
| **NLB → ALB → MetalLB → pods** | Full hybrid: static IP edge → L7 → bare-metal | Document each hop's health-check chain; timeout budgets decrease end-to-end |

For every combination used, state:
1. Which OSI layer each hop operates at.
2. Where TLS terminates (and whether mTLS is needed end-to-end).
3. How client IP is preserved (X-Forwarded-For, proxy protocol, or TPROXY).
4. Health-check chain - what each LB checks, at what interval, and threshold.
5. Failure mode - what the client sees if one hop in the chain fails.

## Parallel Decomposition

Use parallel agents when available.

Minimum lanes:

1. design estimates (use case, personas, existing options, build-vs-buy, capacity model)
2. system architecture
3. API and contract design
4. low-level design and state machine
5. scale and cost
6. security and isolation
7. reliability and debugging
8. skeptical interviewer follow-ups
9. stage-scoped challenge generation (consumes the prior lanes; runs after them)

Each lane should return concise notes that are then synthesized into the final files.

## Chain-of-Thought Challenge Generation

`15-challenges-by-stage.md` is a required deliverable for every `system-design`
pack. To make the output reliable across runs, generate it with this explicit
Chain-of-Thought procedure rather than free-form brainstorming.

### Step 0: scope check

In working notes, restate the system in one sentence and pick the single most
load-bearing resume anchor for it (file + line number). If either is unclear,
re-read the inputs before continuing.

### Step 1: fix the stages

Default stages, used unless the question is clearly outside this lifecycle:

| Stage | Window | Stage truth |
|---|---|---|
| 1. Inception | weeks 0-12 | One team, no real customers; "make it work once" |
| 2. Early scale | months 3-9 | First 1-50 tenants; concurrency exposes bugs |
| 3. Production hardening | months 6-18 | Reliability and observability dominate |
| 4. Multi-tenant scale | months 12-30 | Next 10x exposes multi-tenancy and policy gaps |
| 5. Frontier / next-platform | months 18+ | Adjacent ambitions: new hardware, new model class, new region |

Write the stage-truth header for each stage in the file before listing
challenges. The header constrains what counts as a challenge for that stage.

### Step 2: per-stage inner CoT

For each stage, produce at least four candidate challenges using this
four-question inner CoT, executed in your reasoning before writing to disk.

1. **Surface:** what concrete symptom does the team see at this stage? Write a
   sentence, not a noun.
2. **Root layer:** which architectural layer is responsible (identity, network,
   scheduling, runtime, storage, observability, product surface, organizational)?
3. **Blast radius:** one engineer, one tenant, all tenants, security, finance,
   or trust narrative?
4. **Counterfactual:** why does the easy fix not work? What design constraint
   makes it interesting?

Include a candidate only when all four steps produced a non-generic answer.

### Step 3: rate on three axes

| Axis | Scale | 1 anchor | 10 anchor |
|---|---|---|---|
| Severity | 1-10 | Paper cut | Cannot ship; recurring SEV-1 |
| Frequency | 1-10 | Once in the program's life | Daily, every job |
| Difficulty | 1-10 | Read the manual | Open research, multi-quarter |

`Pain = Severity × Frequency × Difficulty / 100`, capped at 100, one decimal.
Keep S, F, D visible alongside Pain. Pairwise compare highest two and lowest
two within each stage if many ratings cluster.

### Step 4: anchors

At least one in three challenges across the file must cite a specific
`resume.txt` or `*-experience.md` line. No anchor at all means the file slides
into a generic "things that go wrong" essay.

### Step 5: top-10 and meta-observations

End the file with a top-10 leaderboard sorted descending by Pain (include
stage, ID, name, Pain), and two to four bullet observations naming patterns
the ranking exposes. Observations must point to specific top-10 rows; no
generic conclusion paragraph.

### Step 6: pre-save checklist

- [ ] At least 4 challenges per stage; at least 20 total
- [ ] Every challenge rated on S, F, D, Pain
- [ ] Top-10 leaderboard present and sorted
- [ ] At least 30% of challenges cite an anchor
- [ ] No identical (S, F, D) triples in the same stage unless deliberate
- [ ] No challenge is fully generic to "any distributed system"

If any item is unchecked, redo the relevant step before writing.

### Reference exemplar

`design-packs/2026-05-17-distributed-finetuning-dataplane-internals/14-challenges-by-stage.md`
is the canonical example of this procedure's output (named `14-...` because
that pack is `schemaVersion: 1`; under v2 the same content lives in
`15-challenges-by-stage.md`). Mirror its layout when in doubt.

## Pack Quality Bar

- principal engineer tone and structure
- explicit assumptions and scope limits
- concrete API contract and likely LLD follow-through, not just high-level boxes
- concrete failure handling and operational metrics
- strong tradeoff discussion, not just a happy path
- interview-ready cross-questions and short talking points
- deterministic reuse through `manifest.json` and exact `questionHash` matching

## Guardrails

- Do not invent private implementation details.
- Do not leave the answer only in chat; write the files.
- Do not collapse everything into a single summary file.
- Do not update a pack based on recency heuristics.
- Do not omit API or LLD details when the prompt includes workflows, jobs, control planes, or orchestration.
- Do not skip `15-challenges-by-stage.md` for `system-design` packs; it is required.
- Do not generate the challenges file by listing problems and rating after the fact; follow the Chain-of-Thought order or quality drops.
- Do not give the same (S, F, D) triple to many challenges in a row; that signals the inner CoT was skipped.
