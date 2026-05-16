# 03 - API Contracts & Internal gRPC Interfaces

> **Resume anchor:** Founding team member of AI Fine-tuning on IPP; designed secure multi-tenant ML infrastructure on Kubernetes and Azure VNet; 15M+ AutoML jobs/month; TunDRA QUIC protocol over 1M+ Compute Instances.

---

## 1. Public REST API

Base URL: `https://api.finetune.azure.com/v1`

Authentication: Bearer token via Azure Managed Identity or AAD OAuth2. Every request carries `Authorization: Bearer <token>` and the tenant is resolved from the token claim - no tenant ID in the URL path.

---

### 1.1 Resource Hierarchy

```
/jobs                        - collection of fine-tuning jobs
/jobs/{job_id}               - individual job resource
/jobs/{job_id}/logs          - streaming log resource
/jobs/{job_id}/artifacts     - artifact listing resource
/jobs/{job_id}/checkpoints   - checkpoint listing resource
```

---

### 1.2 Endpoint Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/jobs` | Submit a new fine-tuning job |
| `GET` | `/jobs/{job_id}` | Poll job status |
| `DELETE` | `/jobs/{job_id}` | Cancel a running or queued job |
| `GET` | `/jobs/{job_id}/logs` | Stream training logs |
| `GET` | `/jobs/{job_id}/artifacts` | List published artifacts |
| `GET` | `/jobs/{job_id}/checkpoints` | List available checkpoints |
| `POST` | `/jobs/{job_id}/resume` | Resume from a named checkpoint |
| `GET` | `/jobs` | List jobs for the tenant (paginated) |

---

### 1.3 POST /jobs - Create Job

**Request headers:**

```
POST /v1/jobs HTTP/1.1
Authorization: Bearer eyJ...
Content-Type: application/json
Idempotency-Key: client-uuid-7f3a1b2c
X-Request-ID: trace-uuid-for-logging
```

**Request body:**

```json
{
  "model": "gpt-4o-mini-2024-07-18",
  "dataset_uri": "azureml://datastores/workspaceblobstore/paths/datasets/instruction-tuning-v3/train.jsonl",
  "validation_dataset_uri": "azureml://datastores/workspaceblobstore/paths/datasets/instruction-tuning-v3/val.jsonl",
  "hyperparameters": {
    "n_epochs": 3,
    "batch_size": 16,
    "learning_rate_multiplier": 1.8,
    "warmup_ratio": 0.03,
    "weight_decay": 0.01,
    "gradient_accumulation_steps": 4,
    "max_sequence_length": 4096,
    "lora_rank": 16,
    "lora_alpha": 32,
    "lora_dropout": 0.05,
    "peft_method": "qlora"
  },
  "compute_config": {
    "sku": "Standard_NC96ads_A100_v4",
    "node_count": 4,
    "gpu_per_node": 4,
    "priority": "dedicated",
    "vnet_subnet_id": "/subscriptions/.../subnets/training-subnet",
    "max_runtime_seconds": 86400
  },
  "output_config": {
    "checkpoint_storage_uri": "azureml://datastores/checkpointstore/paths/ckpt/",
    "checkpoint_interval_steps": 500,
    "artifact_storage_uri": "azureml://datastores/modelstore/paths/artifacts/",
    "register_model": true,
    "model_name": "gpt4o-mini-instruct-v3",
    "evaluation_dataset_uri": "azureml://datastores/workspaceblobstore/paths/datasets/eval-v3.jsonl"
  },
  "tags": {
    "project": "customer-support-bot",
    "team": "nlp-platform",
    "experiment": "qlora-rank16-run2"
  },
  "notification_config": {
    "webhook_url": "https://internal.company.com/hooks/ml-platform",
    "webhook_secret": "sha256-hmac-secret",
    "events": ["JOB_COMPLETED", "JOB_FAILED", "JOB_CANCELED"]
  }
}
```

**Response 201 Created:**

```json
{
  "job_id": "ftjob-8a3c2f1d9e7b4051",
  "status": "PENDING",
  "model": "gpt-4o-mini-2024-07-18",
  "created_at": "2026-05-06T08:12:34.123Z",
  "updated_at": "2026-05-06T08:12:34.123Z",
  "resource_group": "rg-finetuning-eastus-prod",
  "estimated_start_time": "2026-05-06T08:17:00.000Z",
  "tenant_id": "tenant-a8f2c3d1",
  "links": {
    "self": "/v1/jobs/ftjob-8a3c2f1d9e7b4051",
    "logs": "/v1/jobs/ftjob-8a3c2f1d9e7b4051/logs",
    "artifacts": "/v1/jobs/ftjob-8a3c2f1d9e7b4051/artifacts"
  }
}
```

