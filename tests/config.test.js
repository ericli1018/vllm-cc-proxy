import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRequestPolicy,
  loadConfig,
  selectRecoveryPlan,
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


test('loadConfig parses exact MCP-first recovery tool priorities and network sampling limits', () => {
  const config = loadConfig({
    RECOVERY_MCP_SEARCH_TOOL_PRIORITY: 'mcp__searxng__search, mcp__brave__search',
    RECOVERY_MCP_FETCH_TOOL_PRIORITY: 'mcp__fetch__fetch',
    RECOVERY_WEB_SEARCH_TOOL_NAMES: 'WebSearch,CustomWebSearch',
    RECOVERY_WEB_FETCH_TOOL_NAMES: 'WebFetch,CustomWebFetch',
    RECOVERY_NETWORK_TEMPERATURE_MAX: '0.25',
    RECOVERY_NETWORK_MAX_TOKENS: '768',
  });

  assert.deepEqual(config.recoveryMcpSearchToolPriority, [
    'mcp__searxng__search',
    'mcp__brave__search',
  ]);
  assert.deepEqual(config.recoveryMcpFetchToolPriority, ['mcp__fetch__fetch']);
  assert.deepEqual(config.recoveryWebSearchToolNames, ['WebSearch', 'CustomWebSearch']);
  assert.deepEqual(config.recoveryWebFetchToolNames, ['WebFetch', 'CustomWebFetch']);
  assert.equal(config.recoveryNetworkTemperatureMax, 0.25);
  assert.equal(config.recoveryNetworkMaxTokens, 768);
});

test('selectRecoveryPlan prefers configured MCP search over built-in WebSearch and WebFetch', () => {
  const config = loadConfig({
    RECOVERY_MCP_SEARCH_TOOL_PRIORITY: 'mcp__searxng__search',
    RECOVERY_MCP_FETCH_TOOL_PRIORITY: 'mcp__fetch__fetch',
  });
  const input = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'check current behavior' }],
    tools: [
      { name: 'WebFetch', input_schema: { type: 'object' } },
      { name: 'WebSearch', input_schema: { type: 'object' } },
      { name: 'mcp__searxng__search', input_schema: { type: 'object' } },
      { name: 'mcp__fetch__fetch', input_schema: { type: 'object' } },
    ],
  };

  const plan = selectRecoveryPlan(input, config, { kind: 'loop', reason: 'abab_reasoning_loop' });

  assert.equal(plan.mode, 'network_search');
  assert.equal(plan.selectedTool, 'mcp__searxng__search');
  assert.match(plan.instruction, /Preserve all existing progress/i);
  assert.match(plan.instruction, /Do not restart, re-plan, re-scope, undo, replace, or reconsider completed work/i);
  assert.match(plan.instruction, /exactly one complete call/i);
  assert.doesNotMatch(plan.instruction, /Active Outcome/i);
  assert.doesNotMatch(plan.instruction, /complete the original user request/i);
});

test('selectRecoveryPlan prefers configured MCP fetch when a completed search result exposes a URL', () => {
  const config = loadConfig({
    RECOVERY_MCP_SEARCH_TOOL_PRIORITY: 'mcp__searxng__search',
    RECOVERY_MCP_FETCH_TOOL_PRIORITY: 'mcp__fetch__fetch',
  });
  const input = {
    messages: [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use', id: 'toolu_search', name: 'mcp__searxng__search', input: { query: 'vllm' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 'toolu_search',
          content: 'Official docs: https://docs.vllm.ai/en/latest/',
        }],
      },
    ],
    tools: [
      { name: 'mcp__searxng__search', input_schema: { type: 'object' } },
      { name: 'mcp__fetch__fetch', input_schema: { type: 'object' } },
      { name: 'WebFetch', input_schema: { type: 'object' } },
    ],
  };

  const plan = selectRecoveryPlan(input, config, { kind: 'loop', reason: 'reasoning_without_action' });

  assert.equal(plan.mode, 'network_fetch');
  assert.equal(plan.selectedTool, 'mcp__fetch__fetch');
});

test('selectRecoveryPlan uses WebFetch after a URL-bearing WebSearch result when no MCP tool is configured', () => {
  const config = loadConfig({});
  const input = {
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_search', name: 'WebSearch', input: { query: 'x' } }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 'toolu_search', content: [{ type: 'text', text: 'https://example.com/source' }],
        }],
      },
    ],
    tools: [
      { name: 'WebSearch', input_schema: { type: 'object' } },
      { name: 'WebFetch', input_schema: { type: 'object' } },
    ],
  };

  const plan = selectRecoveryPlan(input, config, { kind: 'loop', reason: 'repeated_reasoning_segment' });

  assert.equal(plan.mode, 'network_fetch');
  assert.equal(plan.selectedTool, 'WebFetch');
});

