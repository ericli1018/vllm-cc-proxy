import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRequestPolicy,
  loadConfig,
} from '../vllm-cc-proxy.js';

test('loadConfig ignores legacy model alias environment variables', () => {
  const config = loadConfig({
    VLLM_BASE_URL: 'http://vllm:8001/',
    VLLM_API_KEY: 'upstream-secret',
    PROXY_API_KEY: 'downstream-secret',
    REAL_MODEL: 'legacy-model-must-be-ignored',
    MODEL_ALIASES_JSON: JSON.stringify({ sonnet: 'legacy-target-must-be-ignored' }),
    HEARTBEAT_INTERVAL_MS: '12000',
    MAX_ACTIVE_REQUESTS: '4000',
  });

  assert.equal(config.vllmBaseUrl, 'http://vllm:8001');
  assert.equal(config.vllmApiKey, 'upstream-secret');
  assert.equal(config.proxyApiKey, 'downstream-secret');
  assert.equal(Object.hasOwn(config, 'realModel'), false);
  assert.equal(Object.hasOwn(config, 'modelAliases'), false);
  assert.equal(config.heartbeatIntervalMs, 12000);
  assert.equal(config.maxActiveRequests, 4000);
  assert.deepEqual(config.samplingDefaults, {
    temperature: 0.65,
    top_p: 0.9,
    top_k: 40,
    max_tokens: 8192,
  });
});

test('applyRequestPolicy preserves legal client sampling and required Anthropic fields', () => {
  const config = loadConfig({});
  const input = {
    model: 'claude-sonnet-4-5',
    max_tokens: 1234,
    temperature: 0.3,
    top_p: 0.8,
    top_k: 17,
    stream: true,
    system: [{ type: 'text', text: 'system' }],
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto' },
    stop_sequences: ['STOP'],
    metadata: { user_id: 'u1' },
  };

  const output = applyRequestPolicy(input, config);

  assert.notEqual(output, input);
  assert.equal(output.model, 'claude-sonnet-4-5');
  assert.equal(output.max_tokens, 1234);
  assert.equal(output.temperature, 0.3);
  assert.equal(output.top_p, 0.8);
  assert.equal(output.top_k, 17);
  assert.equal(output.stream, true);
  assert.deepEqual(output.messages, input.messages);
  assert.deepEqual(output.system, input.system);
  assert.deepEqual(output.tools, input.tools);
  assert.deepEqual(output.tool_choice, input.tool_choice);
  assert.deepEqual(output.stop_sequences, input.stop_sequences);
  assert.deepEqual(output.metadata, input.metadata);
});


test('applyRequestPolicy replaces invalid client sampling values with safe defaults', () => {
  const config = loadConfig({});
  const output = applyRequestPolicy({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
    temperature: 99,
    top_p: -0.1,
    top_k: 1.5,
    max_tokens: 0,
  }, config);

  assert.equal(output.temperature, 0.65);
  assert.equal(output.top_p, 0.9);
  assert.equal(output.top_k, 40);
  assert.equal(output.max_tokens, 8192);
});

test('applyRequestPolicy injects defaults only when absent and removes unsupported request fields', () => {
  const config = loadConfig({});
  const output = applyRequestPolicy({
    model: 'claude-opus-4-1',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
    thinking_token_budget: 3072,
    repetition_detection: { min_count: 2 },
    presence_penalty: 0,
    frequency_penalty: 0.15,
    repetition_penalty: 1.05,
    min_p: 0.05,
    max_new_tokens: 999,
    reasoning_budget: 2048,
    reasoning_effort: 'high',
  }, config);

  assert.equal(output.model, 'claude-opus-4-1');
  assert.equal(output.temperature, 0.65);
  assert.equal(output.top_p, 0.9);
  assert.equal(output.top_k, 40);
  assert.equal(output.max_tokens, 8192);
  for (const key of [
    'thinking_token_budget', 'repetition_detection', 'presence_penalty',
    'frequency_penalty', 'repetition_penalty', 'min_p', 'max_new_tokens',
    'reasoning_budget', 'reasoning_effort',
  ]) {
    assert.equal(Object.hasOwn(output, key), false, key);
  }
});

test('applyRequestPolicy applies request-local recovery overrides and appends system instruction', () => {
  const config = loadConfig({
    RECOVERY_TEMPERATURE_MAX: '0.4',
    RECOVERY_MAX_TOKENS: '4096',
  });
  const input = {
    model: 'Ornith-1.0-35B-NVFP4',
    max_tokens: 8192,
    temperature: 0.65,
    seed: 42,
    system: [{ type: 'text', text: 'base system' }],
    messages: [{ role: 'user', content: 'do work' }],
  };

  const output = applyRequestPolicy(input, config, { recoveryReason: 'thinking_loop' });

  assert.equal(output.temperature, 0.4);
  assert.equal(output.max_tokens, 4096);
  assert.equal(Object.hasOwn(output, 'seed'), false);
  assert.equal(output.system.at(-1).type, 'text');
  assert.match(output.system.at(-1).text, /repetitive reasoning cycle/i);
  assert.match(output.system.at(-1).text, /thinking_loop/);
  assert.deepEqual(input.system, [{ type: 'text', text: 'base system' }]);
});

test('applyRequestPolicy maps Claude thinking to vLLM chat_template_kwargs and removes unsupported seed', () => {
  const config = loadConfig({});
  const output = applyRequestPolicy({
    model: 'claude-opus-4-1',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 1000,
    thinking: { type: 'enabled', budget_tokens: 3072 },
    seed: 42,
    chat_template_kwargs: { custom_flag: 'keep' },
  }, config);

  assert.equal(output.chat_template_kwargs.enable_thinking, true);
  assert.equal(output.chat_template_kwargs.custom_flag, 'keep');
  assert.equal(Object.hasOwn(output, 'thinking'), false);
  assert.equal(Object.hasOwn(output, 'seed'), false);
});

test('instruct model name disables thinking unless Claude explicitly enables it', () => {
  const config = loadConfig({});
  const instruct = applyRequestPolicy({
    model: 'ornith-instruct-general', messages: [], max_tokens: 100,
  }, config);
  const explicit = applyRequestPolicy({
    model: 'ornith-instruct-general', messages: [], max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 1024 },
  }, config);

  assert.equal(instruct.chat_template_kwargs.enable_thinking, false);
  assert.equal(explicit.chat_template_kwargs.enable_thinking, true);
});

test('haiku model name defaults to non-thinking for background work', () => {
  const config = loadConfig({});
  const output = applyRequestPolicy({
    model: 'claude-haiku-3-5', messages: [], max_tokens: 100,
  }, config);

  assert.equal(output.chat_template_kwargs.enable_thinking, false);
});
