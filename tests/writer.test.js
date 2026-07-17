import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  HeartbeatScheduler,
  RequestContext,
  SseWriter,
  loadConfig,
} from '../vllm-cc-proxy.js';

class FakeResponse extends EventEmitter {
  constructor({ backpressureAt = [] } = {}) {
    super();
    this.writes = [];
    this.ended = 0;
    this.destroyed = false;
    this.backpressureAt = new Set(backpressureAt);
  }

  write(chunk) {
    this.writes.push(String(chunk));
    const index = this.writes.length - 1;
    if (this.backpressureAt.has(index)) {
      queueMicrotask(() => this.emit('drain'));
      return false;
    }
    return true;
  }

  end() {
    this.ended += 1;
    this.emit('finish');
  }
}

class FakeRequest extends EventEmitter {
  constructor() {
    super();
    this.socket = {
      setKeepAlive() {},
      setNoDelay() {},
    };
  }
}

test('SseWriter serializes concurrent frames in FIFO order', async () => {
  const response = new FakeResponse();
  const writer = new SseWriter(response);

  await Promise.all([
    writer.writeFrame('ping', { type: 'ping', sequence: 1 }),
    writer.writeFrame('ping', { type: 'ping', sequence: 2 }),
    writer.writeFrame('ping', { type: 'ping', sequence: 3 }),
  ]);

  assert.equal(response.writes.length, 3);
  assert.match(response.writes[0], /"sequence":1/);
  assert.match(response.writes[1], /"sequence":2/);
  assert.match(response.writes[2], /"sequence":3/);
});

test('SseWriter transaction writes a complete tool block without heartbeat interleaving', async () => {
  const response = new FakeResponse();
  const writer = new SseWriter(response);
  const frames = [
    'event: content_block_start\ndata: {"type":"content_block_start"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
  ];

  const toolWrite = writer.writeTransaction(frames);
  const pingWrite = writer.writeFrame('ping', { type: 'ping' });
  await Promise.all([toolWrite, pingWrite]);

  assert.equal(response.writes.length, 2);
  assert.equal(response.writes[0], frames.join(''));
  assert.match(response.writes[1], /event: ping/);
});

test('SseWriter waits for drain on backpressure and closes idempotently', async () => {
  const response = new FakeResponse({ backpressureAt: [0] });
  const writer = new SseWriter(response);

  await writer.writeFrame('ping', { type: 'ping' });
  assert.equal(response.listenerCount('close'), 0);
  assert.equal(response.listenerCount('drain'), 0);
  await Promise.all([writer.close(), writer.close(), writer.close()]);

  assert.equal(response.writes.length, 1);
  assert.equal(response.ended, 1);
  assert.equal(writer.closed, true);
});


test('SseWriter flushes already queued frames before close', async () => {
  const response = new FakeResponse();
  const writer = new SseWriter(response);

  const queued = writer.writeFrame('ping', { type: 'ping', sequence: 1 });
  const closing = writer.close();
  await Promise.all([queued, closing]);

  assert.equal(response.writes.length, 1);
  assert.match(response.writes[0], /"sequence":1/);
  assert.equal(response.ended, 1);
});

test('HeartbeatScheduler enqueues due heartbeats and ignores terminal or removed contexts', async () => {
  let now = 1000;
  const scheduler = new HeartbeatScheduler({ intervalMs: 100, now: () => now });
  const responseA = new FakeResponse();
  const responseB = new FakeResponse();
  const contextA = {
    requestId: 'a', writer: new SseWriter(responseA), terminal: false,
    heartbeatEnabled: true, messageStartSent: true, nextHeartbeatAt: 1100,
  };
  const contextB = {
    requestId: 'b', writer: new SseWriter(responseB), terminal: true,
    heartbeatEnabled: true, messageStartSent: true, nextHeartbeatAt: 1100,
  };

  scheduler.register(contextA);
  scheduler.register(contextB);
  now = 1099;
  await scheduler.tick();
  assert.equal(responseA.writes.length, 0);

  now = 1100;
  await scheduler.tick();
  assert.equal(responseA.writes.length, 1);
  assert.equal(responseB.writes.length, 0);
  assert.equal(contextA.nextHeartbeatAt, 1200);

  scheduler.unregister(contextA);
  now = 1300;
  await scheduler.tick();
  assert.equal(responseA.writes.length, 1);
});


test('HeartbeatScheduler uses transport comments before message_start', async () => {
  let now = 1000;
  const scheduler = new HeartbeatScheduler({ intervalMs: 100, now: () => now });
  const response = new FakeResponse();
  const context = {
    requestId: 'prestart', writer: new SseWriter(response), terminal: false,
    heartbeatEnabled: true, messageStartSent: false, nextHeartbeatAt: 1000,
  };
  scheduler.register(context);

  await scheduler.tick();

  assert.deepEqual(response.writes, [': keep-alive\n\n']);
});

test('RequestContext cancellation aborts only its own attempts and cleanup is idempotent', async () => {
  const config = loadConfig({ HEARTBEAT_INTERVAL_MS: '1000' });
  const scheduler = new HeartbeatScheduler({ intervalMs: 1000 });
  const reqA = new FakeRequest();
  const reqB = new FakeRequest();
  const resA = new FakeResponse();
  const resB = new FakeResponse();
  const contextA = new RequestContext({ requestId: 'a', req: reqA, res: resA, config, scheduler });
  const contextB = new RequestContext({ requestId: 'b', req: reqB, res: resB, config, scheduler });
  const controllerA = new AbortController();
  const controllerB = new AbortController();
  contextA.trackAbortController(controllerA);
  contextB.trackAbortController(controllerB);

  await contextA.cancel('client_disconnect');
  await contextA.cancel('duplicate_cancel');

  assert.equal(controllerA.signal.aborted, true);
  assert.equal(controllerB.signal.aborted, false);
  assert.equal(contextA.terminal, true);
  assert.equal(contextA.state, 'CANCELLED');
  assert.equal(contextB.terminal, false);
  assert.equal(resA.ended, 1);
  assert.equal(resB.ended, 0);
});

test('BufferBudget isolates reservations and releases them idempotently', async () => {
  const { BufferBudget } = await import('../vllm-cc-proxy.js');
  const budget = new BufferBudget(100);

  assert.equal(budget.reserve('a', 60), true);
  assert.equal(budget.reserve('b', 50), false);
  assert.equal(budget.currentBytes, 60);
  assert.equal(budget.release('a'), 60);
  assert.equal(budget.release('a'), 0);
  assert.equal(budget.reserve('b', 50), true);
  assert.equal(budget.currentBytes, 50);
});

test('HeartbeatScheduler does not queue another heartbeat while the prior write is pending', async () => {
  let now = 1000;
  let resolveWrite;
  let writes = 0;
  const scheduler = new HeartbeatScheduler({ intervalMs: 100, now: () => now });
  const context = {
    requestId: 'slow-writer',
    writer: {
      closed: false,
      writeFrame() {
        writes += 1;
        return new Promise((resolve) => { resolveWrite = resolve; });
      },
      writeRaw() {
        writes += 1;
        return new Promise((resolve) => { resolveWrite = resolve; });
      },
    },
    terminal: false,
    heartbeatEnabled: true,
    heartbeatPending: false,
    messageStartSent: true,
    nextHeartbeatAt: 1000,
  };
  scheduler.register(context);

  const firstTick = scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  now = 1200;
  const secondTick = scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writes, 1);
  resolveWrite();
  await Promise.all([firstTick, secondTick]);
  assert.equal(context.heartbeatPending, false);
});
