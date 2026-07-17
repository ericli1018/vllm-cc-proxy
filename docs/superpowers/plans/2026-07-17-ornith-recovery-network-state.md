# Ornith Recovery Network-State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add automatic, MCP-preferred, progress-preserving network Tool selection for Ornith Thinking-loop recovery while leaving non-loop recovery unchanged.

**Architecture:** `selectRecoveryPlan` classifies current tools and completed Tool Results, chooses a Search or Fetch stage, and returns either one forced tool or a bounded candidate set. `applyRequestPolicy` filters Recovery `tools[]`, applies exact or `any` tool choice, and the post-generation contract validates exactly one allowed Tool Call.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, Anthropic Messages request/SSE protocol.

## Global Constraints

- No model aliasing or model-name rewrite.
- No new runtime dependency.
- Never invent absent tools.
- Network recovery is loop-only.
- Exactly one recovery attempt.
- Existing request-local isolation and buffer limits remain unchanged.
- Existing progress must not be reopened by Recovery instructions.

---

### Task 1: Automatic classification and selection

**Files:**
- Modify: `vllm-cc-proxy.js`
- Test: `tests/config.test.js`

**Interfaces:**
- Produces: `selectRecoveryPlan(input, config, { kind, reason })` returning `{ mode, selectedTool, allowedTools, instruction }`.
- Consumes: original Anthropic Messages request and immutable config.

- [x] Add failing tests for mode parsing, automatic MCP Search／Fetch discovery, local-tool exclusion, exact MCP override, and disabled／configured-only modes.
- [x] Run `node --test tests/config.test.js` and confirm failures identify the missing behavior.
- [x] Implement conservative classification, stage selection, MCP candidate preference, and single／multiple candidate plans.
- [x] Re-run `node --test tests/config.test.js` and confirm all config tests pass.

### Task 2: Restricted Recovery request and contract validation

**Files:**
- Modify: `vllm-cc-proxy.js`
- Test: `tests/config.test.js`
- Test: `tests/integration.test.js`

**Interfaces:**
- Consumes: `allowedTools` and optional `selectedTool` from the Recovery plan.
- Produces: filtered Recovery `tools[]`, exact or `any` `tool_choice`, and candidate-membership validation.

- [x] Add tests proving multi-candidate Recovery removes unrelated tools and uses `tool_choice:any`.
- [x] Add integration coverage for Ornith choosing one auto-discovered MCP candidate.
- [x] Add integration coverage rejecting a Tool Call outside the candidate set without downstream leakage.
- [x] Run focused integration tests and confirm they pass.

### Task 3: Deployment documentation and artifact

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/known-limitations.md`
- Modify: `docs/architecture.md`
- Modify: `docker-compose.partial.yaml`
- Modify: `examples/environment.example`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [x] Document `auto`, `configured-only`, and `disabled` modes, classification signals, exclusions, and candidate behavior.
- [x] Run syntax, unit, integration, Golden SSE, load, JSON, shell, and YAML checks.
- [x] Build a ZIP with project files at archive root and no `.git` directory.
- [x] Verify ZIP integrity, compare archive files with source, and compute SHA-256.