test('selectRecoveryPlan falls back to WebSearch and never invents an absent network tool', () => {
  const config = loadConfig({
    RECOVERY_MCP_SEARCH_TOOL_PRIORITY: 'mcp__missing__search',
    RECOVERY_MCP_FETCH_TOOL_PRIORITY: 'mcp__missing__fetch',
  });
  const withWebSearch = selectRecoveryPlan({
    messages: [],
    tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }],
  }, config, { kind: 'loop', reason: 'zero_delta_correction' });
  const withoutNetwork = selectRecoveryPlan({
    messages: [],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
  }, config, { kind: 'loop', reason: 'zero_delta_correction' });

  assert.equal(withWebSearch.mode, 'network_search');
  assert.equal(withWebSearch.selectedTool, 'WebSearch');
  assert.equal(withoutNetwork.mode, 'evidence_fallback');
  assert.equal(withoutNetwork.selectedTool, null);
  assert.match(withoutNetwork.instruction, /Do not invent a network tool/i);
});

test('selectRecoveryPlan does not force another network call after newer completed fetch evidence', () => {
  const config = loadConfig({
    RECOVERY_MCP_SEARCH_TOOL_PRIORITY: 'mcp__searxng__search',
    RECOVERY_MCP_FETCH_TOOL_PRIORITY: 'mcp__fetch__fetch',
  });
  const input = {
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_search', name: 'mcp__searxng__search', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_search', content: 'https://docs.example/a' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_fetch', name: 'mcp__fetch__fetch', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_fetch', content: 'authoritative source body' }],
      },
    ],
    tools: [
      { name: 'mcp__searxng__search', input_schema: { type: 'object' } },
      { name: 'mcp__fetch__fetch', input_schema: { type: 'object' } },
    ],
  };

  const plan = selectRecoveryPlan(input, config, { kind: 'loop', reason: 'semantic_stall_timeout' });

  assert.equal(plan.mode, 'evidence_available');
  assert.equal(plan.selectedTool, null);
  assert.match(plan.instruction, /completed configured source-retrieval result is present/i);
  assert.match(plan.instruction, /not a verified conclusion/i);
  assert.match(plan.instruction, /Do not treat source retrieval as completion/i);
});

test('selectRecoveryPlan keeps non-loop recovery generic and does not redirect transport failures to research', () => {
  const config = loadConfig({ RECOVERY_MCP_SEARCH_TOOL_PRIORITY: 'mcp__searxng__search' });
  const input = {
    messages: [],
    tools: [{ name: 'mcp__searxng__search', input_schema: { type: 'object' } }],
  };

  const plan = selectRecoveryPlan(input, config, {
    kind: 'invalid', reason: 'upstream_stream_interrupted',
  });

  assert.equal(plan.mode, 'generic_regeneration');
  assert.equal(plan.selectedTool, null);
  assert.doesNotMatch(plan.instruction, /Required tool/i);
  assert.doesNotMatch(plan.instruction, /network/i);
});

test('applyRequestPolicy applies forced network recovery tool choice and tighter sampling without changing model', () => {
  const config = loadConfig({
    RECOVERY_NETWORK_TEMPERATURE_MAX: '0.3',
    RECOVERY_NETWORK_MAX_TOKENS: '1024',
  });
  const input = {
    model: 'claude-sonnet-4-6',
    temperature: 0.65,
    max_tokens: 8192,
    system: 'base',
    messages: [{ role: 'user', content: 'research' }],
    tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto' },
  };
  const plan = {
    mode: 'network_search',
    selectedTool: 'WebSearch',
    instruction: '[RECOVERY CONTROL] Preserve all existing progress.',
  };

  const output = applyRequestPolicy(input, config, { recoveryPlan: plan });

  assert.equal(output.model, 'claude-sonnet-4-6');
  assert.equal(output.temperature, 0.3);
  assert.equal(output.max_tokens, 1024);
  assert.deepEqual(output.tool_choice, { type: 'tool', name: 'WebSearch' });
  assert.match(JSON.stringify(output.system), /Preserve all existing progress/);
});


test('selectRecoveryPlan ignores failed network tool results when classifying recovery state', () => {
  const config = loadConfig({
    RECOVERY_MCP_SEARCH_TOOL_PRIORITY: 'mcp__searxng__search',
    RECOVERY_MCP_FETCH_TOOL_PRIORITY: 'mcp__fetch__fetch',
  });
  const input = {
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_fetch', name: 'mcp__fetch__fetch', input: {} }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 'toolu_fetch', is_error: true,
          content: 'fetch failed for https://docs.example/a',
        }],
      },
    ],
    tools: [
      { name: 'mcp__searxng__search', input_schema: { type: 'object' } },
      { name: 'mcp__fetch__fetch', input_schema: { type: 'object' } },
    ],
  };

  const plan = selectRecoveryPlan(input, config, { kind: 'loop', reason: 'semantic_stall_timeout' });

  assert.equal(plan.mode, 'network_search');
  assert.equal(plan.selectedTool, 'mcp__searxng__search');
});
