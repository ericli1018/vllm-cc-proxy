# vLLM Claude Code Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build and verify a standalone Node.js 22 Anthropic-protocol reverse proxy for Claude Code and vLLM with request sampling policy, buffered SSE validation, heartbeat, reasoning-loop recovery, complete tool calls, and high-concurrency request isolation.

**Architecture:** The HTTP server creates one request-local context per call. A same-protocol upstream client parses Anthropic SSE into an attempt result, a watchdog validates it, and a serializer emits one fresh Anthropic SSE stream through a request-local backpressure-aware writer while a global scheduler enqueues ping events. A failed attempt is never partially committed; the proxy retries once and returns only validated output.

**Tech Stack:** Node.js 22 ESM, built-in `node:http`, `fetch`, Web Streams, `AbortController`, `node:test`, Docker Compose YAML; no runtime npm dependencies.

## Global Constraints

- Do not modify CCR or vLLM source.
- Do not translate Anthropic Messages into OpenAI Chat Completions.
- Manage only `POST /v1/messages`; transparently forward every other non-local route.
- Default watchdog mode is buffered.
- Heartbeats use Anthropic `event: ping` and continue during thinking, tool-call buffering, and recovery.
- Tool-call arguments are emitted only after complete ordered assembly and successful JSON parsing.
- Loop detection applies only to one thinking block in one generation attempt.
- Preserve one unique cycle when truncating a detected loop.
- Each request may recover at most once.
- All request state is isolated and safe under thousands of concurrent connections.
- Node.js version floor is 22.
- Runtime dependencies are zero.

---

### Task 1: Project Contract and Configuration

**Files:**
- Create: `package.json`
- Create: `examples/environment.example`
- Create: `README.md`
- Test: `tests/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env)` and `applyRequestPolicy(body, config, { recoveryReason })` exported from `vllm-cc-proxy.js`.

- [x] Write failing tests for environment parsing, preserved client model names, preserved client sampling, injected defaults, rejected body size, and recovery overrides.
- [x] Run `node --test tests/config.test.js` and confirm failure because the module does not exist.
- [x] Implement the minimum configuration and request-policy functions.
- [x] Run the test and confirm it passes.

### Task 2: Anthropic SSE Parser and Serializer

**Files:**
- Create: `tests/sse.test.js`
- Create: `tests/fixtures/*.sse`
- Modify: `vllm-cc-proxy.js`

**Interfaces:**
- Produces: `AnthropicSseParser`, `validateAttempt(result, config)`, `serializeValidatedResponse(result, options)`.

- [x] Write failing tests for message ordering, thinking, signatures, fragmented tool JSON, multiple tool calls, unknown events, malformed blocks, missing message stop, and stop-reason consistency.
- [x] Run targeted tests and confirm expected failures.
- [x] Implement incremental SSE parsing, request-local block state, tool assembly, validation, and fresh stream serialization.
- [x] Run targeted and existing tests.

### Task 3: Loop Detector and Recovery Merge

**Files:**
- Create: `tests/loop-detector.test.js`
- Modify: `vllm-cc-proxy.js`

**Interfaces:**
- Produces: `detectThinkingLoop(text, config)` returning raw truncation boundary and reason; `mergeRecovery(firstAttempt, secondAttempt, loopInfo)`.

- [x] Write failing tests for exact repetition, normalized repetition, A-B-A-B, zero-delta correction, non-loop code/log text, one-cycle preservation, and accidental truncation behavior.
- [x] Run tests and verify red.
- [x] Implement bounded incremental-compatible detection and merge rules.
- [x] Run tests and verify green.

### Task 4: Request-local Writer, Heartbeat, and Cancellation

**Files:**
- Create: `tests/writer.test.js`
- Modify: `vllm-cc-proxy.js`

**Interfaces:**
- Produces: `SseWriter`, `HeartbeatScheduler`, and `RequestContext`.

- [x] Write failing tests for FIFO ordering, ping frames, atomic block transactions, backpressure, idempotent close, cancellation isolation, and scheduler cleanup.
- [x] Run tests and verify red.
- [x] Implement the writer, global scheduler, and request lifecycle.
- [x] Run tests and verify green.

### Task 5: Proxy Server and Fault-injection Integration

**Files:**
- Create: `tests/integration.test.js`
- Modify: `vllm-cc-proxy.js`

**Interfaces:**
- Produces: `createProxyServer(config)` and executable startup when run as the main module.

- [x] Write a mock vLLM server and failing integration tests for normal streams, heartbeat during delay, loop recovery, stream truncation recovery, tool-call recovery, count tokens, upstream errors, concurrent isolation, capacity rejection, and downstream cancellation.
- [x] Run tests and verify red.
- [x] Implement managed-message routing, transparent non-message forwarding, auth replacement, upstream fetch/abort/timeouts, one recovery, SSE errors, health, metrics, and draining.
- [x] Run integration and full tests.

### Task 6: Docker Deployment and Documentation

**Files:**
- Create: `docker-compose.partial.yaml`
- Modify: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/known-limitations.md`

**Interfaces:**
- Produces: deployable Compose fragment and Claude Code environment instructions.

- [x] Add deployment files with fixed Node 22 image, mounted proxy file, health check, limits, and vLLM network wiring.
- [x] Validate YAML syntax and shell snippets.
- [x] Document parameters, security, scaling, load balancer requirements, and limitations.

### Task 7: Verification and Packaging

**Files:**
- Create: `scripts/verify.sh`
- Create: `CHANGELOG.md`

**Interfaces:**
- Produces: repeatable verification command and ZIP artifact.

- [x] Run `node --check vllm-cc-proxy.js`.
- [x] Run the complete `node --test` suite.
- [x] Run concurrency and fault-injection tests repeatedly.
- [x] Parse Docker Compose YAML.
- [x] Review requirements against the design document.
- [x] Create a ZIP whose root directly contains the project files.
