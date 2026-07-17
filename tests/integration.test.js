import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  createProxyServer,
  loadConfig,
} from '../vllm-cc-proxy.js';

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStart(model = 'Ornith-1.0-35B-NVFP4') {
  return sse('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_upstream', type: 'message', role: 'assistant', content: [], model,
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
}

function textBlock(index, text) {
  return sse('content_block_start', {
    type: 'content_block_start', index,
    content_block: { type: 'text', text: '' },
  }) + sse('content_block_delta', {
    type: 'content_block_delta', index,
    delta: { type: 'text_delta', text },
  }) + sse('content_block_stop', { type: 'content_block_stop', index });
}

function thinkingBlock(index, thinking) {
  return sse('content_block_start', {
    type: 'content_block_start', index,
    content_block: { type: 'thinking', thinking: '' },
  }) + sse('content_block_delta', {
    type: 'content_block_delta', index,
    delta: { type: 'thinking_delta', thinking },
  }) + sse('content_block_delta', {
    type: 'content_block_delta', index,
    delta: { type: 'signature_delta', signature: 'upstream-signature' },
  }) + sse('content_block_stop', { type: 'content_block_stop', index });
}

function toolBlock(index, { id, name, chunks }) {
  let output = sse('content_block_start', {
    type: 'content_block_start', index,
    content_block: { type: 'tool_use', id, name, input: {} },
  });
  for (const chunk of chunks) {
    output += sse('content_block_delta', {
      type: 'content_block_delta', index,
      delta: { type: 'input_json_delta', partial_json: chunk },
    });
  }
  return output + sse('content_block_stop', { type: 'content_block_stop', index });
}

function endMessage(stopReason = 'end_turn') {
  return sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 20 },
  }) + sse('message_stop', { type: 'message_stop' });
}

async function readJsonRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function startMockVllm(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      server.closeAllConnections?.();
      await once(server, 'close');
    },
  };
}

async function startProxy(baseUrl, env = {}) {
  const config = {
    ...loadConfig({
      VLLM_BASE_URL: baseUrl,
      VLLM_API_KEY: 'upstream-key',
      PROXY_API_KEY: 'proxy-key',
      LOOP_MIN_PATTERN_SIZE: '12',
      LOOP_MAX_PATTERN_SIZE: '160',
      LOG_LEVEL: 'silent',
      ...env,
    }),
    heartbeatIntervalMs: Number(env.HEARTBEAT_INTERVAL_MS || 20),
    upstreamIdleTimeoutMs: Number(env.UPSTREAM_IDLE_TIMEOUT_MS || 1000),
    semanticStallTimeoutMs: Number(env.SEMANTIC_STALL_TIMEOUT_MS || 1000),
    totalGenerationTimeoutMs: Number(env.TOTAL_GENERATION_TIMEOUT_MS || 3000),
    recoveryTimeoutMs: Number(env.RECOVERY_TIMEOUT_MS || 2000),
  };
  const app = createProxyServer(config);
  await app.listen(0, '127.0.0.1');
  return {
    app,
    url: `http://127.0.0.1:${app.address().port}`,
    async close() { await app.close({ force: true }); },
  };
}

async function postMessages(proxyUrl, body, { signal } = {}) {
  return fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'proxy-key',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });
}

