import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TRANSCRIPTION_CAPTURE_CHUNK_SECONDS = '60';
const {
  scheduledIncompleteAudioRetry, scheduledAvailabilityRetry, scheduledProcessingNoProgressRetry, markActionSchedulerState,
  forceScheduledCandidateRetry, shouldRunScheduledCandidate, runScheduledOpenAiAction,
  buildDriveTranscriptFiles
} = await import('../server.mjs');

const from = '2026-10-24T02:30:00.000Z';
const to = '2026-10-24T02:31:00.000Z';
const candidate = {
  action: {
    id: 'incomplete-audio', name: 'Неполное аудио', destination: 'drive', question: '',
    groupIds: ['g'], periodMode: 'daily', dayPreset: 'today', reportDaily: false, reportWeekly: false
  },
  groups: [{ id: 'g', name: 'Группа', channels: [5] }],
  selections: [{ groupId: 'g', groupName: 'Группа', channel: 5, from, to, rangeSeconds: 60 }],
  periodMode: 'daily', from, to, dueAt: to, runKey: 'daily:incomplete-audio', configHash: 'incomplete-audio',
  timeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow'
};

function issue(overrides = {}, causeOverrides = {}) {
  return {
    stage: 'transcript', code: 'TRANSCRIPTION_FAILED', channel: 5,
    fileName: '/archive/channel-5.h264', offsetSeconds: 0, durationSeconds: 60,
    error: 'Получен неполный аудиофрагмент.', status: 502,
    ...overrides,
    cause: { code: 'INCOMPLETE_AUDIO', expectedDurationSeconds: 60, receivedDurationSeconds: 31.05, ...causeOverrides }
  };
}

const failure = (issues = [issue()], overrides = {}) => ({
  details: { stage: 'transcript', failedSearches: 0, failedRecordings: issues.length, issues, ...overrides }
});
const previous = result => ({
  runKey: candidate.runKey,
  incompleteAudioAttempts: result.attempts,
  incompleteAudioFingerprint: result.fingerprint,
  incompleteAudioCheckpoint: result.checkpoint
});

const noProgressPrevious = result => ({
  runKey: candidate.runKey,
  noProgressAttempts: result.attempts,
  noProgressCheckpoint: result.checkpoint
});
const oldArchiveDate = new Date('2026-10-26T12:00:00.000Z');
const archiveIssue = (overrides = {}) => ({
  stage: 'search', code: 'ARCHIVE_UNCONFIRMED', channel: 6, from, to, ...overrides
});
const processingRetry = (issues, state = {}, progress = {}, diagnostics = []) => scheduledProcessingNoProgressRetry(
  candidate, failure(issues, { failedRecordings: issues.filter(item => item.stage === 'transcript').length }),
  state, progress, diagnostics, oldArchiveDate
);

test('mixed archive and audio errors stop after three substantive attempts despite changing codes and worse gaps', () => {
  const first = processingRetry([archiveIssue(), issue()]);
  const second = processingRetry([archiveIssue({ code: 'NO_RECORDINGS' }), issue({}, { receivedDurationSeconds: 20 })], noProgressPrevious(first));
  const third = processingRetry([archiveIssue({ channel: 5, code: 'ARCHIVE_GAPS' }), issue({ channel: 6 })], noProgressPrevious(second));
  assert.equal(first.attempts, 1);
  assert.equal(second.attempts, 2);
  assert.equal(third.attempts, 3);
  assert.equal(third.exhausted, true);
});

test('delivery-only and transient failures preserve but do not increment or exhaust the processing streak', () => {
  const first = processingRetry([archiveIssue(), issue()]);
  const second = processingRetry([archiveIssue(), issue()], noProgressPrevious(first));
  for (const error of [
    { details: { stage: 'drive', code: 'ENOTFOUND' } },
    failure([archiveIssue(), issue({}, { code: 'ETIMEDOUT' })]),
    failure([archiveIssue(), { stage: 'search', channel: 5, code: 'SEARCH_FAILED' }]),
    { message: 'A DNS error', details: { stage: 'drive', issues: [archiveIssue(), issue()] } }
  ]) {
    const retained = scheduledProcessingNoProgressRetry(candidate, error, noProgressPrevious(second), {}, [], oldArchiveDate);
    assert.equal(retained.attempts, 2);
    assert.equal(retained.observed, false);
    assert.equal(retained.exhausted, false);
    const third = processingRetry([archiveIssue(), issue()], noProgressPrevious(retained));
    assert.equal(third.attempts, 3);
    assert.equal(third.exhausted, true);
  }
});

