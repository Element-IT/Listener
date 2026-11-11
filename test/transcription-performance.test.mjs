import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

process.env.TZ = 'Asia/Yekaterinburg';
process.env.CAMERA_TIME_ZONE = 'Asia/Yekaterinburg';
process.env.DISPLAY_TIME_ZONE = 'Asia/Yekaterinburg';
process.env.TRANSCRIPTION_CAPTURE_CHUNK_SECONDS = '60';
process.env.TRANSCRIPTION_RECORDING_CONCURRENCY = '2';

const {
  buildScheduledActionTranscript,
  checkFfmpeg,
  chunkFixedPcm,
  createXmG711Demuxer,
  clearFfmpegCheckCache,
  createXmAudioChunkWriter,
  openXmArchivePcmSession,
  openXmWebSocket,
  transcriptCacheKey,
  transcribeScheduledRecording,
  transcriptionDurationSeconds
} = await import('../server.mjs');

function fakeProcess(onReady) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => onReady(child));
  return child;
}

const selection = {
  groupName: 'Performance test',
  channel: 2,
  from: '2026-09-14T11:30:00',
  to: '2026-09-14T11:32:05.750'
};

const recording = {
  startTime: '2026-09-14T11:30:00',
  endTime: '2026-09-14T11:32:05.750',
  fileName: 'large-chunk.h264'
};

test('successful ffmpeg availability checks share in-flight work and remain cached by command', async t => {
  clearFfmpegCheckCache();
  t.after(() => clearFfmpegCheckCache());
  let spawns = 0;
  const spawnProcess = command => {
    spawns += 1;
    return fakeProcess(child => {
      child.stdout.end(`ffmpeg version test-${command}\n`);
      child.emit('close', 0);
    });
  };

  const firstPromise = checkFfmpeg('test-ffmpeg-cache-a', { spawnProcess });
  const secondPromise = checkFfmpeg('test-ffmpeg-cache-a', { spawnProcess });
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(spawns, 1);
  assert.equal(first.available, true);
  assert.deepEqual(second, first);

  const cached = await checkFfmpeg('test-ffmpeg-cache-a', { spawnProcess });
  assert.deepEqual(cached, first);
  assert.equal(spawns, 1);

  const fresh = await checkFfmpeg('test-ffmpeg-cache-a', { spawnProcess, bypassCache: true });
  assert.equal(fresh.available, true);
  assert.equal(spawns, 2);
  await checkFfmpeg('test-ffmpeg-cache-a', { spawnProcess });
  assert.equal(spawns, 2, 'a bypassed probe must not discard the normal cached result');

  const otherCommand = await checkFfmpeg('test-ffmpeg-cache-b', { spawnProcess });
  assert.equal(otherCommand.available, true);
  assert.equal(spawns, 3);

  clearFfmpegCheckCache();
  await checkFfmpeg('test-ffmpeg-cache-a', { spawnProcess });
  assert.equal(spawns, 4);
});

test('a failed ffmpeg availability check is retried instead of becoming a stale cache entry', async t => {
  clearFfmpegCheckCache();
  t.after(() => clearFfmpegCheckCache());
  let spawns = 0;
  const spawnProcess = () => {
    spawns += 1;
    const attempt = spawns;
    return fakeProcess(child => {
      if (attempt === 1) child.stderr.end('temporary failure');
      else child.stdout.end('ffmpeg version recovered\n');
      child.emit('close', attempt === 1 ? 1 : 0);
    });
  };

  const failed = await checkFfmpeg('test-ffmpeg-retry', { spawnProcess });
  const recovered = await checkFfmpeg('test-ffmpeg-retry', { spawnProcess });

  assert.equal(failed.available, false);
  assert.equal(recovered.available, true);
  assert.equal(spawns, 2);
});

