import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createProxyServer, loadConfig } from '../vllm-cc-proxy.js';

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function toolResponse(id) {
  const input = JSON.stringify({ request: id, path: `/workspace/${id}.txt` });
  const split = Math.max(1, Math.floor(input.length / 3));
  const chunks = [input.slice(0, split), input.slice(split, split * 2), input.slice(split * 2)];
  let output = sse('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${id}`, type: 'message', role: 'assistant', content: [],
      model: 'Ornith-1.0-35B-NVFP4', stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  output += sse('content_block_start', {
    type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: `toolu_${id}`, name: 'Write', input: {} },
  });
  for (const chunk of chunks) {
    output += sse('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: chunk },
    });
  }
  output += sse('content_block_stop', { type: 'content_block_stop', index: 0 });
  output += sse('message_delta', {
    type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  output += sse('message_stop', { type: 'message_stop' });
  return output;
}


function parseEvents(text) {
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

async function readJsonRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  server.closeAllConnections?.();
  await once(server, 'close');
}

test('high-concurrency requests keep fragmented tool calls isolated', { timeout: 120_000 }, async (t) => {
  const count = Number.parseInt(process.env.LOAD_SMOKE_REQUESTS || '100', 10);
  assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 5000);

  const upstream = http.createServer(async (req, res) => {
    const body = await readJsonRequest(req);
    const id = body.messages[0].content;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(toolResponse(id));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();

  const config = {
    ...loadConfig({
      VLLM_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}`,
      VLLM_API_KEY: 'upstream-key',
      PROXY_API_KEY: 'proxy-key',
      REAL_MODEL: 'Ornith-1.0-35B-NVFP4',
      MAX_ACTIVE_REQUESTS: String(count + 10),
      MAX_TOTAL_BUFFERED_BYTES: String(256 * 1024 * 1024),
      HEARTBEAT_INTERVAL_MS: '1000',
      LOG_LEVEL: 'silent',
    }),
    heartbeatIntervalMs: 1000,
    totalGenerationTimeoutMs: 60_000,
    recoveryTimeoutMs: 30_000,
  };
  const proxy = createProxyServer(config);
  await proxy.listen(0, '127.0.0.1');
  const proxyAddress = proxy.address();
  const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;

  t.after(async () => {
    await proxy.close({ force: true });
    await closeServer(upstream);
  });

  const results = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const id = `request_${index}`;
    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'proxy-key',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5', max_tokens: 1000, stream: true,
        messages: [{ role: 'user', content: id }],
      }),
    });
    const text = await response.text();
    return { id, status: response.status, text };
  }));

  for (const { id, status, text } of results) {
    assert.equal(status, 200, id);
    const events = parseEvents(text);
    const toolStart = events.find((event) => event.event === 'content_block_start' && event.data.content_block?.type === 'tool_use');
    const toolDeltas = events.filter((event) => event.event === 'content_block_delta' && event.data.delta?.type === 'input_json_delta');
    assert.equal(toolStart?.data.content_block.id, `toolu_${id}`, id);
    assert.equal(toolDeltas.length, 1, id);
    assert.deepEqual(JSON.parse(toolDeltas[0].data.delta.partial_json), {
      request: id,
      path: `/workspace/${id}.txt`,
    }, id);
  }

  assert.equal(proxy.admittedRequests, 0);
  assert.equal(proxy.bufferBudget.currentBytes, 0);
});