test('only actual processed coverage advances the generic checkpoint, not counters or delivery activity', () => {
  const diagnostic = { channel: 5, from, to, processedSeconds: 30 };
  const first = processingRetry([issue()], {}, {}, [diagnostic]);
  const artifacts = {
    completedChunks: 200, completedRecordings: 100, uploadedCameras: 3,
    completedSelections: 4, selectionProcessedSeconds: 60, partialUploadedCameras: 10,
    transcribedSeconds: 1000
  };
  const second = processingRetry([issue()], noProgressPrevious(first), artifacts, [diagnostic]);
  assert.equal(second.attempts, 2);
  const progress = processingRetry([issue()], noProgressPrevious(second), artifacts, [{ ...diagnostic, processedSeconds: 31 }]);
  assert.equal(progress.attempts, 1);
  const regressed = processingRetry([issue()], noProgressPrevious(progress), {}, [{ ...diagnostic, processedSeconds: 20 }]);
  assert.equal(regressed.attempts, 2);
  const merelyRestored = processingRetry([issue()], noProgressPrevious(regressed), {}, [{ ...diagnostic, processedSeconds: 31 }]);
  assert.equal(merelyRestored.attempts, 3);
  assert.equal(merelyRestored.exhausted, true);
});

test('restored complete local or delivered cameras retain coverage without masquerading as renewed progress', () => {
  const diagnostic = { channel: 6, from, to, processedSeconds: 60 };
  const first = processingRetry([issue()], {}, {}, [diagnostic]);
  const second = processingRetry([issue()], noProgressPrevious(first), { processedCoverage: [diagnostic] }, [
    { ...diagnostic, status: 'skipped', processedSeconds: 0 }
  ]);
  assert.equal(second.attempts, 2);
  assert.deepEqual(second.checkpoint.coverage, first.checkpoint.coverage);
  const next = processingRetry([issue()], noProgressPrevious(second), {
    processedCoverage: [diagnostic, { channel: 7, from, to, processedSeconds: 60 }]
  });
  assert.equal(next.attempts, 1);
});

test('generic archive retry retains the 24-hour indexing grace and resets only for a different period', () => {
  const error = failure([archiveIssue()], { failedRecordings: 0 });
  const first = scheduledProcessingNoProgressRetry(candidate, error, {}, {}, [], new Date(Date.parse(to) + 1000));
  const second = scheduledProcessingNoProgressRetry(candidate, error, noProgressPrevious(first), {}, [], new Date(Date.parse(to) + 2000));
  const third = scheduledProcessingNoProgressRetry(candidate, error, noProgressPrevious(second), {}, [], new Date(Date.parse(to) + 3000));
  assert.equal(third.attempts, 3);
  assert.equal(third.exhausted, false);
  const later = scheduledProcessingNoProgressRetry(candidate, error, noProgressPrevious(third), {}, [], oldArchiveDate);
  assert.equal(later.exhausted, true);
  assert.equal(scheduledProcessingNoProgressRetry({ ...candidate, runKey: 'another-period' }, error, noProgressPrevious(later), {}, [], oldArchiveDate).attempts, 1);
});

