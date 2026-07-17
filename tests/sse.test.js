import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AnthropicSseParser,
  loadConfig,
  serializeValidatedResponse,
  validateAttempt,
} from '../vllm-cc-proxy.js';

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseInFragments(text, fragmentSizes = [1, 7, 3, 19, 2, 31]) {
  const parser = new AnthropicSseParser(loadConfig({}));
  let offset = 0;
  let i = 0;
  while (offset < text.length) {
    const size = fragmentSizes[i++ % fragmentSizes.length];
    parser.push(text.slice(offset, offset + size));
    offset += size;
  }
  return parser.finish();
}

function baseStart() {
  return frame('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_upstream',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'Ornith-1.0-35B-NVFP4',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
}

function finish(stopReason = 'end_turn') {
  return frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 20 },
  }) + frame('message_stop', { type: 'message_stop' });
}

test('parser reconstructs thinking, signature, text, and message lifecycle across arbitrary chunks', () => {
  const stream = baseStart()
    + frame('ping', { type: 'ping' })
    + frame('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'thinking', thinking: '' },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'thinking_delta', thinking: 'inspect state' },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'signature_delta', signature: 'upstream-signature' },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + frame('content_block_start', {
      type: 'content_block_start', index: 1,
      content_block: { type: 'text', text: '' },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 1,
      delta: { type: 'text_delta', text: 'done' },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 1 })
    + finish('end_turn');

  const result = parseInFragments(stream);
  const validation = validateAttempt(result, loadConfig({}));

  assert.equal(validation.ok, true);
  assert.equal(result.pingCount, 1);
  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0].type, 'thinking');
  assert.equal(result.blocks[0].thinking, 'inspect state');
  assert.equal(result.blocks[0].signature, 'upstream-signature');
  assert.equal(result.blocks[1].type, 'text');
  assert.equal(result.blocks[1].text, 'done');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.messageStopped, true);
});

test('parser assembles fragmented tool JSON only at content_block_stop', () => {
  const stream = baseStart()
    + frame('content_block_start', {
      type: 'content_block_start', index: 2,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"file_' },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 2,
      delta: { type: 'input_json_delta', partial_json: 'path":"/work/a.txt"}' },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 2 })
    + finish('tool_use');

  const result = parseInFragments(stream);
  const validation = validateAttempt(result, loadConfig({}));

  assert.equal(validation.ok, true);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].type, 'tool_use');
  assert.equal(result.blocks[0].id, 'toolu_1');
  assert.equal(result.blocks[0].name, 'Read');
  assert.equal(result.blocks[0].partialJson, '{"file_path":"/work/a.txt"}');
  assert.deepEqual(result.blocks[0].input, { file_path: '/work/a.txt' });
});

test('parser keeps multiple tool calls isolated by content block index', () => {
  const stream = baseStart()
    + frame('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + frame('content_block_start', {
      type: 'content_block_start', index: 1,
      content_block: { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: {} },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 1 })
    + finish('tool_use');

  const result = parseInFragments(stream);
  assert.equal(validateAttempt(result, loadConfig({})).ok, true);
  assert.deepEqual(result.blocks.map((block) => block.input), [
    { path: 'a' },
    { command: 'pwd' },
  ]);
});

test('validation rejects malformed or incomplete tool blocks', () => {
  const malformed = parseInFragments(baseStart()
    + frame('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'toolu_bad', name: 'Edit', input: {} },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"path":' },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + finish('tool_use'));

  assert.deepEqual(validateAttempt(malformed, loadConfig({})), {
    ok: false,
    reason: 'malformed_tool_json',
    detail: 'tool block 0 contains invalid JSON',
  });

  const missingStop = parseInFragments(baseStart()
    + frame('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'partial' },
    }));

  assert.equal(validateAttempt(missingStop, loadConfig({})).reason, 'missing_message_stop');
});

test('validation rejects stop_reason inconsistent with emitted tool calls', () => {
  const stream = baseStart()
    + frame('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + finish('end_turn');

  const validation = validateAttempt(parseInFragments(stream), loadConfig({}));
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'tool_stop_reason_mismatch');
});

