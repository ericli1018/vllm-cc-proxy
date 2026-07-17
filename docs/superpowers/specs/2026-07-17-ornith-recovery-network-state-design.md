# Ornith Recovery Network-State Design

## Goal

Change recovery for Ornith-1.0-35B-NVFP4 so a detected Thinking loop moves to one bounded evidence-acquisition action without reopening, re-planning, undoing, or replacing established task progress.

## Scope

- Preserve the existing model name exactly; no model aliasing.
- Apply network-first behavior only to reasoning-loop failures, not transport, SSE, or malformed-tool recovery.
- Select network tools deterministically from the current request; do not ask the model whether research is needed.
- Prefer explicitly configured MCP network tools over Claude Code WebSearch/WebFetch.
- If a search result containing a URL exists and a fetch tool is available, fetch before another broad search.
- Never invent a tool that is absent from `request.tools`.
- Force exactly one selected network Tool Call through Anthropic `tool_choice`.
- Use a short Ornith-specific prompt that preserves current task state and forbids full-task restart, re-planning, conclusions, final text, and completion claims during the forced-tool recovery turn.
- After source retrieval evidence already exists, do not force another network call; use a state-preserving evidence continuation prompt.
- Non-loop recovery remains a clean regeneration from the unchanged request and must not be redirected to web research.

## Configuration

- `RECOVERY_MCP_SEARCH_TOOL_PRIORITY`: comma-separated exact MCP search tool names, in priority order.
- `RECOVERY_MCP_FETCH_TOOL_PRIORITY`: comma-separated exact MCP source-retrieval tool names, in priority order.
- `RECOVERY_WEB_SEARCH_TOOL_NAMES`: comma-separated exact web-search names; default `WebSearch`.
- `RECOVERY_WEB_FETCH_TOOL_NAMES`: comma-separated exact web-fetch names; default `WebFetch`.
- `RECOVERY_NETWORK_TEMPERATURE_MAX`: default `0.30`.
- `RECOVERY_NETWORK_MAX_TOKENS`: default `1024`.

## State Classification

1. Build a tool-use map from prior assistant `tool_use` blocks and match subsequent `tool_result.tool_use_id` blocks.
2. Classify configured exact tool names as search or fetch.
3. A result is usable only when a completed matching `tool_result` exists.
4. A search result is considered to expose a source candidate only when its result text contains an HTTP(S) URL.
5. If a completed fetch result is newer than the latest completed search result, authoritative source content is treated as available and no network tool is forced.
6. Otherwise, choose:
   - configured MCP fetch when a URL candidate exists;
   - configured MCP search;
   - WebFetch when a URL candidate exists;
   - WebSearch;
   - configured MCP fetch only when no search tool exists but a URL is already present;
   - no forced tool if none match.

## Recovery Prompt Boundaries

The prompt must state that task state established before the failed generation remains authoritative. It must forbid restart, re-plan, re-scope, undo, replacement, reconsideration of completed work, analysis text, conclusions, final response, completion claims, and any tool other than the selected tool. It must not add an `Active Outcome` or summarize the original task.

## Verification

Automated tests must prove model preservation, MCP priority, URL-aware fetch selection, WebSearch fallback, absence of invented tools, non-loop recovery isolation, forced tool choice, prompt state-preservation language, no `Active Outcome`, and end-to-end loop recovery emitting only the selected network Tool Call.
