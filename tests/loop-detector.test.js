import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectThinkingLoop,
  loadConfig,
  mergeRecovery,
} from '../vllm-cc-proxy.js';

function config(overrides = {}) {
  return loadConfig({
    LOOP_MIN_PATTERN_SIZE: '12',
    LOOP_MAX_PATTERN_SIZE: '160',
    LOOP_MIN_COUNT: '2',
    LOOP_REASONING_CHAR_LIMIT: '5000',
    ...overrides,
  });
}

function attempt({ thinking = [], text = [], tools = [], stopReason = 'end_turn' }) {
  const blocks = [];
  let index = 0;
  for (const value of thinking) {
    blocks.push({
      upstreamIndex: index++, type: 'thinking', start: { type: 'thinking', thinking: '' },
      stopped: true, thinking: value, signature: 'upstream', text: '', rawDeltas: [],
    });
  }
  for (const value of text) {
    blocks.push({
      upstreamIndex: index++, type: 'text', start: { type: 'text', text: '' },
      stopped: true, text: value, thinking: '', rawDeltas: [],
    });
  }
  for (const value of tools) {
    blocks.push({
      upstreamIndex: index++, type: 'tool_use', start: { type: 'tool_use' }, stopped: true,
      id: value.id, name: value.name, partialJson: JSON.stringify(value.input), input: value.input,
      thinking: '', text: '', rawDeltas: [],
    });
  }
  return {
    messageStart: { message: { model: 'Ornith', usage: { input_tokens: 10, output_tokens: 1 } } },
    messageDelta: { usage: { output_tokens: 10 } },
    messageStopped: true,
    stopReason,
    stopSequence: null,
    blocks,
    unknownEvents: [],
    pingCount: 0,
    errorEvent: null,
    structuralErrors: [],
    bytes: 100,
  };
}

test('detects adjacent exact repetition and retains one unique cycle', () => {
  const prefix = 'Inspect the repository and identify the next action.\n';
  const cycle = 'Hypothesis A is invalid, so evaluate hypothesis B.\n';
  const text = prefix + cycle + cycle + cycle;

  const loop = detectThinkingLoop(text, config());

  assert.equal(loop.reason, 'repeated_reasoning_segment');
  assert.equal(text.slice(0, loop.retainEnd), prefix + cycle);
  assert.equal(loop.cycleStart, prefix.length);
  assert.equal(loop.repeatCount >= 2, true);
});

test('detects normalized repetition despite whitespace and punctuation changes', () => {
  const prefix = 'Initial evidence collected.\n';
  const first = 'Check state: no new evidence; choose tool call now.\n';
  const second = 'CHECK   STATE -- no new evidence, choose tool call now!!!\n';

  const loop = detectThinkingLoop(prefix + first + second, config());

  assert.equal(loop.reason, 'normalized_reasoning_segment');
  assert.equal((prefix + first + second).slice(0, loop.retainEnd), prefix + first);
});

test('detects A-B-A-B loop as one two-segment cycle', () => {
  const prefix = 'Start analysis.\n';
  const a = 'A: inspect the configuration.\n';
  const b = 'B: reconsider the same assumption.\n';
  const text = prefix + a + b + a + b;

  const loop = detectThinkingLoop(text, config());

  assert.equal(loop.reason, 'abab_reasoning_loop');
  assert.equal(text.slice(0, loop.retainEnd), prefix + a + b);
});

test('detects zero-delta correction when correction repeats unchanged reasoning', () => {
  const text = [
    'The issue is the provider configuration and I should inspect it next.',
    'Wait, correction.',
    'The issue is the provider configuration and I should inspect it next.',
  ].join('\n');

  const loop = detectThinkingLoop(text, config());

  assert.equal(loop.reason, 'zero_delta_correction');
  assert.equal(text.slice(0, loop.retainEnd), text.split('\n').slice(0, 2).join('\n'));
});

test('does not classify repeated fenced code or log records as a reasoning loop', () => {
  const code = [
    '```text',
    'retry=1 status=pending',
    'retry=1 status=pending',
    'retry=1 status=pending',
    '```',
  ].join('\n');
  const logs = [
    '2026-07-17T10:00:00Z worker=1 status=pending',
    '2026-07-17T10:00:01Z worker=1 status=pending',
    '2026-07-17T10:00:02Z worker=1 status=pending',
  ].join('\n');

  assert.equal(detectThinkingLoop(code, config()), null);
  assert.equal(detectThinkingLoop(logs, config()), null);
});