function parseSseText(text) {
  const events = [];
  for (const raw of text.split(/\r?\n\r?\n/)) {
    if (!raw.trim()) continue;
    let event = null;
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (event && data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
  }
  return events;
}

test('forwards Anthropic Messages with the client model unchanged, defaults, and replaced upstream authentication', async (t) => {
  let captured;
  const mock = await startMockVllm(async (req, res) => {
    captured = {
      url: req.url,
      authorization: req.headers.authorization,
      apiKey: req.headers['x-api-key'],
      anthropicVersion: req.headers['anthropic-version'],
      body: await readJsonRequest(req),
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(messageStart() + textBlock(0, 'ok') + endMessage());
  });
  const proxy = await startProxy(mock.baseUrl);
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await postMessages(proxy.url, {
    model: 'claude-sonnet-4-5', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  });
  const output = await response.text();

  assert.equal(response.status, 200);
  assert.equal(captured.url, '/v1/messages');
  assert.equal(captured.authorization, 'Bearer upstream-key');
  assert.equal(captured.apiKey, 'upstream-key');
  assert.equal(captured.anthropicVersion, '2023-06-01');
  assert.equal(captured.body.model, 'claude-sonnet-4-5');
  assert.equal(captured.body.temperature, 0.65);
  assert.equal(captured.body.top_p, 0.9);
  assert.equal(captured.body.top_k, 40);
  assert.equal(captured.body.max_tokens, 1000);
  assert.match(output, /"text":"ok"/);
});

test('sends downstream ping heartbeats while upstream thinking is buffered', async (t) => {
  const mock = await startMockVllm(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(messageStart());
    await new Promise((resolve) => setTimeout(resolve, 90));
    res.end(thinkingBlock(0, 'delayed thought') + textBlock(1, 'done') + endMessage());
  });
  const proxy = await startProxy(mock.baseUrl, { HEARTBEAT_INTERVAL_MS: '20' });
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  });
  const events = parseSseText(await response.text());

  assert.equal(events[0].event, 'message_start');
  assert.equal(events.filter((event) => event.event === 'ping').length >= 2, true);
  assert.equal(events.findIndex((event) => event.event === 'ping') > 0, true);
  assert.equal(events.some((event) => event.data.delta?.thinking === 'delayed thought'), true);
  assert.equal(events.at(-1).event, 'message_stop');
});

test('buffers fragmented tool arguments and emits one complete input_json_delta', async (t) => {
  const mock = await startMockVllm(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(messageStart()
      + toolBlock(0, { id: 'toolu_1', name: 'Read', chunks: ['{"file_', 'path":"/work/a.txt"}'] })
      + endMessage('tool_use'));
  });
  const proxy = await startProxy(mock.baseUrl);
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'read' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
  });
  const events = parseSseText(await response.text());
  const deltas = events.filter((event) => event.data.delta?.type === 'input_json_delta');

  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].data.delta.partial_json, '{"file_path":"/work/a.txt"}');
  assert.deepEqual(JSON.parse(deltas[0].data.delta.partial_json), { file_path: '/work/a.txt' });
});

test('detects a loop in one thinking block, retains one cycle, and returns only recovery tool calls', async (t) => {
  let attempts = 0;
  const cycle = 'Hypothesis A is invalid, evaluate hypothesis B.\n';
  const mock = await startMockVllm(async (_req, res) => {
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempts === 1) {
      res.write(messageStart());
      res.write(sse('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }));
      res.write(sse('content_block_delta', {
        type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: 'Prefix.\n' + cycle + cycle + cycle },
      }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (!res.destroyed) res.end();
      return;
    }
    const request = await readJsonRequest(_req).catch(() => null);
    assert.match(JSON.stringify(request?.system), /Preserve all existing progress/i);
    assert.match(JSON.stringify(request?.system), /No approved network tool is available/i);
    res.end(messageStart()
      + thinkingBlock(0, 'Recovery chooses the next action.')
      + toolBlock(1, { id: 'toolu_new', name: 'Read', chunks: ['{"file_path":"/work/a"}'] })
      + endMessage('tool_use'));
  });
  const proxy = await startProxy(mock.baseUrl);
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'do work' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
  });
  const events = parseSseText(await response.text());
  const thinking = events
    .filter((event) => event.data.delta?.type === 'thinking_delta')
    .map((event) => event.data.delta.thinking)
    .join('');
  const toolStarts = events.filter((event) => event.data.content_block?.type === 'tool_use');

  assert.equal(attempts, 2);
  assert.equal((thinking.match(/Hypothesis A is invalid/g) || []).length, 1);
  assert.match(thinking, /Recovery chooses the next action/);
  assert.deepEqual(toolStarts.map((event) => event.data.content_block.id), ['toolu_new']);
});

