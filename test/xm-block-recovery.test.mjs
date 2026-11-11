import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  XM_RECOVERY_PIPELINE,
  xmRecoveryPlans,
  readXmRecoveryPcm
} from '../xm-block-recovery.mjs';

const { transcribeXmRecoveryBlock, transcriptCacheKey } = await import('../server.mjs');
const PCM_BYTES_PER_SECOND = 32000;
const RAW_BYTES_PER_SECOND = 8000;

function pcm(seconds, value = 0) {
  return Buffer.alloc(Math.round(seconds * PCM_BYTES_PER_SECOND), value);
}

function fakeSession(capture, overrides = {}) {
  const state = { closed: 0 };
  const bytes = overrides.pcm || pcm(capture.durationSeconds - 0.025);
  const stats = {
    rawBytes: Math.round(capture.durationSeconds * RAW_BYTES_PER_SECOND),
    partial: false,
    ...overrides.stats
  };
  return {
    state,
    readable: overrides.readable || Readable.from([bytes], { objectMode: false }),
    done: Promise.resolve(stats),
    async close() { state.closed += 1; }
  };
}

function fixture({ openSession, asrResult } = {}) {
  const cache = new Map();
  const wavs = new Map();
  const calls = { captures: [], sessions: [], cacheReads: [], cacheWrites: [], wavs: [], asr: [], unlinks: [] };
  const options = {
    item: { fileName: 'offline-camera-14.h264', startTime: '2026-10-23T05:00:00' },
    coverage: { offsetSeconds: 1800, durationSeconds: 1800, from: '2026-10-23T02:30:00Z' },
    settings: { cameraTimeZone: 'Europe/Moscow', displayTimeZone: 'Asia/Yekaterinburg' }
  };
  const block = { offsetSeconds: 3582, durationSeconds: 18 };
  const context = {
    config: { host: 'offline', gigaamModel: 'test', xmAudioCodec: 'pcm_alaw', transcriptionChunkSeconds: 18 },
    channel: 14,
    stream: 'main',
    audioFilter: 'voice',
    baseQuery: new URLSearchParams({
      fileName: options.item.fileName,
      localBeginTime: '2026-10-23 05:00:00',
      from: '2026-10-23T05:30:00',
      to: '2026-10-23T06:00:00'
    }),
    services: {
      async readCache(key) { calls.cacheReads.push(key); return cache.get(key) || null; },
      async writeCache(key, value) { calls.cacheWrites.push(key); cache.set(key, value); },
      async openSession(capture) {
        calls.captures.push(capture);
        const session = openSession ? await openSession(capture, calls.captures.length) : fakeSession(capture);
        calls.sessions.push(session);
        return session;
      },
      async writeWav(file, bytes, sampleRate, channels) {
        assert.equal(sampleRate, 16000);
        assert.equal(channels, 1);
        wavs.set(file, bytes);
        calls.wavs.push(bytes);
      },
      async transcribe(config, file, params) {
        assert.equal(config.host, 'offline');
        const bytes = wavs.get(file);
        assert.ok(bytes, 'ASR must read only the in-memory WAV fixture');
        calls.asr.push(params);
        const result = { durationSeconds: bytes.length / PCM_BYTES_PER_SECOND, text: '', segments: [] };
        return asrResult ? asrResult(result) : result;
      },
      async unlink(file) { calls.unlinks.push(file); wavs.delete(file); }
    }
  };
  return { options, block, context, calls, cache, wavs };
}

test('recovery plans respect the whole-second selection anchor and stay below 71 seconds', () => {
  const plans = xmRecoveryPlans({ offsetSeconds: 3582, durationSeconds: 60 }, 1800);
  assert.deepEqual(plans.map(plan => [plan.captureOffsetSeconds, plan.captureDurationSeconds, plan.discardSeconds]), [
    [3572, 70, 10], [3582, 60, 0]
  ]);
  assert.ok(plans.every(plan => plan.pipeline === XM_RECOVERY_PIPELINE));
  const clipped = xmRecoveryPlans({ offsetSeconds: 1805, durationSeconds: 18 }, 1800);
  assert.deepEqual(clipped.map(plan => [plan.captureOffsetSeconds, plan.discardSeconds]), [[1800, 5], [1805, 0]]);
  assert.equal(xmRecoveryPlans({ offsetSeconds: 1800, durationSeconds: 18 }, 1800).length, 1);
  for (const block of [
    { offsetSeconds: 1800, durationSeconds: 60.001 },
    { offsetSeconds: 1799, durationSeconds: 18 },
    { offsetSeconds: 1800, durationSeconds: 0 },
    { offsetSeconds: Infinity, durationSeconds: 18 }
  ]) assert.throws(() => xmRecoveryPlans(block, 1800), RangeError);
});

