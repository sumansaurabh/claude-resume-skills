# 03 — APIs and Contracts

This document specifies the API surfaces, the WebSocket protocol, the internal gRPC contracts, and the cross-cutting concerns (auth, idempotency, pagination, errors, versioning, rate limiting, webhooks) that every team building Qale will integrate against.

The principle: **three surfaces, one identity, one error envelope, one idempotency model**. Anything that cannot be expressed in those three surfaces is a smell and goes back through architecture review.

Resume anchors used most in this doc:

- **A-BB3** — DAG workflow engine with checkpointing and retry semantics. Drives the AI run lifecycle and idempotency story.
- **A-BB4** — Model router across Claude / GPT / Grok at 1B+ tokens/month. Drives the AI streaming surface and provider-degradation error codes.
- **A-BB5** — LLMOps telemetry mesh, deterministic replay. Drives the `traceId` requirement on every error envelope.
- **A-MS1** — TunDRA QUIC at 1M+ instances. Drives the connection-rotation, resume-token, and ack-window choices on the WebSocket.
- **A-MS3** — AutoML job orchestration at 15M+ jobs/month, 200K+ users. Drives the job/run state model behind `POST /ai/runs`.
- **A-MS4** — secure CI/CD, threat models. Drives the auth, mTLS, and signed-payload choices.

Anything called "Qale-specific" that I cannot ground to a resume anchor is labeled **assumption**.

---

## 1. API surface overview

Qale exposes three protocol surfaces. Each one has one audience, one auth scheme, and one error envelope. We do not let teams "just open another port."

| Surface | Protocol | Audience | Examples | Auth | Versioning |
| --- | --- | --- | --- | --- | --- |
| External control plane | HTTPS / REST + JSON | First-party web/mobile clients, third-party integrators | `POST /v1/threads`, `GET /v1/search` | OIDC bearer (JWT access + refresh) | URL-major (`/v1/`) |
| External data plane | WebSocket (over WSS); WebTransport later | First-party web/mobile clients only | `client.send_message`, `server.ai_run_token` | Signed WS upgrade token (short-lived) bound to JWT subject | Negotiated in `client.hello` |
| Internal service mesh | gRPC over HTTP/2 + Protobuf | Qale services only (private VPC) | `MessageService.Send`, `AIOrchestratorService.StreamRun` | mTLS (SPIFFE IDs) + workspace-scoped JWT propagated as metadata | Proto package versioning (`qale.message.v1`) |
| Outbound webhooks | HTTPS POST + JSON, HMAC-signed | Enterprise integrations (Jira, ServiceNow, etc.) | `thread.message.created`, `ai.run.completed` | HMAC-SHA256 of body with rotated secret | URL-major (`/v1/`) |
| Telemetry export | OTLP/gRPC (egress to ClickHouse + vendor) | Internal only | spans, metrics, logs | mTLS | OTel semantic conventions |

Notes:

- We intentionally **do not** expose gRPC externally at Alpha. Browsers don't speak it well, and the polyfill (gRPC-Web) buys us nothing over plain REST + WebSocket. **Open question:** revisit for mobile native clients when they exist (see §13).
- We intentionally **do not** put GraphQL on the critical path. We will discuss in §13.
- The realtime surface is **WebSocket-only** at Alpha. Long polling and SSE exist solely as fallbacks (see §8).

---

## 2. Authentication and identity

### Identity model

- Every request — REST, WebSocket, gRPC — carries a single subject: `userId` scoped to a `workspaceId`. A user belongs to N workspaces; one access token represents one (`userId`, `workspaceId`) pair. Switching workspace = new token. This eliminates a whole class of cross-tenant bugs that we'd otherwise have to catch in code.
- This mirrors the multi-tenant boundary I enforced for ML workloads on Azure (A-MS2): the workspace is the unit of isolation everywhere — Postgres row policies, S3 prefixes, Kafka tenant tags, Redis key prefixes, and AI quotas.

### External auth (web/mobile)

- **OIDC** flow (PKCE on web, native flows on mobile) against Qale's auth service or a federated IdP (Google, Microsoft, Okta).
- **Access token (JWT)**: ~10 min lifetime. Signed RS256, public keys served from `/.well-known/jwks.json`. Claims:

  ```json
  {
    "iss": "https://auth.qale.app",
    "sub": "usr_01HF4Z7N9P3K8XQ2YJV",
    "aud": "qale-api",
    "exp": 1762958400,
    "iat": 1762957800,
    "wsid": "ws_01HF4Z7N9P3K8XQ2YJV",
    "wsrole": "member",
    "scopes": ["thread:read","thread:write","ai:invoke"],
    "ver": 1
  }
  ```

- **Refresh token**: 30 days, rotating, single-use. Stored as `HttpOnly; Secure; SameSite=Strict` cookie on web. Theft-detection: if a previously-rotated refresh token is reused, all sessions for that user are invalidated and the user is forced to re-auth.
- **Token rotation**: clients refresh ~60s before `exp`. The refresh endpoint returns the new access + refresh pair. **Connection-level rebinding** below describes how this works *without dropping the WebSocket*.

### WebSocket upgrade