test('a configured 60 second archive block is accepted but never exceeded', () => {
  const config = {
    transcriptionArchiveMaxSeconds: 0,
    transcriptionCaptureChunkSeconds: 60,
    transcriptionLiveSeconds: 18
  };

  assert.equal(transcriptionDurationSeconds(
    new URLSearchParams({ duration: '21600' }),
    config,
    'archive'
  ), 60);
  assert.equal(transcriptionDurationSeconds(
    new URLSearchParams({ duration: '47.25' }),
    config,
    'archive'
  ), 47.25);
});

test('larger scheduled blocks cover the recording without gaps and publish each result progressively', async () => {
  const contextLines = [];
  const progress = {};
  const requests = [];
  const progressSnapshots = [];
  let activeRequests = 0;

  await transcribeScheduledRecording({
    item: recording,
    selection,
    coverage: { offsetSeconds: 0, durationSeconds: 125.75 },
    settings: { transcriptSeconds: 60 },
    contextLines,
    progress,
    onProgress(update) {
      Object.assign(progress, update);
      if (update.completedChunks) {
        progressSnapshots.push({
          completedChunks: progress.completedChunks,
          transcribedSeconds: progress.transcribedSeconds,
          lines: contextLines.length
        });
      }
    },
    async requestApi(pathname) {
      activeRequests += 1;
      assert.equal(activeRequests, 1, 'camera requests must remain bounded and sequential');

      const params = new URL(pathname, 'http://localhost').searchParams;
      const offset = Number(params.get('offsetSeconds'));
      const duration = Number(params.get('duration'));
      requests.push({ offset, duration });

      // The previous block must already be available before the next camera request starts.
      assert.equal(contextLines.length, requests.length - 1);
      assert.equal(progress.completedChunks || 0, requests.length - 1);

      await Promise.resolve();
      activeRequests -= 1;
      return {
        durationSeconds: duration,
        segments: [{ start: offset, end: offset + duration, text: `block ${requests.length}` }]
      };
    }
  });

  assert.deepEqual(requests, [
    { offset: 0, duration: 60 },
    { offset: 60, duration: 60 },
    { offset: 120, duration: 5.75 }
  ]);
  assert.deepEqual(progressSnapshots, [
    { completedChunks: 1, transcribedSeconds: 60, lines: 1 },
    { completedChunks: 2, transcribedSeconds: 120, lines: 2 },
    { completedChunks: 3, transcribedSeconds: 125.75, lines: 3 }
  ]);
  assert.equal(contextLines.length, 3);
  assert.match(contextLines[0], /11:30:00/);
  assert.match(contextLines.at(-1), /11:32:05/);
});

test('recordings use bounded concurrency while transcript text keeps archive order', async () => {
  const items = [
    { startTime: '2026-09-14T11:30:00', endTime: '2026-09-14T11:31:00', fileName: 'first.h264' },
    { startTime: '2026-09-14T11:31:00', endTime: '2026-09-14T11:32:00', fileName: 'second.h264' },
    { startTime: '2026-09-14T11:32:00', endTime: '2026-09-14T11:33:00', fileName: 'third.h264' }
  ];
  const delayByFile = new Map([
    ['first.h264', 35],
    ['second.h264', 5],
    ['third.h264', 1]
  ]);
  let active = 0;
  let maxActive = 0;

  const result = await buildScheduledActionTranscript({
    action: { id: 'performance-action', name: 'Performance action' },
    selections: [{
      groupName: 'Performance test',
      channel: 2,
      from: '2026-09-14T11:30:00',
      to: '2026-09-14T11:33:00'
    }]
  }, {
    settings: { transcriptSeconds: 60 },
    async requestApi(pathname) {
      const url = new URL(pathname, 'http://localhost');
      if (url.pathname.endsWith('/search')) return { vendor: 'xm', items };

      const fileName = url.searchParams.get('fileName');
      const duration = Number(url.searchParams.get('duration'));
      const offset = Number(url.searchParams.get('offsetSeconds'));
      active += 1;
      maxActive = Math.max(maxActive, active);
      assert.ok(active <= 2, `unexpected ${active} concurrent camera requests`);
      await new Promise(resolve => setTimeout(resolve, delayByFile.get(fileName)));
      active -= 1;
      return {
        durationSeconds: duration,
        segments: [{ start: offset, end: offset + duration, text: fileName }]
      };
    }
  });

  assert.equal(maxActive, 2);
  assert.equal(result.completedRecordings, 3);
  assert.deepEqual(
    result.contextLines.map(line => line.match(/(first|second|third)\.h264/)?.[0]),
    ['first.h264', 'second.h264', 'third.h264']
  );
});