test('new generic retry state survives reload, unrelated state writes and explicit manual reset', () => {
  const first = processingRetry([issue()]);
  const state = { actions: {} };
  markActionSchedulerState(state, candidate, {
    status: 'error', at: oldArchiveDate.toISOString(),
    noProgressAttempts: 2, noProgressCheckpoint: first.checkpoint
  });
  const reloaded = JSON.parse(JSON.stringify(state));
  markActionSchedulerState(reloaded, candidate, { status: 'delivery_pending', stage: 'drive', at: oldArchiveDate.toISOString() });
  const entry = reloaded.actions[candidate.action.id].daily;
  assert.equal(entry.noProgressAttempts, 2);
  assert.deepEqual(entry.noProgressCheckpoint, first.checkpoint);
  forceScheduledCandidateRetry(reloaded, candidate, oldArchiveDate);
  for (const reset of [reloaded.actions[candidate.action.id].daily, reloaded.actions[candidate.action.id].daily.pending[0]]) {
    assert.equal(reset.noProgressAttempts, 0);
    assert.equal(reset.noProgressCheckpoint, null);
  }
});

test('three identical nested incomplete-audio failures stop retrying without an archive-age requirement', () => {
  const first = scheduledIncompleteAudioRetry(candidate, failure());
  const second = scheduledIncompleteAudioRetry(candidate,
    failure([issue({}, { receivedDurationSeconds: 31.054 })]), previous(first));
  const third = scheduledIncompleteAudioRetry(candidate,
    failure([issue({}, { receivedDurationSeconds: 31.048 })]), previous(second));
  assert.equal(first.attempts, 1);
  assert.equal(first.exhausted, false);
  assert.equal(second.attempts, 2);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(third.attempts, 3);
  assert.equal(third.exhausted, true);
  assert.equal(third.fingerprint, first.fingerprint);
  assert.deepEqual(third.checkpoint, first.checkpoint);
  assert.equal(scheduledAvailabilityRetry(candidate, failure()).attempts, 0);
});

test('a changed file, channel, gap, expected duration or received audio resets the streak', () => {
  const first = scheduledIncompleteAudioRetry(candidate, failure());
  const state = { ...previous(first), incompleteAudioAttempts: 2 };
  for (const changed of [
    issue({ channel: 6 }), issue({ fileName: '/archive/another.h264' }),
    issue({ offsetSeconds: 60 }), issue({}, { expectedDurationSeconds: 59 }),
    issue({}, { receivedDurationSeconds: 32 }), issue({}, { receivedDurationSeconds: 30 }),
    issue({}, { missingFrom: '2026-10-24T02:30:31.000Z', missingTo: to })
  ]) {
    const result = scheduledIncompleteAudioRetry(candidate, failure([changed]), state);
    assert.equal(result.attempts, 1);
    assert.equal(result.exhausted, false);
    assert.notEqual(result.fingerprint, first.fingerprint);
  }
  assert.equal(scheduledIncompleteAudioRetry({ ...candidate, runKey: 'another-period' }, failure(), state).attempts, 1);
});

test('small consecutive improvements accumulate against the first observation instead of being hidden as jitter', () => {
  const first = scheduledIncompleteAudioRetry(candidate, failure([issue({}, { receivedDurationSeconds: 31 })]));
  const second = scheduledIncompleteAudioRetry(candidate,
    failure([issue({}, { receivedDurationSeconds: 31.2 })]), previous(first));
  assert.equal(second.attempts, 2);
  const third = scheduledIncompleteAudioRetry(candidate,
    failure([issue({}, { receivedDurationSeconds: 31.4 })]), previous(second));
  assert.equal(third.attempts, 1);
  assert.equal(third.exhausted, false);
});

test('new processed chunks, completed recordings, uploads or meaningful audio progress reset the counter', () => {
  const progress = { completedChunks: 2, completedRecordings: 1, uploadedCameras: 1, transcribedSeconds: 31 };
  const first = scheduledIncompleteAudioRetry(candidate, failure(), {}, progress);
  for (const key of Object.keys(progress)) {
    const changed = { ...progress, [key]: progress[key] + 1 };
    const result = scheduledIncompleteAudioRetry(candidate, failure(), previous(first), changed);
    assert.equal(result.attempts, 1, key);
    assert.notEqual(result.fingerprint, first.fingerprint, key);
  }
  const jitter = scheduledIncompleteAudioRetry(candidate, failure(), previous(first), { ...progress, transcribedSeconds: 31.004 });
  assert.equal(jitter.attempts, 2);
});