- The WS upgrade is authenticated with a **short-lived signed upgrade token** (separate from the access token), obtained from `POST /v1/realtime/tokens`. The upgrade token is single-use, valid for 30 seconds, and bound to (userId, workspaceId, deviceId). This avoids leaking the long-lived access token via URL or browser network logs (which is the standard pattern; the WebSocket handshake doesn't have a clean header path on browser-native APIs without a custom subprotocol).
- After upgrade, the connection holds a **session** that is independent of the original access token. Refresh of the underlying access token rebinds the session via a `client.rebind` frame (see §4).

### Internal auth (service-to-service)

- **mTLS** between every pair of services. SPIFFE-style identities (`spiffe://qale/ns/prod/sa/message-service`) issued by an internal CA. Certificate rotation every 24h.
- **Workspace context** is propagated as gRPC metadata (`x-qale-wsid`, `x-qale-userid`, `x-qale-traceid`). Services validate that the calling service is allowed to act on behalf of that workspace; cross-tenant calls are rejected at the interceptor layer, not in business logic. Same pattern I used at Microsoft for inter-service calls inside the AutoML control plane (A-MS3).
- **JWT propagation** for end-user requests: the original user JWT is forwarded as `authorization` metadata so that downstream services can run their own ABAC checks against the user's scopes, not just the calling service's identity.

### Signed payload integrity

- Outbound webhooks are HMAC-SHA256 signed (see §12).
- AI run tool-call payloads (when calling internal tool services) are HMAC-signed by the AI orchestrator with a per-workspace key, so tool services can verify provenance and prevent prompt-injected tool invocations from reaching them via any other path.

---

## 3. REST endpoints (control plane)

All endpoints are under `https://api.qale.app/v1/`. All requests must carry:

- `Authorization: Bearer <jwt>`
- `X-Qale-Workspace-Id: <wsid>` — must match the token's `wsid` claim. Mismatch = 403.
- `X-Request-Id: <uuid>` — client-generated; echoed in the response and in the trace.
- `Idempotency-Key: <uuid v7>` — required on `POST` that creates side-effect-bearing resources (see §6).

Standard response headers:

- `X-Trace-Id: <hex>` — every response, even errors (A-BB5).
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (see §11).
- `Sunset`, `Deprecation` — when applicable (see §10).

### 3.1 Create thread

```
POST /v1/workspaces/{wsId}/threads
Idempotency-Key: 0190f3a7-3f1b-7c9a-8b2d-7e6c1d4a9f01
Content-Type: application/json

{
  "title": "Q3 launch checklist",
  "kind": "channel",
  "visibility": "workspace",
  "members": ["usr_01HF...A1", "usr_01HF...B2"],
  "parentThreadId": null,
  "metadata": { "source": "web" }
}
```

Response (201):

```json
{
  "threadId": "th_01HF4ZA8B7CD3E1FXZK",
  "workspaceId": "ws_01HF4Z7N9P3K8XQ2YJV",
  "kind": "channel",
  "visibility": "workspace",
  "title": "Q3 launch checklist",
  "createdAt": "2026-05-12T14:03:21.418Z",
  "createdBy": "usr_01HF...A1",
  "memberCount": 3,
  "lastSequence": 0,
  "etag": "W/\"v1-0\""
}
```

Notes:

- `kind` ∈ `dm | group_dm | channel | ai_thread`. **Assumption:** `ai_thread` is a Qale-specific thread type whose primary participant is an AI agent.
- `visibility` ∈ `private | workspace | public`. Public threads are workspace-discoverable but require a join action.
- `etag` lets clients do conditional updates with `If-Match`. Used by `PATCH` endpoints below.

### 3.2 Send message (idempotent)

```
POST /v1/threads/{tid}/messages
Idempotency-Key: 0190f3a7-3f1b-7c9a-8b2d-7e6c1d4a9f02
Content-Type: application/json

{
  "clientMessageId": "0190f3a7-4111-7000-a000-000000000001",
  "type": "text",
  "body": {
    "text": "Can you summarize the thread above?",
    "mentions": [{"userId": "agent_summarizer", "offset": 4, "length": 9}]
  },
  "attachments": [
    {"uploadId": "up_01HF4ZB...", "kind": "image", "filename": "screenshot.png"}
  ],
  "replyTo": null,
  "metadata": { "client": "web/1.42.0" }
}
```

Response (201):

```json
{
  "messageId": "msg_01HF4ZC1D2E3F4G5HJK",
  "threadId": "th_01HF4ZA8B7CD3E1FXZK",
  "workspaceId": "ws_01HF4Z7N9P3K8XQ2YJV",
  "sequence": 18342,
  "authorId": "usr_01HF...A1",
  "type": "text",
  "createdAt": "2026-05-12T14:05:01.092Z",
  "deliveryState": "fanout_pending",
  "etag": "W/\"v1-0\""
}
```

Notes on send semantics (anchors A-BB3, A-MS1):

- `sequence` is **server-assigned, monotonically increasing per thread**. This is the natural sort key for the thread (see §7).
- `clientMessageId` is the dedup key the client will see in the WebSocket echo, so the client can reconcile its optimistic local message with the server's authoritative one.
- The REST response returns the **persisted** state (`fanout_pending`), not the fanout-completed state. Fanout completion is observed via the WebSocket `server.message_event` (see §4). This separation lets us keep the REST path cheap and predictable.
- `Idempotency-Key` is enforced at the gateway (see §6). The same key + same body returns the same `201` with the same `messageId`. Same key + different body returns `409 IDEMPOTENCY_CONFLICT`.

### 3.3 List messages (cursor-paginated)

```
GET /v1/threads/{tid}/messages?cursor=eyJzZXEiOjE4MzQyfQ&limit=50&direction=backward
```

Response (200):

```json
{
  "items": [
    { "messageId": "msg_01HF...HJK", "sequence": 18342, "authorId": "usr_...", "type": "text",
      "body": {"text": "..."}, "createdAt": "2026-05-12T14:05:01.092Z", "editedAt": null,
      "reactions": [], "replyCount": 0 }
  ],
  "page": {
    "nextCursor": "eyJzZXEiOjE4MjkyfQ",
    "prevCursor": null,
    "hasMore": true,
    "limit": 50
  }
}
```

Notes:

- `cursor` is **opaque, base64-encoded JSON** containing whatever the server needs (`{"seq": 18342}` today; could become `{"seq": 18342, "shard": 7}` later without breaking clients).
- `direction` ∈ `forward | backward`. Default `backward` (load history).
- Server caps `limit` at 200; requests above the cap are silently clamped, with `X-Qale-Limit-Clamped: true` in the response.
- **No `offset` parameter exists.** Offset pagination is forbidden across the platform — see §7.

### 3.4 Edit and delete a message

```
PATCH /v1/messages/{mid}
If-Match: W/"v1-0"
Content-Type: application/json

{
  "body": { "text": "Can you summarize the last 50 messages?" }
}
```

Response (200): the updated message. New `etag` returned. The thread's sequence is **not** advanced — edits are an out-of-band update on an existing sequence number, broadcast as a `server.message_event` with `kind: "edited"`.

```
DELETE /v1/messages/{mid}
If-Match: W/"v1-0"
```

Response (204). Soft delete by default — the row stays, the body is replaced with a tombstone. Hard delete (for GDPR / DSAR) is a separate admin endpoint.

`If-Match` failures return `412 PRECONDITION_FAILED` with the current `etag` so the client can resolve the conflict.

### 3.5 Start an AI run

```
POST /v1/threads/{tid}/ai/runs
Idempotency-Key: 0190f3a7-5222-7000-b000-000000000001
Content-Type: application/json

{
  "intent": "summarize_thread",
  "input": {
    "scope": { "fromSequence": 18000, "toSequence": 18342 },
    "style": "bullet"
  },
  "tools": ["search.workspace", "calendar.read"],
  "modelHint": "auto",
  "budget": { "maxTokens": 8000, "maxToolCalls": 6, "maxWallSeconds": 60 },
  "stream": true
}
```

Response (202):

```json
{
  "runId": "run_01HF4ZD7E8F9G0H1JKL",
  "threadId": "th_01HF4ZA8B7CD3E1FXZK",
  "status": "queued",
  "createdAt": "2026-05-12T14:07:11.001Z",
  "stream": {
    "transport": "websocket",
    "channel": "run:run_01HF4ZD7E8F9G0H1JKL"
  },
  "budget": { "maxTokens": 8000, "maxToolCalls": 6, "maxWallSeconds": 60 }
}
```

Notes (anchors A-BB3, A-BB4):

- `intent` is one of a registered set; arbitrary free-form intents are rejected. The orchestrator selects the appropriate DAG and tools per intent.
- `modelHint` ∈ `auto | fast | reasoning | cheap | byo:<id>`. The router resolves to a concrete model; the resolved model is reported back in the `server.ai_run_complete` event and is part of the trace.
- `budget` is enforced by the orchestrator. Exceeding it produces `AI_BUDGET_EXCEEDED` (see §9).
- `stream: true` says "subscribe me to the run channel on my existing WebSocket." The REST call returns immediately; tokens stream back over WS.

### 3.6 Cancel an AI run

```
POST /v1/threads/{tid}/ai/runs/{runId}/cancel
Content-Type: application/json

{ "reason": "user_cancelled" }
```

Response (202):

```json
{ "runId": "run_01HF4ZD7E8F9G0H1JKL", "status": "cancelling" }
```

Cancellation is best-effort; a run already past the point of an irreversible side effect transitions to `partially_committed` instead of `cancelled`. This is the same "side effects you cannot un-execute" problem from BlackBox tool-calling agents (A-BB3).

### 3.7 Search

```
GET /v1/search?q=launch+checklist&workspaceId=ws_01HF...&kind=message&from=2026-04-01&limit=20&cursor=...
```

Response (200):

```json
{
  "items": [
    {
      "kind": "message",
      "messageId": "msg_01HF4...",
      "threadId": "th_01HF4ZA8B7CD3E1FXZK",
      "snippet": "...the Q3 <em>launch</em> <em>checklist</em> needs review by...",
      "score": 0.84,
      "createdAt": "2026-05-09T09:15:12Z"
    }
  ],
  "facets": {
    "kind": { "message": 142, "file": 17, "thread": 8 }
  },
  "page": { "nextCursor": "...", "hasMore": true, "limit": 20 }
}
```

Notes:

- Lexical (BM25 over OpenSearch / equivalent) + semantic (vector index) search are blended server-side. `mode=hybrid|lexical|semantic` is supported but `hybrid` is default.
- Per-workspace ACLs are enforced at query time, not at indexing time (rows the user cannot see are filtered out, not just dropped from results).

### 3.8 Uploads

```
POST /v1/uploads
Content-Type: application/json

{
  "filename": "screenshot.png",
  "contentType": "image/png",
  "size": 184211,
  "kind": "thread_attachment",
  "threadId": "th_01HF4ZA8B7CD3E1FXZK"
}
```

Response (201):

```json
{
  "uploadId": "up_01HF4ZE9F0G1H2J3KLM",
  "method": "PUT",
  "url": "https://uploads.qale.app/ws_.../up_01HF4ZE9F0G1H2J3KLM?X-Amz-Signature=...",
  "headers": {
    "Content-Type": "image/png",
    "x-amz-server-side-encryption": "aws:kms"
  },
  "expiresAt": "2026-05-12T14:22:11Z",
  "maxBytes": 200000
}
```

The client `PUT`s the file directly to S3 (or equivalent). Once the upload completes, the `uploadId` can be referenced from a message. Server validates `Content-Length`, content type sniffing (server-side), and runs antivirus + image-EXIF stripping out of band before marking the upload `clean`.

### 3.9 Register a push device

```
POST /v1/users/me/devices
Content-Type: application/json

{
  "platform": "ios",
  "pushToken": "abc123...",
  "deviceId": "dev_01HF4...",
  "appVersion": "1.4.2",
  "locale": "en-IN"
}
```

Response (201):

```json
{
  "deviceId": "dev_01HF4...",
  "registeredAt": "2026-05-12T14:24:00Z"
}
```

`DELETE /v1/users/me/devices/{deviceId}` removes a device on logout.

### 3.10 Other endpoints (sketched, not detailed here)

| Method + Path | Purpose |
| --- | --- |
| `GET /v1/workspaces/{wsId}` | Workspace metadata, plan, quotas |
| `GET /v1/workspaces/{wsId}/members?cursor=...` | List members |
| `POST /v1/workspaces/{wsId}/invites` | Invite user (idempotent on email) |
| `GET /v1/threads/{tid}` | Thread metadata + member list |
| `POST /v1/threads/{tid}/members` | Add member (idempotent) |
| `DELETE /v1/threads/{tid}/members/{userId}` | Remove member |
| `POST /v1/threads/{tid}/read` | Mark read up to a sequence |
| `POST /v1/messages/{mid}/reactions` | Add reaction (idempotent on (userId, emoji)) |
| `GET /v1/users/me` | Current user |
| `POST /v1/users/me/notifications/preferences` | Notification preferences |
| `GET /v1/admin/audit?cursor=...` | SOC-2 audit log (admin only) |

---

## 4. WebSocket protocol

### 4.1 Connection lifecycle

1. Client `POST /v1/realtime/tokens` → gets a single-use upgrade token.
2. Client opens `wss://realtime.qale.app/v1/socket?token=<upgrade>&device=<deviceId>`. The gateway validates the upgrade token, attaches a session, and returns `server.welcome`.
3. Client sends `client.hello` with capabilities, last seen sequences, and protocol version.
4. Server confirms in `server.welcome_complete`, optionally with `resumeToken` and per-thread `lastSequence` snapshot.
5. Steady state: bidirectional framed JSON messages.
6. Heartbeat: `client.ping` every 25s, server responds `server.pong`. Three missed pongs → client reconnects.
7. Token rotation: client sends `client.rebind` with the new JWT. Server validates and updates the session's identity binding **without dropping the socket**. (This is the same pattern I used in TunDRA for cert rotation on long-lived QUIC sessions — A-MS1.)
8. Disconnect: client sends `client.bye` (clean) or the socket drops (unclean). On unclean drop, the gateway holds session state for 30 seconds to allow `client.resume`.
9. Reconnect with `resumeToken` → server replays missed events in order from the per-thread last delivered sequence.

### 4.2 Framing

JSON over WebSocket text frames at Alpha. Every frame has:

```json
{
  "v": 1,
  "id": "0190f3a7-7000-7000-c000-000000000001",
  "type": "client.send_message",
  "ts": "2026-05-12T14:05:01.000Z",
  "payload": { ... }
}
```

- `v` is the protocol version negotiated in `client.hello`.
- `id` is a frame identifier (UUID v7) used for ack correlation.
- `type` is the frame type (table below).
- `ts` is the sender's wall clock; informational only — server uses its own clock for ordering.

**Open question** (§13): switch to a binary framing (CBOR or protobuf) once we hit a clear cost or latency wall. Not at Alpha.

### 4.3 Message types

| Direction | Type | Purpose |
| --- | --- | --- |
| C→S | `client.hello` | Negotiate version, declare capabilities, declare last-seen sequences |
| S→C | `server.welcome` | Session established; sessionId, serverTime, max frame size |
| S→C | `server.welcome_complete` | After hello: per-thread lastSequence map + optional resumeToken |
| C→S | `client.ping` | Heartbeat |
| S→C | `server.pong` | Heartbeat reply |
| C→S | `client.rebind` | New JWT after token rotation |
| S→C | `server.rebind_ack` | Rotation accepted; new identity bound |
| C→S | `client.resume` | Resume after disconnect with resumeToken |
| S→C | `server.resume_complete` | Replay finished |
| C→S | `client.subscribe_thread` | Subscribe to a thread's events |
| S→C | `server.subscription_state` | Subscribed/unsubscribed; current lastSequence |
| C→S | `client.unsubscribe_thread` | Unsubscribe |
| C→S | `client.send_message` | Send a message via WS (alternative to REST) |
| S→C | `server.message_ack` | Server accepted client.send_message; carries assigned messageId, sequence |
| S→C | `server.message_event` | New / edited / deleted message in a subscribed thread |
| C→S | `client.typing` | Typing indicator |
| S→C | `server.typing_event` | Someone is typing in a subscribed thread |
| C→S | `client.read` | Mark read up to sequence |
| S→C | `server.read_receipt` | Read receipt event for a thread |
| S→C | `server.presence_event` | Presence change for someone you watch |
| C→S | `client.ai_run` | Start an AI run (alternative to REST `POST /ai/runs`) |
| S→C | `server.ai_run_token` | Streaming token chunk for a run |
| S→C | `server.ai_run_tool_call` | Run is invoking a tool |
| S→C | `server.ai_run_tool_result` | Tool result observed |
| S→C | `server.ai_run_complete` | Run finished successfully |
| S→C | `server.ai_run_error` | Run failed (typed) |
| C→S | `client.ai_ack` | Backpressure ack: "I have processed up to chunk N" |
| S→C | `server.error` | Typed error envelope (see §9) |
| S→C | `server.pause` | Server is asking client to slow down (rate limit / load shedding) |

### 4.4 Frame examples

**`client.hello`**

```json
{
  "v": 1, "id": "...", "type": "client.hello",
  "payload": {
    "protocol": "qale-rt/1",
    "client": { "name": "qale-web", "version": "1.42.0" },
    "deviceId": "dev_01HF4...",
    "lastSequences": {
      "th_01HF4ZA8B7CD3E1FXZK": 18342,
      "th_01HF4ZC...": 901
    },
    "capabilities": ["compress:permessage-deflate","ai-stream:v1"]
  }
}
```

**`server.welcome_complete`**

```json
{
  "v": 1, "id": "...", "type": "server.welcome_complete",
  "payload": {
    "sessionId": "sess_01HF4...",
    "serverTime": "2026-05-12T14:05:00.500Z",
    "missedEvents": {
      "th_01HF4ZA8B7CD3E1FXZK": { "from": 18343, "to": 18351, "willReplay": true }
    },
    "resumeToken": "rt_eyJzZXNzaW9uIjoiLi4uIn0",
    "limits": { "maxFrameBytes": 65536, "maxInflight": 256 }
  }
}
```

**`client.send_message` (alternative to REST)**

```json
{
  "v": 1, "id": "...", "type": "client.send_message",
  "payload": {
    "threadId": "th_01HF4ZA8B7CD3E1FXZK",
    "clientMessageId": "0190f3a7-4111-7000-a000-000000000001",
    "idempotencyKey": "0190f3a7-3f1b-7c9a-8b2d-7e6c1d4a9f02",
    "type": "text",
    "body": { "text": "Can you summarize the thread above?" }
  }
}
```

**`server.message_ack`**

```json
{
  "v": 1, "id": "...", "type": "server.message_ack",
  "payload": {
    "clientMessageId": "0190f3a7-4111-7000-a000-000000000001",
    "messageId": "msg_01HF4ZC1D2E3F4G5HJK",
    "threadId": "th_01HF4ZA8B7CD3E1FXZK",
    "sequence": 18342,
    "createdAt": "2026-05-12T14:05:01.092Z"
  }
}
```

**`server.message_event`**

```json
{
  "v": 1, "id": "...", "type": "server.message_event",
  "payload": {
    "kind": "created",
    "threadId": "th_01HF4ZA8B7CD3E1FXZK",
    "sequence": 18343,
    "message": {
      "messageId": "msg_01HF4ZC1D2E3F4G5HJK",
      "authorId": "usr_01HF...B2",
      "type": "text",
      "body": { "text": "Sure, summarizing now." },
      "createdAt": "2026-05-12T14:05:02.142Z"
    }
  }
}
```

`kind` ∈ `created | edited | deleted | reaction_added | reaction_removed | tombstone_reaped`.

**`server.ai_run_token`** (anchor A-BB4)

```json
{
  "v": 1, "id": "...", "type": "server.ai_run_token",
  "payload": {
    "runId": "run_01HF4ZD7E8F9G0H1JKL",
    "chunkSeq": 42,
    "delta": "...the launch checklist has 8 open items, the riskiest of which is",
    "finishReason": null,
    "metadata": {
      "model": "claude-sonnet-4.5",
      "providerLatencyMs": 31,
      "tokensIn": 0,
      "tokensOut": 14
    }
  }
}
```

**`server.ai_run_tool_call`**

```json
{
  "v": 1, "id": "...", "type": "server.ai_run_tool_call",
  "payload": {
    "runId": "run_01HF4ZD7E8F9G0H1JKL",
    "stepId": "step_07",
    "tool": "search.workspace",
    "input": { "query": "Q3 launch open items", "limit": 5 },
    "policyDecision": "allow"
  }
}
```

**`client.ai_ack`** (backpressure, anchor A-BB3)

```json
{
  "v": 1, "id": "...", "type": "client.ai_ack",
  "payload": { "runId": "run_01HF4ZD7E8F9G0H1JKL", "throughChunk": 40 }
}
```

**`server.ai_run_complete`**

```json
{
  "v": 1, "id": "...", "type": "server.ai_run_complete",
  "payload": {
    "runId": "run_01HF4ZD7E8F9G0H1JKL",
    "status": "succeeded",
    "totalChunks": 71,
    "finishReason": "stop",
    "usage": {
      "model": "claude-sonnet-4.5",
      "tokensIn": 3142,
      "tokensOut": 814,
      "toolCalls": 3,
      "wallMs": 4321,
      "estCostUsd": 0.0182
    },
    "outputMessageId": "msg_01HF4ZF...",
    "traceId": "tr_4f3a..."
  }
}
```

**`server.error`** — see §9 for the envelope.

### 4.5 Ordering and delivery guarantees

| Property | Guarantee |
| --- | --- |
| Per-thread message order | **Total order** by server-assigned `sequence`. Strictly monotonic, gap-free per thread. |
| Per-run AI chunk order | **Total order** by `chunkSeq` within a `runId`. Strictly monotonic, gap-free. |
| Cross-thread order | **No guarantee.** Clients merge by client-side recency. |
| Delivery | At-least-once over the WS. Clients dedupe by `messageId` (server) and `clientMessageId` (own writes). |
| Resume window | 30s of in-memory replay; older gaps forced to a REST history fetch. |
| Ack window | Server keeps up to **256 unacked frames** per session. Beyond that, server emits `server.pause` and stops sending until the client acks. |

This ordering model is the same shape as the per-instance ordered streams I worked on for TunDRA (A-MS1): per-stream total order, no cross-stream order, and a small ack window to bound server memory.

### 4.6 Dedup

- Messages: `clientMessageId` (UUID v7, generated on the client) is propagated all the way through the system. The first time the server sees it (within a 24h window), the message is committed; subsequent occurrences (e.g., client retried a `send_message` after a network blip) are **silently mapped** to the same `messageId` and re-acked.
- AI runs: `Idempotency-Key` on REST start; on the WS path, `client.ai_run` carries `idempotencyKey` for the same effect.

---

## 5. Internal gRPC contracts

Internal services speak gRPC over HTTP/2 with mTLS. Protos live in a single shared monorepo path `proto/qale/...`. Below is just enough proto to show the boundaries — the canonical files live in code, not in this doc.

### 5.1 MessageService

```proto
syntax = "proto3";
package qale.message.v1;

import "google/protobuf/timestamp.proto";

service MessageService {
  rpc Send(SendRequest) returns (SendResponse);
  rpc GetThreadMessages(GetThreadMessagesRequest) returns (GetThreadMessagesResponse);
  rpc Edit(EditRequest) returns (EditResponse);
  rpc Delete(DeleteRequest) returns (DeleteResponse);
}

message SendRequest {
  string workspace_id      = 1;
  string thread_id         = 2;
  string author_id         = 3;
  string client_message_id = 4;  // dedup
  string idempotency_key   = 5;  // gateway-enforced; relayed for trace
  MessageBody body         = 6;
  repeated string attachment_upload_ids = 7;
  string reply_to_message_id = 8;
}

message SendResponse {
  string message_id = 1;
  uint64 sequence   = 2;          // per-thread monotonic
  google.protobuf.Timestamp created_at = 3;
  bool   deduped    = 4;          // true if this was an idempotent retry
}

message GetThreadMessagesRequest {
  string workspace_id = 1;
  string thread_id    = 2;
  string cursor       = 3;        // opaque
  uint32 limit        = 4;
  Direction direction = 5;
  enum Direction { BACKWARD = 0; FORWARD = 1; }
}

message GetThreadMessagesResponse {
  repeated Message items = 1;
  string next_cursor = 2;
  string prev_cursor = 3;
  bool has_more = 4;
}

message EditRequest {
  string workspace_id = 1;
  string message_id   = 2;
  string editor_id    = 3;
  MessageBody new_body = 4;
  string if_match_etag = 5;
}

message EditResponse {
  Message message = 1;
}

message DeleteRequest {
  string workspace_id = 1;
  string message_id   = 2;
  string deleter_id   = 3;
  string if_match_etag = 4;
  bool   hard         = 5;        // false = tombstone, true = GDPR hard delete
}

message DeleteResponse {
  google.protobuf.Timestamp deleted_at = 1;
}

message MessageBody {
  string mime = 1;                // "text/plain", "text/markdown", etc.
  string text = 2;
  bytes  rich = 3;                // optional rich-content blob
  repeated Mention mentions = 4;
}

message Mention {
  string user_id = 1;
  uint32 offset  = 2;
  uint32 length  = 3;
}

message Message {
  string message_id   = 1;
  string thread_id    = 2;
  string workspace_id = 3;
  uint64 sequence     = 4;
  string author_id    = 5;
  MessageBody body    = 6;
  google.protobuf.Timestamp created_at = 7;
  google.protobuf.Timestamp edited_at  = 8;
  bool   deleted      = 9;
  string etag         = 10;
}
```

### 5.2 AIOrchestratorService (anchors A-BB3, A-BB4)

```proto
syntax = "proto3";
package qale.ai.v1;

service AIOrchestratorService {
  rpc StartRun(StartRunRequest) returns (StartRunResponse);
  rpc StreamRun(StreamRunRequest) returns (stream RunEvent);
  rpc Cancel(CancelRequest) returns (CancelResponse);
  rpc GetRun(GetRunRequest) returns (RunRecord);
}

message StartRunRequest {
  string workspace_id    = 1;
  string user_id         = 2;
  string thread_id       = 3;
  string idempotency_key = 4;
  string intent          = 5;          // e.g. "summarize_thread"
  bytes  input_json      = 6;          // intent-specific payload
  repeated string tool_ids = 7;
  ModelHint model_hint   = 8;
  Budget budget          = 9;
  enum ModelHint { AUTO = 0; FAST = 1; REASONING = 2; CHEAP = 3; }
}

message StartRunResponse {
  string run_id = 1;
  RunStatus status = 2;
  bool deduped = 3;
}

message StreamRunRequest {
  string run_id = 1;
  uint64 from_chunk = 2;               // resume support
}

message RunEvent {
  string run_id = 1;
  uint64 chunk_seq = 2;
  oneof body {
    TokenDelta token = 3;
    ToolCall   tool_call = 4;
    ToolResult tool_result = 5;
    Completed  completed = 6;
    Failed     failed = 7;
  }
}

message TokenDelta { string delta = 1; string model = 2; uint32 tokens_out = 3; }
message ToolCall   { string step_id = 1; string tool = 2; bytes input_json = 3; string policy_decision = 4; }
message ToolResult { string step_id = 1; bytes output_json = 2; uint32 latency_ms = 3; }
message Completed  { Usage usage = 1; string output_message_id = 2; string trace_id = 3; }
message Failed     { string code = 1; string message = 2; bool retryable = 3; string trace_id = 4; }

enum RunStatus { QUEUED = 0; RUNNING = 1; SUCCEEDED = 2; FAILED = 3; CANCELLED = 4; PARTIALLY_COMMITTED = 5; }

message Budget { uint32 max_tokens = 1; uint32 max_tool_calls = 2; uint32 max_wall_seconds = 3; }
message Usage  { string model = 1; uint32 tokens_in = 2; uint32 tokens_out = 3; uint32 tool_calls = 4; uint32 wall_ms = 5; double est_cost_usd = 6; }

message CancelRequest  { string run_id = 1; string reason = 2; }
message CancelResponse { RunStatus status = 1; }
message GetRunRequest  { string run_id = 1; }
message RunRecord      { string run_id = 1; RunStatus status = 2; Usage usage = 3; google.protobuf.Timestamp created_at = 4; google.protobuf.Timestamp completed_at = 5; }
```

`StreamRun` lets the gateway re-attach to a run after a client reconnect (the `from_chunk` parameter). The orchestrator persists chunks in a short-lived ring (Redis Streams or Kafka with short retention) so reconnects within the resume window get a perfect replay (A-BB3, A-BB5).

### 5.3 PresenceService

```proto
syntax = "proto3";
package qale.presence.v1;

service PresenceService {
  rpc Heartbeat(HeartbeatRequest) returns (HeartbeatResponse);
  rpc Subscribe(SubscribeRequest) returns (stream PresenceEvent);
  rpc GetPresence(GetPresenceRequest) returns (GetPresenceResponse);
}

message HeartbeatRequest {
  string workspace_id = 1;
  string user_id = 2;
  string device_id = 3;
  PresenceState state = 4;
  string custom_status = 5;
}

message HeartbeatResponse { uint32 next_heartbeat_seconds = 1; }

message SubscribeRequest {
  string workspace_id = 1;
  string subscriber_id = 2;
  repeated string user_ids = 3;
}

message PresenceEvent {
  string user_id = 1;
  PresenceState state = 2;
  google.protobuf.Timestamp updated_at = 3;
  string custom_status = 4;
}

message GetPresenceRequest  { string workspace_id = 1; repeated string user_ids = 2; }
message GetPresenceResponse { repeated PresenceEvent items = 1; }

enum PresenceState { OFFLINE = 0; ACTIVE = 1; AWAY = 2; DND = 3; INVISIBLE = 4; }
```

### 5.4 Other internal services (sketched)

| Service | Purpose | Key RPCs |
| --- | --- | --- |
| `ThreadService` | Thread CRUD, membership, ACL | `Create`, `Get`, `AddMember`, `RemoveMember`, `ListForUser` |
| `FanoutService` | Fanout to gateways, per-shard | `Publish`, `RegisterGateway`, `Broadcast` |
| `NotificationService` | Push/email digest | `Enqueue`, `RegisterDevice`, `Suppress` |
| `SearchService` | Hybrid query, ACL filter | `Query`, `Index`, `Reindex` |
| `UploadService` | Signed URLs, AV scan | `IssueUploadUrl`, `MarkUploaded`, `GetMetadata` |
| `BillingService` | Token / seat metering | `RecordUsage`, `GetQuota`, `EnforceBudget` |
| `AuditService` | SOC-2 audit log | `Append`, `Query` |

---

## 6. Idempotency model

Anchor: this is the same idempotency pattern I had to build for AI tool calls at BlackBox (A-BB3) — agents that retry a side-effect-bearing tool must not double-charge or double-send.

### 6.1 Where idempotency is required

| Operation | Required? | Key |
| --- | --- | --- |
| `POST /v1/threads/{tid}/messages` | Required | `Idempotency-Key` |
| `POST /v1/threads/{tid}/ai/runs` | Required | `Idempotency-Key` |
| `POST /v1/uploads` | Required | `Idempotency-Key` |
| `POST /v1/workspaces/{wsId}/threads` | Recommended | `Idempotency-Key` |
| `POST /v1/workspaces/{wsId}/invites` | Required | `Idempotency-Key` (and dedup also enforced on email) |
| `POST /v1/messages/{mid}/reactions` | Auto-idempotent | dedup on (userId, mid, emoji) |
| `PATCH` and `DELETE` | Not used | use `If-Match` etag for concurrency |
| `GET` | N/A | safe & idempotent by definition |

### 6.2 Semantics

- Key shape: `Idempotency-Key: <UUID v7>`. Server validates the format. Non-UUID-v7 → `400 IDEMPOTENCY_KEY_MALFORMED`.
- Scope: `(userId, idempotencyKey)`. Same key from two different users is independent; same user reusing a key is deduped.
- Storage: Redis-backed write-through cache (`idem:{userId}:{key}` → `{requestHash, statusCode, responseBody, expiresAt}`), TTL **24h**. Promoted to Postgres only for the small set of operations that need a longer audit trail (financial, admin).
- Behavior:
  - **Same key + same body hash** → return the original response, status `200`/`201`. Header `X-Qale-Idempotent-Replay: true`.
  - **Same key + different body hash** → `409 IDEMPOTENCY_CONFLICT` with the original `requestHash` in the `details`.
  - **In-flight request with same key** → second request blocks for up to 5s on the in-flight result; if it completes, replay; if it doesn't, `503 IDEMPOTENCY_IN_FLIGHT` with `Retry-After`.
- Body hash: SHA-256 of canonical JSON (sorted keys, no insignificant whitespace) of the request body.

### 6.3 Why client-generated, not server-generated

Server-generated keys would force a two-trip protocol (`POST` to allocate a key, then `POST` with the key) which doubles latency. Client-generated UUID v7s give us:

- A monotonic-ish key that's friendly to Redis hot sharding.
- A stable retry token across network failures (the client retries with the *same* key).
- A built-in correlation ID for tracing.

### 6.4 Idempotency for AI runs specifically

`POST /v1/threads/{tid}/ai/runs` is the most expensive idempotent operation. A user mashing the "Summarize" button must not cost us five LLM calls. Body-hash equivalence here is loose: we hash `(intent, input, tools, modelHint, budget)` — small differences in `metadata` are ignored. This was the same shape of dedup I built into the BlackBox model router (A-BB4) — at 1B+ tokens/month, even single-digit % of duplicate runs are meaningful money.

---

## 7. Pagination model

**Stance: cursor-based, opaque, server-defined limits, no offsets, anywhere in the platform.**

Why no offset:

- Offset pagination breaks under concurrent inserts (the most common case for a chat product — new messages arrive constantly).
- Offset pagination forces the database to scan-and-skip, which gets pathologically expensive past the first few pages.
- Offset pagination gives a false "page count" affordance that we don't actually need.

Cursor contract:

- Cursors are **opaque base64-encoded JSON**. Clients **must not** parse, log, or store them beyond a single session.
- Cursors are valid for at least 1 hour. Older cursors may return `410 CURSOR_EXPIRED`.
- The server determines `limit`. Clients may *suggest* a limit; the server clamps and returns `X-Qale-Limit-Clamped: true` if it did.
- For per-thread message lists, the cursor is `{ "seq": <int> }` (today). For search, it's `{ "scrollId": "...", "seq": <int> }`. The opacity lets us evolve this without breaking clients.
- Bidirectional pagination uses `direction=backward|forward`. Both `nextCursor` and `prevCursor` may be returned where it makes sense.

The natural sort key for thread messages is the **server-assigned per-thread monotonic sequence**, not `createdAt`. Clock skew across DB writers and clock drift across client devices both make `createdAt` pagination dangerous. Sequence is the source of truth; `createdAt` is for display.

---

## 8. Streaming AI responses

Anchors: A-BB3 (DAG agent runtime), A-BB4 (model router), A-BB5 (deterministic replay).

### 8.1 Transport choice

Default transport: **the existing client WebSocket**. We chose this over a per-run SSE stream for three reasons:

1. The client already has a WebSocket open for messaging. Opening a second per-run SSE connection doubles the connection-plane cost.
2. WS supports backpressure (the `client.ai_ack` frame); browser-native SSE does not have a clean ack channel.
3. The same gateway can multiplex AI tokens, message events, presence, and typing on one socket, which is friendlier to mobile networks and corporate proxies.

Fallback transport: **SSE** at `GET /v1/threads/{tid}/ai/runs/{runId}/stream`. This is for restrictive networks (corporate proxies that strip WS, environments behind transparent HTTP/1.1 proxies). The SSE event format mirrors the WS frame `payload`:

```
event: ai_run_token
data: {"runId":"run_01HF...","chunkSeq":42,"delta":"...","metadata":{...}}

event: ai_run_complete
data: {"runId":"run_01HF...","status":"succeeded","usage":{...}}
```

We **do not** support a third transport. Multiple transports = multiple bug surfaces.

### 8.2 Run-scoped sequence numbers

Each `runId` carries its own `chunkSeq`, monotonic and gap-free. Clients dedupe by `(runId, chunkSeq)`. If the WS reconnects mid-run, the client sends `client.resume` and the gateway re-attaches via `AIOrchestratorService.StreamRun(from_chunk=<lastSeen+1>)`. The orchestrator persists each chunk to a short-retention ring (24h) keyed by `runId`, so this replay is cheap and correct.

This is the same chunk-replay pattern I institutionalized in the BlackBox telemetry mesh for deterministic replay (A-BB5): the chunk is the unit of replay, and every chunk has a sequence number so we can detect gaps unambiguously.

### 8.3 Backpressure

- Client ACKs every **N=16 chunks** (configurable in `client.hello`).
- Server keeps a window of **W=64 chunks** outstanding per run.
- When window fills, the server pauses generation:
  - For provider-streamed models: stops draining the upstream token stream (the upstream may buffer a small amount, then start applying its own backpressure to us).
  - For locally-batched generators: pauses the batch loop.
- If the client hasn't ACKed within **5s** of a paused state, the server emits `server.pause` with a reason and stops sending. After **30s** of no progress, the run is auto-cancelled with `AI_CLIENT_UNRESPONSIVE` and the partial output is committed as a draft message rather than a final one.

This matters at the BlackBox scale (1B+ tokens/month, A-BB4): without an ACK window, a single slow client can keep an upstream stream open and hold a model slot unproductively, which directly burns money and blocks other tenants.

### 8.4 Tool calls in the stream

Tool calls (`server.ai_run_tool_call`) and their results (`server.ai_run_tool_result`) are interleaved with token deltas. Clients render them as inline structured blocks ("Searching workspace…", "Read 5 results"). The structured form is preserved in the persisted output message so the audit log shows exactly which tools ran with which inputs — required for SOC-2 (A-BB1).

### 8.5 Cancellation in the stream

`POST .../runs/{runId}/cancel` triggers the orchestrator to stop the upstream generation, run the DAG's cleanup nodes (e.g. close any in-flight tool transactions that support cancellation), and emit a final `server.ai_run_complete` with `status: cancelled` (or `partially_committed`). The client will not see further `server.ai_run_token` frames after that complete event.

---

## 9. Error model

### 9.1 Envelope

Every error response — REST, WS, gRPC — uses the same envelope.

REST/JSON:

```json
{
  "error": {
    "code": "AI_BUDGET_EXCEEDED",
    "message": "Run exceeded the workspace token budget for this hour.",
    "retryable": false,
    "traceId": "tr_4f3a9e1b8c7d6e5f",
    "details": {
      "budget": { "maxTokens": 8000 },
      "used":   { "tokens": 8214 }
    }
  }
}
```

WebSocket `server.error`:

```json
{
  "v": 1, "id": "...", "type": "server.error",
  "payload": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many send_message calls; slow down.",
    "retryable": true,
    "traceId": "tr_8d2e7c1a3b4f5e6d",
    "details": { "retryAfterMs": 1500, "limit": 10, "windowSec": 1 },
    "correlatedFrameId": "0190f3a7-7000-7000-c000-000000000001"
  }
}
```

gRPC: errors return a standard `google.rpc.Status` with `code` mapped, plus a `qale.errors.v1.ErrorDetail` in `details` carrying the same fields.

### 9.2 Canonical error codes

| Code | HTTP | Retryable | Meaning |
| --- | --- | --- | --- |
| `AUTH_MISSING` | 401 | No | No credential presented |
| `AUTH_INVALID` | 401 | No | Token signature/issuer/audience invalid |
| `AUTH_EXPIRED` | 401 | Yes (after refresh) | Access token expired |
| `AUTH_REFRESH_REUSED` | 401 | No | Refresh token reuse detected; all sessions invalidated |
| `AUTH_WORKSPACE_MISMATCH` | 403 | No | Token's wsid does not match request wsid |
| `AUTH_FORBIDDEN` | 403 | No | Subject lacks scope/role for action |
| `RESOURCE_NOT_FOUND` | 404 | No | Resource does not exist or is not visible to subject |
| `VALIDATION_FAILED` | 400 | No | Schema or field-level validation error (with `details.fields`) |
| `IDEMPOTENCY_KEY_MALFORMED` | 400 | No | Key not a UUID v7 |
| `IDEMPOTENCY_CONFLICT` | 409 | No | Same key, different body |
| `IDEMPOTENCY_IN_FLIGHT` | 503 | Yes | Concurrent retry on same key still in progress |
| `CONFLICT_PRECONDITION` | 412 | No | `If-Match` etag mismatch |
| `CONFLICT_VERSION` | 409 | No | Optimistic concurrency conflict |
| `RATE_LIMIT_EXCEEDED` | 429 | Yes | Per-user/workspace bucket exhausted (`details.retryAfterMs`) |
| `RATE_LIMIT_TIER_DEGRADED` | 429 | Yes | Workspace plan does not include this surface at this rate |
| `QUOTA_WORKSPACE_SEATS_EXCEEDED` | 402 | No | Add seats to continue |
| `AI_BUDGET_EXCEEDED` | 402 | No | Workspace token budget exhausted |
| `AI_PROVIDER_DEGRADED` | 503 | Yes | Routed model is degraded; router will reroute on retry |
| `AI_PROVIDER_TIMEOUT` | 504 | Yes | Upstream model timed out |
| `AI_CONTEXT_TOO_LONG` | 413 | No | Selected context exceeds the resolved model's window |
| `AI_TOOL_DENIED` | 403 | No | Policy gate blocked a tool call |
| `AI_CLIENT_UNRESPONSIVE` | n/a (WS) | No | Run cancelled because client stopped acking |
| `AI_RUN_NOT_FOUND` | 404 | No | Run id does not exist or is outside replay window |
| `AI_BUDGET_NEAR_LIMIT` | n/a (warning) | n/a | Soft warning event, not a failure |
| `WS_RESUME_EXPIRED` | n/a (WS) | No | Resume token outside the replay window; client must re-fetch history |
| `WS_FRAME_TOO_LARGE` | n/a (WS) | No | Frame exceeds negotiated `maxFrameBytes` |
| `WS_PROTOCOL_VIOLATION` | n/a (WS) | No | Bad frame; connection will be closed |
| `INTERNAL_ERROR` | 500 | Yes | Unhandled server error; trace id required |
| `INTERNAL_DEPENDENCY_DEGRADED` | 503 | Yes | Downstream service degraded; circuit breaker open |

Client guidance:

- `retryable: true` → exponential backoff with full jitter, max 5 attempts. If `details.retryAfterMs` is present, honor it.
- `retryable: false` → do **not** retry; surface or recover differently.
- `traceId` is always present, including on `400`/`401` errors. It's the correlation handle for support tickets and the entry point into the deterministic replay path (A-BB5).

### 9.3 Validation error shape

`VALIDATION_FAILED` carries a structured field map:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request body failed validation.",
    "retryable": false,
    "traceId": "tr_...",
    "details": {
      "fields": [
        { "path": "/body/text", "code": "TOO_LONG", "limit": 32000 },
        { "path": "/attachments/0/uploadId", "code": "NOT_FOUND" }
      ]
    }
  }
}
```

This makes form-level error rendering on the React client trivial.

---

## 10. Versioning

### 10.1 REST

- **URL-major**: `/v1/...`. We will introduce `/v2/` only when we have to make a breaking change. We expect not to for at least 18 months.
- **Additive evolution within `/v1/`**: new fields, new endpoints, new optional headers are not breaking. Removing or renaming fields, narrowing types, or changing semantics is breaking.
- **Deprecation**: deprecated endpoints/fields return `Deprecation: true` and a `Sunset: <RFC 7231 date>` header. Sunset is at minimum 6 months out. The deprecation is also published in the developer changelog.
- Clients **must** ignore unknown fields in responses. SDKs are tested against a "future fields" fixture in CI to catch parsers that explode on extra keys.

### 10.2 WebSocket

- Protocol version negotiated in `client.hello.payload.protocol`. Server picks the highest mutually supported version.
- New frame types are additive and tagged with the version they were introduced in. Clients silently ignore unknown frame types.
- We will not re-use frame type names for different shapes. `client.send_message` shape is frozen in v1; v2 would be `client.send_message_v2` if we ever need to.

### 10.3 gRPC

- Proto package versioning: `qale.message.v1`. New version = new package. Old packages are kept until all callers have migrated.
- Field numbers are never reused. Removed fields are reserved.

### 10.4 Webhooks

- Webhook payload schema is versioned per event type: `{"type":"thread.message.created","schema":1, ...}`. We can publish both `schema:1` and `schema:2` in parallel during migrations.

---

## 11. Rate limiting and quotas

### 11.1 Buckets

We run separate token buckets per dimension and the most restrictive one wins.

| Class | Default limit | Bucket dimension |
| --- | --- | --- |
| `rest.read` | 60 req/sec | per user |
| `rest.write` | 10 req/sec | per user |
| `rest.search` | 5 req/sec | per user |
| `rest.upload.issue` | 5 req/sec | per user |
| `ws.send_message` | 10 msg/sec sustained, 20 burst | per user |
| `ws.typing` | 5 events/sec | per user |
| `ai.run.start` | 30 runs/min | per user, with workspace ceiling |
| `ai.run.start.workspace` | 600 runs/min | per workspace (plan-dependent) |
| `ai.tokens` | plan-dependent | per workspace per hour |
| `webhooks.outbound` | 50/sec | per workspace |

### 11.2 Algorithm

- **Token bucket** with Redis Lua. The Lua script is the source of truth; each refill is computed from `(now - lastRefill) * refillRate`.
- We choose token bucket over leaky bucket for the same reason a chat product wants it: bursty user behavior (paste a long thread, send 5 messages in a row) is fine, sustained abuse is not.
- Buckets are tagged by class so we can change limits per plan tier without touching code.
- Per-region: each region runs an independent bucket. We do **not** centralize rate limits cross-region. The downside (slightly looser global limits) is much cheaper than the upside (no cross-region critical-path call on every request).

### 11.3 Headers

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 41
X-RateLimit-Reset: 1762958461
X-RateLimit-Class: rest.read
```