test('XM audio is forwarded as it arrives instead of waiting for the whole large block', () => {
  const writes = [];
  const sink = new Writable({
    write(chunk, encoding, done) {
      writes.push(Buffer.from(chunk));
      done();
    }
  });
  const writer = createXmAudioChunkWriter(sink, 60);

  writer.write(Buffer.alloc(8000, 0x11));
  assert.equal(Buffer.concat(writes).length, 8000);
  assert.equal(writer.bytesWritten, 8000);
  assert.equal(writer.ended, false);

  writer.write(Buffer.alloc(16000, 0x22));
  assert.equal(Buffer.concat(writes).length, 24000);
  assert.equal(writer.bytesWritten, 24000);
  assert.equal(writer.ended, false);

  writer.end();
  assert.equal(writer.ended, true);
});

test('XM audio demuxer accepts dynamic 320 and 640 byte G.711 frames across arbitrary chunks', () => {
  const frame = (length, fill) => Buffer.concat([
    Buffer.from([0x00, 0x00, 0x01, 0xfa, 0x0a, 0x02, length & 0xff, length >>> 8]),
    Buffer.alloc(length, fill)
  ]);
  const expected = [Buffer.alloc(320, 0x31), Buffer.alloc(640, 0x62)];
  const invalidZeroLength = Buffer.from([0x00, 0x00, 0x01, 0xfa, 0x0a, 0x02, 0x00, 0x00]);
  const invalidHugeLength = Buffer.from([0x00, 0x00, 0x01, 0xfa, 0x0a, 0x02, 0xff, 0xff]);
  const input = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x01, 0xfc, 0x13, 0x0a, 0x40, 0x01]),
    Buffer.alloc(23, 0xaa),
    invalidZeroLength,
    Buffer.alloc(7, 0xbb),
    frame(320, 0x31),
    Buffer.alloc(11, 0xcc),
    invalidHugeLength,
    Buffer.alloc(5, 0xdd),
    frame(640, 0x62)
  ]);
  const chunks = [
    input.subarray(0, 3),
    input.subarray(3, 47),
    input.subarray(47, 53),
    input.subarray(53, 211),
    input.subarray(211, 392),
    input.subarray(392, 815),
    input.subarray(815)
  ];
  const actual = [];
  const demuxer = createXmG711Demuxer(payload => actual.push(Buffer.from(payload)));
  for (const chunk of chunks) demuxer.push(chunk);
  demuxer.flush();

  assert.deepEqual(actual, expected);
});

test('XM audio demuxer discards an incomplete frame on flush and resumes cleanly', () => {
  const header = length => Buffer.from([
    0x00, 0x00, 0x01, 0xfa, 0x0a, 0x02, length & 0xff, length >>> 8
  ]);
  const actual = [];
  const demuxer = createXmG711Demuxer(payload => actual.push(Buffer.from(payload)));
  demuxer.push(Buffer.concat([header(320), Buffer.alloc(73, 0x11)]));
  demuxer.flush();
  assert.deepEqual(actual, []);

  demuxer.push(Buffer.concat([header(320), Buffer.alloc(320, 0x22)]));
  assert.deepEqual(actual, [Buffer.alloc(320, 0x22)]);
});

