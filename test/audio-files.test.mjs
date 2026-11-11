import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { handleAudioFileTranscription, validateAudioUpload } from '../audio-files.mjs';
import { chunkFixedPcm, writePcm16Wav } from '../server.mjs';

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffmpegAvailable = spawnSync(ffmpegPath, ['-version'], { windowsHide: true, timeout: 5000, stdio: 'ignore' }).status === 0;
const model = 'v3_e2e_rnnt';
const pcmBytesPerSecond = 32000;

function query(fileName = '1-recording-20261009-235958.wav', extra = {}) {
  return new URLSearchParams({ fileName, ...extra });
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'listener-audio-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t, durationSeconds = 12.25, format = 'wav') {
  const directory = await temporaryDirectory(t);
  const pcm = Buffer.alloc(Math.round(durationSeconds * pcmBytesPerSecond));
  for (let offset = 0; offset < pcm.length; offset += 2) {
    pcm.writeInt16LE(Math.round(6000 * Math.sin((offset / 2) * 2 * Math.PI * 440 / 16000)), offset);
  }
  const wavPath = path.join(directory, 'source.wav');
  await writePcm16Wav(wavPath, pcm, 16000, 1);
  if (format === 'wav') return fs.readFile(wavPath);
  const outputPath = path.join(directory, `source.${format}`);
  const process = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', wavPath, outputPath], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  process.stderr.on('data', value => { stderr += value; });
  const [code] = await once(process, 'close');
  assert.equal(code, 0, `Audio fixture encoding failed: ${stderr}`);
  return fs.readFile(outputPath);
}

async function harness(t, overrides = {}) {
  const tempRoot = await temporaryDirectory(t);
  const requests = [];
  const calls = [];
  const failures = [];
  const services = {
    config: { ffmpegPath, gigaamModel: model, transcriptionChunkSeconds: 5 },
    tempRoot,
    timeZone: 'Asia/Yekaterinburg',
    chunkFixedPcm,
    writePcm16Wav,
    publicError: error => error.message,
    transcribe: async (config, wavPath, options) => {
      const wav = await fs.readFile(wavPath);
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
      assert.equal(wav.readUInt16LE(22), 1);
      assert.equal(wav.readUInt32LE(24), 16000);
      assert.equal(wav.readUInt16LE(34), 16);
      const durationSeconds = wav.readUInt32LE(40) / pcmBytesPerSecond;
      assert.equal(wav.length, 44 + durationSeconds * pcmBytesPerSecond);
      calls.push({ model: config.gigaamModel, offset: options.offsetSeconds, durationSeconds, wavPath });
      return {
        text: `Фрагмент ${calls.length}`,
        segments: [{ start: options.offsetSeconds, end: options.offsetSeconds + durationSeconds, text: `Фрагмент ${calls.length}` }]
      };
    },
    ...overrides
  };
  const server = http.createServer((req, res) => {
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const request = handleAudioFileTranscription(req, res, new URL(req.url, 'http://localhost').searchParams, {
      ...services,
      signal: controller.signal
    }).catch(error => {
      failures.push(error);
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    requests.push(request);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.all(requests);
  });
  return {
    port: server.address().port,
    tempRoot,
    calls,
    failures,
    async settled() {
      await Promise.all(requests);
      assert.deepEqual(await fs.readdir(tempRoot), [], 'per-request temporary upload and WAV files must be removed');
    }
  };
}

function upload(server, data, { params = query(), headers = {}, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.port, method: 'POST', path: `/transcribe?${params}`,
      headers: { 'Content-Type': 'application/octet-stream', ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': data.length }), ...headers }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const events = res.headers['content-type']?.includes('application/x-ndjson')
          ? body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
        resolve({ status: res.statusCode, body, events });
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Test upload timed out')));
    req.once('error', reject);
    req.end(data);
  });
}

test('audio upload validates filename, format, empty input and declared size before allocating a job', () => {
  const valid = validateAudioUpload(query('1-recording-20261009-142239.FLAC'), { 'content-length': '12' }, 12);
  assert.deepEqual(valid, { fileName: '1-recording-20261009-142239.FLAC', extension: '.flac', startTime: '2026-10-09T14:22:39' });
  const cases = [
    [query(''), {}, 400],
    [query('../recording.wav'), {}, 400],
    [query('C:\\private\\recording.wav'), {}, 400],
    [query('recording\0.wav'), {}, 400],
    [query('recording.exe'), {}, 415],
    [query(), { 'content-length': '0' }, 400],
    [query(), { 'content-length': '-1' }, 400],
    [query(), { 'content-length': 'bad' }, 400],
    [query(), { 'content-length': '13' }, 413]
  ];
  for (const [params, headers, expected] of cases) {
    assert.throws(() => validateAudioUpload(params, headers, 12), { statusCode: expected });
  }
});

test('WAV upload transcribes every PCM chunk with selected model and filename timing across midnight', async t => {
  if (!ffmpegAvailable) return t.skip('FFmpeg is not available via FFMPEG_PATH or PATH.');
  const body = await fixture(t);
  const server = await harness(t);
  const response = await upload(server, body, { params: query(undefined, { model }) });
  assert.equal(response.status, 200);
  assert.deepEqual(server.calls.map(call => [call.model, call.offset, call.durationSeconds]), [
    [model, 0, 5], [model, 5, 5], [model, 10, 2.25]
  ]);
  assert.equal(new Set(server.calls.map(call => call.wavPath)).size, 1, 'WAV scratch space is reused across chunks');
  assert.equal(response.events[0].type, 'start');
  assert.equal(response.events[0].model, model);
  assert.equal(response.events[0].timeZone, 'Asia/Yekaterinburg');
  assert.deepEqual(response.events.filter(event => event.type === 'block').map(event => event.processedSeconds), [5, 10, 12.25]);
  const completed = response.events.filter(event => event.type === 'done');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].durationSeconds, 12.25);
  assert.match(completed[0].txt, /09\.10\.2026 23:59:58 — 10\.10\.2026 00:00:03/);
  assert.match(completed[0].txt, /10\.10\.2026 00:00:03 — 10\.10\.2026 00:00:08/);
  assert.match(completed[0].txt, /10\.10\.2026 00:00:08 — 10\.10\.2026 00:00:10/);
  assert.equal(response.events.some(event => event.type === 'error'), false);
  await server.settled();
});