test('saving more partial files alone does not reset an unchanged incomplete-audio retry streak', () => {
  const progress = {
    completedChunks: 1, completedRecordings: 0, uploadedCameras: 0,
    partialUploadedCameras: 0, transcribedSeconds: 60
  };
  const first = scheduledIncompleteAudioRetry(candidate, failure(), {}, progress);
  const second = scheduledIncompleteAudioRetry(candidate, failure(), previous(first), {
    ...progress, partialUploadedCameras: 1
  });
  const third = scheduledIncompleteAudioRetry(candidate, failure(), previous(second), {
    ...progress, partialUploadedCameras: 2
  });
  assert.equal(second.attempts, 2);
  assert.equal(third.attempts, 3);
  assert.equal(third.exhausted, true);
  assert.equal(third.fingerprint, first.fingerprint);
});

test('timeout, network, CUDA and mixed failures preserve audio history without counting or becoming terminal', () => {
  const first = scheduledIncompleteAudioRetry(candidate, failure());
  const state = { ...previous(first), incompleteAudioAttempts: 2 };
  const cases = [
    failure([issue({}, { code: 'ETIMEDOUT' })]),
    failure([issue({ status: 504 })]),
    failure([issue({ error: 'CUDA out of memory.' })]),
    failure([issue({ error: 'Timed out while waiting for archive audio.' })]),
    failure([issue({}, { details: { code: 'ECONNRESET' } })]),
    failure([issue(), { code: 'SEARCH_FAILED', channel: 6 }]),
    failure([issue()], { failedSearches: 1 }),
    failure([issue()], { failedRecordings: 2 }),
    failure([{ code: 'NO_RECORDINGS', channel: 5 }]),
    failure([issue({ fileName: '' })]),
    failure([])
  ];
  for (const error of cases) {
    assert.deepEqual(scheduledIncompleteAudioRetry(candidate, error, state), {
      attempts: 2, fingerprint: state.incompleteAudioFingerprint,
      checkpoint: state.incompleteAudioCheckpoint, exhausted: false
    });
  }
});

test('an intervening unrelated failure preserves the shortfall streak', () => {
  const first = scheduledIncompleteAudioRetry(candidate, failure());
  const timeout = scheduledIncompleteAudioRetry(candidate, failure([issue({ status: 504 })]), previous(first));
  const retry = scheduledIncompleteAudioRetry(candidate, failure(), previous(timeout));
  assert.equal(timeout.attempts, 1);
  assert.equal(retry.attempts, 2);
});

test('reordering camera failures and changing their diagnostic wording does not restart the same streak', () => {
  const issues = [issue(), issue({ channel: 6, fileName: '/archive/channel-6.h264' })];
  const first = scheduledIncompleteAudioRetry(candidate, failure(issues));
  const reordered = [issues[1], { ...issues[0], error: 'Audio is shorter than the requested block.' }];
  const second = scheduledIncompleteAudioRetry(candidate, failure(reordered), previous(first));
  assert.equal(second.attempts, 2);
  assert.equal(second.fingerprint, first.fingerprint);
});

test('retry state survives serialization and a manual retry clears both independent policies', () => {
  const first = scheduledIncompleteAudioRetry(candidate, failure());
  const state = { actions: {} };
  const now = new Date('2026-10-24T03:00:00.000Z');
  markActionSchedulerState(state, candidate, {
    status: 'incomplete', at: now.toISOString(),
    availabilityAttempts: 2, availabilityFingerprint: 'older-archive-policy',
    incompleteAudioAttempts: 3, incompleteAudioFingerprint: first.fingerprint,
    incompleteAudioCheckpoint: first.checkpoint
  }, now);
  const reloaded = JSON.parse(JSON.stringify(state));
  const saved = reloaded.actions[candidate.action.id].daily;
  assert.equal(saved.incompleteAudioAttempts, 3);
  assert.deepEqual(saved.incompleteAudioCheckpoint, first.checkpoint);
  assert.equal(saved.pending.length, 0);
  assert.equal(shouldRunScheduledCandidate(saved, candidate, now), false);
  forceScheduledCandidateRetry(reloaded, candidate, now);
  const queued = reloaded.actions[candidate.action.id].daily;
  for (const entry of [queued, queued.pending[0]]) {
    assert.equal(entry.incompleteAudioAttempts, 0);
    assert.equal(entry.incompleteAudioFingerprint, '');
    assert.equal(entry.incompleteAudioCheckpoint, null);
    assert.equal(entry.availabilityAttempts, 0);
    assert.equal(entry.availabilityFingerprint, '');
  }
  assert.equal(shouldRunScheduledCandidate(queued, candidate, now), true);
});

