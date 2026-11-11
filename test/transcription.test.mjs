import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import test from 'node:test';

process.env.TZ = 'Asia/Yekaterinburg';
process.env.CAMERA_TIME_ZONE = 'Asia/Yekaterinburg';
process.env.DISPLAY_TIME_ZONE = 'Asia/Yekaterinburg';
process.env.TRANSCRIPTION_CAPTURE_CHUNK_SECONDS = '30';

const {
  buildScheduledActionTranscript,
  createXmAudioChunkWriter,
  scheduledActionErrorMessage,
  sendScheduledActionErrorEmail,
  transcribeScheduledRecording,
  transcriptionDurationSeconds
} = await import('../server.mjs');

const selection = {
  groupName: 'Group 3', channel: 2,
  from: '2026-09-07T09:00:00', to: '2026-09-07T18:00:11.250'
};
const recording = { startTime: '2026-09-07T08:00:00', endTime: '2026-09-07T20:00:00', fileName: 'large.h264' };
const candidate = {
  action: { id: 'test-action', name: 'Group 3 action', question: 'What happened?', reportDaily: false, reportWeekly: false },
  from: selection.from, to: selection.to, selections: [selection]
};

test('archive requests remain bounded even with an unlimited or invalid configured cap', () => {
  const config = { transcriptionArchiveMaxSeconds: 0, transcriptionLiveSeconds: 18 };
  for (const duration of ['32400', 'Infinity', '0', '']) {
    const params = new URLSearchParams({ duration, from: selection.from, to: selection.to });
    assert.equal(transcriptionDurationSeconds(params, config, 'archive'), 30);
  }
  const params = new URLSearchParams({ duration: '32400' });
  assert.equal(transcriptionDurationSeconds(params, { ...config, transcriptionCaptureChunkSeconds: 99999 }, 'archive'), 60);
  assert.equal(transcriptionDurationSeconds(params, { ...config, transcriptionArchiveMaxSeconds: 12 }, 'archive'), 12);
  assert.equal(transcriptionDurationSeconds(new URLSearchParams({ duration: '1.25' }), config, 'archive'), 1.25);
  assert.equal(transcriptionDurationSeconds(new URLSearchParams(), config, 'live'), 18);
});

test('nine hours are processed sequentially without gaps, including the final partial block', async () => {
  const contextLines = [];
  const progress = {};
  let offset = 3600;
  let requests = 0;
  let active = false;
  await transcribeScheduledRecording({
    item: recording, selection, coverage: { offsetSeconds: 3600, durationSeconds: 32411.25 },
    settings: { transcriptSeconds: 60 }, contextLines, progress,
    onProgress: update => Object.assign(progress, update),
    requestApi: async pathname => {
      assert.equal(active, false);
      active = true;
      const params = new URL(pathname, 'http://localhost').searchParams;
      const duration = Number(params.get('duration'));
      assert.equal(Number(params.get('offsetSeconds')), offset);
      assert.ok(duration > 0 && duration <= 30);
      assert.equal(params.get('fileName'), recording.fileName);
      await Promise.resolve();
      const start = offset;
      offset += duration;
      requests += 1;
      active = false;
      return { durationSeconds: duration, segments: [{ start, end: offset, text: `part ${requests}` }] };
    }
  });
  assert.equal(offset, 3600 + 32411.25);
  assert.equal(requests, 1081);
  assert.equal(contextLines.length, requests);
  assert.equal(progress.completedChunks, requests);
  assert.equal(progress.transcribedSeconds, 32411.25);
  assert.match(contextLines[0], /09:00:00/);
  assert.match(contextLines.at(-1), /18:00:11/);
});

test('a failed later block preserves text and reports its exact camera, offset and cause', async () => {
  const lines = [];
  let requests = 0;
  await assert.rejects(transcribeScheduledRecording({
    item: recording, selection, coverage: { offsetSeconds: 3600, durationSeconds: 60 },
    settings: { transcriptSeconds: 30 }, contextLines: lines,
    requestApi: async () => {
      if (++requests === 1) return { durationSeconds: 30, text: 'Already transcribed' };
      throw Object.assign(new Error('ffmpeg crashed'), { statusCode: 502, details: { exitCode: 1 } });
    }
  }), error => {
    assert.equal(error.details.stage, 'transcript');
    assert.equal(error.details.channel, 2);
    assert.equal(error.details.offsetSeconds, 3630);
    assert.equal(error.details.from, '2026-09-07T09:00:30');
    assert.equal(error.details.durationSeconds, 30);
    assert.deepEqual(error.details.cause, { exitCode: 1 });
    return true;
  });
  assert.equal(lines.length, 1);
});

