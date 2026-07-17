# Known limitations

## Not an Anthropic/OpenAI converter

The proxy requires the upstream vLLM deployment to expose compatible `/v1/messages` and `/v1/messages/count_tokens` endpoints. It does not fall back to `/v1/chat/completions`.

## Transparent non-message routes

Only `POST /v1/messages` receives schema normalization, sampling defaults, Thinking mapping, Watchdog, Heartbeat, and Recovery. `/v1/messages/count_tokens`, `/v1/models`, and every other non-local route are byte-stream passthroughs. Consequently, vLLM must accept the exact method, path, headers, and body emitted by the installed Claude Code version. Unsupported Claude-specific fields on those routes are intentionally not repaired by this proxy.

The proxy also does not provide model aliases. vLLM `--served-model-name` must exactly match the model identifier selected by Claude Code.

## Buffered latency

Assistant content is intentionally delayed until one attempt is structurally complete. Heartbeats remain live, but Thinking, Text, and Tool Calls are not delivered token-by-token.

## Usage accounting after Loop Recovery

When retained Thinking from attempt 1 is merged with attempt 2, upstream token usage cannot exactly describe the synthetic output. The proxy preserves upstream usage metadata but does not claim exact billing-grade accounting for the merged Thinking.

## Thinking signature

A merged Thinking block cannot reuse either upstream signature. The proxy emits a new opaque UUID-style signature. This follows vLLM-compatible behavior but is not a cryptographic attestation of the modified Thinking.

## Tool schema validation

The proxy guarantees complete JSON syntax and protocol structure. It does not implement full JSON Schema validation against `tools[].input_schema`; that would require a maintained validator such as Ajv. Claude Code／the tool runtime must still reject semantically invalid arguments.

## Thinking request mapping

The vLLM 0.23 Anthropic request model does not expose the Claude `thinking` object. The proxy maps its enabled/disabled intent to `chat_template_kwargs.enable_thinking`; `budget_tokens` cannot be enforced through this endpoint.

## Sampling fields

Only request fields accepted by the Anthropic-compatible endpoint are injected. OpenAI-only fields such as `repetition_penalty`, `presence_penalty`, `frequency_penalty`, and `min_p` are removed. Configure backend-only generation behavior in vLLM/model generation configuration. Request-level `seed` is also removed because it is not part of the vLLM 0.23 Anthropic request model.

## DFlash and parsers

DFlash speculative decoding, reasoning parser, tool-call parser, chat template, tensor parallelism, KV cache, and GPU scheduling are vLLM server concerns and are not configured by this proxy.

## Global buffer accounting

`MAX_TOTAL_BUFFERED_BYTES` counts raw upstream SSE bytes. Parsed JavaScript strings and object overhead can consume additional memory. Run load tests with the exact Node heap limit and set this value conservatively.

## Tenant-level distributed quotas

The proxy supports a per-instance active-request limit but does not include a distributed API-key／tenant rate limiter. At large scale, enforce tenant quotas at the load balancer or add an external shared limiter.

## One recovery only

The implementation intentionally permits zero or one internal recovery. Repeated automatic retries can duplicate load and worsen a model loop storm.

## No completed live model test in this package build

Automated tests use deterministic mock vLLM streams. A real deployment must still validate:

1. Claude Code text response.
2. Extended Thinking event sequence.
3. Bash／Read／Edit Tool Calls.
4. Multiple Tool Calls and Tool Results.
5. Model-specific `stop_reason` behavior.
6. Client cancellation reaching the vLLM scheduler.
7. DFlash acceptance rate and performance.
8. Load balancer heartbeat visibility.
9. Target-host soak behavior with real Claude Code sessions, load balancer, vLLM scheduling, and model-sized buffers. The package includes a 1,000-request mock HTTP isolation smoke test, but that is not a production soak test.
