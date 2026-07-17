# Changelog

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