test('detects long two-space-wrapped technical prose with variable wrapping and a partial next cycle', () => {
  const sentences = [
    'The fix is to call it inside the read loop after data has been written to rbio, or just call it once at the start and let the loop handle the WANT_READ state properly.',
    'Looking at the actual flow: the client connects, sends ClientHello, the server reads it into rbio, then calls SSL_accept which should process that data and return 1.',
    "I'm realizing the issue might be that SSL_accept is being called before any data arrives in rbio, so it returns WANT_READ immediately.",
  ];
  const wrap = (value, width) => {
    const words = value.split(' ');
    const lines = [];
    let line = '  ';
    for (const word of words) {
      if (line.length + word.length + 1 > width) {
        lines.push(line);
        line = `  ${word}`;
      } else {
        line += `${line.trim() ? ' ' : ''}${word}`;
      }
    }
    lines.push(line);
    return lines.join('\n');
  };
  const cycleA = sentences.map((sentence) => wrap(sentence, 76)).join('\n');
  const cycleB = sentences.map((sentence) => wrap(sentence, 68)).join('\n');
  const cycleC = sentences.map((sentence) => wrap(sentence, 82)).join('\n');
  const partial = wrap(sentences[0].slice(0, 88), 64);
  const text = `Initial TLS observation.\n${cycleA}\n${cycleB}\n${cycleC}\n${partial}`;

  const loop = detectThinkingLoop(text, config({
    LOOP_MAX_PATTERN_SIZE: '2048',
    LOOP_SCAN_INTERVAL_CHARS: '64',
  }));

  assert.ok(loop);
  assert.match(loop.reason, /sentence|reasoning_segment|tandem/);
  assert.match(text.slice(0, loop.retainEnd), /Initial TLS observation/);
  assert.equal(text.slice(0, loop.retainEnd).includes(cycleB), false);
});

test('detects a normalized cycle longer than 384 characters before a partial trailing repeat', () => {
  const cycle = [
    'Inspect the TLS state machine using only observable transitions and preserve all prior verified progress.',
    'Confirm whether ciphertext was written to rbio before SSL_accept and whether pending wbio output was drained.',
    'Use the next concrete diagnostic action instead of restating the same hypothesis without new evidence.',
    'Record the exact SSL_get_error result and the BIO pending byte counts before revising the implementation.',
  ].join(' ');
  assert.ok(cycle.length > 384);
  const text = `Prefix evidence. ${cycle} ${cycle} ${cycle.slice(0, 72)}`;

  const loop = detectThinkingLoop(text, config({ LOOP_MAX_PATTERN_SIZE: '2048' }));

  assert.ok(loop);
  assert.equal(loop.cycleLength > 384, true);
  assert.equal(text.slice(0, loop.retainEnd).includes(cycle + ' ' + cycle), false);
});

test('does not treat ordinary two-space prose wrapping as code', () => {
  const cycle = [
    '  This is ordinary wrapped reasoning text without programming syntax.',
    '  It repeats because the model is stuck, not because it is quoting code.',
  ].join('\n');
  const loop = detectThinkingLoop(`${cycle}\n${cycle}`, config({ LOOP_MAX_PATTERN_SIZE: '512' }));
  assert.ok(loop);
});

test('still exempts strongly code-like indented repeated regions', () => {
  const code = [
    '  if (ret <= 0) {',
    '    error = SSL_get_error(ssl, ret);',
    '  }',
    '  if (ret <= 0) {',
    '    error = SSL_get_error(ssl, ret);',
    '  }',
  ].join('\n');
  assert.equal(detectThinkingLoop(code, config({ LOOP_MAX_PATTERN_SIZE: '512' })), null);
});

test('mergeRecovery discards all failed-attempt thinking and returns only the complete recovery attempt', () => {
  const firstText = 'Prefix.\nCycle action.\nCycle action.\n';
  const loop = detectThinkingLoop(firstText, config());
  const first = attempt({
    thinking: [firstText],
    text: ['discard this text'],
    tools: [{ id: 'toolu_old', name: 'Bash', input: { command: 'danger' } }],
    stopReason: 'tool_use',
  });
  const second = attempt({
    thinking: ['Recovery selects a concrete action.'],
    tools: [{ id: 'toolu_new', name: 'Read', input: { file_path: '/work/a' } }],
    stopReason: 'tool_use',
  });

  const merged = mergeRecovery(first, second, { ...loop, blockIndex: 0 });

  assert.equal(merged.stopReason, 'tool_use');
  assert.equal(merged.blocks[0].type, 'thinking');
  assert.equal(merged.blocks[0].thinking, 'Recovery selects a concrete action.');
  assert.equal(merged.blocks.some((block) => String(block.thinking || '').includes('Prefix.')), false);
  assert.equal(merged.blocks.some((block) => block.text === 'discard this text'), false);
  assert.deepEqual(merged.blocks.filter((block) => block.type === 'tool_use').map((block) => block.id), ['toolu_new']);
  assert.equal(merged.bytes, second.bytes);
});

test('mergeRecovery returns only the complete recovery attempt for accidental truncation', () => {
  const first = attempt({ thinking: ['partial thought'], text: ['partial text'] });
  const second = attempt({ text: ['complete recovery'] });

  const merged = mergeRecovery(first, second, null);

  assert.deepEqual(merged.blocks.map((block) => block.text).filter(Boolean), ['complete recovery']);
  assert.equal(merged.blocks.some((block) => block.thinking === 'partial thought'), false);
});