test('loop recovery forces the configured MCP network tool without reopening task state', async (t) => {
  let attempts = 0;
  const captured = [];
  const cycle = 'Re-evaluate the same unresolved hypothesis without new evidence.\n';
  const mock = await startMockVllm(async (req, res) => {
    attempts += 1;
    captured.push(await readJsonRequest(req));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempts === 1) {
      res.write(messageStart('claude-sonnet-4-6'));
      res.write(sse('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }));
      res.write(sse('content_block_delta', {
        type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: 'Preserved prefix.\n' + cycle + cycle + cycle },
      }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (!res.destroyed) res.end();
      return;
    }

    assert.equal(captured[1].model, 'claude-sonnet-4-6');
    assert.equal(captured[1].temperature, 0.3);
    assert.equal(captured[1].max_tokens, 1024);
    assert.deepEqual(captured[1].tool_choice, {
      type: 'tool', name: 'mcp__searxng__search',
    });
    const system = JSON.stringify(captured[1].system);
    assert.match(system, /Preserve all existing progress/i);
    assert.match(system, /Do not restart, re-plan, re-scope, undo, replace, or reconsider completed work/i);
    assert.match(system, /exactly one complete call/i);
    assert.doesNotMatch(system, /Active Outcome/i);
    assert.doesNotMatch(system, /complete the original user request/i);

    res.end(messageStart('claude-sonnet-4-6')
      + toolBlock(0, {
        id: 'toolu_network', name: 'mcp__searxng__search',
        chunks: ['{"query":"current vLLM 0.23 behavior"}'],
      })
      + endMessage('tool_use'));
  });
  const proxy = await startProxy(mock.baseUrl, {
    RECOVERY_MCP_SEARCH_TOOL_PRIORITY: 'mcp__searxng__search',
  });
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await postMessages(proxy.url, {
    model: 'claude-sonnet-4-6', max_tokens: 8192, temperature: 0.65, stream: true,
    system: 'Keep prior progress.',
    messages: [{ role: 'user', content: 'Continue the existing task.' }],
    tools: [
      { name: 'Read', input_schema: { type: 'object' } },
      { name: 'WebSearch', input_schema: { type: 'object' } },
      { name: 'mcp__searxng__search', input_schema: { type: 'object' } },
    ],
    tool_choice: { type: 'auto' },
  });
  const events = parseSseText(await response.text());
  const toolStarts = events.filter((event) => event.data.content_block?.type === 'tool_use');

  assert.equal(attempts, 2);
  assert.deepEqual(toolStarts.map((event) => event.data.content_block.name), ['mcp__searxng__search']);
  assert.equal(events.filter((event) => event.data.delta?.type === 'text_delta').length, 0);
  assert.equal(events.at(-1).event, 'message_stop');
});

test('forced network recovery rejects a different tool and exposes no partial recovery output', async (t) => {
  let attempts = 0;
  const cycle = 'Repeat unresolved reasoning without evidence.\n';
  const mock = await startMockVllm(async (req, res) => {
    attempts += 1;
    await readJsonRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempts === 1) {
      res.write(messageStart('claude-sonnet-4-6'));
      res.write(sse('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }));
      res.write(sse('content_block_delta', {
        type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: cycle + cycle + cycle },
      }));
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (!res.destroyed) res.end();
      return;
    }
    res.end(messageStart('claude-sonnet-4-6')
      + toolBlock(0, { id: 'toolu_wrong', name: 'Read', chunks: ['{"file_path":"/tmp/x"}'] })
      + endMessage('tool_use'));
  });
  const proxy = await startProxy(mock.baseUrl, {
    RECOVERY_MCP_SEARCH_TOOL_PRIORITY: 'mcp__searxng__search',
  });
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await postMessages(proxy.url, {
    model: 'claude-sonnet-4-6', max_tokens: 8192, stream: true,
    messages: [{ role: 'user', content: 'continue' }],
    tools: [
      { name: 'Read', input_schema: { type: 'object' } },
      { name: 'mcp__searxng__search', input_schema: { type: 'object' } },
    ],
  });
  const events = parseSseText(await response.text());

  assert.equal(attempts, 2);
  assert.equal(events.filter((event) => event.data.content_block?.type === 'tool_use').length, 0);
  assert.equal(events.filter((event) => event.event === 'message_stop').length, 0);
  assert.equal(events.at(-1).event, 'error');
  assert.match(events.at(-1).data.error.message, /recovery contract/i);
});

test('discards an accidentally truncated first stream and returns a complete recovery', async (t) => {
  let attempts = 0;
  const mock = await startMockVllm(async (_req, res) => {
    attempts += 1;
    if (attempts === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(messageStart() + thinkingBlock(0, 'partial thinking') + textBlock(1, 'partial'));
      res.destroy();
      return;
    }
    await readJsonRequest(_req).catch(() => null);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(messageStart() + textBlock(0, 'complete recovery') + endMessage());
  });
  const proxy = await startProxy(mock.baseUrl);
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'do work' }],
  });
  const output = await response.text();

  assert.equal(attempts, 2);
  assert.equal(output.includes('partial thinking'), false);
  assert.equal(output.includes('"text":"partial"'), false);
  assert.equal(output.includes('complete recovery'), true);
});