test('FLAC upload is decoded with real FFmpeg and retains relative timing for filenames without a date', async t => {
  if (!ffmpegAvailable) return t.skip('FFmpeg is not available via FFMPEG_PATH or PATH.');
  const body = await fixture(t, 6.5, 'flac');
  const server = await harness(t);
  const response = await upload(server, body, { params: query('meeting.flac') });
  assert.equal(response.status, 200);
  assert.deepEqual(server.calls.map(call => [call.offset, call.durationSeconds]), [[0, 5], [5, 1.5]]);
  const done = response.events.find(event => event.type === 'done');
  assert.ok(done);
  assert.equal(done.startTime, null);
  assert.match(done.txt, /\[00:00:05 — 00:00:06\] Фрагмент 2/);
  await server.settled();
});

for (const format of ['m4a', 'mp3', 'ogg', 'opus']) {
  test(`${format.toUpperCase()} uploads pass the media demuxer whitelist and produce all audio chunks`, async t => {
    if (!ffmpegAvailable) return t.skip('FFmpeg is not available via FFMPEG_PATH or PATH.');
    const body = await fixture(t, 6.5, format);
    if (format === 'm4a') {
      const mediaPosition = body.indexOf(Buffer.from('mdat'));
      const moviePosition = body.indexOf(Buffer.from('moov'));
      assert.ok(mediaPosition >= 0 && moviePosition > mediaPosition, 'M4A fixture must have moov after audio data');
    }
    const server = await harness(t);
    const response = await upload(server, body, { params: query(`2-recording-20261009-142239.${format}`) });
    assert.equal(response.status, 200);
    assert.equal(response.events.some(event => event.type === 'error'), false, response.body);
    assert.equal(server.calls.length, 2);
    assert.equal(server.calls[0].offset, 0);
    assert.equal(server.calls[0].durationSeconds, 5);
    assert.equal(server.calls[1].offset, 5);
    const done = response.events.find(event => event.type === 'done');
    assert.ok(done, response.body);
    assert.ok(done.durationSeconds >= 6.4 && done.durationSeconds <= 6.7, `Decoded duration: ${done.durationSeconds}`);
    assert.match(done.txt, /09\.10\.2026 14:22:39/);
    await server.settled();
  });
}

test('HTTP upload rejects changed models and invalid requests without invoking ASR', async t => {
  const server = await harness(t, { maxBytes: 12 });
  for (const [params, body, expected] of [
    [query(undefined, { model: 'different-model' }), Buffer.from('abc'), 409],
    [query('../escape.wav'), Buffer.from('abc'), 400],
    [query('script.txt'), Buffer.from('abc'), 415],
    [query(), Buffer.alloc(0), 400],
    [query(), Buffer.alloc(13), 413]
  ]) {
    const response = await upload(server, body, { params });
    assert.equal(response.status, expected);
  }
  assert.deepEqual(server.calls, []);
  await server.settled();
});

