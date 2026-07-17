# Loop Detector and vLLM Generation Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect long wrapped reasoning loops with partial trailing repeats and let vLLM `--override-generation-config` own normal temperature/top-p/top-k defaults.

**Architecture:** Keep `/v1/messages` request policy validation, but only preserve valid client-provided sampling fields and inject the required `max_tokens`; Recovery explicitly sets its own temperature cap. Extend loop detection with sentence-sequence and trailing-slack tandem matching, while applying code/log suppression only to candidate repeated regions.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, deterministic Anthropic SSE fixtures.

## Global Constraints

- Preserve the incoming model name unchanged.
- Normal generation must not inject `temperature`, `top_p`, or `top_k` when absent.
- Recovery must continue to enforce its own temperature and max-token caps.
- Default maximum loop period is 2048 normalized characters.
- Ordinary two-space terminal wrapping is not code.
- Repeated fenced code and strong code/log regions remain exempt from loop detection.

---

### Task 1: Sampling ownership

**Files:**
- Modify: `tests/config.test.js`
- Modify: `tests/integration.test.js`
- Modify: `vllm-cc-proxy.js`

- [ ] Add failing tests proving absent normal sampling fields are not injected and invalid optional fields are removed.
- [ ] Verify the new tests fail against v0.4.0.
- [ ] Implement optional sampling validation and Recovery-only temperature injection.
- [ ] Run configuration and integration tests.

### Task 2: Long wrapped loop detection

**Files:**
- Modify: `tests/loop-detector.test.js`
- Modify: `vllm-cc-proxy.js`

- [ ] Add failing tests for two-space-wrapped long prose, periods over 384 characters, variable wrapping, and partial next cycles.
- [ ] Verify the tests fail against v0.4.0.
- [ ] Remove global code/log short-circuit, refine candidate code detection, add sentence-sequence detection, and add trailing-slack tandem matching.
- [ ] Run loop detector tests and the full suite.

### Task 3: Documentation and package

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/architecture.md`
- Modify: `docs/known-limitations.md`
- Modify: `docker-compose.partial.yaml`
- Modify: `examples/environment.example`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] Document vLLM ownership of normal sampling defaults and the strengthened loop detector.
- [ ] Remove obsolete normal sampling environment variables.
- [ ] Run syntax, unit, integration, 1,000-request isolation, YAML/JSON, shell, and ZIP integrity checks.
- [ ] Build a root-level ZIP without `.git`.