On `429`, additionally:

```
Retry-After: 2
```

### 11.4 AI quotas

AI quotas are **plan-bound** and live in the `BillingService`:

- Per-workspace per-month token cap.
- Per-workspace per-hour soft warning threshold (publishes `AI_BUDGET_NEAR_LIMIT` event to admins).
- Per-user per-day cap (configurable by workspace admin).
- Per-run hard cap from the `budget` field on `POST /ai/runs`.

When any cap is exceeded, the run fails fast with `AI_BUDGET_EXCEEDED`. This is a direct lift of the budget enforcer pattern from the BlackBox model router (A-BB4) — at 1B+ tokens/month, a workspace going haywire (an agent in a tool-call loop) will quietly cost five figures in an afternoon if there's no enforcer.

### 11.5 Load shedding

When a region or service is over capacity, we shed load by **class**, in this order:

1. `rest.search`
2. `ws.typing`
3. `rest.read` of historical data
4. `ai.run.start` with `modelHint=reasoning` (most expensive)
5. `ai.run.start` (any)
6. `ws.send_message` and `rest.write` (last)

A shed request gets `503 INTERNAL_DEPENDENCY_DEGRADED` with `Retry-After`. We **never** shed message sends or writes ahead of reads — the unit of trust in a chat product is "can my message get through?" If that breaks, the product is broken.