test('transparently forwards count_tokens without modifying generation fields', async (t) => {
  let captured;
  const mock = await startMockVllm(async (req, res) => {
    captured = await readJsonRequest(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: 123 }));
  });
  const proxy = await startProxy(mock.baseUrl);
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await fetch(`${proxy.url}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'proxy-key' },
    body: JSON.stringify({
      model: 'claude-haiku-3-5', messages: [{ role: 'user', content: 'count' }],
      temperature: 0.2, max_tokens: 100, stream: true,
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { input_tokens: 123 });
  assert.equal(captured.model, 'claude-haiku-3-5');
  assert.equal(captured.temperature, 0.2);
  assert.equal(captured.max_tokens, 100);
  assert.equal(captured.stream, true);
});

test('keeps concurrent request tool arguments isolated', async (t) => {
  const mock = await startMockVllm(async (req, res) => {
    const body = await readJsonRequest(req);
    const value = body.messages[0].content;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const json = JSON.stringify({ request: value });
    const split = Math.floor(json.length / 2);
    await new Promise((resolve) => setTimeout(resolve, Number(value) % 5));
    res.end(messageStart()
      + toolBlock(0, { id: `toolu_${value}`, name: 'Echo', chunks: [json.slice(0, split), json.slice(split)] })
      + endMessage('tool_use'));
  });
  const proxy = await startProxy(mock.baseUrl, { MAX_ACTIVE_REQUESTS: '100' });
  t.after(async () => { await proxy.close(); await mock.close(); });

  const outputs = await Promise.all(Array.from({ length: 30 }, async (_, index) => {
    const response = await postMessages(proxy.url, {
      model: 'claude-sonnet-4-5', max_tokens: 1000, stream: true,
      messages: [{ role: 'user', content: String(index) }],
      tools: [{ name: 'Echo', input_schema: { type: 'object' } }],
    });
    const events = parseSseText(await response.text());
    const delta = events.find((event) => event.data.delta?.type === 'input_json_delta');
    return JSON.parse(delta.data.delta.partial_json).request;
  }));

  assert.deepEqual(outputs, Array.from({ length: 30 }, (_, index) => String(index)));
});

test('rejects requests over capacity before opening SSE', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const mock = await startMockVllm(async (_req, res) => {
    await gate;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(messageStart() + textBlock(0, 'done') + endMessage());
  });
  const proxy = await startProxy(mock.baseUrl, { MAX_ACTIVE_REQUESTS: '1' });
  t.after(async () => { release(); await proxy.close(); await mock.close(); });

  const firstPromise = postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'first' }],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'second' }],
  });

  assert.equal(second.status, 503);
  assert.match(second.headers.get('content-type'), /application\/json/);
  release();
  const first = await firstPromise;
  assert.equal(first.status, 200);
  await first.text();
});


test('upstream idle timeout aborts the corresponding vLLM stream before emitting an SSE error', async (t) => {
  let upstreamClosed = false;
  const mock = await startMockVllm(async (_req, res) => {
    res.on('close', () => { upstreamClosed = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(messageStart());
  });
  const proxy = await startProxy(mock.baseUrl, {
    UPSTREAM_IDLE_TIMEOUT_MS: '50',
    MAX_RECOVERY_ATTEMPTS: '0',
  });
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'hang' }],
  });
  const events = parseSseText(await response.text());
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(events.at(-1).event, 'error');
  assert.match(events.at(-1).data.error.message, /idle|interrupted/i);
  assert.equal(upstreamClosed, true);
});

test('malformed tool JSON is never exposed and a complete recovery tool call is emitted once', async (t) => {
  let attempts = 0;
  const mock = await startMockVllm(async (_req, res) => {
    attempts += 1;
    await readJsonRequest(_req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempts === 1) {
      res.end(messageStart()
        + toolBlock(0, { id: 'toolu_bad', name: 'Read', chunks: ['{"file_path":'] })
        + endMessage('tool_use'));
      return;
    }
    res.end(messageStart()
      + toolBlock(0, { id: 'toolu_good', name: 'Read', chunks: ['{"file_path":"/work/good.txt"}'] })
      + endMessage('tool_use'));
  });
  const proxy = await startProxy(mock.baseUrl);
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'read' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
  });
  const events = parseSseText(await response.text());
  const starts = events.filter((event) => event.data.content_block?.type === 'tool_use');
  const deltas = events.filter((event) => event.data.delta?.type === 'input_json_delta');

  assert.equal(attempts, 2);
  assert.deepEqual(starts.map((event) => event.data.content_block.id), ['toolu_good']);
  assert.deepEqual(deltas.map((event) => event.data.delta.partial_json), ['{"file_path":"/work/good.txt"}']);
  assert.equal(events.at(-1).event, 'message_stop');
});

test('second invalid generation emits one Anthropic SSE error without partial tool or message_stop', async (t) => {
  let attempts = 0;
  const mock = await startMockVllm(async (req, res) => {
    attempts += 1;
    await readJsonRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(messageStart()
      + toolBlock(0, { id: `toolu_bad_${attempts}`, name: 'Read', chunks: ['{"file_path":'] })
      + endMessage('tool_use'));
  });
  const proxy = await startProxy(mock.baseUrl);
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'read' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
  });
  const events = parseSseText(await response.text());

  assert.equal(attempts, 2);
  assert.equal(events.filter((event) => event.event === 'message_start').length, 1);
  assert.equal(events.filter((event) => event.data.content_block?.type === 'tool_use').length, 0);
  assert.equal(events.filter((event) => event.event === 'message_stop').length, 0);
  assert.equal(events.at(-1).event, 'error');
  assert.match(events.at(-1).data.error.message, /recovery attempt/i);
});

test('rejects invalid authentication and oversized request bodies before opening SSE', async (t) => {
  const mock = await startMockVllm(async (_req, res) => {
    res.writeHead(500);
    res.end();
  });
  const proxy = await startProxy(mock.baseUrl, { MAX_REQUEST_BODY_BYTES: '1024' });
  t.after(async () => { await proxy.close(); await mock.close(); });

  const unauthorized = await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'wrong' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('content-type'), /application\/json/);

  const oversized = await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'proxy-key' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'x'.repeat(2048) }] }),
  });
  assert.equal(oversized.status, 413);
  assert.match(oversized.headers.get('content-type'), /application\/json/);
});

test('drain rejects new work while allowing an existing request to finish', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const mock = await startMockVllm(async (_req, res) => {
    await readJsonRequest(_req);
    await gate;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(messageStart() + textBlock(0, 'existing completed') + endMessage());
  });
  const proxy = await startProxy(mock.baseUrl);
  t.after(async () => { release(); await proxy.close(); await mock.close(); });

  const existingPromise = postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'existing' }],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await proxy.app.drain();

  const ready = await fetch(`${proxy.url}/health/ready`);
  const rejected = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'new' }],
  });
  assert.equal(ready.status, 503);
  assert.equal(rejected.status, 503);

  release();
  const existing = await existingPromise;
  const output = await existing.text();
  assert.equal(existing.status, 200);
  assert.match(output, /existing completed/);
});

test('client cancellation aborts only its own upstream generation and does not affect another request', async (t) => {
  let slowClosed = false;
  const mock = await startMockVllm(async (req, res) => {
    const body = await readJsonRequest(req);
    const content = body.messages[0].content;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (content === 'slow') {
      res.on('close', () => { slowClosed = true; });
      res.write(messageStart());
      return;
    }
    res.end(messageStart() + textBlock(0, 'fast completed') + endMessage());
  });
  const proxy = await startProxy(mock.baseUrl, { HEARTBEAT_INTERVAL_MS: '20' });
  t.after(async () => { await proxy.close(); await mock.close(); });

  const controller = new AbortController();
  const slowResponse = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'slow' }],
  }, { signal: controller.signal });
  controller.abort();
  await slowResponse.text().catch(() => {});

  const fastResponse = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'fast' }],
  });
  const fastOutput = await fastResponse.text();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(fastResponse.status, 200);
  assert.match(fastOutput, /fast completed/);
  assert.equal(slowClosed, true);
});

test('global buffered-memory budget fails closed and releases the reservation after the request', async (t) => {
  const mock = await startMockVllm(async (_req, res) => {
    await readJsonRequest(_req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(messageStart() + textBlock(0, 'x'.repeat(4096)) + endMessage());
  });
  const proxy = await startProxy(mock.baseUrl, {
    MAX_TOTAL_BUFFERED_BYTES: '1024',
    MAX_RECOVERY_ATTEMPTS: '0',
  });
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'large' }],
  });
  const events = parseSseText(await response.text());

  assert.equal(events.at(-1).event, 'error');
  assert.match(events.at(-1).data.error.message, /buffer/i);
  assert.equal(proxy.app.bufferBudget.currentBytes, 0);
});

test('active-request admission limit also counts count_tokens and non-streaming requests', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const mock = await startMockVllm(async (req, res) => {
    await readJsonRequest(req);
    await gate;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: 10 }));
  });
  const proxy = await startProxy(mock.baseUrl, { MAX_ACTIVE_REQUESTS: '1' });
  t.after(async () => { release(); await proxy.close(); await mock.close(); });

  const firstPromise = fetch(`${proxy.url}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'proxy-key' },
    body: JSON.stringify({ model: 'claude-haiku-3-5', messages: [{ role: 'user', content: 'count' }] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const second = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'second' }],
  });
  assert.equal(second.status, 503);

  release();
  const first = await firstPromise;
  assert.equal(first.status, 200);
  await first.text();
});