test('partial recording failures remain available for email while other recordings continue', async () => {
  const result = await buildScheduledActionTranscript(candidate, {
    settings: { transcriptSeconds: 30 },
    requestApi: async pathname => {
      const url = new URL(pathname, 'http://localhost');
      if (url.pathname.endsWith('/search')) return { items: [
        { ...recording, startTime: selection.from, endTime: '2026-09-07T09:00:30', fileName: 'bad.h264' },
        { ...recording, startTime: '2026-09-07T09:00:30', endTime: '2026-09-07T09:01:00', fileName: 'good.h264' }
      ] };
      if (url.searchParams.get('fileName') === 'bad.h264') throw new Error('ffmpeg failed');
      return { durationSeconds: 30, text: 'Available recording' };
    }
  });
  assert.equal(result.completedRecordings, 1);
  assert.equal(result.failedRecordings, 1);
  assert.equal(result.contextLines.length, 1);
  const failedRecording = result.issues.find(issue => issue.stage === 'transcript');
  assert.equal(failedRecording.fileName, 'bad.h264');
  assert.equal(failedRecording.error, 'ffmpeg failed');
  assert.ok(result.issues.some(issue => issue.code === 'ARCHIVE_GAPS'));
});

test('complete transcription failures retain the correct stage and low-level error', async () => {
  await assert.rejects(buildScheduledActionTranscript(candidate, {
    settings: {},
    requestApi: async pathname => {
      if (pathname.startsWith('/api/recordings/search')) return { items: [recording] };
      throw new Error('ffmpeg allocation failed');
    }
  }), error => {
    assert.equal(error.details.stage, 'transcript');
    assert.equal(error.details.issues[0].error, 'ffmpeg allocation failed');
    return true;
  });
  await assert.rejects(buildScheduledActionTranscript(candidate, {
    settings: {}, requestApi: async () => { throw new Error('XM search failed'); }
  }), error => error.details.stage === 'search' && error.details.issues[0].error === 'XM search failed');
});

test('XM input truncates an oversized recording to exactly one block and stops once', async () => {
  const output = [];
  let stopped = 0;
  const sink = new Writable({ write(chunk, encoding, done) { output.push(Buffer.from(chunk)); done(); } });
  const finished = once(sink, 'finish');
  const writer = createXmAudioChunkWriter(sink, 30, { stop: () => { stopped += 1; } });
  writer.write(Buffer.alloc(8000 * 100, 0xff));
  writer.write(Buffer.alloc(8000 * 100, 0xff));
  writer.end();
  await finished;
  assert.equal(Buffer.concat(output).length, 30 * 8000);
  assert.equal(writer.bytesWritten, 30 * 8000);
  assert.equal(stopped, 1);
});

test('XM input pauses a fast source until ffmpeg drains its input', async () => {
  const events = [];
  const sink = new Writable({
    highWaterMark: 640,
    write(chunk, encoding, done) { setImmediate(done); }
  });
  const writer = createXmAudioChunkWriter(sink, 1, {
    pause: () => events.push('pause'), resume: () => events.push('resume')
  });
  const drained = once(sink, 'drain');
  writer.write(Buffer.alloc(640));
  assert.equal(writer.backpressured, true);
  await drained;
  assert.deepEqual(events, ['pause', 'resume']);
  assert.equal(writer.backpressured, false);
  const finished = once(sink, 'finish');
  writer.end();
  await finished;
});

test('broken ffmpeg input becomes a handled error', async () => {
  const failure = new Error('broken pipe');
  const sink = new Writable({ write(chunk, encoding, done) { done(failure); } });
  let writer;
  await new Promise(resolve => {
    writer = createXmAudioChunkWriter(sink, 30, { onError: error => { assert.equal(error, failure); resolve(); } });
    writer.write(Buffer.alloc(640));
  });
  assert.equal(writer.ended, true);
});