---

## 12. Outbound webhooks

For enterprise integrations: connect Qale events to Jira, ServiceNow, Linear, custom internal systems.

### 12.1 Configuration

```
POST /v1/workspaces/{wsId}/webhooks
Content-Type: application/json

{
  "url": "https://example.com/qale-webhook",
  "events": ["thread.message.created", "ai.run.completed"],
  "secret": "whsec_<server-rotated>",
  "active": true,
  "filter": { "threadIds": ["th_..."] }
}
```

### 12.2 Delivery

```
POST https://example.com/qale-webhook
Content-Type: application/json
X-Qale-Event: thread.message.created
X-Qale-Delivery-Id: dlv_01HF4ZG...
X-Qale-Timestamp: 1762958461
X-Qale-Signature: t=1762958461,v1=4f3a9e1b8c7d...

{
  "id": "evt_01HF4ZH...",
  "type": "thread.message.created",
  "schema": 1,
  "createdAt": "2026-05-12T14:11:01.092Z",
  "workspaceId": "ws_01HF4Z7N9P3K8XQ2YJV",
  "data": {
    "threadId": "th_01HF4ZA8B7CD3E1FXZK",
    "messageId": "msg_01HF4ZC1D2E3F4G5HJK",
    "authorId": "usr_01HF...A1",
    "sequence": 18342,
    "preview": "Can you summarize the thread above?"
  }
}
```

