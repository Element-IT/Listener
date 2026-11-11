import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

const { openXmArchivePcmSession } = await import('../server.mjs');

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function createHarness({ openWebSocket } = {}) {
  const calls = { login: 0, logout: 0, kill: 0, socketClose: 0, command: 0 };
  const harness = { calls };
  harness.dependencies = {
    async login() {
      calls.login += 1;
      return { salt: 'offline-test-salt' };
    },
    async logout() { calls.logout += 1; },
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        calls.kill += 1;
        child.killed = true;
        child.stdout.end();
        child.stderr.end();
      };
      child.stdin = new Writable({
        write(chunk, encoding, callback) {
          child.stdout.write(Buffer.alloc(chunk.length * 4, 0x53));
          callback();
        }
      });
      harness.child = child;
      return child;
    },
    async cameraJsonRequest() {
      calls.command += 1;
      return { Ret: 100 };
    },
    async openWebSocket(config, path, handlers) {
      harness.handlers = handlers;
      let destroyed = false;
      harness.socket = {
        pause() {},
        resume() {},
        destroy() {
          if (destroyed) return;
          destroyed = true;
          calls.socketClose += 1;
          handlers.onClose();
        }
      };
      if (openWebSocket) return await openWebSocket(harness);
      return harness.socket;
    }
  };
  harness.open = signal => openXmArchivePcmSession({
    ffmpegPath: 'offline-ffmpeg',
    xmAudioCodec: 'mulaw',
    transcriptionCaptureTimeoutMs: 30000
  }, new URLSearchParams({
    fileName: '/offline/recording.h264',
    localBeginTime: '2026-10-22 05:30:00'
  }), 5, 'main', {
    audioFilter: 'off', durationSeconds: 1, offsetSeconds: 0, signal
  }, harness.dependencies);
  return harness;
}

async function collect(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('fast FFmpeg exit preserves PCM before the delayed websocket and consumer attach', { timeout: 3000 }, async t => {
  const childClosed = deferred();
  const releaseWebSocket = deferred();
  const harness = createHarness({
    async openWebSocket({ child, handlers, socket }) {
      await handlers.onText(JSON.stringify({ Ret: 100, State: 'Begin' }));
      const frame = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x01, 0xfa, 0x0a, 0x02, 0x40, 0x01]),
        Buffer.alloc(320, 0x7f)
      ]);
      for (let index = 0; index < 25; index += 1) handlers.onBinary(frame);
      // Real ChildProcess resumes stdout on exit, even if nobody has attached
      // an async iterator yet. A late consumer must not see an empty stream.
      const stdoutEnded = once(child.stdout, 'end');
      child.stdout.end();
      child.stdout.resume();
      await stdoutEnded;
      child.exitCode = 0;
      child.emit('close', 0, null);
      childClosed.resolve();
      await releaseWebSocket.promise;
      return socket;
    }
  });
  let session;
  t.after(async () => {
    releaseWebSocket.resolve();
    await session?.close();
  });
  let returned = false;
  const opening = harness.open().then(value => { returned = true; return value; });
  await childClosed.promise;
  assert.equal(returned, false, 'the consumer cannot attach before websocket opening finishes');
  assert.equal(harness.child.stdout.readableEnded, true);
  releaseWebSocket.resolve();
  session = await opening;
  const pcm = await collect(session.readable);
  const stats = await session.done;
  await session.close();
  await session.close();

  assert.deepEqual(pcm, Buffer.alloc(32000, 0x53));
  assert.equal(stats.rawBytes, 8000);
  assert.equal(stats.partial, undefined);
  assert.deepEqual(harness.calls, { login: 1, logout: 1, kill: 0, socketClose: 1, command: 1 });
});

for (const kind of ['process error', 'stdout error', 'nonzero exit']) {
  test(`FFmpeg ${kind} rejects a waiting PCM consumer and cleans up exactly once`, { timeout: 3000 }, async t => {
    const harness = createHarness();
    const session = await harness.open();
    t.after(() => session.close());
    const expected = new Error(`offline ${kind}`);
    const matches = kind === 'nonzero exit'
      ? error => error.statusCode === 502 && /ffmpeg failed/.test(error.message)
      : error => error === expected;
    const consumerRejected = assert.rejects(collect(session.readable), matches);
    const completionRejected = assert.rejects(session.done, matches);

    if (kind === 'process error') harness.child.emit('error', expected);
    else if (kind === 'stdout error') harness.child.stdout.emit('error', expected);
    else {
      harness.child.stderr.write('offline decoder rejected input');
      harness.child.exitCode = 1;
      harness.child.emit('close', 1, null);
    }
    await Promise.all([consumerRejected, completionRejected]);
    await session.close();
    await session.close();
    assert.equal(session.readable.destroyed, true);
    assert.equal(harness.handlers.signal.aborted, true);
    assert.deepEqual(harness.calls, {
      login: 1, logout: 1, kill: kind === 'nonzero exit' ? 0 : 1, socketClose: 1, command: 0
    });
  });
}

test('cancellation rejects a waiting PCM consumer and releases the camera session once', { timeout: 3000 }, async t => {
  const controller = new AbortController();
  const harness = createHarness();
  const session = await harness.open(controller.signal);
  t.after(() => session.close());
  const isCancellation = error => error.statusCode === 499 && /cancelled/.test(error.message);
  const consumerRejected = assert.rejects(collect(session.readable), isCancellation);
  const completionRejected = assert.rejects(session.done, isCancellation);
  controller.abort();
  await Promise.all([consumerRejected, completionRejected]);
  await session.close();
  await session.close();
  assert.equal(session.readable.destroyed, true);
  assert.equal(harness.handlers.signal.aborted, true);
  assert.deepEqual(harness.calls, { login: 1, logout: 1, kill: 1, socketClose: 1, command: 0 });
});