test('three failed action runs become incomplete without any partial upload; a complete silent run remains successful', async () => {
  const schedulerState = { actions: {} };
  let uploadCount = 0;
  let actualDuration = 0.32;
  const context = {
    settings: { transcriptSeconds: 60, displayTimeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow' },
    labels: [],
    services: {
      updateLastRun: async () => {}, persistRun: async () => {},
      findDriveTranscripts: async () => ({ uploads: [] }),
      requestApi: async pathname => {
        if (pathname.startsWith('/api/recordings/search')) return { items: [{
          startTime: '2026-10-24T05:30:00', endTime: '2026-10-24T05:31:00',
          fileName: '/archive/channel-5.h264'
        }] };
        if (pathname.startsWith('/api/recordings/transcript')) return { durationSeconds: actualDuration, text: '', segments: [] };
        assert.fail(pathname);
      },
      uploadDriveTranscripts: async () => { uploadCount += 1; return { uploads: [{ channel: 5, fileId: 'complete' }] }; }
    }
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    context.previousState = schedulerState.actions[candidate.action.id]?.daily;
    const result = await runScheduledOpenAiAction(candidate, context);
    assert.equal(result.status, attempt < 3 ? 'error' : 'incomplete', result.error);
    assert.equal(result.incompleteAudioAttempts, attempt);
    assert.equal(result.availabilityAttempts, 0);
    assert.equal(uploadCount, 0);
    assert.equal(result.uploads.length, 0);
    if (attempt === 3) assert.match(result.error, /без прогресса/);
    markActionSchedulerState(schedulerState, candidate, result);
  }
  const exhausted = schedulerState.actions[candidate.action.id].daily;
  assert.equal(exhausted.pending.length, 0);
  assert.equal(exhausted.nextRetryAt, '');
  forceScheduledCandidateRetry(schedulerState, candidate);
  context.previousState = schedulerState.actions[candidate.action.id].daily;
  actualDuration = 60;
  const completed = await runScheduledOpenAiAction(candidate, context);
  assert.equal(completed.status, 'success', completed.error);
  assert.equal(uploadCount, 1);
  markActionSchedulerState(schedulerState, candidate, completed);
  assert.equal(schedulerState.actions[candidate.action.id].daily.incompleteAudioAttempts, 0);
});

test('partial camera data stays local, exhausts unchanged failures, then uploads only a complete file', async () => {
  const periodEnd = '2026-10-24T02:32:00.000Z';
  const partialCandidate = {
    ...candidate, to: periodEnd, dueAt: periodEnd,
    selections: candidate.selections.map(selection => ({ ...selection, to: periodEnd, rangeSeconds: 120 }))
  };
  const schedulerState = { actions: {} };
  const stored = new Map();
  const uploadedFiles = [];
  const requestedOffsets = [];
  let completeSecondBlock = false;
  let searchCount = 0;
  const context = {
    settings: { transcriptSeconds: 60, displayTimeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow' },
    labels: [{ channel: 5, label: 'Камера 5' }],
    services: {
      updateLastRun: async () => {}, persistRun: async () => {},
      findDriveTranscripts: async () => ({ uploads: [...stored.values()].map(file => ({ ...file, skipped: true })) }),
      requestApi: async pathname => {
        const url = new URL(pathname, 'http://listener.test');
        if (url.pathname === '/api/recordings/search') {
          searchCount += 1;
          return { items: [{
            startTime: '2026-10-24T05:30:00', endTime: '2026-10-24T05:32:00',
            fileName: '/archive/channel-5.h264'
          }] };
        }
        if (url.pathname === '/api/recordings/transcript') {
          const offsetSeconds = Number(url.searchParams.get('offsetSeconds'));
          requestedOffsets.push(offsetSeconds);
          if (offsetSeconds === 60 && !completeSecondBlock) return { durationSeconds: 0.32, text: '', segments: [] };
          return {
            durationSeconds: 60,
            segments: [{ start: offsetSeconds, end: offsetSeconds + 4, text: offsetSeconds ? 'Второй блок' : 'Первый блок' }]
          };
        }
        assert.fail(pathname);
      },
      uploadDriveTranscripts: async (item, transcript) => {
        const files = buildDriveTranscriptFiles({
          action: item.action, from: item.from, to: item.to, selections: item.selections,
          entries: transcript.transcriptEntries, issues: transcript.issues,
          diagnostics: transcript.diagnostics, settings: context.settings
        });
        const uploads = files.map(file => {
          uploadedFiles.push(file);
          const upload = {
            channel: file.channel, fileId: stored.get(file.channel)?.fileId || 'same-camera-file',
            completeness: file.completeness, processedSeconds: file.processedSeconds,
            fileName: file.fileName
          };
          stored.set(file.channel, upload);
          return upload;
        });
        return { uploads };
      }
    }
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    context.previousState = schedulerState.actions[candidate.action.id]?.daily;
    const result = await runScheduledOpenAiAction(partialCandidate, context);
    assert.equal(result.status, attempt < 3 ? 'error' : 'incomplete', result.error);
    assert.equal(result.incompleteAudioAttempts, attempt);
    assert.equal(result.availabilityAttempts, 0);
    assert.equal(result.progress.uploadedCameras, 0);
    assert.equal(result.progress.partialUploadedCameras || 0, 0);
    assert.equal(result.progress.transcribedSeconds, 60);
    assert.equal(result.incompleteAudioCheckpoint.progress.uploadedCameras, 0);
    assert.equal(result.uploads.length, 0);
    assert.equal(uploadedFiles.length, 0, 'a partial camera must never be sent to Drive');
    assert.equal(searchCount, attempt, 'an incomplete camera must remain retryable');
    markActionSchedulerState(schedulerState, partialCandidate, result);
  }
  assert.deepEqual(requestedOffsets, [0, 60, 0, 60, 0, 60]);
  assert.equal(schedulerState.actions[candidate.action.id].daily.pending.length, 0);
  assert.equal(schedulerState.actions[candidate.action.id].daily.nextRetryAt, '');

  forceScheduledCandidateRetry(schedulerState, partialCandidate);
  context.previousState = schedulerState.actions[candidate.action.id].daily;
  completeSecondBlock = true;
  const completed = await runScheduledOpenAiAction(partialCandidate, context);
  assert.equal(completed.status, 'success', completed.error);
  assert.equal(completed.uploads.length, 1);
  assert.equal(completed.uploads[0].fileId, 'same-camera-file');
  assert.equal(completed.uploads[0].completeness, 'complete');
  assert.equal(completed.progress.uploadedCameras, 1);
  assert.equal(completed.progress.partialUploadedCameras, 0);
  assert.equal(uploadedFiles.length, 1);
  const completeFile = uploadedFiles.at(-1);
  assert.equal(completeFile.processedSeconds, 120);
  assert.match(completeFile.content, /Первый блок/);
  assert.match(completeFile.content, /Второй блок/);
  assert.doesNotMatch(completeFile.fileName, /НЕПОЛНАЯ ТРАНСКРИБАЦИЯ/);
  assert.doesNotMatch(completeFile.content, /НЕПОЛНАЯ ТРАНСКРИБАЦИЯ|INCOMPLETE_AUDIO/);
  markActionSchedulerState(schedulerState, partialCandidate, completed);
  assert.equal(schedulerState.actions[candidate.action.id].daily.incompleteAudioAttempts, 0);

  const alreadyCompleted = await runScheduledOpenAiAction(partialCandidate, context);
  assert.equal(alreadyCompleted.status, 'success', alreadyCompleted.error);
  assert.equal(alreadyCompleted.progress.skippedCameras, 1);
  assert.equal(searchCount, 4, 'a complete file must skip subsequent camera processing');
  assert.equal(uploadedFiles.length, 1);
});
