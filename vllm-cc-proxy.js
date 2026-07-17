#!/usr/bin/env node

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

const UNSUPPORTED_ANTHROPIC_REQUEST_FIELDS = [
  'thinking_token_budget',
  'repetition_detection',
  'presence_penalty',
  'frequency_penalty',
  'repetition_penalty',
  'min_p',
  'max_new_tokens',
  'reasoning_budget',
  'reasoning_effort',
  'seed',
];

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function parseNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function parseNameList(value, defaults = []) {
  const source = value === undefined || value === null || value === ''
    ? defaults
    : String(value).split(',');
  const seen = new Set();
  const output = [];
  for (const item of source) {
    const name = String(item).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    output.push(name);
  }
  return output;
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    host: env.PROXY_HOST || '0.0.0.0',
    port: parseInteger(env.PROXY_PORT, 3456, { min: 1, max: 65535 }),
    vllmBaseUrl: trimTrailingSlash(env.VLLM_BASE_URL || 'http://vllm:8001'),
    vllmApiKey: env.VLLM_API_KEY || 'vllm',
    proxyApiKey: env.PROXY_API_KEY || '',
    samplingDefaults: Object.freeze({
      temperature: parseNumber(env.DEFAULT_TEMPERATURE, 0.65, { min: 0, max: 2 }),
      top_p: parseNumber(env.DEFAULT_TOP_P, 0.9, { min: 0, max: 1 }),
      top_k: parseInteger(env.DEFAULT_TOP_K, 40, { min: 0, max: 100000 }),
      max_tokens: parseInteger(env.DEFAULT_MAX_TOKENS, 8192, { min: 1 }),
    }),
    defaultEnableThinking: parseBoolean(env.DEFAULT_ENABLE_THINKING, true),
    recoveryTemperatureMax: parseNumber(env.RECOVERY_TEMPERATURE_MAX, 0.45, { min: 0, max: 2 }),
    recoveryMaxTokens: parseInteger(env.RECOVERY_MAX_TOKENS, 4096, { min: 1 }),
    recoveryNetworkTemperatureMax: parseNumber(env.RECOVERY_NETWORK_TEMPERATURE_MAX, 0.30, { min: 0, max: 2 }),
    recoveryNetworkMaxTokens: parseInteger(env.RECOVERY_NETWORK_MAX_TOKENS, 1024, { min: 1 }),
    recoveryMcpSearchToolPriority: Object.freeze(parseNameList(env.RECOVERY_MCP_SEARCH_TOOL_PRIORITY)),
    recoveryMcpFetchToolPriority: Object.freeze(parseNameList(env.RECOVERY_MCP_FETCH_TOOL_PRIORITY)),
    recoveryWebSearchToolNames: Object.freeze(parseNameList(env.RECOVERY_WEB_SEARCH_TOOL_NAMES, ['WebSearch'])),
    recoveryWebFetchToolNames: Object.freeze(parseNameList(env.RECOVERY_WEB_FETCH_TOOL_NAMES, ['WebFetch'])),
    maxRecoveryAttempts: parseInteger(env.MAX_RECOVERY_ATTEMPTS, 1, { min: 0, max: 1 }),
    heartbeatIntervalMs: parseInteger(env.HEARTBEAT_INTERVAL_MS, 10000, { min: 1000 }),
    maxActiveRequests: parseInteger(env.MAX_ACTIVE_REQUESTS, 2000, { min: 1 }),
    maxRequestBodyBytes: parseInteger(env.MAX_REQUEST_BODY_BYTES, 8 * 1024 * 1024, { min: 1024 }),
    maxResponseBufferBytes: parseInteger(env.MAX_RESPONSE_BUFFER_BYTES, 32 * 1024 * 1024, { min: 1024 }),
    maxTotalBufferedBytes: parseInteger(env.MAX_TOTAL_BUFFERED_BYTES, 2 * 1024 * 1024 * 1024, { min: 1024 }),
    maxThinkingBytes: parseInteger(env.MAX_THINKING_BYTES, 4 * 1024 * 1024, { min: 1024 }),
    maxToolArgumentBytes: parseInteger(env.MAX_TOOL_ARGUMENT_BYTES, 8 * 1024 * 1024, { min: 1024 }),
    maxContentBlocks: parseInteger(env.MAX_CONTENT_BLOCKS, 256, { min: 1 }),
    maxToolCalls: parseInteger(env.MAX_TOOL_CALLS, 128, { min: 1 }),
    upstreamIdleTimeoutMs: parseInteger(env.UPSTREAM_IDLE_TIMEOUT_MS, 180000, { min: 1000 }),
    semanticStallTimeoutMs: parseInteger(env.SEMANTIC_STALL_TIMEOUT_MS, 300000, { min: 1000 }),
    totalGenerationTimeoutMs: parseInteger(env.TOTAL_GENERATION_TIMEOUT_MS, 1800000, { min: 1000 }),
    recoveryTimeoutMs: parseInteger(env.RECOVERY_TIMEOUT_MS, 900000, { min: 1000 }),
    shutdownGraceMs: parseInteger(env.SHUTDOWN_GRACE_MS, 300000, { min: 1000 }),
    loopMinPatternSize: parseInteger(env.LOOP_MIN_PATTERN_SIZE, 24, { min: 4 }),
    loopMaxPatternSize: parseInteger(env.LOOP_MAX_PATTERN_SIZE, 384, { min: 8 }),
    loopMinCount: parseInteger(env.LOOP_MIN_COUNT, 2, { min: 2 }),
    loopReasoningCharLimit: parseInteger(env.LOOP_REASONING_CHAR_LIMIT, 24000, { min: 128 }),
    loopScanIntervalChars: parseInteger(env.LOOP_SCAN_INTERVAL_CHARS, 64, { min: 8 }),
    logLevel: env.LOG_LEVEL || 'info',
  });
}

function applyThinkingPolicy(body, originalModel, config) {
  const requestedThinking = body.thinking;
  const existingKwargs = body.chat_template_kwargs && typeof body.chat_template_kwargs === 'object'
    && !Array.isArray(body.chat_template_kwargs)
    ? structuredClone(body.chat_template_kwargs)
    : {};
  const modelName = String(originalModel || '').toLowerCase();

  let enableThinking;
  if (requestedThinking && typeof requestedThinking === 'object') {
    if (requestedThinking.type === 'enabled') enableThinking = true;
    if (requestedThinking.type === 'disabled') enableThinking = false;
  }
  if (enableThinking === undefined && typeof existingKwargs.enable_thinking === 'boolean') {
    enableThinking = existingKwargs.enable_thinking;
  }
  if (enableThinking === undefined && (modelName.includes('instruct') || modelName.includes('haiku'))) enableThinking = false;
  if (enableThinking === undefined && modelName.includes('think')) enableThinking = true;
  if (enableThinking === undefined) enableThinking = config.defaultEnableThinking;

  delete body.thinking;
  body.chat_template_kwargs = {
    ...existingKwargs,
    enable_thinking: Boolean(enableThinking),
  };
}

function appendSystemInstruction(system, text) {
  if (typeof system === 'string') return `${system}\n\n${text}`;
  if (Array.isArray(system)) return [...system, { type: 'text', text }];
  return [{ type: 'text', text }];
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentToText).filter(Boolean).join('\n');
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (Object.hasOwn(content, 'content')) return contentToText(content.content);
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

function firstAvailable(priority, available) {
  return priority.find((name) => available.has(name)) || null;
}