test('thinking-only max_tokens response is recovered instead of being committed as a completed turn', async (t) => {
  let attempts = 0;
  const mock = await startMockVllm(async (req, res) => {
    attempts += 1;
    await readJsonRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempts === 1) {
      res.end(messageStart() + thinkingBlock(0, 'long reasoning without action') + endMessage('max_tokens'));
      return;
    }
    res.end(messageStart() + textBlock(0, 'recovered final response') + endMessage('end_turn'));
  });
  const proxy = await startProxy(mock.baseUrl);
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'finish the task' }],
  });
  const output = await response.text();

  assert.equal(attempts, 2);
  assert.equal(output.includes('long reasoning without action'), false);
  assert.match(output, /recovered final response/);
  assert.match(output, /"stop_reason":"end_turn"/);
});

test('messages request without stream uses non-streaming forwarding semantics', async (t) => {
  let captured;
  const mock = await startMockVllm(async (req, res) => {
    captured = await readJsonRequest(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_nonstream',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'non-stream response' }],
      model: 'Ornith-1.0-35B-NVFP4',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    }));
  });
  const proxy = await startProxy(mock.baseUrl);
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000,
    messages: [{ role: 'user', content: 'nonstream' }],
  });
  const output = await response.json();

  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(captured.stream, undefined);
  assert.equal(output.content[0].text, 'non-stream response');
});