**Response 409 Conflict (duplicate idempotency key, different body):**

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "An existing job with idempotency key 'client-uuid-7f3a1b2c' was submitted with different parameters.",
    "details": {
      "existing_job_id": "ftjob-8a3c2f1d9e7b4051",
      "existing_status": "RUNNING"
    }
  }
}
```

**Response 200 OK (duplicate idempotency key, same body - safe replay):**

Returns the original job record, identical to 201, allowing clients to treat retries as idempotent.

---

### 1.4 GET /jobs/{job_id} - Status Polling

**Request:**

```
GET /v1/jobs/ftjob-8a3c2f1d9e7b4051 HTTP/1.1
Authorization: Bearer eyJ...
```

**Response 200 OK:**

```json
{
  "job_id": "ftjob-8a3c2f1d9e7b4051",
  "status": "RUNNING",
  "model": "gpt-4o-mini-2024-07-18",
  "created_at": "2026-05-06T08:12:34.123Z",
  "updated_at": "2026-05-06T09:01:22.456Z",
  "started_at": "2026-05-06T08:18:05.789Z",
  "resource_group": "rg-finetuning-eastus-prod",
  "progress": {
    "current_step": 1250,
    "total_steps": 3750,
    "current_epoch": 1,
    "total_epochs": 3,
    "tokens_processed": 6800000000,
    "train_loss": 1.342,
    "eval_loss": 1.501,
    "percent_complete": 33.3
  },
  "compute": {
    "node_count": 4,
    "gpu_count": 16,
    "sku": "Standard_NC96ads_A100_v4",
    "cluster_id": "cluster-eastus-gpu-prod-03"
  },
  "last_checkpoint": {
    "step": 1000,
    "uri": "azureml://datastores/checkpointstore/paths/ckpt/ftjob-8a3c2f1d9e7b4051/step-1000/",
    "saved_at": "2026-05-06T08:58:11.000Z"
  },
  "links": {
    "self": "/v1/jobs/ftjob-8a3c2f1d9e7b4051",
    "logs": "/v1/jobs/ftjob-8a3c2f1d9e7b4051/logs",
    "artifacts": "/v1/jobs/ftjob-8a3c2f1d9e7b4051/artifacts"
  }
}
```

---

### 1.5 DELETE /jobs/{job_id} - Cancel

**Response 202 Accepted:**

```json
{
  "job_id": "ftjob-8a3c2f1d9e7b4051",
  "status": "CANCELED",
  "canceled_at": "2026-05-06T09:45:00.000Z",
  "message": "Cancellation accepted. In-flight pods will terminate within 60 seconds. Partial checkpoints retained for 7 days."
}
```

Cancellation is asynchronous. The final status transitions to `CANCELED` once all pods report termination. Partial checkpoints are preserved for potential resumption.

---

### 1.6 GET /jobs/{job_id}/logs - Streaming Logs

Supports two modes:

**Mode A - Server-Sent Events (SSE):** Default. Client sends `Accept: text/event-stream`. Server streams log lines as they arrive.

```
GET /v1/jobs/ftjob-8a3c2f1d9e7b4051/logs?follow=true&since=0 HTTP/1.1
Accept: text/event-stream
Authorization: Bearer eyJ...
```

Response:

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache

data: {"timestamp":"2026-05-06T08:18:10Z","pod":"worker-0","level":"INFO","message":"Rank 0 initialized, world_size=16"}

data: {"timestamp":"2026-05-06T08:18:11Z","pod":"worker-1","level":"INFO","message":"Rank 1 initialized, world_size=16"}

data: {"timestamp":"2026-05-06T08:18:45Z","pod":"worker-0","level":"INFO","message":"Step 1/3750 | loss=2.341 | lr=1.2e-5 | tokens/sec=18450"}
```

**Mode B - Snapshot:** `follow=false` returns a paginated JSON response of stored log lines from the log aggregator.

Query parameters:

