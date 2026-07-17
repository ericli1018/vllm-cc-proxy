# vLLM Claude Code Proxy

專用於以下資料流的 Node.js 22 reverse proxy：

```text
Claude Code
→ Anthropic Messages API / SSE
→ vllm-cc-proxy.js
→ Anthropic Messages API / SSE
→ vLLM 0.23
→ Ornith-1.0-35B-NVFP4
```

Proxy **不做 Anthropic ↔ OpenAI 格式轉換**。只有精確的 `POST /v1/messages` 進入 request policy、完整緩衝、Thinking Loop 偵測、Tool Call 組裝、Heartbeat 與一次內部 Recovery。Proxy 本地的 health／metrics 路徑除外，其餘 method、path、query、raw request body、upstream status、headers 與 response bytes 均採透明轉送。

## 主要保證

- 每個 request 有獨立 `RequestContext`、AbortController、SSE parser、Tool Call map、writer、heartbeat 與 recovery 狀態。
- Claude Code 與 Proxy 之間以 SSE comment／Anthropic `ping` 維持連線。
- Thinking block 在 Proxy 內緩衝；同一 Thinking block 發生循環時，保留循環前內容與第一份循環，刪除後續重複，再執行一次 Recovery。
- 第一輪失敗產生的 text 與 tool calls 不會送到 Claude Code。
- `tool_use` 的 `partial_json` 必須完整累積並通過 `JSON.parse`，才以一筆完整 `input_json_delta` 輸出。
- 意外截斷時整份第一次 generation 丟棄；最多 Recovery 一次。
- SSE 已建立後的不可恢復錯誤以 Anthropic `error` event 結束，不偽裝成 Assistant 回覆。
- 每 Request 與全 process 皆有 buffer 上限，避免數千連線共同造成無界限記憶體成長。
- `SIGTERM` 會先進入 drain：停止接受新 request，既有 request 繼續完成至 grace deadline。

## 快速部署

### 1. 放置檔案

將下列檔案放在 Compose 專案目錄：

```text
vllm-cc-proxy.js
docker-compose.partial.yaml
```

把 `docker-compose.partial.yaml` 的 service 片段合併到現有 `services:`。它假設已有：

```text
service: vllm
network: vllm-test-network
vLLM port: 8001
```

若你的 vLLM service／port／network 不同，修改對應三處即可。

### 2. 設定密鑰

```bash
export VLLM_CC_PROXY_API_KEY='replace-with-a-long-random-key'
export VLLM_API_KEY='vllm'
```

### 3. 啟動

```bash
docker compose up -d vllm-cc-proxy
```

### 4. Claude Code 指向 Proxy

```bash
export ANTHROPIC_BASE_URL='http://127.0.0.1:3456'
export ANTHROPIC_AUTH_TOKEN="$VLLM_CC_PROXY_API_KEY"
export ANTHROPIC_MODEL='claude-sonnet-4-6'
```

Proxy 不修改 `model`。Claude Code 傳入的名稱會原樣送到 vLLM，因此 vLLM `--served-model-name` 必須使用完全相同的值，例如：

```text
--served-model-name claude-sonnet-4-6
```

`REAL_MODEL` 與 `MODEL_ALIASES_JSON` 已移除；即使殘留在環境中也不會生效。

## Request policy

Proxy 只保留合法的 Anthropic request sampling 欄位：

```text
temperature
top_p
top_k
max_tokens
```

合法且由 Claude Code 明確提供的值會保留；缺少或超出範圍時才注入預設值。

僅在 `POST /v1/messages` 中，Claude Code 的 `thinking.type` 會轉成 `chat_template_kwargs.enable_thinking`；原始 `thinking` 物件不會直接送入 vLLM 0.23。

`/v1/messages/count_tokens` 與其他路徑完全透明：Proxy 不解析 JSON、不移除 generation fields、不修改 model，也不插入 Heartbeat。這表示 vLLM 必須能直接接受 Claude Code 對這些路徑送出的原始內容。

以下欄位不會送往 vLLM `/v1/messages`：

```text
thinking_token_budget
repetition_detection
presence_penalty
frequency_penalty
repetition_penalty
min_p
max_new_tokens
reasoning_budget
reasoning_effort
seed
```

`seed` 無法透過 vLLM 0.23 的 Anthropic request schema 傳入；需要固定測試時，應使用 vLLM 啟動端的全域 seed／batch-invariance 設定。DFlash、reasoning parser、tool-call parser 與 chat template 仍由 vLLM 啟動端設定。

## Heartbeat 規則

- 上游尚未送出 `message_start`：Proxy 送標準 SSE comment `: keep-alive`。
- `message_start` 已送出後：Proxy 送 `event: ping`／`{"type":"ping"}`。
- Thinking、Tool Call 緩衝與 Recovery 期間均持續 heartbeat。
- 最終 Thinking／Tool Call／Text 由單一 FIFO writer 輸出，heartbeat 不會插入 tool block 中間。

## Recovery 規則

### Thinking Loop：Ornith 網路證據 Recovery