test('fractional offsets include whole-second seek rounding in the discarded warmup', async () => {
  const plans = xmRecoveryPlans({ offsetSeconds: 3582.75, durationSeconds: 18 }, 1800);
  assert.deepEqual(plans.map(plan => [plan.captureOffsetSeconds, plan.captureDurationSeconds, plan.discardSeconds]), [
    [3572, 28.75, 10.75], [3582, 18.75, 0.75]
  ]);
  for (const plan of plans) {
    const wanted = pcm(17.975, 22);
    const result = await readXmRecoveryPcm(plan, async capture => fakeSession(capture, {
      pcm: Buffer.concat([pcm(plan.discardSeconds, 11), wanted])
    }));
    assert.deepEqual(result.pcm, wanted);
    assert.equal(result.durationSeconds, 17.975);
  }
  const [longest] = xmRecoveryPlans({ offsetSeconds: 3582.75, durationSeconds: 60 }, 1800);
  assert.equal(longest.captureDurationSeconds, 70.75);
  const captured = await readXmRecoveryPcm(longest, async capture => fakeSession(capture));
  assert.equal(captured.durationSeconds, 59.975);
});

test('invalid capture plans are rejected before opening any session', async () => {
  const [valid] = xmRecoveryPlans({ offsetSeconds: 3582, durationSeconds: 18 }, 1800);
  const invalid = [
    null,
    undefined,
    {},
    { ...valid, captureOffsetSeconds: -1 },
    { ...valid, captureOffsetSeconds: 3572.75 },
    { ...valid, captureDurationSeconds: Infinity },
    { ...valid, captureDurationSeconds: 71.1 },
    { ...valid, captureDurationSeconds: 27.5 },
    { ...valid, discardSeconds: -1 },
    { ...valid, discardSeconds: 11, captureDurationSeconds: 29 },
    { ...valid, durationSeconds: 0, captureDurationSeconds: 10 },
    { ...valid, durationSeconds: 61, captureDurationSeconds: 71 }
  ];
  let captures = 0;
  for (const plan of invalid) {
    await assert.rejects(readXmRecoveryPcm(plan, async capture => {
      captures += 1;
      return fakeSession(capture);
    }), RangeError);
  }
  assert.equal(captures, 0);
});

for (const seconds of [18, 57, 60]) {
  test(`full ${seconds}-second source accepts only the small decoder drain shortfall`, async () => {
    const [plan] = xmRecoveryPlans({ offsetSeconds: 1800, durationSeconds: seconds }, 1800);
    let session;
    const result = await readXmRecoveryPcm(plan, async capture => (session = fakeSession(capture)));
    assert.equal(result.durationSeconds, seconds - 0.025);
    assert.equal(result.stats.rawBytes, seconds * RAW_BYTES_PER_SECOND);
    assert.equal(session.state.closed, 1);
  });
}

test('warmup is removed from PCM, not merely hidden in transcript metadata', async () => {
  const [plan] = xmRecoveryPlans({ offsetSeconds: 3582, durationSeconds: 18 }, 1800);
  const warmup = pcm(10, 11);
  const wanted = pcm(17.975, 22);
  const result = await readXmRecoveryPcm(plan, async capture => fakeSession(capture, {
    pcm: Buffer.concat([warmup, wanted])
  }));
  assert.equal(result.durationSeconds, 17.975);
  assert.deepEqual(result.pcm, wanted);
});

for (const source of [
  { name: 'one missing raw byte despite nearly complete PCM', rawBytes: 18 * RAW_BYTES_PER_SECOND - 1 },
  { name: 'partial capture despite full raw byte count', rawBytes: 18 * RAW_BYTES_PER_SECOND, partial: true },
  { name: 'missing raw byte accounting', rawBytes: undefined }
]) {
  test(`recovery rejects ${source.name}`, async () => {
    const [plan] = xmRecoveryPlans({ offsetSeconds: 1800, durationSeconds: 18 }, 1800);
    let session;
    await assert.rejects(readXmRecoveryPcm(plan, async capture => (session = fakeSession(capture, {
      stats: { rawBytes: source.rawBytes, partial: Boolean(source.partial) }
    }))), error => error.details?.code === 'INCOMPLETE_AUDIO' && error.details.sourceGapConfirmed === false);
    assert.equal(session.state.closed, 1);
  });
}