| Param | Type | Description |
|-------|------|-------------|
| `follow` | bool | Stream live or return snapshot (default: `true`) |
| `since` | int | Start from log line offset (default: `0`) |
| `pod` | string | Filter by pod name |
| `level` | string | `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `limit` | int | Max lines for snapshot mode (default: `1000`) |

---

### 1.7 GET /jobs/{job_id}/artifacts - Artifact Listing

```json
{
  "job_id": "ftjob-8a3c2f1d9e7b4051",
  "artifacts": [
    {
      "artifact_id": "art-f9c2b1a0",
      "type": "model_weights",
      "uri": "azureml://datastores/modelstore/paths/artifacts/ftjob-8a3c2f1d9e7b4051/model/",
      "size_bytes": 14529348608,
      "created_at": "2026-05-06T14:33:10.000Z",
      "format": "safetensors",
      "model_version": "gpt4o-mini-instruct-v3:1"
    },
    {
      "artifact_id": "art-c3d4e5f6",
      "type": "training_metrics",
      "uri": "azureml://datastores/modelstore/paths/artifacts/ftjob-8a3c2f1d9e7b4051/metrics/metrics.json",
      "size_bytes": 204800,
      "created_at": "2026-05-06T14:33:15.000Z",
      "format": "json"
    },
    {
      "artifact_id": "art-a1b2c3d4",
      "type": "tokenizer",
      "uri": "azureml://datastores/modelstore/paths/artifacts/ftjob-8a3c2f1d9e7b4051/tokenizer/",
      "size_bytes": 2097152,
      "created_at": "2026-05-06T14:33:12.000Z",
      "format": "huggingface_tokenizer"
    }
  ],
  "total_count": 3
}
```

---

## 2. Status Enum

| Status | Meaning | Terminal? |
|--------|---------|-----------|
| `PENDING` | Job received, pre-validation not yet started | No |
| `VALIDATING` | Quota check, dataset access check, model availability check | No |
| `QUEUED` | Passed validation; waiting in the scheduler queue | No |
| `SCHEDULING` | Scheduler selected nodes; pods being provisioned | No |
| `RUNNING` | At least one training step has completed | No |
| `CHECKPOINTING` | Mid-training checkpoint write in progress | No |
| `COMPLETING` | Training loop done; artifact publishing and model registration in progress | No |
| `COMPLETED` | All artifacts published and (optionally) model registered | **Yes** |
| `FAILED` | Non-retriable error; job cannot continue | **Yes** |
| `CANCELED` | User-initiated or system-initiated cancellation completed | **Yes** |

`CHECKPOINTING` is a sub-state of `RUNNING` surfaced to the API to let clients know writes are in progress - do not cancel during this window if you want a clean checkpoint.

---

## 3. Idempotency

### How it works

Every `POST /jobs` request must include an `Idempotency-Key` header. The API tier:

1. Hashes `(tenant_id, idempotency_key)` and looks it up in Redis (TTL: 24 hours).
2. **Cache miss:** Record does not exist. Persist the request body hash + `job_id` to Redis, then proceed to create the job.
3. **Cache hit, same body hash:** Return the original response verbatim with HTTP 200. No new job is created. This is the safe-retry path for transient network errors.
4. **Cache hit, different body hash:** Return HTTP 409 Conflict. The client intended a new job but reused a key - this is a client error.

### Why this matters for LLM training

Training job submission can fail at the network layer after the server has already accepted the request (TCP RST, load-balancer timeout). Without idempotency, a retry creates a duplicate job that wastes GPU hours and produces conflicting model versions. With idempotency keys, the client can safely retry until it gets a 200 or 201.

```
Client          API Tier        Redis           Job Service
  |                |                |                |
  |-- POST /jobs --|                |                |
  |  Idem-Key: K  |-- GET K ------>|                |
  |                |<-- miss -------|                |
  |                |-- SET K+hash->|                |
  |                |-- CreateJob --|--------------->|
  |                |<-- JobRecord -|<---------------|
  |<-- 201 --------|                |                |
  |                                                  |
  | (network drop, client retries)                   |
  |                |                |                |
  |-- POST /jobs --|                |                |
  |  Idem-Key: K  |-- GET K ------>|                |
  |                |<-- hit:same ---|                |
  |<-- 200:same ---|                |                |
```

---

## 4. Error Model

All error responses follow this envelope:

```json
{
  "error": {
    "code": "string",
    "message": "string (human-readable)",
    "details": {},
    "request_id": "trace-uuid",
    "retry_after": 30
  }
}
```

| HTTP Status | Error Code | Description |
|-------------|------------|-------------|
| 400 | `INVALID_REQUEST` | Missing required field or schema violation |
| 400 | `INVALID_DATASET_URI` | Dataset URI scheme not supported or unreachable |
| 400 | `UNSUPPORTED_MODEL` | Model not available for fine-tuning |
| 401 | `UNAUTHORIZED` | Token missing or expired |
| 403 | `FORBIDDEN` | Token valid but tenant lacks permission for this resource |
| 404 | `JOB_NOT_FOUND` | Job ID does not exist or belongs to another tenant |
| 409 | `IDEMPOTENCY_CONFLICT` | Same key, different body |
| 409 | `JOB_TERMINAL` | Cannot cancel or modify a terminal-state job |
| 422 | `QUOTA_EXCEEDED` | Tenant GPU quota exhausted |
| 429 | `RATE_LIMITED` | Too many requests; `retry_after` in seconds |
| 500 | `INTERNAL_ERROR` | Unhandled server-side error; safe to retry with backoff |
| 503 | `SCHEDULER_UNAVAILABLE` | Scheduler cluster unreachable; transient |

**429 example (with Retry-After header):**

```
HTTP/1.1 429 Too Many Requests
Retry-After: 30
Content-Type: application/json

