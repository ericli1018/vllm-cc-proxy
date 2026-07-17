# Changelog

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