test('empty and oversized chunked uploads fail and remove temporary files', async t => {
  const server = await harness(t, { maxBytes: 12 });
  const empty = await upload(server, Buffer.alloc(0), { chunked: true });
  assert.equal(empty.status, 400);
  const oversized = await upload(server, Buffer.alloc(13), { chunked: true });
  assert.equal(oversized.status, 413);
  assert.deepEqual(server.calls, []);
  await server.settled();
});

test('corrupt media produces an NDJSON error after start, never successful completion', async t => {
  if (!ffmpegAvailable) return t.skip('FFmpeg is not available via FFMPEG_PATH or PATH.');
  const server = await harness(t);
  const response = await upload(server, Buffer.from('This is not a valid audio recording.'));
  assert.equal(response.status, 200);
  assert.equal(response.events[0].type, 'start');
  assert.equal(response.events.at(-1).type, 'error');
  assert.match(response.events.at(-1).error, /декодировать аудиофайл/);
  assert.equal(response.events.some(event => event.type === 'done'), false);
  assert.deepEqual(server.calls, []);
  await server.settled();
});

test('unavailable FFmpeg reports a bounded streaming error and removes the uploaded file', async t => {
  const body = await fixture(t, 0.5);
  const server = await harness(t, {
    config: { ffmpegPath: path.join(os.tmpdir(), 'listener-nonexistent-ffmpeg.exe'), gigaamModel: model, transcriptionChunkSeconds: 5 }
  });
  const response = await upload(server, body);
  assert.equal(response.events[0].type, 'start');
  assert.equal(response.events.at(-1).type, 'error');
  assert.match(response.events.at(-1).error, /FFmpeg \(ENOENT\)/);
  assert.equal(response.events.some(event => event.type === 'done'), false);
  await server.settled();
});

test('ASR failure preserves preceding chunks and removes all request temporary files', async t => {
  if (!ffmpegAvailable) return t.skip('FFmpeg is not available via FFMPEG_PATH or PATH.');
  const body = await fixture(t, 6);
  let callCount = 0;
  const server = await harness(t, {
    transcribe: async () => {
      if (++callCount === 2) throw new Error('ASR unavailable');
      return { text: 'Распознанный первый фрагмент', segments: [] };
    }
  });
  const response = await upload(server, body);
  assert.equal(response.events.filter(event => event.type === 'block').length, 1);
  assert.equal(response.events.at(-1).type, 'error');
  assert.equal(response.events.at(-1).error, 'ASR unavailable');
  assert.equal(response.events.some(event => event.type === 'done'), false);
  await server.settled();
});

test('disconnect during transcription aborts work and cleans uploaded audio plus WAV scratch file', async t => {
  if (!ffmpegAvailable) return t.skip('FFmpeg is not available via FFMPEG_PATH or PATH.');
  // Enough PCM to leave FFmpeg blocked on pipe backpressure while ASR is pending.
  const body = await fixture(t, 90);
  let started;
  const processingStarted = new Promise(resolve => { started = resolve; });
  let cancelled = false;
  const server = await harness(t, {
    transcribe: async (_config, wavPath, { signal }) => {
      assert.ok((await fs.stat(wavPath)).size > 44);
      started();
      try {
        await delay(10000, undefined, { signal });
      } catch (error) {
        cancelled = signal.aborted;
        throw error;
      }
      throw new Error('Cancellation did not reach ASR');
    }
  });
  const req = http.request({ hostname: '127.0.0.1', port: server.port, method: 'POST', path: `/transcribe?${query()}`,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }
  }, res => { res.on('error', () => {}); res.resume(); });
  req.on('error', () => {});
  req.end(body);
  await processingStarted;
  req.destroy();
  await server.settled();
  assert.equal(cancelled, true);
});

test('disconnect during upload removes the partially written input without starting ASR', async t => {
  const server = await harness(t);
  const req = http.request({ hostname: '127.0.0.1', port: server.port, method: 'POST', path: `/transcribe?${query()}`,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': 1024 * 1024 }
  });
  req.on('error', () => {});
  req.write(Buffer.alloc(4096));
  const deadline = Date.now() + 5000;
  let partialInputExists = false;
  while (Date.now() < deadline && !partialInputExists) {
    const directories = await fs.readdir(server.tempRoot);
    for (const directory of directories) {
      const input = await fs.stat(path.join(server.tempRoot, directory, 'input.wav')).catch(() => null);
      if (input?.size > 0) partialInputExists = true;
    }
    if (!partialInputExists) await delay(10);
  }
  req.destroy();
  await server.settled();
  assert.equal(partialInputExists, true, 'test must interrupt an upload after bytes are written');
  assert.deepEqual(server.calls, []);
});