{
  "error": {
    "code": "RATE_LIMITED",
    "message": "You have exceeded the submission rate limit of 10 jobs/minute for your tenant.",
    "details": {
      "limit": 10,
      "window_seconds": 60,
      "current_count": 11
    },
    "request_id": "req-abc123",
    "retry_after": 30
  }
}
```

---

## 5. Webhook / Event Notification Model

### 5.1 Subscription (in job creation request)

```json
"notification_config": {
  "webhook_url": "https://internal.company.com/hooks/ml-platform",
  "webhook_secret": "whsec_abc123xyz",
  "events": ["JOB_COMPLETED", "JOB_FAILED", "JOB_CANCELED", "JOB_CHECKPOINT_SAVED"]
}
```

### 5.2 Event Payload

```json
{
  "event_id": "evt-f1a2b3c4d5",
  "event_type": "JOB_COMPLETED",
  "occurred_at": "2026-05-06T14:33:20.123Z",
  "job_id": "ftjob-8a3c2f1d9e7b4051",
  "tenant_id": "tenant-a8f2c3d1",
  "data": {
    "status": "COMPLETED",
    "final_train_loss": 0.872,
    "final_eval_loss": 0.941,
    "tokens_trained": 20400000000,
    "duration_seconds": 22395,
    "model_version": "gpt4o-mini-instruct-v3:1",
    "artifact_uri": "azureml://datastores/modelstore/paths/artifacts/ftjob-8a3c2f1d9e7b4051/"
  }
}
```

### 5.3 Delivery Semantics

- **At-least-once delivery** via an internal event queue (Azure Service Bus). The notification service dequeues, calls the webhook URL, and retries on non-2xx with exponential backoff (1s, 2s, 4s, 8s, max 5 attempts).
- **HMAC-SHA256 signature** in `X-Webhook-Signature: sha256=<hex>` header. Client verifies using the `webhook_secret`.
- **Replay protection:** `event_id` is globally unique; clients should deduplicate by `event_id`.

### 5.4 Supported Event Types

| Event | Trigger |
|-------|---------|
| `JOB_PENDING` | Job accepted by API |
| `JOB_VALIDATING` | Validation started |
| `JOB_QUEUED` | Validation passed, placed in scheduler queue |
| `JOB_RUNNING` | First training step completed |
| `JOB_CHECKPOINT_SAVED` | Checkpoint write complete |
| `JOB_COMPLETING` | Training done, artifact publishing started |
| `JOB_COMPLETED` | All artifacts published, model registered |
| `JOB_FAILED` | Terminal failure |
| `JOB_CANCELED` | Cancellation complete |

---

## 6. Internal gRPC Contracts

> **Assumption:** Internal services communicate over mTLS-secured gRPC within the VNet. Service mesh (e.g., Istio or Azure Service Mesh) handles certificate rotation and traffic policies. Proto files are the source of truth; REST is a generated facade.

---

### 6.1 API Tier → Job Service

```protobuf
syntax = "proto3";

service JobService {
  rpc CreateJob(CreateJobRequest) returns (JobRecord);
  rpc GetJob(GetJobRequest) returns (JobRecord);
  rpc CancelJob(CancelJobRequest) returns (CancelJobResponse);
  rpc ListJobs(ListJobsRequest) returns (ListJobsResponse);
  rpc StreamLogs(StreamLogsRequest) returns (stream LogLine);
}

message CreateJobRequest {
  string idempotency_key = 1;
  string tenant_id = 2;
  string model_id = 3;
  string dataset_uri = 4;
  string validation_dataset_uri = 5;
  HyperParameters hyperparameters = 6;
  ComputeConfig compute_config = 7;
  OutputConfig output_config = 8;
  map<string, string> tags = 9;
  NotificationConfig notification_config = 10;
}

message JobRecord {
  string job_id = 1;
  string tenant_id = 2;
  JobStatus status = 3;
  string model_id = 4;
  string created_at = 5;
  string updated_at = 6;
  string started_at = 7;
  JobProgress progress = 8;
  ComputeInfo compute_info = 9;
  CheckpointRef last_checkpoint = 10;
  string error_message = 11;
}

