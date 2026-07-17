# Architecture

## Data path

```text
Claude Code
  │ POST /v1/messages (Anthropic JSON)
  │ Anthropic SSE
  ▼
vllm-cc-proxy.js
  ├─ authentication replacement
  ├─ preserve model exactly; validate optional sampling only on POST /v1/messages
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

## Normal sampling ownership

The proxy validates but does not synthesize `temperature`, `top_p`, or `top_k` for a normal Messages request. Valid explicit client values remain request-level overrides; absent or invalid optional values are omitted so vLLM applies its `generation_config`／`override_generation_config`. The required `max_tokens` field retains a proxy fallback. Recovery is separate and intentionally injects a lower request-level temperature plus an output-token cap.

## Thinking Loop

Loop detection only receives `thinking_delta` text from one Thinking content block. It does not inspect user messages, system prompts, text blocks, tool JSON, or tool results. Detection normalizes case, punctuation, whitespace, and line wrapping; it checks correction loops, line-level A-B-A-B, repeated sentence sequences, tandem repeated regions up to 2048 normalized characters, and a reasoning-without-action limit. Tandem matching permits a bounded partial next cycle so 64-character scan cadence does not require an exact cycle-boundary hit.

Code／log suppression is candidate-local. Ordinary terminal indentation is not sufficient to classify prose as code; fenced ranges, strong programming syntax, and log-dense ranges are excluded only when they overlap the candidate repeated region.

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
- response `stop_reason` is consistent with emitted tools;
- Edit-like input does not have identical `old_string`／`new_string`;
- an Edit-like call does not exactly repeat a canonicalized call already paired with `is_error:true` in request history.

The serializer emits one complete `input_json_delta` per Tool Call.

## Recovery

The original request is immutable. Recovery is produced by `structuredClone` plus request-local overrides. No failed Thinking transcript, text, or Tool Call is inserted into the next request.

For `no_op_edit_tool_call` or `repeated_failed_edit_tool_call`, recovery is local and Edit-specific. The rejected Tool Call is never serialized. If the latest successful Tool Result is not already a local Read of the same `file_path`, the proxy filters recovery tools to the detected local Read tool and forces one Read call. Once the latest successful result is a Read of that file, recovery instead forces the original Edit／Update tool and requires a corrected non-identical replacement. This prevents a repeated Read-only cycle while keeping the repair limited to the current edit blocker.

For a detected Thinking Loop only, `selectRecoveryPlan` inspects completed Tool Results and builds a Search or Fetch recovery stage. Exact configured MCP priority names are checked first. In default `auto` mode, if no configured MCP name is available, the proxy conservatively classifies current tools from their name, description, and input schema. MCP candidates suppress non-MCP candidates within the same stage.

A single candidate is forced through Anthropic `tool_choice`. Multiple candidates replace the Recovery request's `tools[]` with only that set and use `tool_choice:any`, allowing Ornith to choose one without access to local or unrelated tools. The network sampling cap and short progress-preservation instruction apply in both cases. The instruction does not introduce an `Active Outcome` or reopen the full task. A post-generation contract check rejects names outside the allowed set, zero or multiple Tool Calls, non-empty Text output, or a non-`tool_use` stop reason before anything is serialized downstream.

Completed fetch results suppress another forced network call only when they are newer than the latest completed search result. Failed Tool Results (`is_error: true`) do not advance state. Search-to-fetch advancement requires an HTTP(S) URL in a completed Search Tool Result recognized by the active classification mode.

For a detected Thinking Loop, the final response may retain the first attempt's de-duplicated Thinking prefix. All first-attempt text and Tool Calls are discarded. For every other failure, the first response is discarded entirely and generic recovery is used without network redirection.

## Concurrency and memory

Every request owns its parser, writer, timers, abort controllers, buffers, and Tool Call state. Global mutable state is limited to configuration, active-context registry, heartbeat scheduler, counters, and a synchronous `BufferBudget`.

`MAX_TOTAL_BUFFERED_BYTES` accounts raw upstream SSE bytes reserved by active requests. This is a guardrail, not an exact V8 heap measurement; deployment should set it conservatively below available heap/RSS limits.

## Horizontal scaling

The process is stateless outside active TCP requests. Multiple instances can sit behind a load balancer. An established SSE connection remains on one instance; cross-instance synchronization of Thinking or Tool Call state is unnecessary.