function inspectNetworkToolHistory(input, config) {
  const searchNames = new Set([
    ...config.recoveryMcpSearchToolPriority,
    ...config.recoveryWebSearchToolNames,
  ]);
  const fetchNames = new Set([
    ...config.recoveryMcpFetchToolPriority,
    ...config.recoveryWebFetchToolNames,
  ]);
  const toolUses = new Map();
  const results = [];
  let sequence = 0;

  for (const message of Array.isArray(input?.messages) ? input.messages : []) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      sequence += 1;
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        toolUses.set(block.id, { name: block.name, sequence });
        continue;
      }
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      if (block.is_error === true) continue;
      const use = toolUses.get(block.tool_use_id);
      if (!use) continue;
      let kind = null;
      if (searchNames.has(use.name)) kind = 'search';
      if (fetchNames.has(use.name)) kind = 'fetch';
      if (!kind) continue;
      const text = contentToText(block.content);
      results.push({
        kind,
        name: use.name,
        sequence,
        hasUrl: /https?:\/\/[^\s<>'"`]+/i.test(text),
      });
    }
  }

  const latestSearch = results.filter((result) => result.kind === 'search').at(-1) || null;
  const latestFetch = results.filter((result) => result.kind === 'fetch').at(-1) || null;
  return { latestSearch, latestFetch };
}

function buildForcedNetworkInstruction(reason, selectedTool) {
  return [
    '[RECOVERY CONTROL]',
    'This is a recovery generation for the current assistant turn.',
    'The task state established before the failed generation remains authoritative.',
    'Preserve all existing progress.',
    'Do not restart, re-plan, re-scope, undo, replace, or reconsider completed work.',
    'Only the unresolved blocker that caused the reasoning loop is open.',
    `Recovery reason: ${reason}.`,
    `Required tool: ${selectedTool}.`,
    `Emit exactly one complete call to ${selectedTool} to obtain missing current external evidence for that blocker.`,
    'Do not emit analysis, planning, explanation, conclusions, final text, completion claims, or any other tool call.',
    'Do not change existing task state before the real tool result is returned.',
  ].join('\n');
}

function buildEvidenceAvailableInstruction(reason) {
  return [
    '[RECOVERY CONTROL]',
    'This is a recovery generation for the current assistant turn.',
    'The task state established before the failed generation remains authoritative.',
    'Preserve all existing progress.',
    'Do not restart, re-plan, re-scope, undo, replace, or reconsider completed work.',
    'A completed configured source-retrieval result is present in the request messages.',
    'Treat that result as evidence input, not a verified conclusion.',
    'Use it only to resolve the blocker that caused the reasoning loop, then take the smallest next necessary action.',
    'Do not repeat network search or source retrieval merely because recovery was triggered.',
    'Do not treat source retrieval as completion of research or completion of the task.',
    'Do not reopen completed work unless new direct evidence specifically contradicts an unverified provisional assumption.',
    `Recovery reason: ${reason}.`,
  ].join('\n');
}

function buildEvidenceFallbackInstruction(reason) {
  return [
    '[RECOVERY CONTROL]',
    'This is a recovery generation for the current assistant turn.',
    'The task state established before the failed generation remains authoritative.',
    'Preserve all existing progress.',
    'Do not restart, re-plan, re-scope, undo, replace, or reconsider completed work.',
    'No approved network tool is available in the current request. Do not invent a network tool or external evidence.',
    'Use the smallest available evidence-producing action for only the unresolved blocker.',
    'If no available tool can produce new evidence, identify the exact missing evidence without guessing or claiming completion.',
    `Recovery reason: ${reason}.`,
  ].join('\n');
}

function buildGenericRecoveryInstruction(reason) {
  return [
    '[RECOVERY CONTROL]',
    'The previous generation was incomplete or structurally invalid.',
    'The task state established before that failed generation remains authoritative.',
    'Preserve all completed progress and existing tool results.',
    'Do not assume that partial text or partial tool calls from the failed generation were executed.',
    'Regenerate only the current assistant turn without restarting, re-planning, re-scoping, undoing, or replacing completed work.',
    `Recovery reason: ${reason}.`,
  ].join('\n');
}

export function selectRecoveryPlan(input, config, { kind, reason }) {
  const normalizedReason = typeof reason === 'string' && reason ? reason : 'unknown_recovery_reason';
  if (kind !== 'loop') {
    return {
      mode: 'generic_regeneration',
      selectedTool: null,
      instruction: buildGenericRecoveryInstruction(normalizedReason),
    };
  }

  const available = new Set(
    (Array.isArray(input?.tools) ? input.tools : [])
      .map((tool) => tool?.name)
      .filter((name) => typeof name === 'string' && name),
  );
  const { latestSearch, latestFetch } = inspectNetworkToolHistory(input, config);

  if (latestFetch && (!latestSearch || latestFetch.sequence > latestSearch.sequence)) {
    return {
      mode: 'evidence_available',
      selectedTool: null,
      instruction: buildEvidenceAvailableInstruction(normalizedReason),
    };
  }

  if (latestSearch?.hasUrl) {
    const selectedFetch = firstAvailable(config.recoveryMcpFetchToolPriority, available)
      || firstAvailable(config.recoveryWebFetchToolNames, available);
    if (selectedFetch) {
      return {
        mode: 'network_fetch',
        selectedTool: selectedFetch,
        instruction: buildForcedNetworkInstruction(normalizedReason, selectedFetch),
      };
    }
  }

  const selectedSearch = firstAvailable(config.recoveryMcpSearchToolPriority, available)
    || firstAvailable(config.recoveryWebSearchToolNames, available);
  if (selectedSearch) {
    return {
      mode: 'network_search',
      selectedTool: selectedSearch,
      instruction: buildForcedNetworkInstruction(normalizedReason, selectedSearch),
    };
  }

  return {
    mode: 'evidence_fallback',
    selectedTool: null,
    instruction: buildEvidenceFallbackInstruction(normalizedReason),
  };
}

function validateRecoveryContract(result, recoveryPlan) {
  if (!recoveryPlan?.selectedTool) return { ok: true };
  const blocks = Array.isArray(result?.blocks) ? result.blocks : [];
  const toolBlocks = blocks.filter((block) => block.type === 'tool_use');
  if (toolBlocks.length !== 1) {
    return { ok: false, reason: 'forced_network_tool_count_mismatch' };
  }
  if (toolBlocks[0].name !== recoveryPlan.selectedTool) {
    return { ok: false, reason: 'forced_network_tool_name_mismatch' };
  }
  const hasText = blocks.some((block) => block.type === 'text' && String(block.text || '').trim());
  if (hasText) return { ok: false, reason: 'forced_network_recovery_emitted_text' };
  if (result.stopReason !== 'tool_use') {
    return { ok: false, reason: 'forced_network_recovery_stop_reason_mismatch' };
  }
  return { ok: true };
}

function removeUnsupportedFields(body) {
  for (const key of UNSUPPORTED_ANTHROPIC_REQUEST_FIELDS) delete body[key];
}

export function applyRequestPolicy(input, config, { recoveryReason = null, recoveryPlan = null } = {}) {
  const body = structuredClone(input);
  const originalModel = body.model;
  applyThinkingPolicy(body, originalModel, config);
  removeUnsupportedFields(body);

  const strictInteger = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
  };
  const validatedSampling = {
    temperature: parseNumber(body.temperature, config.samplingDefaults.temperature, { min: 0, max: 2 }),
    top_p: parseNumber(body.top_p, config.samplingDefaults.top_p, { min: 0, max: 1 }),
    top_k: strictInteger(body.top_k, config.samplingDefaults.top_k, { min: 0, max: 100000 }),
    max_tokens: strictInteger(body.max_tokens, config.samplingDefaults.max_tokens, { min: 1 }),
  };
  Object.assign(body, validatedSampling);

  const effectiveRecoveryPlan = recoveryPlan || (recoveryReason
    ? {
      mode: 'generic_regeneration',
      selectedTool: null,
      instruction: [
        'The previous generation entered a repetitive reasoning cycle or produced an incomplete response.',
        buildGenericRecoveryInstruction(recoveryReason),
      ].join('\n'),
    }
    : null);

  if (effectiveRecoveryPlan) {
    const forcedNetworkTool = effectiveRecoveryPlan.selectedTool;
    const temperatureMax = forcedNetworkTool
      ? config.recoveryNetworkTemperatureMax
      : config.recoveryTemperatureMax;
    const maxTokens = forcedNetworkTool
      ? config.recoveryNetworkMaxTokens
      : config.recoveryMaxTokens;
    body.temperature = Math.min(Number(body.temperature), temperatureMax);
    body.max_tokens = Math.min(Number(body.max_tokens), maxTokens);
    body.system = appendSystemInstruction(body.system, effectiveRecoveryPlan.instruction);
    if (forcedNetworkTool) {
      const toolExists = Array.isArray(body.tools)
        && body.tools.some((tool) => tool?.name === forcedNetworkTool);
      if (toolExists) body.tool_choice = { type: 'tool', name: forcedNetworkTool };
    }
  }

  return body;
}



function encodeSseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function byteLength(value) {
  return Buffer.byteLength(value || '', 'utf8');
}

function createBlock(index, contentBlock) {
  const type = contentBlock?.type || 'unknown';
  return {
    upstreamIndex: index,
    type,
    start: structuredClone(contentBlock || { type }),
    stopped: false,
    thinking: '',
    signature: null,
    text: typeof contentBlock?.text === 'string' ? contentBlock.text : '',
    id: contentBlock?.id || null,
    name: contentBlock?.name || null,
    partialJson: '',
    input: contentBlock?.input && typeof contentBlock.input === 'object'
      ? structuredClone(contentBlock.input)
      : null,
    toolJsonError: null,
    rawDeltas: [],
  };
}

export class AnthropicSseParser {
  constructor(config = loadConfig({})) {
    this.config = config;
    this.decoder = new TextDecoder();
    this.pending = '';
    this.bytes = 0;
    this.messageStart = null;
    this.messageDelta = null;
    this.messageStopped = false;
    this.stopReason = null;
    this.stopSequence = null;
    this.blocks = [];
    this.blocksByIndex = new Map();
    this.unknownEvents = [];
    this.pingCount = 0;
    this.errorEvent = null;
    this.structuralErrors = [];
    this.finished = false;
  }

  push(chunk) {
    if (this.finished) throw new Error('parser already finished');
    let text;
    if (typeof chunk === 'string') {
      text = chunk;
    } else if (chunk instanceof Uint8Array) {
      text = this.decoder.decode(chunk, { stream: true });
    } else {
      throw new TypeError('SSE chunk must be a string or Uint8Array');
    }
    this.bytes += byteLength(text);
    if (this.bytes > this.config.maxResponseBufferBytes) {
      this.structuralErrors.push('response_buffer_limit');
      return;
    }
    this.pending += text;
    this.#drainFrames();
  }

  #drainFrames() {
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match) break;
      const raw = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      if (raw.trim()) this.#handleFrame(raw);
    }
  }

  #handleFrame(raw) {
    let eventName = 'message';
    const dataLines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0) return;
    const rawData = dataLines.join('\n');
    let data;
    try {
      data = JSON.parse(rawData);
    } catch {
      this.structuralErrors.push('invalid_sse_json');
      return;
    }
    const event = eventName === 'message' && typeof data?.type === 'string'
      ? data.type
      : eventName;
    this.#handleEvent(event, data);
  }

  #handleEvent(event, data) {
    switch (event) {
      case 'message_start': {
        if (this.messageStart) this.structuralErrors.push('duplicate_message_start');
        else this.messageStart = structuredClone(data);
        break;
      }
      case 'ping':
        this.pingCount += 1;
        break;
      case 'content_block_start': {
        const index = data?.index;
        if (!Number.isInteger(index) || this.blocksByIndex.has(index)) {
          this.structuralErrors.push('invalid_content_block_start');
          break;
        }
        const block = createBlock(index, data.content_block);
        this.blocks.push(block);
        this.blocksByIndex.set(index, block);
        break;
      }
      case 'content_block_delta': {
        const block = this.blocksByIndex.get(data?.index);
        if (!block || block.stopped) {
          this.structuralErrors.push('orphan_content_block_delta');
          break;
        }
        const delta = data?.delta || {};
        switch (delta.type) {
          case 'thinking_delta':
            if (typeof delta.thinking === 'string') block.thinking += delta.thinking;
            break;
          case 'signature_delta':
            if (typeof delta.signature === 'string') block.signature = delta.signature;
            break;
          case 'text_delta':
            if (typeof delta.text === 'string') block.text += delta.text;
            break;
          case 'input_json_delta':
            if (typeof delta.partial_json === 'string') block.partialJson += delta.partial_json;
            break;
          default:
            block.rawDeltas.push(structuredClone(data));
            break;
        }
        break;
      }
      case 'content_block_stop': {
        const block = this.blocksByIndex.get(data?.index);
        if (!block || block.stopped) {
          this.structuralErrors.push('invalid_content_block_stop');
          break;
        }
        block.stopped = true;
        if (block.type === 'tool_use') {
          if (!block.partialJson && block.input && typeof block.input === 'object') {
            // Some compatible servers place a complete object on the start event.
          } else {
            try {
              block.input = JSON.parse(block.partialJson || '{}');
            } catch (error) {
              block.toolJsonError = error instanceof Error ? error.message : String(error);
            }
          }
        }
        break;
      }
      case 'message_delta':
        this.messageDelta = structuredClone(data);
        this.stopReason = data?.delta?.stop_reason ?? null;
        this.stopSequence = data?.delta?.stop_sequence ?? null;
        break;
      case 'message_stop':
        this.messageStopped = true;
        break;
      case 'error':
        this.errorEvent = structuredClone(data);
        break;
      default:
        this.unknownEvents.push({ event, data: structuredClone(data) });
        break;
    }
  }

  snapshot() {
    return this.#result();
  }

  finish() {
    if (this.finished) return this.#result();
    const tail = this.decoder.decode();
    if (tail) {
      this.bytes += byteLength(tail);
      this.pending += tail;
    }
    this.#drainFrames();
    if (this.pending.trim()) this.structuralErrors.push('incomplete_sse_frame');
    this.finished = true;
    return this.#result();
  }

  #result() {
    return {
      bytes: this.bytes,
      messageStart: this.messageStart,
      messageDelta: this.messageDelta,
      messageStopped: this.messageStopped,
      stopReason: this.stopReason,
      stopSequence: this.stopSequence,
      blocks: this.blocks,
      unknownEvents: this.unknownEvents,
      pingCount: this.pingCount,
      errorEvent: this.errorEvent,
      structuralErrors: [...this.structuralErrors],
    };
  }
}

function invalid(reason, detail) {
  return { ok: false, reason, detail };
}

export function validateAttempt(result, config) {
  if (!result.messageStopped) return invalid('missing_message_stop', 'stream ended before message_stop');
  if (!result.messageStart) return invalid('missing_message_start', 'stream did not contain message_start');
  if (result.errorEvent) return invalid('upstream_sse_error', result.errorEvent?.error?.message || 'upstream error event');
  if (result.structuralErrors.length > 0) {
    return invalid(result.structuralErrors[0], `invalid SSE structure: ${result.structuralErrors[0]}`);
  }
  if (!result.messageDelta || !result.stopReason) {
    return invalid('missing_message_delta', 'stream did not contain a terminal message_delta');
  }
  if (result.blocks.length > config.maxContentBlocks) {
    return invalid('too_many_content_blocks', `content block count exceeds ${config.maxContentBlocks}`);
  }

  let toolCount = 0;
  let hasThinking = false;
  let hasFinalText = false;
  for (const block of result.blocks) {
    if (!block.stopped) return invalid('unclosed_content_block', `content block ${block.upstreamIndex} was not closed`);
    if (block.type === 'thinking' && block.thinking) hasThinking = true;
    if (block.type === 'text' && block.text?.trim()) hasFinalText = true;
    if (block.type === 'thinking' && byteLength(block.thinking) > config.maxThinkingBytes) {
      return invalid('thinking_buffer_limit', `thinking block ${block.upstreamIndex} exceeds configured limit`);
    }
    if (block.type === 'tool_use') {
      toolCount += 1;
      if (!block.id || !block.name) {
        return invalid('invalid_tool_identity', `tool block ${block.upstreamIndex} is missing id or name`);
      }
      if (byteLength(block.partialJson) > config.maxToolArgumentBytes) {
        return invalid('tool_argument_limit', `tool block ${block.upstreamIndex} exceeds configured limit`);
      }
      if (block.toolJsonError) {
        return invalid('malformed_tool_json', `tool block ${block.upstreamIndex} contains invalid JSON`);
      }
      if (!block.input || typeof block.input !== 'object' || Array.isArray(block.input)) {
        return invalid('invalid_tool_input', `tool block ${block.upstreamIndex} input must be an object`);
      }
    }
  }
  if (toolCount > config.maxToolCalls) {
    return invalid('too_many_tool_calls', `tool call count exceeds ${config.maxToolCalls}`);
  }
  if (toolCount > 0 && result.stopReason !== 'tool_use') {
    return invalid('tool_stop_reason_mismatch', 'tool calls require stop_reason tool_use');
  }
  if (hasThinking && !hasFinalText && toolCount === 0) {
    return invalid('thinking_without_output', 'response contains reasoning but no final text or tool call');
  }
  return { ok: true };
}

