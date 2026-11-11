import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TRANSCRIPTION_CAPTURE_CHUNK_SECONDS = '60';
const { buildDriveTranscriptFiles, runScheduledOpenAiAction } = await import('../server.mjs');

const from = '2026-10-13T02:30:00.000Z';
const oneMinuteTo = '2026-10-13T02:31:00.000Z';
const twoMinuteTo = '2026-10-13T02:32:00.000Z';

function actionCandidate(channels = [5], durationSeconds = 60) {
  const to = durationSeconds === 120 ? twoMinuteTo : oneMinuteTo;
  return {
    action: {
      id: 'completeness-audit', name: 'Проверка полноты', destination: 'drive',
      groupIds: ['group-1'], periodMode: 'daily', reportDaily: false, reportWeekly: false
    },
    groups: [{ id: 'group-1', name: 'Рабочее время', channels }],
    selections: channels.map(channel => ({
      groupId: 'group-1', groupName: 'Рабочее время', channel,
      from, to, rangeSeconds: durationSeconds
    })),
    periodMode: 'daily', from, to, dueAt: to,
    runKey: 'daily:completeness-audit', configHash: 'completeness-audit'
  };
}

function recording(channel = 5) {
  return {
    startTime: '2026-10-13T05:30:00', endTime: '2026-10-13T05:31:00',
    fileName: `/archive/channel-${channel}.h264`
  };
}

function fixture(options = {}) {
  const searched = [];
  const transcribed = [];
  const uploads = [];
  const events = [];
  return {
    searched, transcribed, uploads, events,
    context: {
      settings: {
        transcriptSeconds: 60,
        displayTimeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow'
      },
      labels: [],
      services: {
        updateLastRun: async () => {},
        persistRun: async () => {},
        findDriveTranscripts: async () => ({ uploads: options.existing || [] }),
        requestApi: async pathname => {
          const url = new URL(pathname, 'http://listener.test');
          const channel = Number(url.searchParams.get('channel'));
          if (url.pathname === '/api/recordings/search') {
            searched.push(channel);
            events.push(`search:${channel}`);
            return options.search ? options.search(channel) : { items: [recording(channel)] };
          }
          if (url.pathname === '/api/recordings/transcript') {
            transcribed.push(channel);
            events.push(`transcript:${channel}`);
            return options.transcript ? options.transcript(channel, url) : {
              durationSeconds: 60,
              segments: [{ start: 0, end: 4, text: `Речь камеры ${channel}` }]
            };
          }
          assert.fail(`Unexpected API call: ${url.pathname}`);
        },
        uploadDriveTranscripts: async (candidate, transcript) => {
          const channel = Number(candidate.selections[0].channel);
          events.push(`upload:${channel}`);
          if (options.upload) return options.upload(candidate, transcript);
          const files = buildDriveTranscriptFiles({
            action: candidate.action, from: candidate.from, to: candidate.to,
            selections: candidate.selections, entries: transcript.transcriptEntries,
            issues: transcript.issues, diagnostics: transcript.diagnostics,
            settings: { displayTimeZone: 'Asia/Yekaterinburg' }
          });
          uploads.push({ channel, transcript, files });
          return { uploads: files.map(file => ({
            channel: file.channel, fileId: `uploaded-${file.channel}`,
            completeness: file.completeness, processedSeconds: file.processedSeconds
          })) };
        }
      }
    }
  };
}

function hasIssue(run, code) {
  return (run.details?.issues || []).some(issue => issue.code === code);
}

test('complete camera recovered through daily search uploads despite its informational warning', async () => {
  const state = fixture({ search: channel => ({
    items: [recording(channel)],
    searchOutcome: 'found', searchComplete: true, warningSeverity: 'info',
    warning: 'Direct XM OPFileQuery returned Ret=119; records were found through daily archive search.'
  }) });
  const result = await runScheduledOpenAiAction(actionCandidate(), state.context);
  assert.equal(result.status, 'success', result.error);
  assert.deepEqual(state.uploads.map(item => item.channel), [5]);
  assert.equal(state.uploads[0].transcript.transcriptEntries.length, 1);
  assert.equal(result.progress.stage, 'done');
});