test('per-attempt response buffer limit aborts immediately and recovers without waiting for total timeout', async (t) => {
  let attempts = 0;
  let firstClosed = false;
  const mock = await startMockVllm(async (req, res) => {
    attempts += 1;
    await readJsonRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (attempts === 1) {
      res.on('close', () => { firstClosed = true; });
      res.write(messageStart());
      await new Promise((resolve) => setImmediate(resolve));
      res.write(textBlock(0, 'x'.repeat(4096)));
      const timer = setInterval(() => res.write(sse('ping', { type: 'ping' })), 10);
      timer.unref?.();
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.end(messageStart() + textBlock(0, 'recovered after buffer limit') + endMessage());
  });
  const proxy = await startProxy(mock.baseUrl, {
    MAX_RESPONSE_BUFFER_BYTES: '1024',
    TOTAL_GENERATION_TIMEOUT_MS: '2000',
    SEMANTIC_STALL_TIMEOUT_MS: '3000',
  });
  t.after(async () => { await proxy.close(); await mock.close(); });

  const started = Date.now();
  const response = await postMessages(proxy.url, {
    model: 'claude-opus-4-1', max_tokens: 1000, stream: true,
    messages: [{ role: 'user', content: 'buffer test' }],
  });
  const output = await response.text();
  const elapsed = Date.now() - started;

  assert.equal(attempts, 2);
  assert.equal(firstClosed, true);
  assert.match(output, /recovered after buffer limit/);
  assert.ok(elapsed < 500, `expected immediate limit handling, got ${elapsed}ms`);
});

test('transparently forwards count_tokens with the exact model and raw JSON body', async (t) => {
  let captured;
  const mock = await startMockVllm(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
      rawBody: Buffer.concat(chunks).toString('utf8'),
    };
    res.writeHead(207, {
      'content-type': 'application/json',
      'x-upstream-marker': 'count-tokens',
    });
    res.end('{"input_tokens":321}');
  });
  const proxy = await startProxy(mock.baseUrl);
  t.after(async () => { await proxy.close(); await mock.close(); });

  const rawBody = '{\n  "model": "claude-sonnet-4-6",\n  "messages": [{"role":"user","content":"count"}]\n}';
  const response = await fetch(`${proxy.url}/v1/messages/count_tokens?beta=1`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'proxy-key',
      'anthropic-version': '2023-06-01',
    },
    body: rawBody,
  });

  assert.equal(response.status, 207);
  assert.equal(response.headers.get('x-upstream-marker'), 'count-tokens');
  assert.equal(await response.text(), '{"input_tokens":321}');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.url, '/v1/messages/count_tokens?beta=1');
  assert.equal(captured.authorization, 'Bearer upstream-key');
  assert.equal(captured.contentType, 'application/json');
  assert.equal(captured.rawBody, rawBody);
});