enum JobStatus {
  PENDING = 0;
  VALIDATING = 1;
  QUEUED = 2;
  SCHEDULING = 3;
  RUNNING = 4;
  CHECKPOINTING = 5;
  COMPLETING = 6;
  COMPLETED = 7;
  FAILED = 8;
  CANCELED = 9;
}
```

---

### 6.2 Job Service → Scheduler (Volcano Queue API)

```protobuf
service SchedulerService {
  rpc EnqueueJob(EnqueueRequest) returns (SchedulerHandle);
  rpc CancelScheduledJob(CancelRequest) returns (CancelResponse);
  rpc GetSchedulerStatus(StatusRequest) returns (SchedulerStatus);
  rpc ListQueue(ListQueueRequest) returns (ListQueueResponse);
}

message EnqueueRequest {
  string job_id = 1;
  string tenant_id = 2;
  ResourceRequirements resources = 3;
  int32 priority = 4;
  string queue_name = 5;
  int64 max_runtime_seconds = 6;
}

message SchedulerHandle {
  string job_id = 1;
  string queue_position_hint = 2;
  int64 estimated_start_epoch_ms = 3;
}

message ResourceRequirements {
  int32 node_count = 1;
  int32 gpu_per_node = 2;
  string gpu_type = 3;
  int64 memory_mb_per_node = 4;
  int64 cpu_millicores_per_node = 5;
}
```

---

### 6.3 Scheduler → Pod Launcher

```protobuf
service PodLauncherService {
  rpc LaunchJob(LaunchRequest) returns (LaunchResult);
  rpc TerminateJob(TerminateRequest) returns (TerminateResult);
  rpc GetPodStatus(PodStatusRequest) returns (PodStatusResponse);
}

message LaunchRequest {
  string job_id = 1;
  string tenant_id = 2;
  string namespace = 3;
  ComputeConfig compute_config = 4;
  string container_image = 5;
  repeated EnvVar env_vars = 6;
  SecretConfig secret_config = 7;
  NetworkConfig network_config = 8;
  string volcano_queue = 9;
}

message LaunchResult {
  string job_id = 1;
  string volcano_job_name = 2;
  repeated string pod_names = 3;
  string namespace = 4;
  bool success = 5;
  string error = 6;
}

message SecretConfig {
  string managed_identity_client_id = 1;
  string keyvault_uri = 2;
  repeated string secret_names = 3;
}

message NetworkConfig {
  string vnet_subnet_id = 1;
  repeated string allowed_egress_fqdns = 2;
  bool enable_private_endpoints = 3;
}
```

---

### 6.4 Launcher → Checkpoint Manager

```protobuf
service CheckpointManagerService {
  rpc InitCheckpointSession(InitRequest) returns (CheckpointSession);
  rpc WriteCheckpoint(WriteCheckpointRequest) returns (CheckpointRef);
  rpc ReadCheckpoint(ReadCheckpointRequest) returns (CheckpointRef);
  rpc ListCheckpoints(ListCheckpointsRequest) returns (ListCheckpointsResponse);
  rpc DeleteCheckpoint(DeleteCheckpointRequest) returns (google.protobuf.Empty);
  rpc CommitCheckpoint(CommitRequest) returns (CheckpointRef);
}

message WriteCheckpointRequest {
  string job_id = 1;
  string tenant_id = 2;
  int64 step = 3;
  int32 epoch = 4;
  int32 rank = 5;
  string storage_uri = 6;
  CheckpointMetadata metadata = 7;
}

message CheckpointRef {
  string checkpoint_id = 1;
  string job_id = 2;
  int64 step = 3;
  int32 epoch = 4;
  string uri = 5;
  string saved_at = 6;
  CheckpointMetadata metadata = 7;
}

message CheckpointMetadata {
  double train_loss = 1;
  double eval_loss = 2;
  int64 tokens_processed = 3;
  map<string, string> optimizer_state_keys = 4;
}
```

---

### 6.5 Log Shipper → Log Aggregator

```protobuf
service LogAggregatorService {
  rpc IngestLogBatch(LogBatch) returns (IngestResponse);
  rpc StreamLogs(StreamLogsRequest) returns (stream LogLine);
}

message LogBatch {
  string job_id = 1;
  string pod_name = 2;
  int32 rank = 3;
  repeated LogLine lines = 4;
}

message LogLine {
  string job_id = 1;
  string pod_name = 2;
  int32 rank = 3;
  string timestamp = 4;
  LogLevel level = 5;
  string message = 6;
  int64 sequence_number = 7;
  map<string, string> labels = 8;
}