test('a failed camera does not prevent a later complete camera from uploading immediately', async () => {
  const state = fixture({ search: channel => {
    if (channel === 5) {
      const error = new Error('Camera search rejected the requested channel.');
      error.statusCode = 400; // Avoid transport retries in this deterministic test.
      throw error;
    }
    return { items: [recording(channel)] };
  } });
  const result = await runScheduledOpenAiAction(actionCandidate([5, 6]), state.context);
  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'search');
  assert.deepEqual(state.events, ['search:5', 'search:6', 'transcript:6', 'upload:6']);
  assert.deepEqual(result.uploads.map(item => item.channel), [6]);
  assert.equal(state.uploads[0].transcript.failedSearches, 0, 'the uploaded camera must not inherit another camera failure');
  assert.deepEqual(state.uploads[0].transcript.issues, []);
  assert.deepEqual(state.uploads[0].transcript.diagnostics.map(item => item.channel), [6]);
  assert.equal(state.uploads[0].files[0].completeness, 'complete');
  assert.doesNotMatch(state.uploads[0].files[0].content, /НЕПОЛНАЯ ТРАНСКРИБАЦИЯ|Camera search rejected/);
});

test('empty or unconfirmed remaining archives report search issues and preserve all four earlier uploads', async () => {
  for (const [searchOutcome, code] of [['confirmed_empty', 'NO_RECORDINGS'], ['unconfirmed', 'ARCHIVE_UNCONFIRMED']]) {
    const existing = [1, 2, 3, 4].map(channel => ({ channel, fileId: `existing-${channel}`, skipped: true }));
    const state = fixture({
      existing,
      search: () => ({
        items: [], searchOutcome, searchComplete: searchOutcome !== 'unconfirmed',
        warningSeverity: searchOutcome === 'unconfirmed' ? 'warning' : 'info',
        warning: searchOutcome === 'unconfirmed' ? 'The archive index did not confirm this period.' : 'No recordings exist for this period.'
      })
    });
    const result = await runScheduledOpenAiAction(actionCandidate([1, 2, 3, 4, 5]), state.context);
    assert.equal(result.status, 'error');
    assert.equal(result.stage, 'search');
    assert.equal(hasIssue(result, code), true, JSON.stringify(result.details));
    assert.deepEqual(state.searched, [5]);
    assert.deepEqual(state.transcribed, []);
    assert.deepEqual(state.uploads, []);
    assert.deepEqual(result.uploads.map(item => item.fileId), existing.map(item => item.fileId));
  }
});

test('a minute of recordings remains local when the requested two-minute period has an archive gap', async () => {
  const state = fixture();
  const result = await runScheduledOpenAiAction(actionCandidate([5], 120), state.context);
  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'search');
  assert.equal(hasIssue(result, 'ARCHIVE_GAPS'), true, JSON.stringify(result.details));
  assert.deepEqual(state.uploads, []);
  assert.deepEqual(state.transcribed, [5], 'available source audio must still be processed locally');
  assert.equal(result.progress.transcribedSeconds, 60);
  assert.match(result.error, /неполные камеры не выгружены/);
  assert.equal(result.progress.uploadedCameras, 0);
  assert.equal(result.progress.partialUploadedCameras || 0, 0);
});

test('a fully processed silent recording is complete and can be uploaded without speech text', async () => {
  const state = fixture({ transcript: () => ({ durationSeconds: 60, text: '', segments: [] }) });
  const result = await runScheduledOpenAiAction(actionCandidate(), state.context);
  assert.equal(result.status, 'success', result.error);
  assert.deepEqual(state.transcribed, [5]);
  assert.deepEqual(state.uploads.map(item => item.channel), [5]);
  assert.equal(state.uploads[0].transcript.transcriptEntries.length, 0);
  assert.equal(state.uploads[0].transcript.completedRecordings, 1);
});

