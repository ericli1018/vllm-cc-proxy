# Known limitations

## Not an Anthropic/OpenAI converter

The proxy requires the upstream vLLM deployment to expose compatible `/v1/messages` and `/v1/messages/count_tokens` endpoints. It does not fall back to `/v1/chat/completions`.

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

Normal requests do not receive proxy defaults for `temperature`, `top_p`, or `top_k`; absent or invalid optional values are omitted so vLLM generation configuration can supply them. A valid value explicitly sent by Claude Code is preserved and therefore remains a request-level override of the server default. OpenAI-only fields such as `repetition_penalty`, `presence_penalty`, `frequency_penalty`, and `min_p` are removed. Configure backend-only generation behavior in vLLM/model generation configuration. Request-level `seed` is also removed because it is not part of the vLLM 0.23 Anthropic request model.

## DFlash and parsers

DFlash speculative decoding, reasoning parser, tool-call parser, chat template, tensor parallelism, KV cache, and GPU scheduling are vLLM server concerns and are not configured by this proxy.

## Network recovery classification is mechanical

The proxy does not decide whether a source is truly official, authoritative, relevant, or sufficient. It recognizes successful matching Tool Results, their order, HTTP(S) URL presence, exact configured names, and—only in `auto` mode—conservative network semantics in each tool's name, description, and input schema. A completed Fetch Tool Result is evidence input, not certified truth.

Automatic discovery can produce false negatives or false positives. Opaque MCP names with no useful description are intentionally ignored. A tool whose description mixes web access with local repository or database operations may also be excluded by the conservative local-only filter. Use exact MCP priority variables when deterministic classification is required, `configured-only` to disable heuristics, or `disabled` to disable network recovery.

If Claude Code omits a tool from `tools[]`, permission policy denies it, vLLM cannot honor `tool_choice`, or the model emits invalid arguments, the proxy cannot bypass those failures. Multiple auto-discovered candidates are filtered into the Recovery request and left to Ornith through `tool_choice:any`; this does not guarantee that the semantically best candidate is chosen.

The URL detector intentionally does not parse arbitrary user prose, relative links, browser state, or vendor-specific nested result schemas beyond their serialized text. A relevant URL supplied directly by the user may therefore not trigger fetch-first recovery.

The progress-preservation prompt constrains the recovery generation. After the real Tool Result returns in a later Claude Code request, normal model behavior resumes; the proxy cannot guarantee that the model will never reconsider prior work. Existing runtime policies and tests should still enforce decision preservation and evidence-gated changes.

Network recovery rejects non-empty Text output, zero or multiple Tool Calls, names outside the allowed candidate set, and a non-`tool_use` stop reason, but it does not reject valid Thinking blocks. Some reasoning models emit Thinking even when a Tool Call is required; rejecting all Thinking would make recovery brittle. The prompt, 1024-token default cap, Loop detector, and single-recovery limit constrain this behavior but cannot prove the model did not internally reconsider prior hypotheses.


## Loop detection remains heuristic

The detector now covers long tandem cycles, repeated sentence sequences, variable terminal wrapping, and a bounded partial next repeat. It still cannot prove semantic equivalence when the model continuously paraphrases the same idea with different wording. Fenced code and strongly code／log-like candidate ranges are intentionally exempt, so a reasoning loop embedded entirely in a genuine code quotation may not be interrupted. `reasoning_without_action` remains the final safety bound for loops that do not expose enough repeated surface form.

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