test('unknown complete events and blocks are retained without breaking validation', () => {
  const stream = baseStart()
    + frame('future_event', { type: 'future_event', value: 1 })
    + frame('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'future_block', payload: 'a' },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'future_delta', payload: 'b' },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + finish('end_turn');

  const result = parseInFragments(stream);
  assert.equal(validateAttempt(result, loadConfig({})).ok, true);
  assert.equal(result.unknownEvents.length, 1);
  assert.equal(result.blocks[0].type, 'future_block');
  assert.equal(result.blocks[0].rawDeltas.length, 1);
});

test('serializer emits one fresh legal stream and one complete JSON delta per tool call', () => {
  const stream = baseStart()
    + frame('content_block_start', {
      type: 'content_block_start', index: 4,
      content_block: { type: 'thinking', thinking: '' },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 4,
      delta: { type: 'thinking_delta', thinking: 'reason' },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 4,
      delta: { type: 'signature_delta', signature: 'old-signature' },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 4 })
    + frame('content_block_start', {
      type: 'content_block_start', index: 9,
      content_block: { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: {} },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 9,
      delta: { type: 'input_json_delta', partial_json: '{"command":' },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 9,
      delta: { type: 'input_json_delta', partial_json: '"pwd"}' },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 9 })
    + finish('tool_use');

  const result = parseInFragments(stream);
  assert.equal(validateAttempt(result, loadConfig({})).ok, true);
  const output = serializeValidatedResponse(result, {
    messageId: 'msg_proxy_test',
    signature: 'proxy-signature',
  });

  assert.equal((output.match(/event: message_start/g) || []).length, 1);
  assert.equal((output.match(/event: message_stop/g) || []).length, 1);
  assert.equal(output.includes('old-signature'), false);
  assert.equal(output.includes('proxy-signature'), true);
  assert.equal(output.includes('"index":0'), true);
  assert.equal(output.includes('"index":1'), true);
  const inputJsonDeltas = output.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((event) => event.delta?.type === 'input_json_delta');
  assert.equal(inputJsonDeltas.length, 1);
  assert.equal(inputJsonDeltas[0].delta.partial_json, '{"command":"pwd"}');
});

test('validation rejects a completed response that contains thinking but no final text or tool call', () => {
  const stream = baseStart()
    + frame('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'thinking', thinking: '' },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'thinking_delta', thinking: 'reasoning without an action' },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'signature_delta', signature: 'sig' },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + finish('max_tokens');

  const validation = validateAttempt(parseInFragments(stream), loadConfig({}));
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'thinking_without_output');
});

test('validation rejects no-op Edit or Update calls whose old_string and new_string are identical', () => {
  const stream = baseStart()
    + frame('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'toolu_noop', name: 'Update', input: {} },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({
          file_path: '/work/src/tls_common.h',
          old_string: 'same text',
          new_string: 'same text',
        }),
      },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + finish('tool_use');

  const validation = validateAttempt(parseInFragments(stream), loadConfig({}));
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'no_op_edit_tool_call');
});

test('validation accepts a meaningful Edit call whose replacement differs', () => {
  const stream = baseStart()
    + frame('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: {} },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({
          file_path: '/work/src/tls_common.h',
          old_string: 'before',
          new_string: 'after',
        }),
      },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + finish('tool_use');

  assert.equal(validateAttempt(parseInFragments(stream), loadConfig({})).ok, true);
});

test('validation rejects an identical edit call that already failed in request history', () => {
  const toolInput = {
    file_path: '/work/src/tls_common.h',
    old_string: 'before',
    new_string: 'after',
  };
  const requestInput = {
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_previous', name: 'Edit', input: toolInput }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_previous',
          is_error: true,
          content: 'Error: old_string was not found',
        }],
      },
    ],
  };
  const stream = baseStart()
    + frame('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'toolu_repeat', name: 'Edit', input: {} },
    })
    + frame('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
    })
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + finish('tool_use');

  const validation = validateAttempt(parseInFragments(stream), loadConfig({}), requestInput);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'repeated_failed_edit_tool_call');
});