enum LogLevel {
  DEBUG = 0;
  INFO = 1;
  WARN = 2;
  ERROR = 3;
}
```

The log shipper runs as a sidecar container in each training pod. It tails stdout/stderr via the container runtime, batches lines (max 1000 lines or 5s, whichever comes first), and pushes to the aggregator over gRPC. The aggregator fans in from all pods and indexes into a time-series log store (backed by ClickHouse or Azure Data Explorer).

---

### 6.6 Artifact Publisher → Model Registry

```protobuf
service ModelRegistryService {
  rpc RegisterModel(RegisterModelRequest) returns (ModelVersion);
  rpc GetModelVersion(GetModelVersionRequest) returns (ModelVersion);
  rpc ListModelVersions(ListModelVersionsRequest) returns (ListModelVersionsResponse);
  rpc PromoteModelVersion(PromoteRequest) returns (ModelVersion);
  rpc GetEvaluationResult(EvalResultRequest) returns (EvaluationResult);
}

message RegisterModelRequest {
  string job_id = 1;
  string tenant_id = 2;
  string model_name = 3;
  string artifact_uri = 4;
  string base_model_id = 5;
  ModelMetadata metadata = 6;
  EvaluationResult evaluation_result = 7;
}

message ModelVersion {
  string model_version_id = 1;
  string model_name = 2;
  string version = 3;
  string artifact_uri = 4;
  ModelStage stage = 5;
  ModelMetadata metadata = 6;
  string created_at = 7;
}

enum ModelStage {
  STAGING = 0;
  PRODUCTION = 1;
  ARCHIVED = 2;
}

message EvaluationResult {
  double eval_loss = 1;
  double perplexity = 2;
  map<string, double> custom_metrics = 3;
  bool passed_gate = 4;
  string eval_dataset_uri = 5;
}
```

---

## 7. API Versioning and Backward Compatibility

> **Assumption:** The API uses URI versioning (`/v1/`, `/v2/`). Minor backward-compatible additions (new optional fields, new status enum values, new error codes) are non-breaking within a major version. Breaking changes require a new major version.

- New optional fields on request/response: non-breaking, shipped under existing version.
- New `JobStatus` enum values: non-breaking if clients handle unknown enum values gracefully (required by contract).
- Removal or rename of fields: breaking; requires `/v2/` with a 6-month deprecation window.
- gRPC proto field numbers are never reused; reserved field numbers must be declared when fields are removed.


## Glossary

[ChatGPT Link] https://chatgpt.com/c/69faaf64-a550-83a4-a7a4-7b663e3e7ff5


These are **fine-tuning hyperparameters**. They control **how long you train, how much data the model sees at once, how aggressively weights are updated, and how LoRA/QLoRA adapts the base model**.

Think of fine-tuning like teaching a smart student a new company-specific skill. These parameters decide the **teaching speed, repetition count, memory window, and how much of the brain you allow to adapt**.

```json
{
  "n_epochs": 3,
  "batch_size": 16,
  "learning_rate_multiplier": 1.8,
  "warmup_ratio": 0.03,
  "weight_decay": 0.01,
  "gradient_accumulation_steps": 4,
  "max_sequence_length": 4096,
  "lora_rank": 16,
  "lora_alpha": 32,
  "lora_dropout": 0.05,
  "peft_method": "qlora"
}
```

## 1. `n_epochs: 3`

An **epoch** means one full pass over the training dataset.

```text
If you have 10,000 training examples:

1 epoch  = model sees all 10,000 examples once
3 epochs = model sees all 10,000 examples three times
```

So:

```json
"n_epochs": 3
```

means the model goes through the dataset **3 times**.

| Value    | Effect                                                                    |
| -------- | ------------------------------------------------------------------------- |
| Too low  | Model may underfit; it does not learn enough                              |
| Good     | Learns patterns without memorizing too much                               |
| Too high | Model may overfit; it memorizes examples and performs badly on new inputs |

For LLM fine-tuning, **2–4 epochs** is common for many instruction-tuning jobs.

---

## 2. `batch_size: 16`

Batch size is how many training examples are processed together before one gradient calculation.

```text
batch_size = 16