test('real ffmpeg exits cleanly and emits only 30 seconds for oversized XM input', { timeout: 10000 }, async t => {
  const command = process.env.FFMPEG_PATH || 'ffmpeg';
  const version = spawnSync(command, ['-version'], { windowsHide: true });
  if (version.error?.code === 'ENOENT') {
    t.skip('ffmpeg is not installed');
    return;
  }
  assert.equal(version.status, 0, version.error?.message || 'ffmpeg version check failed');
  const child = spawn(command, [
    '-hide_banner', '-loglevel', 'error', '-f', 'mulaw', '-ar', '8000', '-ac', '1', '-i', 'pipe:0',
    '-af', 'highpass=f=120,lowpass=f=3400,afftdn=nr=10:nf=-35',
    '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-f', 'wav', 'pipe:1'
  ], { windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const output = [];
  let stderr = '';
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  const errors = [];
  const writer = createXmAudioChunkWriter(child.stdin, 30, { onError: error => errors.push(error.message) });
  writer.write(Buffer.alloc(8000 * 120, 0xff));
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  assert.deepEqual(errors, []);
  const wav = Buffer.concat(output);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  let dataOffset = 12;
  while (wav.toString('ascii', dataOffset, dataOffset + 4) !== 'data') {
    const size = wav.readUInt32LE(dataOffset + 4);
    dataOffset += 8 + size + (size % 2);
    assert.ok(dataOffset < wav.length);
  }
  const duration = (wav.length - dataOffset - 8) / (16000 * 2);
  assert.ok(Math.abs(duration - 30) < 0.05, `WAV duration ${duration}`);
});

const failedRun = {
  status: 'error', stage: 'transcript', error: 'ffmpeg crashed', finishedAt: '2026-09-08T09:00:00+05:00',
  progress: { completedChunks: 12, transcribedSeconds: 360, channel: 2, label: 'Group 3 / Channel 2' },
  details: { fileName: 'bad.h264', exitCode: 1 }
};
const mailConfig = {
  host: '127.0.0.1', from: 'sender@example.com', secure: false, startTls: false,
  user: '', password: '', retries: 1, fallback587: false, timeoutMs: 2000, ehloName: 'listener-test'
};

test('failure notification reaches all configured recipients through SMTP with reports disabled', { timeout: 10000 }, async t => {
  let rawMessage = '';
  const recipients = [];
  const sockets = new Set();
  const smtp = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.write('220 test SMTP\r\n');
    let buffer = '';
    let dataMode = false;
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (dataMode) {
          if (line === '.') { dataMode = false; socket.write('250 queued\r\n'); }
          else rawMessage += `${line}\r\n`;
        } else if (line.startsWith('RCPT TO:')) {
          recipients.push(line);
          socket.write('250 recipient ok\r\n');
        } else if (line === 'DATA') {
          dataMode = true;
          socket.write('354 send data\r\n');
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); smtp.close(); });
  smtp.listen(0, '127.0.0.1');
  await once(smtp, 'listening');
  const result = await sendScheduledActionErrorEmail(candidate, failedRun, {
    config: { ...mailConfig, port: smtp.address().port },
    readRecipients: async () => ['first@example.com', 'second@example.com']
  });
  assert.equal(result.status, 'sent');
  assert.equal(result.recipients, 2);
  assert.equal(recipients.length, 2);
  assert.match(rawMessage, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(rawMessage, /ffmpeg crashed/);
  assert.match(rawMessage, /bad\.h264/);
  assert.match(rawMessage, /360/);
  assert.match(rawMessage, /To: <first@example.com>, <second@example.com>/);
});

test('SMTP failure is recorded separately and never overwrites the original action error', async () => {
  let attempts = 0;
  const result = await sendScheduledActionErrorEmail(candidate, failedRun, {
    config: mailConfig, readRecipients: async () => ['first@example.com'],
    sendMail: async () => { attempts += 1; throw new Error('SMTP ETIMEDOUT'); }
  });
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'SMTP ETIMEDOUT');
  assert.equal(failedRun.error, 'ffmpeg crashed');
  assert.equal(attempts, 1);
});

test('missing recipients do not cause a recursive failure or a mail attempt', async () => {
  const result = await sendScheduledActionErrorEmail(candidate, failedRun, {
    config: mailConfig, readRecipients: async () => [], sendMail: () => assert.fail('unexpected email')
  });
  assert.equal(result.status, 'skipped');
});

test('email diagnostics escape HTML and redact environment credentials', () => {
  process.env.TEST_DIAGNOSTIC_API_KEY = 'test-key-do-not-mail';
  try {
    const message = scheduledActionErrorMessage(candidate, {
      ...failedRun, error: '<script>test-key-do-not-mail</script>',
      details: { source: 'rtsp://admin:camera-password@example.com/archive' }
    }, ['recipient@example.com']);
    assert.ok(!message.text.includes('test-key-do-not-mail'));
    assert.ok(!message.text.includes('camera-password'));
    assert.ok(!message.html.includes('<script>'));
    assert.ok(message.html.includes('&lt;script&gt;'));
  } finally {
    delete process.env.TEST_DIAGNOSTIC_API_KEY;
  }
});