test('one progressive XM recording accepts 320-byte camera frames and cleans up once', async () => {
  const calls = { login: 0, logout: 0, spawn: 0, websocket: 0, command: 0, close: 0 };
  const rawPayload = Buffer.alloc(320, 0x7f);
  const xmPacket = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x01, 0xfa, 0x0a, 0x02, 0x40, 0x01]),
    rawPayload
  ]);

  const dependencies = {
    async login() {
      calls.login += 1;
      return { salt: 'test-salt' };
    },
    async logout() {
      calls.logout += 1;
    },
    spawnProcess() {
      calls.spawn += 1;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
      };
      child.stdin = new Writable({
        write(chunk, encoding, done) {
          // G.711 8 kHz bytes become PCM16 mono at 16 kHz (four output bytes per input byte).
          child.stdout.write(Buffer.alloc(chunk.length * 4, 0x33));
          done();
        },
        final(done) {
          child.stdout.end();
          child.exitCode = 0;
          setImmediate(() => child.emit('close', 0, null));
          done();
        }
      });
      return child;
    },
    async cameraJsonRequest() {
      calls.command += 1;
      return { Ret: 100 };
    },
    async openWebSocket(config, path, handlers) {
      calls.websocket += 1;
      let destroyed = false;
      const handle = {
        pause() {},
        resume() {},
        destroy() {
          if (destroyed) return;
          destroyed = true;
          calls.close += 1;
          handlers.onClose();
        }
      };
      setImmediate(async () => {
        await handlers.onText(JSON.stringify({ Ret: 100, State: 'Begin' }));
        for (let index = 0; index < 8; index += 1) handlers.onBinary(xmPacket);
        handle.destroy();
      });
      return handle;
    }
  };

  const session = await openXmArchivePcmSession({
    ffmpegPath: 'test-ffmpeg',
    xmAudioCodec: 'mulaw',
    transcriptionCaptureTimeoutMs: 30000
  }, new URLSearchParams({
    fileName: '/archive/test.h264',
    localBeginTime: '2026-09-14 11:30:00'
  }), 2, 'main', {
    audioFilter: 'off',
    durationSeconds: 1,
    offsetSeconds: 0
  }, dependencies);

  const pcm = [];
  for await (const chunk of chunkFixedPcm(session.readable, 320 * 4)) pcm.push(chunk);
  const stats = await session.done;
  await session.close();
  await session.close();

  assert.deepEqual(pcm.map(chunk => chunk.length), Array(8).fill(320 * 4));
  assert.equal(Buffer.concat(pcm).length, 320 * 4 * 8);
  assert.equal(stats.rawBytes, 320 * 8);
  assert.equal(stats.partial, true);
  assert.equal(stats.receivedSeconds, 0.32);
  assert.deepEqual(calls, {
    login: 1,
    logout: 1,
    spawn: 1,
    websocket: 1,
    command: 1,
    close: 1
  });
});