The model reads 16 examples,
calculates loss,
then computes gradient direction.
```

Simple analogy:

```text
Instead of correcting the student after every single question,
you let them answer 16 questions,
then give feedback based on the group.
```

| Larger batch size                       | Smaller batch size              |
| --------------------------------------- | ------------------------------- |
| More stable gradients                   | Noisier gradients               |
| Better GPU utilization                  | Lower memory requirement        |
| Uses more GPU memory                    | Can work on smaller GPUs        |
| May generalize slightly worse sometimes | Can generalize better sometimes |

---

## 3. `gradient_accumulation_steps: 4`

This is used when you want a bigger effective batch size but cannot fit it into GPU memory.

Here:

```json
"batch_size": 16,
"gradient_accumulation_steps": 4
```

Effective batch size becomes:

```text
effective_batch_size = batch_size × gradient_accumulation_steps
effective_batch_size = 16 × 4 = 64
```

Meaning:

```text
Step 1: process 16 examples, store gradients
Step 2: process 16 more, add gradients
Step 3: process 16 more, add gradients
Step 4: process 16 more, add gradients
Then update model once
```

So the model behaves like it trained with batch size **64**, but only needs memory for **16 examples at a time**.

This is very important in LLM training because GPU memory is usually the bottleneck.

---

## 4. `learning_rate_multiplier: 1.8`

Learning rate controls **how big each update step is**.

A multiplier means you are scaling some base/default learning rate.

```text
final_learning_rate = base_learning_rate × learning_rate_multiplier
```

So if the platform default learning rate is:

```text
1e-5
```

then:

```text
1e-5 × 1.8 = 1.8e-5
```

Meaning:

```json
"learning_rate_multiplier": 1.8
```

makes training **more aggressive** than default.

| Learning rate too low | Learning rate too high              |
| --------------------- | ----------------------------------- |
| Learns slowly         | Training becomes unstable           |
| May underfit          | Loss may explode                    |
| Needs more epochs     | Model may forget previous knowledge |

In interview language:

> “Learning rate controls the step size of optimization. A multiplier of 1.8 means we are training faster than the platform default, but it increases the risk of instability or overfitting if the dataset is small.”

---

## 5. `warmup_ratio: 0.03`

Warmup means you do **not start with the full learning rate immediately**.

Instead, the learning rate slowly increases at the beginning.

```json
"warmup_ratio": 0.03
```

means the first **3% of training steps** are warmup steps.

Example:

```text
Total training steps = 10,000
Warmup ratio = 0.03

Warmup steps = 300
```

During those first 300 steps:

```text
learning rate slowly rises from near 0 to full learning rate
```

Why?

Because early training is unstable. The model is just starting to adapt, and large updates at the start can damage the pretrained weights.

Simple analogy:

```text
Do not start driving at 120 km/h immediately.
First accelerate smoothly, then maintain speed.
```

---

## 6. `weight_decay: 0.01`

Weight decay is a regularization technique. It prevents the model from making weights too large.

```json
"weight_decay": 0.01
```

means you lightly penalize large weight values.

Why does this matter?

Because without regularization, the model may memorize the training data too strongly.

| Weight decay | Effect                               |
| ------------ | ------------------------------------ |
| 0            | No penalty; more risk of overfitting |
| 0.01         | Common light regularization          |
| Too high     | Model may underfit                   |

Simple version:

```text
Weight decay tells the model:
"Learn the pattern, but don't overreact to the dataset."
```

---

## 7. `max_sequence_length: 4096`

This is the maximum number of tokens the model can see in one training example.

```json
"max_sequence_length": 4096
```

means each prompt + completion pair can be up to **4096 tokens**.

Example:

```text
Prompt tokens:     3000
Completion tokens: 1000
Total:             4000
Allowed:           yes

Prompt tokens:     5000
Completion tokens: 1000
Total:             6000
Allowed:           no, it gets truncated or rejected
```

This affects memory heavily.

Longer sequence length means:

```text
more context
more GPU memory
slower training
higher cost
```

For transformers, attention cost grows roughly with sequence length, so increasing from 4096 to 8192 can be significantly more expensive.

---

# LoRA / QLoRA parameters

These next parameters are about **parameter-efficient fine-tuning**.

Instead of updating all model weights, LoRA/QLoRA freezes the base model and trains small adapter matrices.

```text
Base model weights: frozen
Small LoRA adapters: trainable
```

This makes fine-tuning cheaper and faster.

---

## 8. `peft_method: "qlora"`

PEFT means **Parameter-Efficient Fine-Tuning**.

```json
"peft_method": "qlora"
```

means you are using **QLoRA**.

QLoRA is basically:

```text
Quantized LoRA
```

It keeps the base model in lower precision, often 4-bit, and trains small LoRA adapter weights.

Simple stack:

```text
Full fine-tuning:
Update all model weights
Expensive, high GPU memory

LoRA:
Freeze base model
Train small adapter matrices
Cheaper

