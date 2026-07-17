# Changelog

## 0.4.0 - 2026-07-17

- Added `RECOVERY_NETWORK_TOOL_MODE` with `auto`, `configured-only`, and `disabled` modes; `auto` is the default.
- Added conservative network Tool discovery from `tools[].name`, `description`, and `input_schema`, with explicit local／repository／database exclusions.
- Preserved explicit MCP priority overrides; when none match, automatically builds stage-specific Search or Fetch candidates.
- Gives MCP candidates priority over WebSearch／WebFetch candidates during automatic selection.
- When one candidate exists, forces it; when multiple candidates exist, filters the Recovery request to that candidate set and uses `tool_choice: any` so Ornith chooses exactly one.
- Added post-generation validation that rejects zero, multiple, text-bearing, or out-of-candidate Recovery Tool Calls.
- Added unit and end-to-end tests for auto-discovery, MCP-only candidate restriction, configured-only／disabled modes, and out-of-set rejection.

## 0.3.0 - 2026-07-17

- Added Ornith-specific, progress-preserving Recovery control for Thinking Loops.
- Added deterministic MCP-first network Tool selection using exact configured tool names from the current request.
- Added search-result／fetch-result state inspection, HTTP(S) URL gating, and `is_error` rejection.
- Forced exactly one selected network Tool Call through Anthropic `tool_choice` with tighter Recovery sampling limits and post-generation contract validation.
- Kept transport, SSE, and malformed Tool Call recovery generic; these failures no longer imply network research.
- Explicitly prohibited Recovery from creating an Active Outcome, restarting, re-planning, re-scoping, undoing, replacing, or concluding the full task.
- Added unit and end-to-end integration tests for MCP priority, WebSearch／WebFetch fallback, no invented tools, source-result state, model preservation, and Recovery-only Tool output.

## 0.2.0 - 2026-07-17

- Removed all model alias and `REAL_MODEL` behavior; `/v1/messages` now preserves the client model exactly.
- Added raw transparent forwarding for every non-local route other than managed `POST /v1/messages`.
- Made `/v1/messages/count_tokens` preserve the exact model, raw JSON bytes, query string, generation fields, status, headers, and response bytes.
- Added passthrough tests for arbitrary methods, binary response bytes, query strings, legacy alias variables being ignored, and absolute-form request targets being pinned to the configured vLLM origin.

## 0.1.0 - 2026-07-17

- Added direct Anthropic Messages forwarding for Claude Code and vLLM.
- Added model aliasing and legal sampling-default injection.
- Added buffered Anthropic SSE parsing and clean re-serialization.
- Added same-Thinking-block loop detection with one-cycle retention.
- Added one internal recovery and fail-closed SSE error semantics.
- Added complete Tool Call JSON assembly and validation.
- Added SSE heartbeat, backpressure handling, and request-local cancellation.
- Added active-request and global buffer limits for high concurrency.
- Added a configurable high-concurrency fragmented Tool Call isolation smoke test; verified at 1,000 simultaneous requests in the build environment.
- Added health, readiness, drain, and Prometheus-style metrics endpoints.
- Added Docker Compose service fragment and automated test suite.