test('oversized PCM fails the bounded reader and closes the capture', async () => {
  const [plan] = xmRecoveryPlans({ offsetSeconds: 3582, durationSeconds: 60 }, 1800);
  let session;
  await assert.rejects(readXmRecoveryPcm(plan, async capture => (session = fakeSession(capture, {
    pcm: pcm(70.2)
  }))), /exceeded its requested audio range/);
  assert.equal(session.state.closed, 1);
});

test('warmup shortfall falls back once to a direct bounded request, not the original 30-minute range', async () => {
  const state = fixture({ openSession(capture, attempt) {
    return fakeSession(capture, attempt === 1 ? {
      pcm: pcm(capture.durationSeconds - 1.225),
      stats: { rawBytes: (capture.durationSeconds - 1.2) * RAW_BYTES_PER_SECOND, partial: true }
    } : {});
  } });
  const result = await transcribeXmRecoveryBlock(state.options, state.block, state.context);
  assert.deepEqual(state.calls.captures.map(({ offsetSeconds, durationSeconds }) => [offsetSeconds, durationSeconds]), [
    [3572, 28], [3582, 18]
  ]);
  assert.equal(result.durationSeconds, 17.975);
  assert.equal(result.source.recovery.discardSeconds, 0);
  assert.equal(result.source.recovery.sourceAudioComplete, true);
  assert.equal(result.source.recovery.pipeline, 'xm-targeted-pcm-v2');
  assert.equal(result.from, '2026-10-23T02:59:42.000Z');
  assert.equal(state.calls.asr.length, 1);
  assert.equal(state.calls.cacheWrites.length, 1);
  assert.ok(state.calls.sessions.every(session => session.state.closed === 1));
  assert.equal(state.wavs.size, 0);
});

test('repeated 1.2-second source EOF is not classified as silence or cached', async () => {
  const state = fixture({ openSession(capture) {
    return fakeSession(capture, {
      pcm: pcm(capture.durationSeconds - 1.225),
      stats: { rawBytes: (capture.durationSeconds - 1.2) * RAW_BYTES_PER_SECOND, partial: true }
    });
  } });
  await assert.rejects(transcribeXmRecoveryBlock(state.options, state.block, state.context), error => {
    assert.equal(error.details.code, 'INCOMPLETE_AUDIO');
    assert.equal(error.details.sourceGapConfirmed, false);
    return true;
  });
  assert.equal(state.calls.captures.length, 2);
  assert.equal(state.calls.asr.length, 0);
  assert.equal(state.calls.cacheWrites.length, 0);
  assert.equal(state.calls.wavs.length, 0);
});

for (const receivedSeconds of [0, 0.125]) {
  test(`transport INCOMPLETE_AUDIO at ${receivedSeconds} seconds permits one bounded direct recovery`, async () => {
    const state = fixture({ openSession(capture, attempt) {
      if (attempt === 1) throw Object.assign(new Error('XM source ended before sufficient audio arrived.'), {
        statusCode: 502,
        details: {
          code: 'INCOMPLETE_AUDIO', sourceGapConfirmed: false,
          expectedDurationSeconds: capture.durationSeconds, receivedDurationSeconds: receivedSeconds
        }
      });
      return fakeSession(capture);
    } });
    const result = await transcribeXmRecoveryBlock(state.options, state.block, state.context);
    assert.deepEqual(state.calls.captures.map(({ offsetSeconds, durationSeconds }) => [offsetSeconds, durationSeconds]), [
      [3572, 28], [3582, 18]
    ]);
    assert.equal(result.durationSeconds, 17.975);
    assert.equal(result.source.recovery.captureOffsetSeconds, 3582);
    assert.equal(result.source.recovery.discardSeconds, 0);
    assert.equal(state.calls.asr.length, 1);
    assert.equal(state.calls.cacheWrites.length, 1);
  });
}

for (const kind of ['network', 'decoder', 'abort']) {
  test(`${kind} failure does not cause a second capture`, async () => {
    const controller = new AbortController();
    const failure = kind === 'abort' ? new DOMException('Stopped by test', 'AbortError')
      : Object.assign(new Error(`${kind} failed`), { code: kind === 'network' ? 'ECONNRESET' : 'FFMPEG_FAILED' });
    const state = fixture({ openSession(capture) {
      if (kind === 'network') throw failure;
      const readable = Readable.from((async function* () {
        yield pcm(1);
        if (kind === 'abort') controller.abort(failure);
        throw failure;
      })(), { objectMode: false });
      return fakeSession(capture, { readable });
    } });
    state.options.signal = controller.signal;
    await assert.rejects(transcribeXmRecoveryBlock(state.options, state.block, state.context), error => error === failure);
    assert.equal(state.calls.captures.length, 1);
    assert.equal(state.calls.asr.length, 0);
    assert.equal(state.calls.cacheWrites.length, 0);
    assert.ok(state.calls.sessions.every(session => session.state.closed === 1));
  });
}

