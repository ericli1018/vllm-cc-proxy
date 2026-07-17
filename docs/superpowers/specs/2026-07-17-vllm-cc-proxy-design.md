# vLLM Claude Code Proxy Design

## Goal

Build a standalone Node.js 22 reverse proxy that accepts Claude Code Anthropic Messages API traffic and forwards the same protocol to vLLM 0.23 without Anthropic/OpenAI format conversion. The proxy may inspect and minimally modify requests, buffer and validate Anthropic SSE responses, detect loops inside a single thinking block, recover once, preserve tool-call integrity, emit heartbeat ping events, and isolate thousands of concurrent requests.

## Protocol boundary

- Managed downstream path: Anthropic-compatible `POST /v1/messages`.
- Upstream managed path: the same `/v1/messages` path on vLLM.
- Proxy-local paths: `/health/live`, `/health/ready`, and `/metrics`.
- Every other method/path/query is forwarded as a raw byte stream to vLLM.
- No Anthropic-to-OpenAI conversion in the proxy.
- Requests retain `messages`, `system`, `tools`, `tool_choice`, `stop_sequences`, `metadata`, and `stream` unless a documented proxy policy applies.
- Transparent routes receive authentication replacement only; request and response protocol bytes are otherwise preserved.

## Request policy

- Preserve the incoming `model` value exactly; vLLM `--served-model-name` must match Claude Code.
- Preserve valid client-provided `temperature`, `top_p`, `top_k`, and `max_tokens`.
- Inject defaults only when absent.
- Do not inject OpenAI-only request fields into Anthropic `/v1/messages`.
- Replace the downstream API key with the upstream vLLM key.
- Keep the original request immutable and derive attempt-local request bodies using `structuredClone`.

## Buffered streaming and heartbeat

- Open downstream SSE after authentication and JSON validation.
- Emit Anthropic `ping` events on a configurable interval during initial generation, thinking buffering, tool-call buffering, recovery, and final serialization.
- All writes pass through one request-local FIFO writer with backpressure handling.
- Heartbeats never appear inside a content block write sequence.
- Once SSE starts, terminal failures use an Anthropic-compatible SSE `error` event.

## SSE parser and response model

The upstream stream is parsed into request-local attempt state:

- One message-start envelope.
- Ordered content blocks keyed by upstream index.
- Thinking blocks containing raw text and source offsets.
- Tool-use blocks containing ID, name, ordered `partial_json` chunks, and parsed input.
- Text and unknown complete blocks retained as structured events.
- Final message delta, stop reason, stop sequence, usage, and message-stop state.

The proxy never concatenates raw SSE from two attempts. It serializes one new valid Anthropic stream with one message ID and continuous block indexes.

## Thinking loop policy

Detection scope is one thinking content block within one generation attempt.

Detect:

- Repeated exact or normalized segments.
- A-B-A-B cycles.
- Correction phrases followed by effectively unchanged reasoning.
- Excessive thinking without tool-use or final text progress.

When a loop is found:

1. Identify the first repeated cycle and its original raw character boundary.
2. Retain the non-loop prefix plus one unique instance of the repeating cycle.
3. Cancel the first generation.
4. Discard all first-attempt text, tool-use, signatures, usage, and stop reason.
5. Run one recovery request derived from the immutable original request.
6. Merge the retained thinking prefix with recovery thinking and retain only recovery text/tool-use output.
7. Serialize a new legal stream.

An accidental upstream truncation is different: discard the entire first attempt and retry once without retaining partial thinking.

## Tool-call integrity

- Track tool calls by request ID, attempt number, and content-block index.
- Accumulate all `input_json_delta.partial_json` chunks in order.
- Do not expose a tool-use content block downstream before `content_block_stop` and successful `JSON.parse`.
- Support multiple tool-use blocks.
- Fail the attempt on missing IDs/names, mismatched indexes, duplicate conflicting starts, unclosed blocks, malformed JSON, or inconsistent `stop_reason`.
- A failed attempt never commits any tool call downstream.
- On successful serialization, each tool-use block is emitted as start, one complete JSON delta, and stop in one writer transaction.

## Recovery

Each request may recover once.

Recovery changes are request-local:

- Lower temperature to the configured recovery ceiling.
- Cap max tokens at the configured recovery maximum.
- Remove seed when configured.
- Append a one-time system instruction without including the failed thinking transcript.

Second failure emits an SSE error and ends the connection.

## Concurrency and isolation

- Every request owns one `RequestContext`, `SseWriter`, abort controller per attempt, parser state, detector state, buffers, counters, timeouts, and terminal state.
- No global mutable current request, tool call, thinking, writer, or abort controller.
- Global mutable state is limited to configuration, active request registry, aggregate counters, and a central heartbeat scheduler.
- Cleanup and terminal transitions are idempotent.
- Client disconnect cancels only that request and its recovery.
- Per-request and global byte limits prevent unbounded memory growth.
- Over-capacity requests fail before SSE with HTTP 503.
- The process is stateless beyond active connections and supports horizontal scaling.

## Lifecycle and observability

- `/health/live` reports process liveness.
- `/health/ready` fails while draining.
- `/metrics` exposes lightweight Prometheus-compatible counters and gauges.
- `SIGTERM` enters draining mode, rejects new generation requests, allows active requests to finish until a deadline, then aborts them.
- Structured logs contain request IDs and metadata only; prompts, thinking, tool arguments, tool results, and secrets are not logged.

## Verification scope

Automated tests use a deterministic mock vLLM server and cover:

- Request forwarding and sampling defaults.
- Count-token forwarding.
- Heartbeats during delayed generation.
- Text streams.
- Thinking streams.
- Same-block loop truncation plus one recovery.
- Unexpected truncation plus full recovery.
- Complete and fragmented tool-use JSON.
- Malformed and interrupted tool-use recovery.
- Multiple tool calls.
- Client cancellation isolation.
- Concurrent request isolation.
- Capacity limits.
- Graceful drain behavior.

The test suite does not prove compatibility with a specific Ornith model, chat template, reasoning parser, tool parser, DFlash configuration, or a live Claude Code/vLLM deployment.