test('unconfirmed archive coverage never uploads the processed recording as a partial TXT', async () => {
  const state = fixture({ search: channel => ({
    items: [recording(channel)], searchOutcome: 'unconfirmed', searchComplete: false,
    warningSeverity: 'warning', warning: 'Daily archive search could not confirm the whole requested period.'
  }) });
  const result = await runScheduledOpenAiAction(actionCandidate(), state.context);
  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'search');
  assert.equal(hasIssue(result, 'ARCHIVE_UNCONFIRMED'), true, JSON.stringify(result.details));
  assert.deepEqual(state.uploads, []);
  assert.deepEqual(state.transcribed, [5]);
  assert.equal(result.progress.transcribedSeconds, 60);
  assert.equal(result.progress.uploadedCameras, 0);
  assert.equal(result.progress.partialUploadedCameras || 0, 0);
});

test('a successful first block is not uploaded when the second block fails', async () => {
  const state = fixture({
    search: channel => ({ items: [{ ...recording(channel), endTime: '2026-10-13T05:32:00' }] }),
    transcript: (channel, url) => Number(url.searchParams.get('offsetSeconds')) === 0
      ? { durationSeconds: 60, segments: [{ start: 0, end: 4, text: 'Сохранённый первый блок' }] }
      : { durationSeconds: 0.32, text: 'Этот неполный ответ нельзя выдавать за готовый блок', segments: [] }
  });
  const result = await runScheduledOpenAiAction(actionCandidate([5], 120), state.context);
  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'transcript');
  assert.equal(hasIssue(result, 'INCOMPLETE_AUDIO'), true);
  assert.equal(result.details.failedRecordings, 1);
  assert.equal(result.progress.completedRecordings, 0);
  assert.equal(result.progress.completedChunks, 1);
  assert.equal(result.progress.transcribedSeconds, 60);
  assert.deepEqual(state.transcribed, [5, 5]);
  assert.deepEqual(state.uploads, []);
  assert.equal(result.details.issues[0].offsetSeconds, 60);
  assert.match(result.error, /Получен неполный аудиофрагмент/);
  assert.match(result.error, /неполные камеры не выгружены/);
  assert.equal(result.progress.uploadedCameras, 0);
  assert.equal(result.progress.partialUploadedCameras || 0, 0);
  assert.equal(result.incompleteAudioAttempts, 1);
});

test('a real Google Drive upload failure queues the complete transcript for independent delivery', async () => {
  const state = fixture({ upload: async () => {
    const error = new Error('Google authorization request failed.');
    error.statusCode = 502;
    error.details = { code: 'ECONNREFUSED' };
    throw error;
  } });
  const result = await runScheduledOpenAiAction(actionCandidate(), state.context);
  assert.equal(result.status, 'delivery_pending');
  assert.equal(result.stage, 'drive');
  assert.equal(result.processingComplete, true);
  assert.equal(result.queuedCameras, 1);
  assert.deepEqual(state.transcribed, [5]);
});

test('more than 100 earlier search failures never make later failed cameras eligible for upload', async () => {
  const healthyChannel = 104;
  const channels = Array.from({ length: healthyChannel }, (_, index) => index + 1);
  const state = fixture({ search: channel => {
    if (channel < healthyChannel) {
      const error = new Error(`Camera ${channel} could not be searched.`);
      error.statusCode = 400;
      throw error;
    }
    return { items: [recording(channel)] };
  } });
  const result = await runScheduledOpenAiAction(actionCandidate(channels), state.context);
  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'search');
  assert.equal(result.details.failedSearches, 103);
  assert.equal(result.details.issues.some(issue => issue.channel === 103 && issue.code === 'SEARCH_FAILED'), true);
  assert.deepEqual(state.searched, channels);
  assert.deepEqual(state.transcribed, [healthyChannel]);
  assert.deepEqual(state.uploads.map(item => item.channel), [healthyChannel]);
  assert.deepEqual(result.uploads.map(item => item.channel), [healthyChannel]);
});

test('a 0.32-second ASR payload cannot count as a completed 60-second audio block', async () => {
  const state = fixture({ transcript: () => ({ durationSeconds: 0.32, text: '', segments: [] }) });
  const result = await runScheduledOpenAiAction(actionCandidate(), state.context);
  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'transcript');
  assert.equal(hasIssue(result, 'INCOMPLETE_AUDIO'), true, JSON.stringify(result.details));
  assert.equal(result.details.failedRecordings, 1);
  assert.deepEqual(state.transcribed, [5], 'the short block must fail instead of advancing in fabricated half-second steps');
  assert.deepEqual(state.uploads, []);
});