只有第一輪被分類為 Thinking Loop 時，Proxy 才啟用網路優先狀態機。Proxy 不先詢問模型是否需要研究，而是直接檢查原始 request 的 `tools[]` 與既有 `tool_use`／`tool_result`。

```text
已有較新的成功 Fetch Result
→ 不再強制搜尋或讀取
→ 只加入保留進度的 evidence-available prompt

已有帶 HTTP(S) URL 的成功 Search Result
→ MCP Fetch（明確設定的 exact name）
→ WebFetch

尚未有可讀取 URL
→ MCP Search（明確設定的 exact name）
→ WebSearch

沒有任何核准的網路工具
→ 不虛構工具，回退到一般 evidence-producing action
```

MCP 優先清單由環境變數明確指定：

```bash
RECOVERY_MCP_SEARCH_TOOL_PRIORITY='mcp__searxng__search,mcp__brave-search__brave_web_search'
RECOVERY_MCP_FETCH_TOOL_PRIORITY='mcp__fetch__fetch'
```

Proxy 只會選擇同時存在於目前 `request.tools[]` 的 exact tool name。`tool_result.is_error=true` 不會被當成研究進度。

選到工具後，Recovery request 會：

- 保留 Claude Code 傳入的 model 原值。
- 使用較緊的 `temperature <= 0.30` 與 `max_tokens <= 1024`。
- 設定 `tool_choice: {"type":"tool","name":"..."}`。
- 附加 Ornith 專用短 prompt：既有任務狀態與完成進度仍具權威，不得重新開始、重新規劃、重新劃定範圍、撤銷或替換已完成工作。
- 禁止解釋文字、結論、Final Response、完成宣告與其他 Tool Call；可執行輸出只能是一個完整的指定網路 Tool Call。Proxy 會在上游完成後再次驗證工具數量、名稱、non-empty Text block 與 `stop_reason`，不符合就以 SSE error 結束。Ornith 協議仍可能產生受 buffer 與 1024-token 上限約束的 Thinking block。
- 不建立 `Active Outcome`，也不重新摘要原始任務。

搜尋結果、URL 或 Fetch Result只是後續輸入，不代表已驗證結論，也不代表研究或原始任務完成。

### Loop 內容保留

```text
保留：Loop 前內容 + 第一份循環
丟棄：第二份及後續重複、第一輪 text、第一輪 tool_use
最終：整理後 Thinking + Recovery Thinking + Recovery Tool Call
```

### 意外截斷、SSE 或 Tool Call 結構錯誤

這些不是「模型想不通」的證據，不會被導向網路搜尋：

```text
第一次 response 全部丟棄
→ 從不變的原始 request 做一般 Recovery 一次
→ 不假設第一輪 partial text／Tool Call 已執行
→ 第二次完整才輸出
```

### 第二次仍失敗

```text
event: error
data: {"type":"error","error":{"type":"api_error","message":"..."}}
```

不會傳送「請 Claude Code 重試」的 Assistant 文字。

## Health 與 Metrics

```text
GET /health/live
GET /health/ready
GET /metrics
```

Drain 狀態下 `/health/ready` 回 503，既有 SSE request 不會立即被切斷。

## 本機測試

```bash
node --version       # 必須 >= 22
npm test
npm run check
npm run test:load   # 1,000 個同時 HTTP request 的隔離 smoke test
bash scripts/verify.sh
```

測試使用本機 mock vLLM，涵蓋：

- `/v1/messages` sampling／Thinking policy、model 原值保留與 auth replacement
- transparent forwarding of count-token／model-discovery／unknown paths
- heartbeat
- Thinking Loop 與一次 Recovery
- fragmented／malformed Tool Call
- upstream truncation／idle timeout
- client cancellation isolation
- drain
- 預設測試中的並行 Tool Call request 隔離
- 可調整至 1,000 個同時 HTTP request 的 fragmented Tool Call 隔離 smoke test
- per-request／global buffer limits

## 部署調校

數千連線不應只靠提高 `MAX_ACTIVE_REQUESTS`。至少同時檢查：

- Host／container `nofile`。
- `NODE_OPTIONS=--max-old-space-size` 必須高於 `MAX_TOTAL_BUFFERED_BYTES` 並保留 parsed object／writer queue 餘裕。
- 前置 Load Balancer 的 SSE buffering 與 idle timeout。
- 每實例可用 heap 與 `MAX_TOTAL_BUFFERED_BYTES`。
- vLLM scheduler 可承受的 active sequences。
- 多 Proxy instance 橫向擴充。

Proxy 的 active request 狀態只存在單一 TCP connection 所在 instance，可安全橫向擴充；前置 LB 不得對 streaming POST 自動重送。

## 驗證狀態

已執行 Node.js 單元、整合、故障注入、Golden SSE、併發隔離與語法檢查。尚未在此環境執行真實 Claude Code → Proxy → vLLM → Ornith／DFlash 端到端測試；部署後仍需依 `docs/known-limitations.md` 的程序驗證實際模型輸出。