export function serializeValidatedResponse(result, options = {}) {
  const upstreamMessage = result.messageStart?.message || {};
  const messageId = options.messageId || `msg_proxy_${randomUUID().replaceAll('-', '')}`;
  const defaultSignature = options.signature || `proxy_${randomUUID()}`;
  const output = [];

  if (options.includeMessageStart !== false) {
    output.push(encodeSseFrame('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: options.model || upstreamMessage.model || 'unknown',
        stop_reason: null,
        stop_sequence: null,
        usage: upstreamMessage.usage || { input_tokens: 0, output_tokens: 0 },
      },
    }));
  }

  for (const unknown of result.unknownEvents || []) {
    output.push(encodeSseFrame(unknown.event, unknown.data));
  }

  result.blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      output.push(encodeSseFrame('content_block_start', {
        type: 'content_block_start', index,
        content_block: { type: 'thinking', thinking: '' },
      }));
      if (block.thinking) {
        output.push(encodeSseFrame('content_block_delta', {
          type: 'content_block_delta', index,
          delta: { type: 'thinking_delta', thinking: block.thinking },
        }));
      }
      output.push(encodeSseFrame('content_block_delta', {
        type: 'content_block_delta', index,
        delta: { type: 'signature_delta', signature: defaultSignature },
      }));
      output.push(encodeSseFrame('content_block_stop', { type: 'content_block_stop', index }));
      return;
    }

    if (block.type === 'text') {
      output.push(encodeSseFrame('content_block_start', {
        type: 'content_block_start', index,
        content_block: { type: 'text', text: '' },
      }));
      if (block.text) {
        output.push(encodeSseFrame('content_block_delta', {
          type: 'content_block_delta', index,
          delta: { type: 'text_delta', text: block.text },
        }));
      }
      output.push(encodeSseFrame('content_block_stop', { type: 'content_block_stop', index }));
      return;
    }

    if (block.type === 'tool_use') {
      output.push(encodeSseFrame('content_block_start', {
        type: 'content_block_start', index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      }));
      output.push(encodeSseFrame('content_block_delta', {
        type: 'content_block_delta', index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      }));
      output.push(encodeSseFrame('content_block_stop', { type: 'content_block_stop', index }));
      return;
    }

    output.push(encodeSseFrame('content_block_start', {
      type: 'content_block_start', index,
      content_block: structuredClone(block.start),
    }));
    for (const rawDelta of block.rawDeltas) {
      output.push(encodeSseFrame('content_block_delta', { ...structuredClone(rawDelta), index }));
    }
    output.push(encodeSseFrame('content_block_stop', { type: 'content_block_stop', index }));
  });

  output.push(encodeSseFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: result.stopReason, stop_sequence: result.stopSequence ?? null },
    usage: result.messageDelta?.usage || { output_tokens: 0 },
  }));
  output.push(encodeSseFrame('message_stop', { type: 'message_stop' }));
  return output.join('');
}

function normalizeReasoningWithMap(text) {
  const normalized = [];
  const starts = [];
  const ends = [];
  let pendingSeparatorStart = null;
  let index = 0;

  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    const rawChar = String.fromCodePoint(codePoint);
    const width = rawChar.length;
    const isWord = /[\p{L}\p{N}]/u.test(rawChar);

    if (isWord) {
      if (pendingSeparatorStart !== null && normalized.length > 0 && normalized.at(-1) !== ' ') {
        normalized.push(' ');
        starts.push(pendingSeparatorStart);
        ends.push(index);
      }
      pendingSeparatorStart = null;
      const lower = rawChar.toLocaleLowerCase('en-US');
      for (const char of lower) {
        normalized.push(char);
        starts.push(index);
        ends.push(index + width);
      }
    } else if (pendingSeparatorStart === null) {
      pendingSeparatorStart = index;
    }

    index += width;
  }

  while (normalized.at(-1) === ' ') {
    normalized.pop();
    starts.pop();
    ends.pop();
  }

  return { normalized: normalized.join(''), starts, ends };
}

function normalizeLine(text) {
  return normalizeReasoningWithMap(text).normalized;
}

function extractLines(text) {
  const lines = [];
  const pattern = /[^\n]*(?:\n|$)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (!match[0] && pattern.lastIndex >= text.length) break;
    const raw = match[0];
    const content = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    const normalized = normalizeLine(content);
    if (normalized) {
      lines.push({
        raw: content,
        normalized,
        start: match.index,
        endContent: match.index + content.length,
        endWithSeparator: match.index + raw.length,
      });
    }
    if (pattern.lastIndex >= text.length) break;
  }
  return lines;
}

function looksLikeCodeOrLogs(text) {
  if (text.includes('```')) return true;
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return false;
  const logLike = lines.filter((line) => (
    /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(line)
    || /^\s*\[[A-Z]+\]/.test(line)
    || /\b(?:INFO|DEBUG|WARN|ERROR)\b/.test(line)
  )).length;
  const codeLike = lines.filter((line) => (
    /^\s{2,}\S/.test(line)
    || /^\s*(?:const|let|var|function|class|if|for|while|return|import|export)\b/.test(line)
    || /[{};]\s*$/.test(line)
  )).length;
  return logLike / lines.length >= 0.6 || codeLike / lines.length >= 0.7;
}

function detectZeroDeltaCorrection(text, config) {
  const lines = extractLines(text);
  const correctionPattern = /\b(?:wait|actually|correction|i found the issue)\b|等等|其實|更正|我找到問題/iu;
  for (let index = lines.length - 2; index >= 1; index -= 1) {
    const correction = lines[index];
    if (!correctionPattern.test(correction.raw)) continue;
    const before = lines[index - 1];
    const after = lines[index + 1];
    if (!after) continue;
    if (before.normalized.length < config.loopMinPatternSize) continue;
    if (before.normalized === after.normalized) {
      return {
        reason: 'zero_delta_correction',
        cycleStart: before.start,
        cycleLength: before.normalized.length,
        retainEnd: correction.endContent,
        repeatCount: 2,
      };
    }
  }
  return null;
}

function detectAbabLines(text, config) {
  const lines = extractLines(text);
  if (lines.length < 4) return null;
  const a1 = lines.at(-4);
  const b1 = lines.at(-3);
  const a2 = lines.at(-2);
  const b2 = lines.at(-1);
  if (
    a1.normalized === a2.normalized
    && b1.normalized === b2.normalized
    && a1.normalized !== b1.normalized
    && (a1.normalized.length + b1.normalized.length) >= config.loopMinPatternSize
  ) {
    const repeatedRegion = text.slice(a1.start, b2.endWithSeparator);
    if (looksLikeCodeOrLogs(repeatedRegion)) return null;
    return {
      reason: 'abab_reasoning_loop',
      cycleStart: a1.start,
      cycleLength: a1.normalized.length + b1.normalized.length,
      retainEnd: b1.endWithSeparator,
      repeatCount: 2,
    };
  }
  return null;
}

function rawBoundaryForNormalizedIndex(mapping, normalizedIndex, textLength) {
  if (normalizedIndex <= 0) return 0;
  if (normalizedIndex >= mapping.starts.length) return textLength;
  return mapping.starts[normalizedIndex];
}

