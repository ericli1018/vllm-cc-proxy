import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  AnthropicSseParser,
  loadConfig,
  serializeValidatedResponse,
  validateAttempt,
} from '../vllm-cc-proxy.js';

const config = loadConfig({ LOG_LEVEL: 'silent' });

async function parseFixture(name, splitSize = 17) {
  const raw = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
  const parser = new AnthropicSseParser(config);
  for (let offset = 0; offset < raw.length; offset += splitSize) {
    parser.push(raw.subarray(offset, offset + splitSize));
  }
  return parser.finish();
}

test('golden text stream remains structurally valid across arbitrary transport splits', async () => {
  const result = await parseFixture('text-response.sse', 11);
  const validation = validateAttempt(result, config);

  assert.equal(validation.ok, true);
  assert.equal(result.blocks[0].text, 'fixture text');
  assert.equal(result.stopReason, 'end_turn');
});

test('golden fragmented tool stream is assembled and serialized as one complete JSON delta', async () => {
  const result = await parseFixture('fragmented-tool-response.sse', 13);
  const validation = validateAttempt(result, config);
  const output = serializeValidatedResponse(result, {
    messageId: 'msg_proxy_fixture',
    signature: 'proxy_signature',
    model: 'Ornith-1.0-35B-NVFP4',
  });

  assert.equal(validation.ok, true);
  assert.deepEqual(result.blocks[0].input, {
    file_path: '/work/a.txt', old_string: 'a', new_string: 'b',
  });
  assert.equal((output.match(/input_json_delta/g) || []).length, 1);
  assert.match(output, /\\"file_path\\":\\"\/work\/a\.txt\\"/);
});

test('golden malformed tool stream is rejected before any tool block is eligible for output', async () => {
  const result = await parseFixture('malformed-tool-response.sse', 19);
  const validation = validateAttempt(result, config);

  assert.equal(validation.ok, false);
  assert.match(validation.reason, /tool/i);
});