Signature: `v1 = HMAC_SHA256(secret, timestamp + "." + body)`. Receivers verify and reject if `|now - timestamp| > 300s` to defeat replay.

### 12.3 Reliability

- **At-least-once** delivery. Receivers must dedupe by `X-Qale-Delivery-Id`.
- Retry policy: exponential backoff with full jitter, retries at 0, 30s, 2m, 10m, 1h, 6h, 24h. After 24h of failures, the webhook endpoint is auto-disabled and the workspace admin gets a notification.
- HTTP `2xx` is success. `4xx` (except `408`, `429`) stops the retry chain — there's no point retrying a request the server says is malformed.
- `Replay endpoint`: `POST /v1/workspaces/{wsId}/webhooks/{whId}/deliveries/{dlvId}/replay`. Admin-only.
- A delivery log (`GET /v1/workspaces/{wsId}/webhooks/{whId}/deliveries`) shows the last 30 days of attempts with status codes, latencies, and response bodies (truncated).

### 12.4 Event catalog (subset)

| Event type | Payload |
| --- | --- |
| `thread.created` | `threadId`, `kind`, `createdBy` |
| `thread.archived` | `threadId`, `archivedBy` |
| `thread.message.created` | `threadId`, `messageId`, `authorId`, `sequence`, `preview` |
| `thread.message.edited` | `threadId`, `messageId`, `editedBy`, `editedAt` |
| `thread.message.deleted` | `threadId`, `messageId`, `deletedBy`, `hard` |
| `ai.run.started` | `runId`, `intent`, `userId`, `threadId` |
| `ai.run.completed` | `runId`, `status`, `usage`, `outputMessageId` |
| `ai.run.failed` | `runId`, `errorCode`, `traceId` |
| `workspace.member.added` | `workspaceId`, `userId`, `role` |
| `workspace.member.removed` | `workspaceId`, `userId` |
| `audit.event` | Full audit row (admin webhooks only) |