test('an already aborted recovery does not open a session', async () => {
  const state = fixture();
  const controller = new AbortController();
  controller.abort();
  state.options.signal = controller.signal;
  await assert.rejects(transcribeXmRecoveryBlock(state.options, state.block, state.context), { name: 'AbortError' });
  assert.equal(state.calls.captures.length, 0);
});

test('recovery cache is separate from v1 and warmup/direct keys differ; second request skips capture and ASR', async () => {
  const state = fixture();
  const query = new URLSearchParams(state.context.baseQuery);
  query.set('duration', String(state.block.durationSeconds));
  query.set('offsetSeconds', String(state.block.offsetSeconds));
  const legacyKey = transcriptCacheKey(state.context.config, query, {
    vendor: 'xm', channel: 14, stream: 'main', audioFilter: 'voice',
    durationSeconds: 18, offsetSeconds: 3582, pipeline: 'xm-continuous-pcm-v1',
    anchorOffsetSeconds: 1800, sessionEndOffsetSeconds: 3600
  });
  state.cache.set(legacyKey, { durationSeconds: 18, text: 'legacy', segments: [] });
  const first = await transcribeXmRecoveryBlock(state.options, state.block, state.context);
  assert.equal(new Set(state.calls.cacheReads).size, 2, 'warmup and direct captures need distinct cache identities');
  assert.ok(state.calls.cacheReads.every(key => key !== legacyKey));
  assert.equal(state.calls.cacheWrites.length, 1);
  assert.notEqual(state.calls.cacheWrites[0], legacyKey);
  assert.equal(first.source.recovery.captureOffsetSeconds, 3572);
  assert.equal(first.source.recovery.discardSeconds, 10);
  assert.equal(first.timings.pipeline, XM_RECOVERY_PIPELINE);
  const second = await transcribeXmRecoveryBlock(state.options, state.block, state.context);
  assert.equal(second.cached, true);
  assert.equal(second.durationSeconds, first.durationSeconds);
  assert.equal(state.calls.captures.length, 1);
  assert.equal(state.calls.asr.length, 1);
  assert.equal(state.calls.cacheWrites.length, 1);
});

test('a cached short or unverified payload cannot bypass source verification', async () => {
  for (const value of [
    { durationSeconds: 18, text: '', segments: [] },
    { durationSeconds: 0.32, source: { recovery: { sourceAudioComplete: true } } },
    { durationSeconds: 18, source: { recovery: { sourceAudioComplete: false } } }
  ]) {
    const state = fixture();
    state.context.services.readCache = async () => value;
    const result = await transcribeXmRecoveryBlock(state.options, state.block, state.context);
    assert.notEqual(result.cached, true);
    assert.equal(state.calls.captures.length, 1);
    assert.equal(state.calls.asr.length, 1);
  }
});

for (const invalid of [0, 0.32, 17.90, 18, NaN, undefined]) {
  test(`invalid ASR duration ${String(invalid)} is not cached and does not recapture audio`, async () => {
    const state = fixture({ asrResult: result => ({ ...result, durationSeconds: invalid }) });
    await assert.rejects(transcribeXmRecoveryBlock(state.options, state.block, state.context), error => error.details?.code === 'INVALID_ASR_DURATION');
    assert.equal(state.calls.captures.length, 1);
    assert.equal(state.calls.asr.length, 1);
    assert.equal(state.calls.cacheWrites.length, 0);
    assert.equal(state.calls.unlinks.length, 1);
    assert.equal(state.wavs.size, 0);
  });
}

test('fully decoded silence with empty ASR text remains a successful complete block', async () => {
  const state = fixture();
  const result = await transcribeXmRecoveryBlock(state.options, state.block, state.context);
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(result.text, '');
  assert.deepEqual(result.segments, []);
  assert.equal(result.durationSeconds, 17.975);
  assert.equal(result.source.recovery.sourceAudioComplete, true);
  assert.equal(state.calls.cacheWrites.length, 1);
  assert.equal(state.calls.unlinks.length, 1);
});
