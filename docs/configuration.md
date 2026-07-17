# Configuration reference

All settings are environment variables. Values shown are defaults.

## Listener and authentication

| Variable | Default | Meaning |
|---|---:|---|
| `PROXY_HOST` | `0.0.0.0` | Listener address. |
| `PROXY_PORT` | `3456` | Listener port. |
| `PROXY_API_KEY` | empty | Downstream key accepted through `x-api-key` or Bearer auth. Empty disables proxy authentication and is not recommended. |
| `VLLM_BASE_URL` | `http://vllm:8001` | vLLM origin without trailing slash. |
| `VLLM_API_KEY` | `vllm` | Key sent to vLLM as both Bearer and `x-api-key`. |

## Thinking and sampling

| Variable | Default | Meaning |
|---|---:|---|
| `DEFAULT_ENABLE_THINKING` | `true` | Fallback `chat_template_kwargs.enable_thinking`; incoming model names containing `haiku` or `instruct` default to false unless explicitly enabled. |
| `DEFAULT_TEMPERATURE` | `0.65` | Injected only when incoming value is absent or invalid. |
| `DEFAULT_TOP_P` | `0.90` | Valid range 0–1. |
| `DEFAULT_TOP_K` | `40` | Non-negative integer. |
| `DEFAULT_MAX_TOKENS` | `8192` | Positive integer. |

Request priority for Thinking mode:

```text
Claude thinking.type enabled/disabled
→ explicit chat_template_kwargs.enable_thinking
→ incoming model-name profile
→ DEFAULT_ENABLE_THINKING
```

`thinking.budget_tokens` is not forwarded because vLLM 0.23 does not expose it in the Anthropic request model.

## Recovery

| Variable | Default | Meaning |
|---|---:|---|
| `MAX_RECOVERY_ATTEMPTS` | `1` | Allowed range 0–1. |
| `RECOVERY_TEMPERATURE_MAX` | `0.45` | Upper bound for non-forced recovery temperature. |
| `RECOVERY_MAX_TOKENS` | `4096` | Upper bound for non-forced recovery output. |
| `RECOVERY_NETWORK_TEMPERATURE_MAX` | `0.30` | Upper bound when a loop recovery forces one network Tool Call. |
| `RECOVERY_NETWORK_MAX_TOKENS` | `1024` | Output cap for the forced network Tool Call recovery turn. |
| `RECOVERY_MCP_SEARCH_TOOL_PRIORITY` | empty | Comma-separated exact MCP search tool names, highest priority first. |
| `RECOVERY_MCP_FETCH_TOOL_PRIORITY` | empty | Comma-separated exact MCP source-retrieval tool names, highest priority first. |
| `RECOVERY_WEB_SEARCH_TOOL_NAMES` | `WebSearch` | Comma-separated exact built-in／gateway search tool names. |
| `RECOVERY_WEB_FETCH_TOOL_NAMES` | `WebFetch` | Comma-separated exact built-in／gateway fetch tool names. |

### Recovery selection

Network-first selection is applied only when the first attempt is classified as a Thinking Loop. Transport interruption, malformed SSE, incomplete Tool Call, and other structural failures use generic regeneration and are not redirected to network research.

The Proxy uses exact tool names from the current request. It never invents a missing tool and does not infer arbitrary MCP tools from a substring such as `search` or `fetch`.

```text
completed configured fetch result newer than latest search
→ no forced network call; preserve state and continue from retrieved input

URL-bearing configured search result
→ configured MCP fetch
→ configured WebFetch

otherwise
→ configured MCP search
→ configured WebSearch
→ evidence fallback without a forced network tool
```

A `tool_result` with `is_error: true` is ignored for state advancement. URL detection is limited to HTTP(S) URLs found in completed configured search Tool Results. A completed fetch result is only treated as retrieved input, not as a verified or authoritative conclusion.

During a forced network recovery, the Proxy sets Anthropic `tool_choice` to the selected existing tool and appends a short Ornith-specific control prompt. That prompt preserves completed progress, prohibits restart／re-plan／re-scope／undo, and permits only one complete call to the selected tool. It does not create an `Active Outcome` or summarize the original task. The completed recovery is accepted only when it contains exactly one Tool Call with the selected name, no non-empty Text block, and `stop_reason=tool_use`.

## Heartbeat and deadlines

| Variable | Default | Meaning |
|---|---:|---|
| `HEARTBEAT_INTERVAL_MS` | `10000` | Downstream keepalive interval; minimum 1000 ms. |
| `UPSTREAM_IDLE_TIMEOUT_MS` | `180000` | No upstream bytes. |
| `SEMANTIC_STALL_TIMEOUT_MS` | `300000` | Bytes may arrive, but no content/state progress. |
| `TOTAL_GENERATION_TIMEOUT_MS` | `1800000` | First generation deadline. |
| `RECOVERY_TIMEOUT_MS` | `900000` | Recovery deadline. |
| `SHUTDOWN_GRACE_MS` | `300000` | Drain deadline before force close. |

## Concurrency and memory

| Variable | Default | Meaning |
|---|---:|---|
| `MAX_ACTIVE_REQUESTS` | `2000` | Per-instance admission limit covering streaming, non-streaming, and count-token calls. |
| `MAX_REQUEST_BODY_BYTES` | `8388608` | Request JSON limit. |
| `MAX_RESPONSE_BUFFER_BYTES` | `33554432` | Per-attempt raw SSE parser limit. |
| `MAX_TOTAL_BUFFERED_BYTES` | `2147483648` | Process-wide active raw SSE reservation limit. |
| `MAX_THINKING_BYTES` | `4194304` | Per Thinking block. |
| `MAX_TOOL_ARGUMENT_BYTES` | `8388608` | Per Tool Call combined JSON. |
| `MAX_CONTENT_BLOCKS` | `256` | Per response. |
| `MAX_TOOL_CALLS` | `128` | Per response. |

## Loop detector

| Variable | Default | Meaning |
|---|---:|---|
| `LOOP_MIN_PATTERN_SIZE` | `24` | Minimum normalized cycle size. |
| `LOOP_MAX_PATTERN_SIZE` | `384` | Maximum normalized cycle size. |
| `LOOP_MIN_COUNT` | `2` | Detection threshold. |
| `LOOP_REASONING_CHAR_LIMIT` | `24000` | Thinking-only safety limit without an action. |
| `LOOP_SCAN_INTERVAL_CHARS` | `64` | Minimum new Thinking characters between scans. |

## Logging

| Variable | Default | Meaning |
|---|---:|---|
| `LOG_LEVEL` | `info` | Use `silent` or `off` to disable structured lifecycle logs. |

Logs do not contain request prompts, system text, Thinking transcript, Tool Call arguments, Tool Results, or API keys.