QLoRA:
Quantize frozen base model to 4-bit
Train LoRA adapters
Even cheaper memory-wise
```

So QLoRA is useful when you want to fine-tune large models on fewer GPUs.

---

## 9. `lora_rank: 16`

LoRA rank controls the **capacity** of the adapter.

```json
"lora_rank": 16
```

means the LoRA adapter has rank 16.

Higher rank means the adapter can learn more complex changes.

| Rank  | Meaning                                           |
| ----- | ------------------------------------------------- |
| 4     | Very small adapter, cheap, limited learning       |
| 8     | Common lightweight setting                        |
| 16    | Good balance                                      |
| 32/64 | More capacity, more memory, more overfitting risk |

Simple explanation:

```text
lora_rank = how much extra learning capacity you attach to the frozen model
```

If your dataset requires small style adaptation, rank 8 may be enough.

If your dataset requires domain-specific behavior, rank 16 or 32 may be better.

---

## 10. `lora_alpha: 32`

`lora_alpha` controls the **strength/scaling** of the LoRA adapter.

Usually LoRA scaling is:

```text
scaling = lora_alpha / lora_rank
```

Here:

```text
lora_alpha = 32
lora_rank = 16

scaling = 32 / 16 = 2
```

So the LoRA adapter output is scaled by **2x**.

Meaning:

```text
Higher alpha = LoRA changes have stronger influence
Lower alpha = LoRA changes are more conservative
```

A common pattern is:

```text
lora_alpha = 2 × lora_rank
```

Your config follows that:

```text
rank = 16
alpha = 32
```

This is a reasonable default.

---

## 11. `lora_dropout: 0.05`

Dropout randomly disables a small fraction of LoRA adapter activations during training.

```json
"lora_dropout": 0.05
```

means **5% dropout**.

Why?

To prevent overfitting.

Simple analogy:

```text
Don't let the adapter rely too heavily on one narrow path.
Force it to learn more robust patterns.
```

| Dropout  | Meaning                     |
| -------- | --------------------------- |
| 0.0      | No dropout                  |
| 0.05     | Light regularization        |
| 0.1      | Stronger regularization     |
| Too high | Can reduce learning quality |

---

# The most important combined concept

These two together:

```json
"batch_size": 16,
"gradient_accumulation_steps": 4
```

mean:

```text
Effective batch size = 64
```

These three together:

```json
"lora_rank": 16,
"lora_alpha": 32,
"lora_dropout": 0.05
```

mean:

```text
Use a moderate-size LoRA adapter,
scale its effect by 2x,
and add light regularization.
```

These two together:

```json
"n_epochs": 3,
"learning_rate_multiplier": 1.8
```

mean:

```text
Train for 3 passes over the data,
with a somewhat aggressive learning rate.
```

---

# Full table

| Parameter                     |                            Meaning | Your value | Interpretation                          |
| ----------------------------- | ---------------------------------: | ---------: | --------------------------------------- |
| `n_epochs`                    | Number of full passes over dataset |          3 | Model sees training data 3 times        |
| `batch_size`                  |  Examples processed per mini-batch |         16 | Moderate batch size                     |
| `learning_rate_multiplier`    |          Scales base learning rate |        1.8 | More aggressive than default            |
| `warmup_ratio`                |        % of steps spent ramping LR |       0.03 | First 3% steps warm up                  |
| `weight_decay`                |            Penalizes large weights |       0.01 | Light anti-overfitting regularization   |
| `gradient_accumulation_steps` |    Number of batches before update |          4 | Effective batch size = 64               |
| `max_sequence_length`         |             Max tokens per example |       4096 | Supports long examples, higher memory   |
| `lora_rank`                   |              LoRA adapter capacity |         16 | Balanced adapter size                   |
| `lora_alpha`                  |              LoRA scaling strength |         32 | Scaling = 2x                            |
| `lora_dropout`                |               Dropout on LoRA path |       0.05 | Light regularization                    |
| `peft_method`                 |                 Fine-tuning method |      QLoRA | Memory-efficient LoRA with quantization |

---

# Interview-ready explanation

You can say:

> “These hyperparameters define how the fine-tuning job learns. `n_epochs` controls how many times the dataset is replayed. `batch_size` and `gradient_accumulation_steps` define the effective batch size, which here is 64. `learning_rate_multiplier`, `warmup_ratio`, and `weight_decay` control optimization stability and overfitting. `max_sequence_length` controls the training context window and GPU memory cost. Since this uses QLoRA, the base model is quantized and frozen, while small LoRA adapters are trained. `lora_rank` controls adapter capacity, `lora_alpha` controls adapter strength, and `lora_dropout` regularizes the adapter.”

Very simple summary:

```text
These settings say:
Train the model for 3 passes,
use an effective batch size of 64,
support 4096-token examples,
train using memory-efficient QLoRA,
and use a moderate LoRA adapter with light regularization.
```