---

## 13. Open questions for the team (settle in week 1)

These are decisions I deliberately did **not** make in this doc. I want them on the table at the first architecture review.

1. **GraphQL vs REST for the read API.** The control plane is mostly resource-shaped, which fits REST; but a thread-list-with-unread-counts-and-latest-message-and-presence endpoint is the kind of thing GraphQL is good at, and the React client will want exactly that. Proposal: stay REST + add a small set of `/v1/views/...` composite endpoints. Decision needed by end of week 1.

2. **Binary framing on the WebSocket.** JSON is fine through Public Launch. At 1M concurrent sockets we will start to see the cost of JSON framing on both sides. Candidates: CBOR (drop-in), protobuf (best size, worst dx), MessagePack. Proposal: instrument bytes-per-frame and CPU-on-encode at Public Launch, decide then. Don't pre-optimize.

3. **REST writes vs WS-only writes.** We currently support both `POST /v1/threads/{tid}/messages` *and* `client.send_message`. This is two code paths, two test surfaces, two trace shapes. Proposal: REST is the contract for integrations and SDKs; WS is for the first-party client. Internal services share a single MessageService.Send. But the team should explicitly agree.

4. **Multi-region active-active vs active-passive at Public Launch.** Active-active for the connection plane is straightforward. Active-active for writes (per-thread sequence assignment) is a hard problem and would require either single-writer-per-thread with shard ownership or CRDT-style merging. Proposal: single-writer-per-thread (workspace pinned to one home region; cross-region failover, not concurrent write). Decision needed before the SOC-2 architecture sign-off.