function extendBoundaryOverSeparators(text, boundary) {
  let index = boundary;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    if (/[\p{L}\p{N}]/u.test(char)) break;
    index += char.length;
  }
  return index;
}

export function detectThinkingLoop(text, config = loadConfig({})) {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (looksLikeCodeOrLogs(text)) return null;

  const correction = detectZeroDeltaCorrection(text, config);
  if (correction) return correction;

  const abab = detectAbabLines(text, config);
  if (abab) return abab;

  const mapping = normalizeReasoningWithMap(text);
  const normalized = mapping.normalized;
  const minimum = Math.max(4, config.loopMinPatternSize);
  const maximum = Math.min(config.loopMaxPatternSize, Math.floor(normalized.length / config.loopMinCount));

  for (let patternSize = maximum; patternSize >= minimum; patternSize -= 1) {
    const finalStart = normalized.length - patternSize;
    const previousStart = finalStart - patternSize;
    if (previousStart < 0) continue;
    const pattern = normalized.slice(finalStart);
    if (normalized.slice(previousStart, finalStart) !== pattern) continue;

    let repeatCount = 2;
    let cycleStartNormalized = previousStart;
    while (
      cycleStartNormalized - patternSize >= 0
      && normalized.slice(cycleStartNormalized - patternSize, cycleStartNormalized) === pattern
    ) {
      cycleStartNormalized -= patternSize;
      repeatCount += 1;
    }

    const retainEndNormalized = cycleStartNormalized + patternSize;
    const secondEndNormalized = retainEndNormalized + patternSize;
    const cycleStart = extendBoundaryOverSeparators(
      text,
      rawBoundaryForNormalizedIndex(mapping, cycleStartNormalized, text.length),
    );
    const retainEnd = extendBoundaryOverSeparators(
      text,
      rawBoundaryForNormalizedIndex(mapping, retainEndNormalized, text.length),
    );
    const secondEnd = extendBoundaryOverSeparators(
      text,
      rawBoundaryForNormalizedIndex(mapping, secondEndNormalized, text.length),
    );
    const repeatedRegion = text.slice(cycleStart, secondEnd);
    if (looksLikeCodeOrLogs(repeatedRegion)) continue;

    const rawFirst = text.slice(cycleStart, retainEnd);
    const rawSecond = text.slice(retainEnd, secondEnd);
    const exact = rawFirst === rawSecond;
    return {
      reason: exact ? 'repeated_reasoning_segment' : 'normalized_reasoning_segment',
      cycleStart,
      cycleLength: patternSize,
      retainEnd,
      repeatCount,
    };
  }

  if (normalized.length >= config.loopReasoningCharLimit) {
    return {
      reason: 'reasoning_without_action',
      cycleStart: 0,
      cycleLength: normalized.length,
      retainEnd: Math.min(text.length, config.loopReasoningCharLimit),
      repeatCount: 1,
    };
  }

  return null;
}

export function mergeRecovery(firstAttempt, recoveryAttempt, loopInfo) {
  if (!loopInfo) return structuredClone(recoveryAttempt);

  const firstThinkingIndex = Number.isInteger(loopInfo.blockIndex)
    ? loopInfo.blockIndex
    : firstAttempt.blocks.findIndex((block) => block.type === 'thinking');
  const firstThinking = firstAttempt.blocks[firstThinkingIndex];
  const retained = firstThinking?.type === 'thinking'
    ? firstThinking.thinking.slice(0, loopInfo.retainEnd)
    : '';
  const recoveryThinking = recoveryAttempt.blocks
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking)
    .filter(Boolean)
    .join('\n\n');
  const mergedThinking = retained && recoveryThinking
    ? `${retained}\n\n${recoveryThinking}`
    : (retained || recoveryThinking);

  const blocks = [];
  if (mergedThinking) {
    blocks.push({
      upstreamIndex: 0,
      type: 'thinking',
      start: { type: 'thinking', thinking: '' },
      stopped: true,
      thinking: mergedThinking,
      signature: null,
      text: '',
      id: null,
      name: null,
      partialJson: '',
      input: null,
      toolJsonError: null,
      rawDeltas: [],
    });
  }

  for (const block of recoveryAttempt.blocks) {
    if (block.type === 'thinking') continue;
    const clone = structuredClone(block);
    clone.upstreamIndex = blocks.length;
    blocks.push(clone);
  }

  return {
    ...structuredClone(recoveryAttempt),
    blocks,
    bytes: Number(firstAttempt.bytes || 0) + Number(recoveryAttempt.bytes || 0),
    structuralErrors: [],
    errorEvent: null,
  };
}


export class BufferBudget {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.currentBytes = 0;
    this.reservations = new Map();
  }

  reserve(ownerId, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
    if (bytes === 0) return true;
    if (this.currentBytes + bytes > this.maxBytes) return false;
    this.currentBytes += bytes;
    this.reservations.set(ownerId, (this.reservations.get(ownerId) || 0) + bytes);
    return true;
  }

  release(ownerId) {
    const bytes = this.reservations.get(ownerId) || 0;
    if (!bytes) return 0;
    this.reservations.delete(ownerId);
    this.currentBytes = Math.max(0, this.currentBytes - bytes);
    return bytes;
  }
}

export class SseWriter {
  constructor(response) {
    this.response = response;
    this.closed = false;
    this.closing = false;
    this.tail = Promise.resolve();
    this.closePromise = null;
  }

  #enqueue(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  async #writeRaw(raw) {
    if (this.closed) throw new Error('SSE writer is closed');
    if (this.response.destroyed) throw new Error('downstream response is destroyed');
    const accepted = this.response.write(raw);
    if (!accepted) {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          this.response.off('drain', onDrain);
          this.response.off('close', onClose);
        };
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          cleanup();
          reject(new Error('downstream closed during backpressure'));
        };
        this.response.once('drain', onDrain);
        this.response.once('close', onClose);
      });
    }
  }

  writeRaw(raw) {
    if (this.closed || this.closing) return Promise.reject(new Error('SSE writer is closed'));
    return this.#enqueue(() => this.#writeRaw(String(raw)));
  }

  writeFrame(event, data) {
    return this.writeRaw(encodeSseFrame(event, data));
  }

  writeTransaction(frames) {
    if (this.closed || this.closing) return Promise.reject(new Error('SSE writer is closed'));
    const raw = Array.isArray(frames) ? frames.join('') : String(frames);
    return this.#enqueue(() => this.#writeRaw(raw));
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.#enqueue(async () => {
      if (this.closed) return;
      this.closed = true;
      if (!this.response.destroyed) this.response.end();
    });
    return this.closePromise;
  }
}

export class HeartbeatScheduler {
  constructor({ intervalMs = 10000, tickMs = 1000, now = () => Date.now() } = {}) {
    this.intervalMs = intervalMs;
    this.tickMs = Math.max(10, Math.min(tickMs, intervalMs));
    this.now = now;
    this.contexts = new Map();
    this.timer = null;
  }

  register(context) {
    this.contexts.set(context.requestId, context);
  }

  unregister(context) {
    const requestId = typeof context === 'string' ? context : context.requestId;
    this.contexts.delete(requestId);
  }