test('cancelling a stalled XM websocket upgrade does not wait for the network timeout', async t => {
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // Deliberately never answer the upgrade request.
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = openXmWebSocket({
    scheme: 'http', host: '127.0.0.1', httpPort: server.address().port
  }, '/stalled-upgrade', { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(pending, error => error.statusCode === 499);
  assert.ok(Date.now() - startedAt < 1000, 'websocket cancellation should be prompt');
});

test('fixed PCM chunking preserves bytes across arbitrary asynchronous input boundaries', async () => {
  const input = Buffer.from(Array.from({ length: 17 }, (_, index) => index));
  async function* source() {
    yield input.subarray(0, 2);
    await Promise.resolve();
    yield input.subarray(2, 9);
    yield input.subarray(9, 10);
    await Promise.resolve();
    yield input.subarray(10);
  }

  const chunks = [];
  for await (const chunk of chunkFixedPcm(source(), 5)) chunks.push(chunk);

  assert.deepEqual(chunks.map(chunk => chunk.length), [5, 5, 5, 2]);
  assert.deepEqual(Buffer.concat(chunks), input);
});

test('fixed PCM chunking rejects invalid block sizes before consuming audio', async () => {
  for (const bytesPerChunk of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    let consumed = false;
    async function* source() {
      consumed = true;
      yield Buffer.alloc(1);
    }

    await assert.rejects(async () => {
      for await (const chunk of chunkFixedPcm(source(), bytesPerChunk)) void chunk;
    }, /positive integer/i);
    assert.equal(consumed, false);
  }
});

test('fixed PCM chunking propagates an asynchronous source error', async () => {
  const sourceError = new Error('XM stream failed');
  const chunks = [];
  async function* source() {
    yield Buffer.from('abcdef');
    throw sourceError;
  }

  await assert.rejects(async () => {
    for await (const chunk of chunkFixedPcm(source(), 4)) chunks.push(chunk);
  }, error => error === sourceError);
  assert.deepEqual(chunks, [Buffer.from('abcd')]);
});

test('larger transcript blocks keep stable, non-overlapping cache identities', () => {
  const config = {
    host: 'camera.local',
    xmAudioCodec: 'mulaw',
    gigaamModel: 'v3_e2e_ctc',
    transcriptionChunkSeconds: 20
  };
  const params = new URLSearchParams({
    fileName: recording.fileName,
    from: recording.startTime,
    to: recording.endTime
  });
  const base = {
    vendor: 'xm',
    channel: 2,
    stream: 'main',
    audioFilter: 'voice'
  };

  const first = transcriptCacheKey(config, params, { ...base, durationSeconds: 60, offsetSeconds: 0 });
  const retry = transcriptCacheKey(config, params, { ...base, durationSeconds: 60, offsetSeconds: 0 });
  const next = transcriptCacheKey(config, params, { ...base, durationSeconds: 60, offsetSeconds: 60 });
  const shortTail = transcriptCacheKey(config, params, { ...base, durationSeconds: 5.75, offsetSeconds: 120 });
  const progressive = transcriptCacheKey(config, params, {
    ...base,
    durationSeconds: 60,
    offsetSeconds: 0,
    pipeline: 'xm-continuous-pcm-v1'
  });
  const progressiveRetry = transcriptCacheKey(config, params, {
    ...base,
    durationSeconds: 60,
    offsetSeconds: 0,
    pipeline: 'xm-continuous-pcm-v1'
  });
  const anchored = transcriptCacheKey(config, params, {
    ...base,
    durationSeconds: 60,
    offsetSeconds: 60,
    pipeline: 'xm-continuous-pcm-v1',
    anchorOffsetSeconds: 0
  });
  const restarted = transcriptCacheKey(config, params, {
    ...base,
    durationSeconds: 60,
    offsetSeconds: 60,
    pipeline: 'xm-continuous-pcm-v1',
    anchorOffsetSeconds: 60
  });
  const shorterSession = transcriptCacheKey(config, params, {
    ...base,
    durationSeconds: 60,
    offsetSeconds: 60,
    pipeline: 'xm-continuous-pcm-v1',
    anchorOffsetSeconds: 0,
    sessionEndOffsetSeconds: 120
  });
  const longerSession = transcriptCacheKey(config, params, {
    ...base,
    durationSeconds: 60,
    offsetSeconds: 60,
    pipeline: 'xm-continuous-pcm-v1',
    anchorOffsetSeconds: 0,
    sessionEndOffsetSeconds: 180
  });

  assert.equal(first, retry);
  assert.notEqual(first, next);
  assert.notEqual(next, shortTail);
  assert.equal(progressive, progressiveRetry);
  assert.notEqual(progressive, first);
  assert.notEqual(anchored, restarted);
  assert.notEqual(shorterSession, longerSession);
});