5. **AI run output as a message vs as a separate object.** Today `ai.run.completed` writes a real message into the thread (`outputMessageId`). The alternative is a "run record" attached to the thread. Messages give us fanout and search for free; run records give us cleaner audit and easier deletion. Proposal: messages, with `metadata.aiRunId` and a structured renderer. Re-evaluate after first 100 enterprise pilots.

---

## Appendix A — quick reference: required headers per surface

| Header | REST | WS upgrade | gRPC | Webhooks (outbound) |
| --- | :-: | :-: | :-: | :-: |
| `Authorization: Bearer <jwt>` | required | n/a (use upgrade token) | required (metadata) | n/a |
| `X-Qale-Workspace-Id` | required | embedded in upgrade token | required (metadata) | n/a |
| `X-Request-Id` | required | sent in `client.hello` | required (metadata) | mirrored as `X-Qale-Delivery-Id` |
| `Idempotency-Key` | required on side-effect POSTs | embedded in `client.send_message` | required (metadata) | n/a |
| `If-Match` | required on `PATCH`/`DELETE` | n/a | required on edit/delete RPCs | n/a |
| `X-Trace-Id` (response) | always | included in errors | always | always |
| `X-Qale-Signature` | n/a | n/a | n/a | required |

## Appendix B — example end-to-end flow: "user sends a message and asks AI to summarize"