  async tick() {
    const now = this.now();
    const writes = [];
    for (const context of this.contexts.values()) {
      if (
        context.terminal
        || !context.heartbeatEnabled
        || context.heartbeatPending
        || context.writer.closed
        || context.nextHeartbeatAt > now
      ) {
        continue;
      }
      context.nextHeartbeatAt = now + this.intervalMs;
      context.heartbeatPending = true;
      const heartbeatWrite = context.messageStartSent
        ? context.writer.writeFrame('ping', { type: 'ping' })
        : context.writer.writeRaw(': keep-alive\n\n');
      writes.push(
        heartbeatWrite
          .catch(() => {
            if (typeof context.cancel === 'function') return context.cancel('heartbeat_write_failed');
            return undefined;
          })
          .finally(() => {
            context.heartbeatPending = false;
          }),
      );
    }
    await Promise.all(writes);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export class RequestContext {
  constructor({ requestId, req, res, config, scheduler, bufferBudget = null, originalRequest = null }) {
    this.requestId = requestId;
    this.req = req;
    this.res = res;
    this.config = config;
    this.scheduler = scheduler;
    this.bufferBudget = bufferBudget;
    this.originalRequest = originalRequest === null ? null : structuredClone(originalRequest);
    this.writer = new SseWriter(res);
    this.state = 'RECEIVED';
    this.terminal = false;
    this.heartbeatEnabled = false;
    this.heartbeatPending = false;
    this.nextHeartbeatAt = Date.now() + config.heartbeatIntervalMs;
    this.abortControllers = new Set();
    this.attempt = 0;
    this.outputMessageId = `msg_proxy_${randomUUID().replaceAll('-', '')}`;
    this.messageStartSent = false;
    this.messageStartPromise = null;
    this.cancelPromise = null;
    this.cleanupDone = false;
    this.bufferedBytes = 0;
    scheduler?.register(this);
  }

  transition(nextState) {
    if (this.terminal) return false;
    this.state = nextState;
    return true;
  }

  startHeartbeat() {
    if (this.terminal) return;
    this.heartbeatEnabled = true;
    this.nextHeartbeatAt = Date.now() + this.config.heartbeatIntervalMs;
  }

  stopHeartbeat() {
    this.heartbeatEnabled = false;
  }

  ensureMessageStart(upstreamEvent = null) {
    if (this.messageStartSent) return Promise.resolve();
    if (this.messageStartPromise) return this.messageStartPromise;
    const upstreamMessage = upstreamEvent?.message || {};
    this.messageStartPromise = this.writer.writeTransaction([
      encodeSseFrame('message_start', {
        type: 'message_start',
        message: {
          id: this.outputMessageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: upstreamMessage.model || this.originalRequest?.model || 'unknown',
          stop_reason: null,
          stop_sequence: null,
          usage: upstreamMessage.usage || { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ]).then(() => {
      this.messageStartSent = true;
    });
    return this.messageStartPromise;
  }

  trackAbortController(controller) {
    if (this.terminal) {
      controller.abort('request already terminal');
      return;
    }
    this.abortControllers.add(controller);
  }

  untrackAbortController(controller) {
    this.abortControllers.delete(controller);
  }

  reserveBufferedBytes(bytes) {
    if (!this.bufferBudget) {
      this.bufferedBytes += bytes;
      return true;
    }
    const reserved = this.bufferBudget.reserve(this.requestId, bytes);
    if (reserved) this.bufferedBytes += bytes;
    return reserved;
  }

  async #finish(state, { closeWriter = true } = {}) {
    if (this.terminal) return;
    this.terminal = true;
    this.state = state;
    this.stopHeartbeat();
    this.scheduler?.unregister(this);
    for (const controller of this.abortControllers) {
      if (!controller.signal.aborted) controller.abort(state);
    }
    this.abortControllers.clear();
    this.bufferBudget?.release(this.requestId);
    this.bufferedBytes = 0;
    if (closeWriter) await this.writer.close().catch(() => {});
    this.cleanupDone = true;
  }

  cancel(reason = 'cancelled') {
    if (this.cancelPromise) return this.cancelPromise;
    this.cancelReason = reason;
    this.cancelPromise = this.#finish('CANCELLED');
    return this.cancelPromise;
  }

  complete() {
    return this.#finish('COMPLETED');
  }

  fail() {
    return this.#finish('FAILED');
  }
}

function jsonResponse(response, status, payload, headers = {}) {
  if (response.headersSent) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function proxyErrorPayload(type, message, requestId) {
  return {
    type: 'error',
    error: { type, message },
    request_id: requestId,
  };
}

function extractApiKey(request) {
  const xApiKey = request.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey) return xApiKey;
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, '');
  }
  return '';
}

function authenticate(request, config) {
  if (!config.proxyApiKey) return true;
  const expected = createHash('sha256').update(config.proxyApiKey).digest();
  const actual = createHash('sha256').update(extractApiKey(request)).digest();
  return timingSafeEqual(actual, expected);
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('request body exceeds configured limit');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('request body must be a JSON object');
    }
    return parsed;
  } catch (cause) {
    const error = new Error('invalid JSON request body', { cause });
    error.statusCode = 400;
    throw error;
  }
}

function buildUpstreamHeaders(request, config, requestId, accept = 'text/event-stream') {
  const headers = {
    'content-type': 'application/json',
    accept,
    authorization: `Bearer ${config.vllmApiKey}`,
    'x-api-key': config.vllmApiKey,
    'x-request-id': requestId,
  };
  for (const name of ['anthropic-version', 'anthropic-beta', 'user-agent']) {
    const value = request.headers[name];
    if (typeof value === 'string' && value) headers[name] = value;
  }
  if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
  return headers;
}

function semanticProgress(result) {
  let value = result.blocks.length * 7;
  for (const block of result.blocks) {
    value += block.thinking?.length || 0;
    value += block.text?.length || 0;
    value += block.partialJson?.length || 0;
    if (block.stopped) value += 3;
  }
  if (result.messageDelta) value += 11;
  if (result.messageStopped) value += 13;
  return value;
}

function findIncrementalLimitViolation(result, config) {
  if (result.structuralErrors.includes('response_buffer_limit')) return 'response_buffer_limit';
  if (result.blocks.length > config.maxContentBlocks) return 'too_many_content_blocks';

  let toolCount = 0;
  for (const block of result.blocks) {
    if (block.type === 'thinking' && byteLength(block.thinking) > config.maxThinkingBytes) {
      return 'thinking_buffer_limit';
    }
    if (block.type === 'tool_use') {
      toolCount += 1;
      if (byteLength(block.partialJson) > config.maxToolArgumentBytes) return 'tool_argument_limit';
    }
  }
  if (toolCount > config.maxToolCalls) return 'too_many_tool_calls';
  return null;
}

function shouldRetryAttempt(attempt) {
  if (attempt.kind === 'cancelled') return false;
  if (attempt.kind === 'http_error') return attempt.status >= 500;
  return attempt.kind !== 'success';
}

function safeErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'unknown error');
}

