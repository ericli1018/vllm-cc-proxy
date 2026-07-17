# Ornith Recovery Network-State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add deterministic MCP-first, progress-preserving network recovery for Ornith Thinking loops while leaving non-loop recovery unchanged.

**Architecture:** Introduce pure helpers that inspect the original Anthropic request, classify completed network Tool Results, select one existing tool, and build a bounded Recovery policy. `applyRequestPolicy` applies the resulting prompt and optional forced `tool_choice`; the server computes that plan only when the first attempt is a loop.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, Anthropic Messages request/SSE protocol.

## Global Constraints

- No model aliasing or model-name rewrite.
- No new runtime dependency.
- Never invent absent tools.
- Network recovery is loop-only.
- Exactly one recovery attempt.
- Existing request-local isolation and buffer limits remain unchanged.

---

### Task 1: Recovery selection and prompt policy

**Files:**
- Modify: `vllm-cc-proxy.js`
- Test: `tests/config.test.js`

**Interfaces:**
- Produces: `selectRecoveryPlan(input, config, reason)` returning `{ mode, selectedTool, instruction }`.
- Consumes: original Anthropic Messages request and immutable config.

- [x] Add failing tests for config parsing, MCP priority, URL-aware fetch selection, WebSearch fallback, no invented tool, fetched-evidence mode, and non-loop generic mode.
- [x] Run `node --test tests/config.test.js` and confirm the new tests fail for missing behavior.
- [x] Implement exact-name parsing, Tool Result history extraction, deterministic selection, and short state-preserving prompts.
- [x] Re-run `node --test tests/config.test.js` and confirm all config tests pass.

### Task 2: Streaming recovery integration

**Files:**
- Modify: `vllm-cc-proxy.js`
- Test: `tests/integration.test.js`

**Interfaces:**
- Consumes: `selectRecoveryPlan`.
- Produces: loop recovery request with forced `tool_choice` only when an available network tool was selected.

- [x] Add an integration test whose first attempt loops and whose second request must force the configured MCP tool, preserve model, include the bounded prompt, and return only the recovery Tool Call.
- [x] Run the focused integration test and confirm it fails before implementation.
- [x] Wire the plan into the recovery branch and use network-specific sampling limits only for forced network recovery.
- [x] Re-run the focused integration test and the full integration suite.

### Task 3: Deployment documentation and artifact

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/known-limitations.md`
- Modify: `docker-compose.partial.yaml`
- Modify: `examples/environment.example`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [x] Document exact recovery phases, configuration, preservation boundaries, and limitations.
- [x] Run syntax, unit, integration, Golden SSE, load, JSON, shell, and YAML checks.
- [x] Build a ZIP with project files at archive root and no `.git` directory.
- [x] Verify ZIP integrity and compute SHA-256.
