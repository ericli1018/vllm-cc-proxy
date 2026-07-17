# Ornith Recovery Network-State Design

## Goal

Change recovery for Ornith-1.0-35B-NVFP4 so a detected Thinking loop moves to one bounded network-evidence action without reopening, re-planning, undoing, or replacing established task progress. When no exact MCP override is configured, the proxy should discover plausible network tools from the current request and let Ornith choose only within a restricted candidate set.

## Scope

- Preserve the incoming model name exactly; no model aliasing.
- Apply network-first behavior only to reasoning-loop failures, not transport, SSE, or malformed-tool recovery.
- Do not ask the model whether research is needed before recovery.
- Exact configured MCP search／fetch names have highest priority.
- Default `auto` mode classifies current tools from `name`, `description`, and `input_schema`.
- Automatic classification is conservative and excludes local repository, source-code, filesystem, workspace, database, Grep, Glob, and SearchFiles semantics.
- MCP candidates suppress WebSearch／WebFetch and other non-MCP candidates within the same Search or Fetch stage.
- A single candidate is forced; multiple candidates are the only tools exposed to the recovery request and use `tool_choice:any`.
- Never invent a tool absent from `request.tools`.
- If a successful search result containing an HTTP(S) URL exists, choose Fetch candidates before another Search.
- After newer successful Fetch evidence already exists, do not force another network call.
- Use a short Ornith-specific prompt that preserves current task state and forbids full-task restart, re-planning, conclusions, final text, and completion claims during the network recovery turn.
- Validate exactly one Tool Call, candidate membership, no non-empty Text block, and `stop_reason=tool_use` before downstream serialization.

## Configuration

- `RECOVERY_NETWORK_TOOL_MODE`: `auto` by default; also supports `configured-only` and `disabled`.
- `RECOVERY_MCP_SEARCH_TOOL_PRIORITY`: optional exact MCP search names, highest priority first.
- `RECOVERY_MCP_FETCH_TOOL_PRIORITY`: optional exact MCP source-retrieval names, highest priority first.
- `RECOVERY_WEB_SEARCH_TOOL_NAMES`: exact built-in／gateway search names; default `WebSearch`.
- `RECOVERY_WEB_FETCH_TOOL_NAMES`: exact built-in／gateway fetch names; default `WebFetch`.
- `RECOVERY_NETWORK_TEMPERATURE_MAX`: default `0.30`.
- `RECOVERY_NETWORK_MAX_TOKENS`: default `1024`.

## State Classification

1. Build a classification index for current `tools[]`.
2. Exact configured names are always classified by their configured stage.
3. In `auto`, infer Search／Fetch capability from conservative network signals in name, description, and schema.
4. Build a tool-use map from prior assistant `tool_use` blocks and match successful `tool_result.tool_use_id` blocks.
5. A search result advances to Fetch only when its completed Tool Result contains an HTTP(S) URL.
6. A newer completed Fetch Result suppresses another forced network action.
7. Otherwise, build stage candidates:
   - first available exact configured MCP name is forced;
   - `configured-only` then checks exact Web names;
   - `auto` discovers all stage candidates and keeps only MCP candidates when any exist;
   - one candidate is forced, multiple candidates are restricted and delegated to Ornith;
   - no candidates use evidence fallback.

## Recovery Prompt Boundaries

The prompt must state that task state established before the failed generation remains authoritative. It must forbid restart, re-plan, re-scope, undo, replacement, reconsideration of completed work, analysis text, conclusions, final response, and completion claims. It must not add an `Active Outcome` or summarize the original task.

## Verification

Automated tests must prove mode parsing, exact MCP override priority, automatic Search／Fetch discovery, MCP-only candidate restriction, local-tool exclusion, single-candidate force, multi-candidate `tool_choice:any`, Recovery request tool filtering, candidate-membership validation, model preservation, no `Active Outcome`, and end-to-end loop recovery emitting only one allowed network Tool Call.