async function performStreamingAttempt({ body, request, context, config, timeoutMs }) {
  const controller = new AbortController();
  context.trackAbortController(controller);
  let totalTimer = null;
  let abortReason = null;
  let reader = null;

  const abort = (reason) => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort(reason);
  };

  totalTimer = setTimeout(() => abort('total_generation_timeout'), timeoutMs);
  totalTimer.unref?.();

  try {
    const response = await fetch(`${config.vllmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: buildUpstreamHeaders(request, config, context.requestId),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const message = (await response.text()).slice(0, 4096);
      return { kind: 'http_error', status: response.status, reason: 'upstream_http_error', message };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      const message = (await response.text()).slice(0, 4096);
      return {
        kind: 'invalid',
        reason: 'upstream_not_sse',
        message: message || `unexpected content-type: ${contentType}`,
      };
    }

    const parser = new AnthropicSseParser(config);
    reader = response.body.getReader();
    let lastByteAt = Date.now();
    let lastSemanticAt = Date.now();
    let lastSemanticValue = 0;
    const lastLoopScan = new Map();

    while (true) {
      const idleRemaining = Math.max(1, config.upstreamIdleTimeoutMs - (Date.now() - lastByteAt));
      let idleTimer;
      const readResult = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          idleTimer = setTimeout(() => {
            abort('upstream_idle_timeout');
            reject(new Error('upstream_idle_timeout'));
          }, idleRemaining);
          idleTimer.unref?.();
        }),
      ]).finally(() => clearTimeout(idleTimer));

      if (readResult.done) break;
      lastByteAt = Date.now();
      const chunkBytes = readResult.value?.byteLength || 0;
      if (!context.reserveBufferedBytes(chunkBytes)) {
        abort('global_buffer_limit_exceeded');
        await reader.cancel('global_buffer_limit_exceeded').catch(() => {});
        return { kind: 'invalid', reason: 'global_buffer_limit_exceeded' };
      }
      parser.push(readResult.value);
      const snapshot = parser.snapshot();
      const limitViolation = findIncrementalLimitViolation(snapshot, config);
      if (limitViolation) {
        abort(limitViolation);
        await reader.cancel(limitViolation).catch(() => {});
        return { kind: 'invalid', reason: limitViolation, result: snapshot };
      }
      if (snapshot.messageStart && !context.messageStartSent) {
        await context.ensureMessageStart(snapshot.messageStart);
      }
      const currentSemanticValue = semanticProgress(snapshot);
      if (currentSemanticValue !== lastSemanticValue) {
        lastSemanticValue = currentSemanticValue;
        lastSemanticAt = Date.now();
      } else if (Date.now() - lastSemanticAt >= config.semanticStallTimeoutMs) {
        abort('semantic_stall_timeout');
        return { kind: 'invalid', reason: 'semantic_stall_timeout', result: snapshot };
      }

      for (let blockIndex = 0; blockIndex < snapshot.blocks.length; blockIndex += 1) {
        const block = snapshot.blocks[blockIndex];
        if (block.type !== 'thinking' || !block.thinking) continue;
        const previousScan = lastLoopScan.get(blockIndex) || 0;
        if (!block.stopped && block.thinking.length - previousScan < config.loopScanIntervalChars) continue;
        lastLoopScan.set(blockIndex, block.thinking.length);
        const loopInfo = detectThinkingLoop(block.thinking, config);
        if (loopInfo) {
          loopInfo.blockIndex = blockIndex;
          abort(loopInfo.reason);
          await reader.cancel(loopInfo.reason).catch(() => {});
          return { kind: 'loop', reason: loopInfo.reason, result: snapshot, loopInfo };
        }
      }
    }

    const result = parser.finish();
    const validation = validateAttempt(result, config);
    if (!validation.ok) {
      return { kind: 'invalid', reason: validation.reason, message: validation.detail, result };
    }
    return { kind: 'success', result };
  } catch (error) {
    if (context.terminal) return { kind: 'cancelled', reason: context.cancelReason || 'client_cancelled' };
    if (abortReason) return { kind: 'invalid', reason: abortReason, message: abortReason };
    return { kind: 'invalid', reason: 'upstream_stream_interrupted', message: safeErrorMessage(error) };
  } finally {
    clearTimeout(totalTimer);
    if (reader && controller.signal.aborted) await reader.cancel(abortReason || 'aborted').catch(() => {});
    context.untrackAbortController(controller);
  }
}

async function forwardNonStreaming({ path, body, request, config, requestId, signal }) {
  const response = await fetch(`${config.vllmBaseUrl}${path}`, {
    method: 'POST',
    headers: buildUpstreamHeaders(request, config, requestId, 'application/json'),
    body: JSON.stringify(body),
    signal,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || 'application/json',
    buffer,
  };
}


const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function buildTransparentRequestHeaders(request, config, requestId) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (['host', 'authorization', 'x-api-key', 'x-request-id'].includes(lower)) continue;
    if (value !== undefined) headers[name] = value;
  }
  headers.authorization = `Bearer ${config.vllmApiKey}`;
  headers['x-api-key'] = config.vllmApiKey;
  headers['x-request-id'] = requestId;
  return headers;
}

function buildTransparentResponseHeaders(upstreamHeaders) {
  const headers = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

async function forwardTransparent({ request, response, config, requestId }) {
  const incoming = new URL(request.url || '/', 'http://proxy.local');
  const target = new URL(`${config.vllmBaseUrl}/`);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  target.hash = '';
  const transport = target.protocol === 'https:' ? https : http;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const upstreamRequest = transport.request(target, {
      method: request.method,
      headers: buildTransparentRequestHeaders(request, config, requestId),
      setHost: true,
    }, (upstreamResponse) => {
      if (!response.headersSent) {
        response.writeHead(
          upstreamResponse.statusCode || 502,
          upstreamResponse.statusMessage,
          buildTransparentResponseHeaders(upstreamResponse.headers),
        );
      }
      upstreamResponse.once('error', (error) => {
        if (!response.destroyed) response.destroy(error);
        finish();
      });
      upstreamResponse.once('end', finish);
      upstreamResponse.pipe(response);
    });

    upstreamRequest.once('error', (error) => {
      if (!response.headersSent) {
        jsonResponse(response, 502, proxyErrorPayload('api_error', safeErrorMessage(error), requestId));
      } else if (!response.destroyed) {
        response.destroy(error);
      }
      finish();
    });

    request.once('aborted', () => {
      upstreamRequest.destroy(new Error('client disconnected'));
      finish();
    });
    response.once('close', () => {
      if (!response.writableEnded) upstreamRequest.destroy(new Error('client disconnected'));
      finish();
    });

    request.pipe(upstreamRequest);
  });
}

function openSse(response, requestId) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': requestId,
  });
  response.flushHeaders?.();
}

async function sendSseError(context, type, message) {
  if (context.terminal) return;
  context.stopHeartbeat();
  await context.writer.writeFrame('error', {
    type: 'error',
    error: { type, message },
  }).catch(() => {});
  await context.fail();
}

function createMetrics() {
  return {
    requestsTotal: 0,
    activeRequests: 0,
    recoveriesTotal: 0,
    recoverySuccessTotal: 0,
    loopsDetectedTotal: 0,
    upstreamInterruptionsTotal: 0,
    toolValidationFailuresTotal: 0,
    clientCancellationsTotal: 0,
  };
}

function renderMetrics(metrics) {
  return [
    '# TYPE vllm_cc_proxy_requests_total counter',
    `vllm_cc_proxy_requests_total ${metrics.requestsTotal}`,
    '# TYPE vllm_cc_proxy_active_requests gauge',
    `vllm_cc_proxy_active_requests ${metrics.activeRequests}`,
    '# TYPE vllm_cc_proxy_recoveries_total counter',
    `vllm_cc_proxy_recoveries_total ${metrics.recoveriesTotal}`,
    '# TYPE vllm_cc_proxy_recovery_success_total counter',
    `vllm_cc_proxy_recovery_success_total ${metrics.recoverySuccessTotal}`,
    '# TYPE vllm_cc_proxy_loops_detected_total counter',
    `vllm_cc_proxy_loops_detected_total ${metrics.loopsDetectedTotal}`,
    '# TYPE vllm_cc_proxy_upstream_interruptions_total counter',
    `vllm_cc_proxy_upstream_interruptions_total ${metrics.upstreamInterruptionsTotal}`,
    '# TYPE vllm_cc_proxy_tool_validation_failures_total counter',
    `vllm_cc_proxy_tool_validation_failures_total ${metrics.toolValidationFailuresTotal}`,
    '# TYPE vllm_cc_proxy_client_cancellations_total counter',
    `vllm_cc_proxy_client_cancellations_total ${metrics.clientCancellationsTotal}`,
    '',
  ].join('\n');
}

function logEvent(config, event) {
  if (config.logLevel === 'silent' || config.logLevel === 'off') return;
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
}

export function createProxyServer(config = loadConfig()) {
  const heartbeatScheduler = new HeartbeatScheduler({
    intervalMs: config.heartbeatIntervalMs,
    tickMs: Math.min(1000, Math.max(10, Math.floor(config.heartbeatIntervalMs / 4))),
  });
  const activeContexts = new Map();
  const bufferBudget = new BufferBudget(config.maxTotalBufferedBytes);
  const metrics = createMetrics();
  let draining = false;
  let closed = false;
  let admittedRequests = 0;

  const server = http.createServer({
    keepAlive: true,
    keepAliveInitialDelay: 15000,
    noDelay: true,
    requestTimeout: 0,
  }, async (request, response) => {
    request.socket.setKeepAlive(true, 15000);
    request.socket.setNoDelay(true);

    const incomingUrl = new URL(request.url || '/', 'http://proxy.local');
    const pathname = incomingUrl.pathname;

    if (request.method === 'GET' && pathname === '/health/live') {
      return jsonResponse(response, 200, { status: 'ok' });
    }
    if (request.method === 'GET' && pathname === '/health/ready') {
      return jsonResponse(response, draining ? 503 : 200, { status: draining ? 'draining' : 'ready' });
    }
    if (request.method === 'GET' && pathname === '/metrics') {
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      return response.end(renderMetrics(metrics));
    }
    if (!authenticate(request, config)) {
      return jsonResponse(response, 401, proxyErrorPayload('authentication_error', 'Invalid API key.', randomUUID()));
    }
    if (draining) {
      return jsonResponse(response, 503, proxyErrorPayload('overloaded_error', 'Proxy instance is draining.', randomUUID()), { 'retry-after': '5' });
    }
    if (admittedRequests >= config.maxActiveRequests) {
      return jsonResponse(response, 503, proxyErrorPayload('overloaded_error', 'Proxy active request capacity reached.', randomUUID()), { 'retry-after': '5' });
    }

    admittedRequests += 1;
    metrics.requestsTotal += 1;
    metrics.activeRequests = admittedRequests;
    let admissionReleased = false;
    const releaseAdmission = () => {
      if (admissionReleased) return;
      admissionReleased = true;
      admittedRequests = Math.max(0, admittedRequests - 1);
      metrics.activeRequests = admittedRequests;
    };
    response.once('finish', releaseAdmission);
    response.once('close', releaseAdmission);

    const requestId = `proxy_req_${randomUUID().replaceAll('-', '')}`;
    const isManagedMessages = request.method === 'POST' && pathname === '/v1/messages';

    if (!isManagedMessages) {
      try {
        await forwardTransparent({ request, response, config, requestId });
      } catch (error) {
        if (!response.headersSent) {
          return jsonResponse(response, 502, proxyErrorPayload('api_error', safeErrorMessage(error), requestId));
        }
      }
      return;
    }

    let input;
    try {
      input = await readBody(request, config.maxRequestBodyBytes);
    } catch (error) {
      return jsonResponse(
        response,
        error.statusCode || 400,
        proxyErrorPayload('invalid_request_error', safeErrorMessage(error), requestId),
      );
    }

    const policyBody = applyRequestPolicy(input, config);
    if (policyBody.stream !== true) {
      const controller = new AbortController();
      request.once('aborted', () => controller.abort('client disconnected'));
      response.once('close', () => {
        if (!response.writableEnded) controller.abort('client disconnected');
      });
      try {
        const upstream = await forwardNonStreaming({
          path: '/v1/messages', body: policyBody, request, config, requestId,
          signal: controller.signal,
        });
        response.writeHead(upstream.status, {
          'content-type': upstream.contentType,
          'cache-control': 'no-store',
          'x-request-id': requestId,
        });
        return response.end(upstream.buffer);
      } catch (error) {
        if (controller.signal.aborted) return;
        return jsonResponse(response, 502, proxyErrorPayload('api_error', safeErrorMessage(error), requestId));
      }
    }

    openSse(response, requestId);
    const context = new RequestContext({
      requestId, request, req: request, res: response, config,
      scheduler: heartbeatScheduler,
      bufferBudget,
      originalRequest: input,
    });
    activeContexts.set(requestId, context);
    context.transition('SSE_OPEN');
    context.startHeartbeat();

    const cancelForDisconnect = () => {
      if (!context.terminal && !response.writableEnded) {
        metrics.clientCancellationsTotal += 1;
        context.cancel('client_disconnect').catch(() => {});
      }
    };
    request.once('aborted', cancelForDisconnect);
    response.once('close', cancelForDisconnect);

    try {
      context.transition('GENERATING');
      const first = await performStreamingAttempt({
        body: policyBody,
        request,
        context,
        config,
        timeoutMs: config.totalGenerationTimeoutMs,
      });
      if (context.terminal) return;

      let finalResult = null;
      if (first.kind === 'success') {
        finalResult = first.result;
      } else if (shouldRetryAttempt(first) && config.maxRecoveryAttempts > 0) {
        metrics.recoveriesTotal += 1;
        if (first.kind === 'loop') {
          metrics.loopsDetectedTotal += 1;
        } else if (first.reason === 'upstream_stream_interrupted') {
          metrics.upstreamInterruptionsTotal += 1;
        } else if (first.reason?.includes('tool')) {
          metrics.toolValidationFailuresTotal += 1;
        }
        context.transition('RECOVERING');
        const recoveryPlan = selectRecoveryPlan(input, config, {
          kind: first.kind,
          reason: first.reason,
        });
        const recoveryBody = applyRequestPolicy(input, config, { recoveryPlan });
        logEvent(config, {
          event: 'recovery_started',
          request_id: requestId,
          recovery_mode: recoveryPlan.mode,
          selected_tool: recoveryPlan.selectedTool,
          reason: first.reason,
        });
        const recovery = await performStreamingAttempt({
          body: recoveryBody,
          request,
          context,
          config,
          timeoutMs: config.recoveryTimeoutMs,
        });
        if (context.terminal) return;
        if (recovery.kind === 'success') {
          const recoveryContract = validateRecoveryContract(recovery.result, recoveryPlan);
          if (!recoveryContract.ok) {
            return await sendSseError(
              context,
              'api_error',
              `Recovery contract validation failed: ${recoveryContract.reason}.`,
            );
          }
          metrics.recoverySuccessTotal += 1;
          finalResult = first.kind === 'loop'
            ? mergeRecovery(first.result, recovery.result, first.loopInfo)
            : recovery.result;
        } else {
          return await sendSseError(
            context,
            'api_error',
            `Upstream generation remained invalid after one recovery attempt: ${recovery.reason}.`,
          );
        }
      } else {
        return await sendSseError(
          context,
          'api_error',
          `Upstream generation failed: ${first.reason}.`,
        );
      }

      const finalValidation = validateAttempt(finalResult, config);
      if (!finalValidation.ok) {
        return await sendSseError(context, 'api_error', `Final response validation failed: ${finalValidation.reason}.`);
      }

      context.transition('SERIALIZING');
      await context.ensureMessageStart(finalResult.messageStart);
      context.stopHeartbeat();
      const serialized = serializeValidatedResponse(finalResult, {
        includeMessageStart: false,
        messageId: context.outputMessageId,
        signature: `proxy_${randomUUID()}`,
      });
      await context.writer.writeTransaction([serialized]);
      await context.complete();
      logEvent(config, {
        event: 'request_completed', request_id: requestId,
        recovered: first.kind !== 'success', stop_reason: finalResult.stopReason,
      });
    } catch (error) {
      if (!context.terminal) await sendSseError(context, 'api_error', safeErrorMessage(error));
    } finally {
      activeContexts.delete(requestId);
    }
  });

  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 75000;
  heartbeatScheduler.start();

  return {
    server,
    metrics,
    activeContexts,
    bufferBudget,
    get admittedRequests() { return admittedRequests; },
    get draining() { return draining; },
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          resolve();
        });
      });
    },
    address() { return server.address(); },
    async drain() {
      draining = true;
    },
    async close({ force = false } = {}) {
      if (closed) return;
      closed = true;
      draining = true;
      heartbeatScheduler.stop();
      if (force) {
        await Promise.all([...activeContexts.values()].map((context) => context.cancel('proxy_shutdown')));
      }
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        if (force) server.closeAllConnections?.();
      });
    },
  };
}

async function runMain() {
  const config = loadConfig();
  const app = createProxyServer(config);
  await app.listen();
  logEvent(config, {
    event: 'proxy_started', host: config.host, port: config.port,
    upstream: config.vllmBaseUrl,
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent(config, { event: 'proxy_draining', signal });
    await app.drain();
    const deadline = setTimeout(() => {
      app.close({ force: true }).catch(() => {});
    }, config.shutdownGraceMs);
    deadline.unref?.();
    while (app.activeContexts.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    clearTimeout(deadline);
    await app.close();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM').catch(() => process.exitCode = 1));
  process.once('SIGINT', () => shutdown('SIGINT').catch(() => process.exitCode = 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain().catch((error) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