1. Client `POST /v1/threads/{tid}/messages` with `Idempotency-Key: A`. Server returns `messageId`, `sequence: 18342`, `deliveryState: fanout_pending`.
2. Server publishes to bus → fanout shard → all subscribed gateways → all subscribed clients see `server.message_event { kind: created, sequence: 18342 }`. Original sender's WS sees `server.message_ack { clientMessageId, messageId, sequence: 18342 }`.
3. Client `POST /v1/threads/{tid}/ai/runs` with `Idempotency-Key: B`, intent `summarize_thread`, scope `{fromSequence: 18000, toSequence: 18342}`. Server returns `runId`, `status: queued`.
4. AI orchestrator picks up the run, model router resolves `modelHint:auto` → `claude-sonnet-4.5` (anchor A-BB4), DAG starts.
5. Stream over WS:
   - `server.ai_run_token { chunkSeq: 1, delta: "The thread covers..." }`
   - `server.ai_run_tool_call { stepId: 07, tool: "search.workspace", input: {...} }`
   - `server.ai_run_tool_result { stepId: 07, output: {...} }`
   - `server.ai_run_token { chunkSeq: 2..N, delta: "..." }`
   - Client `client.ai_ack { throughChunk: 16 }` periodically.
6. `server.ai_run_complete { status: succeeded, outputMessageId: msg_..., usage: {...}, traceId: tr_... }`.
7. The output message is itself a `server.message_event { kind: created, sequence: 18343 }`, fanned out the same way.
8. The whole thing is one trace, replayable end-to-end via the telemetry mesh (A-BB5). If anything failed, the `traceId` returned in the error envelope is the entry point.

That round trip is the contract the rest of this design pack has to keep stable.