test('transparently forwards non-message paths, methods, queries, status, headers, and bytes', async (t) => {
  let captured;
  const mock = await startMockVllm(async (req, res) => {
    captured = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
    };
    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'x-upstream-marker': 'models',
    });
    res.end(Buffer.from([0, 1, 2, 255]));
  });
  const proxy = await startProxy(mock.baseUrl);
  t.after(async () => { await proxy.close(); await mock.close(); });

  const response = await fetch(`${proxy.url}/v1/models?limit=7`, {
    method: 'GET',
    headers: { 'x-api-key': 'proxy-key' },
  });

  assert.equal(response.status, 206);
  assert.equal(response.headers.get('x-upstream-marker'), 'models');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 1, 2, 255]);
  assert.equal(captured.method, 'GET');
  assert.equal(captured.url, '/v1/models?limit=7');
  assert.equal(captured.authorization, 'Bearer upstream-key');
});


test('transparent forwarding pins absolute-form request targets to the configured vLLM origin', async (t) => {
  let capturedUrl;
  const mock = await startMockVllm(async (req, res) => {
    capturedUrl = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const proxy = await startProxy(mock.baseUrl);
  t.after(async () => { await proxy.close(); await mock.close(); });

  const proxyAddress = new URL(proxy.url);
  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: proxyAddress.hostname,
      port: proxyAddress.port,
      method: 'GET',
      path: 'http://untrusted.invalid/v1/models?limit=9',
      headers: { 'x-api-key': 'proxy-key' },
    }, async (res) => {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
    });
    req.once('error', reject);
    req.end();
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, '{"ok":true}');
  assert.equal(capturedUrl, '/v1/models?limit=9');
});
