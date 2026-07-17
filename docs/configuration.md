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
| `DEFAULT_MAX_TOKENS` | `8192` | Positive fallback for the required Anthropic `max_tokens` field. |

Request priority for Thinking mode:

```text
Claude thinking.type enabled/disabled
→ explicit chat_template_kwargs.enable_thinking
→ incoming model-name profile
→ DEFAULT_ENABLE_THINKING
```

`thinking.budget_tokens` is not forwarded because vLLM 0.23 does not expose it in the Anthropic request model.


Normal `/v1/messages` requests do not receive Proxy defaults for `temperature`, `top_p`, or `top_k`. Valid client-provided values are preserved; absent or invalid optional values are omitted so vLLM can apply its generation configuration. A typical Ornith server configuration is:

```text
--generation-config vllm
--override-generation-config '{"temperature":0.6,"top_p":0.95,"top_k":20}'
```

Generic and network Recovery requests still set their own request-level `temperature` and `max_tokens` caps.

## Recovery

| Variable | Default | Meaning |
|---|---:|---|
| `MAX_RECOVERY_ATTEMPTS` | `1` | Allowed range 0–1. |
| `RECOVERY_TEMPERATURE_MAX` | `0.45` | Upper bound for generic recovery temperature. |
| `RECOVERY_MAX_TOKENS` | `4096` | Upper bound for generic recovery output. |
| `RECOVERY_NETWORK_TEMPERATURE_MAX` | `0.30` | Upper bound for loop recovery that must emit one network Tool Call. |
| `RECOVERY_NETWORK_MAX_TOKENS` | `1024` | Output cap for the network Tool Call recovery turn. |
| `RECOVERY_NETWORK_TOOL_MODE` | `auto` | `auto`, `configured-only`, or `disabled`. |
| `RECOVERY_MCP_SEARCH_TOOL_PRIORITY` | empty | Optional comma-separated exact MCP search names, highest priority first. |
| `RECOVERY_MCP_FETCH_TOOL_PRIORITY` | empty | Optional comma-separated exact MCP source-retrieval names, highest priority first. |
| `RECOVERY_WEB_SEARCH_TOOL_NAMES` | `WebSearch` | Comma-separated exact built-in／gateway search names. Set empty to remove these exact-name candidates. |
| `RECOVERY_WEB_FETCH_TOOL_NAMES` | `WebFetch` | Comma-separated exact built-in／gateway fetch names. Set empty to remove these exact-name candidates. |

### Edit repair（無新增環境變數）

Streaming `/v1/messages` 中，只要 Tool Call input 同時包含字串 `old_string` 與 `new_string`，Proxy 就會套用 Edit 語意防護：

- 完全相同的兩個字串視為 `no_op_edit_tool_call`。
- 與 request history 中 `is_error:true` 的既有 Edit 具有相同 tool name 與 canonical JSON input，視為 `repeated_failed_edit_tool_call`。
- 有本地 `Read` 工具且最新成功結果尚未讀取 target file 時，Recovery 強制先讀取該檔。
- 最新成功 Tool Result 已讀取同一 target file 時，Recovery 強制原 Edit／Update 工具產生修正後參數。
- Edit repair 使用一般 Recovery 上限 `RECOVERY_TEMPERATURE_MAX`／`RECOVERY_MAX_TOKENS`，不使用 network Recovery 的 0.30／1024 上限。

### Network Tool modes

- `auto`: exact configured MCP names have highest priority. If none match the current request, the Proxy conservatively classifies available `tools[]` from each tool's `name`, `description`, and `input_schema`.
- `configured-only`: no heuristic discovery. Only exact configured MCP names and exact `RECOVERY_WEB_*_TOOL_NAMES` are considered.
- `disabled`: loop recovery does not force any network tool and uses evidence fallback.

Network-first selection is applied only when the first attempt is classified as a Thinking Loop. Transport interruption, malformed SSE, incomplete Tool Call, and other structural failures use generic regeneration and are not redirected to network research.

### Automatic classification

`auto` mode uses positive network signals such as web, internet, HTTP(S), URL, webpage, SearXNG, Brave Search, Tavily, fetch, retrieve, browse, and navigate. It rejects tools carrying local-only signals such as local, repository, source code, filesystem, workspace, database, Grep, Glob, and SearchFiles.

This is intentionally conservative. A deployment-specific MCP tool with an opaque name and no useful description is not guessed; add its exact name to the MCP priority variable. The Proxy never adds a tool absent from the current `request.tools[]`.

### Recovery selection

```text
completed successful fetch result newer than latest successful search
→ no forced network call; preserve state and continue from retrieved input

URL-bearing successful search result
→ Fetch stage

otherwise
→ Search stage
```

For either stage:

1. If an exact configured MCP priority name is available, the first available name is forced.
2. In `configured-only`, the first available exact built-in／gateway name is forced.
3. In `auto`, the Proxy builds stage-matching candidates. If any MCP candidates exist, non-MCP candidates are removed.
4. One candidate is forced with `tool_choice: {"type":"tool","name":"..."}`.
5. Multiple candidates replace the Recovery request's `tools[]` with only that set and use `tool_choice: {"type":"any"}` so Ornith chooses one.
6. No candidate produces evidence fallback without a forced network tool.

A `tool_result` with `is_error: true` does not advance state. Search-to-fetch advancement requires an HTTP(S) URL in a completed Search Tool Result. A completed Fetch Result is evidence input, not a verified or authoritative conclusion.

During network recovery the short Ornith-specific instruction preserves completed progress, prohibits restart／re-plan／re-scope／undo, and permits exactly one complete allowed Tool Call. It does not create an `Active Outcome` or summarize the original task. The completed recovery is accepted only when it contains exactly one Tool Call whose name is in the allowed candidate set, no non-empty Text block, and `stop_reason=tool_use`.

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
| `LOOP_MAX_PATTERN_SIZE` | `2048` | Maximum normalized cycle size for tandem matching. |
| `LOOP_MIN_COUNT` | `2` | Detection threshold. |
| `LOOP_REASONING_CHAR_LIMIT` | `24000` | Thinking-only safety limit without an action. |
| `LOOP_SCAN_INTERVAL_CHARS` | `64` | Minimum new Thinking characters between scans. |

## Logging

| Variable | Default | Meaning |
|---|---:|---|
| `LOG_LEVEL` | `info` | Use `silent` or `off` to disable structured lifecycle logs. |

Logs do not contain request prompts, system text, Thinking transcript, Tool Call arguments, Tool Results, or API keys.
