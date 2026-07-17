# Architecture

## Data path

```text
Claude Code
  │ POST /v1/messages (Anthropic JSON)
  │ Anthropic SSE
  ▼
vllm-cc-proxy.js
  ├─ authentication replacement
  ├─ preserve model exactly; apply sampling policy only to POST /v1/messages
  ├─ request-local state machine
  ├─ central heartbeat scheduler
  ├─ buffered Anthropic SSE parser
  ├─ thinking-only loop detector
  ├─ complete tool-use assembler
  ├─ one internal recovery
  └─ clean Anthropic SSE serializer
  │ POST /v1/messages (Anthropic JSON)
  ▼
vLLM 0.23
  ▼
Ornith-1.0-35B-NVFP4
```

No Anthropic/OpenAI protocol conversion exists in this project. Proxy-local health／metrics endpoints are handled locally. Every non-`POST /v1/messages` request is streamed transparently to the same upstream path and query without JSON parsing or model rewriting.

## Request state machine

```text
RECEIVED
→ VALIDATED
→ SSE_OPEN
→ GENERATING
→ VALIDATING
├─ success → SERIALIZING → COMPLETED
└─ retryable failure → RECOVERING
   ├─ success → SERIALIZING → COMPLETED
   └─ failure → FAILED

Any non-terminal state → CANCELLED
```

Terminal states are irreversible. Cleanup, controller abort, heartbeat removal, writer close, and buffer release are idempotent.

## Heartbeat

A central scheduler scans active request contexts. It never writes directly to sockets; every heartbeat enters that request's `SseWriter` FIFO queue.

Before `message_start`, the writer sends an SSE comment. After `message_start`, it sends an Anthropic `ping` event. Final output is one writer transaction, so heartbeat cannot split a Tool Call block.

## Thinking Loop

Loop detection only receives `thinking_delta` text from one Thinking content block. It does not inspect user messages, system prompts, text blocks, tool JSON, tool results, fenced source code, or log-like records.

The detector checks bounded pattern sizes and performs scans only after `LOOP_SCAN_INTERVAL_CHARS` additional characters. On detection it records raw character boundaries so normalization never changes emitted text.

## Tool Call integrity

Each request stores:

```text
Map<content_block.index, ToolCallState>
```

A Tool Call is eligible for output only after:

- start／stop pairing is complete;
- `id` and `name` are non-empty;
- every `partial_json` fragment was received in order;
- combined JSON passes `JSON.parse`;
- response `stop_reason` is consistent with emitted tools.

The serializer emits one complete `input_json_delta` per Tool Call.

## Recovery

The original request is immutable. Recovery is produced by `structuredClone` plus request-local overrides. No failed Thinking transcript, text, or Tool Call is inserted into the next request.

For a detected Thinking Loop only, `selectRecoveryPlan` inspects exact configured network tool names and completed Tool Results in the original request. A configured MCP search／fetch tool has priority over the configured built-in WebSearch／WebFetch names. When one tool is selected, the recovery request forces exactly that tool through Anthropic `tool_choice`, applies the network sampling cap, and appends a short progress-preservation instruction. The instruction does not introduce an `Active Outcome` or reopen the full task. A post-generation contract check rejects a different tool name, zero or multiple Tool Calls, non-empty Text output, or a non-`tool_use` stop reason before anything is serialized downstream.

Completed fetch results suppress another forced network call only when they are newer than the latest completed search result. Failed Tool Results (`is_error: true`) do not advance the state. Search-to-fetch advancement requires an HTTP(S) URL in a completed configured Search Tool Result.

For a detected Thinking Loop, the final response may retain the first attempt's de-duplicated Thinking prefix. All first-attempt text and Tool Calls are discarded. For every other failure, the first response is discarded entirely and generic recovery is used without network redirection.

## Concurrency and memory

Every request owns its parser, writer, timers, abort controllers, buffers, and Tool Call state. Global mutable state is limited to configuration, active-context registry, heartbeat scheduler, counters, and a synchronous `BufferBudget`.

`MAX_TOTAL_BUFFERED_BYTES` accounts raw upstream SSE bytes reserved by active requests. This is a guardrail, not an exact V8 heap measurement; deployment should set it conservatively below available heap/RSS limits.

## Horizontal scaling

The process is stateless outside active TCP requests. Multiple instances can sit behind a load balancer. An established SSE connection remains on one instance; cross-instance synchronization of Thinking or Tool Call state is unnecessary.
