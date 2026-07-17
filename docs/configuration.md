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
| `REAL_MODEL` | `Ornith-1.0-35B-NVFP4` | Must equal vLLM `--served-model-name`. |
| `MODEL_ALIASES_JSON` | built-in aliases | JSON object mapping Claude／virtual model names to the served model. |

## Thinking and sampling

| Variable | Default | Meaning |
|---|---:|---|
| `DEFAULT_ENABLE_THINKING` | `true` | Fallback `chat_template_kwargs.enable_thinking`; `haiku`／`instruct` aliases default to false. |
| `DEFAULT_TEMPERATURE` | `0.65` | Injected only when incoming value is absent or invalid. |
| `DEFAULT_TOP_P` | `0.90` | Valid range 0–1. |
| `DEFAULT_TOP_K` | `40` | Non-negative integer. |
| `DEFAULT_MAX_TOKENS` | `8192` | Positive integer. |

Request priority for Thinking mode:

```text
Claude thinking.type enabled/disabled
→ explicit chat_template_kwargs.enable_thinking
→ model alias profile
→ DEFAULT_ENABLE_THINKING
```

`thinking.budget_tokens` is not forwarded because vLLM 0.23 does not expose it in the Anthropic request model.

## Recovery

| Variable | Default | Meaning |
|---|---:|---|
| `MAX_RECOVERY_ATTEMPTS` | `1` | Allowed range 0–1. |
| `RECOVERY_TEMPERATURE_MAX` | `0.45` | Upper bound for recovery temperature. |
| `RECOVERY_MAX_TOKENS` | `4096` | Upper bound for recovery output. |

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
