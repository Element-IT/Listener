import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

process.env.TZ = 'Asia/Yekaterinburg';
const {
  assertScheduledActionsEditable, forceScheduledCandidateRetry, nextScheduledActionRun,
  scheduledProgressPercent, scheduledActionCandidates, markActionSchedulerState,
  shouldRunScheduledCandidate, runScheduledOpenAiAction, stopScheduledOpenAiAction, localJsonApi
} = await import('../server.mjs');

const group = { id: 'g', name: 'Group 3', channels: [2], from: '2026-09-08T08:37', to: '2026-09-08T08:40' };
const groupMap = new Map([[group.id, group]]);
const action = {
  id: 'a', name: 'Test', question: 'What happened?', groupIds: ['g'], periodMode: 'daily',
  dayPreset: 'today', customDate: '', reportDaily: true, reportWeekly: false, runOnWeekends: false
};
const date = value => new Date(`${value}+05:00`);
const at = date('2026-09-08T08:41');
const candidate = scheduledActionCandidates(action, groupMap, at)[0];

test('next run uses Yekaterinburg time, and advances after a successful period', () => {
  const next = nextScheduledActionRun(action, groupMap, {}, date('2026-09-08T08:39:30'));
  assert.equal(next.nextRunAt, '2026-09-08T03:40:00.000Z');
  const state = { actions: {} };
  markActionSchedulerState(state, candidate, { status: 'success', at: at.toISOString() }, at);
  assert.equal(nextScheduledActionRun(action, groupMap, state.actions.a, at).nextRunAt, '2026-09-09T03:40:00.000Z');
});

test('next run accounts for weekends, weekly reports, custom dates and manual-only actions', () => {
  assert.equal(nextScheduledActionRun(action, groupMap, {}, date('2026-09-05T12:00')).nextRunAt, '2026-09-07T03:40:00.000Z');
  assert.equal(nextScheduledActionRun({ ...action, periodMode: 'weekly', reportDaily: false, reportWeekly: true }, groupMap, {}, at).nextRunAt, '2026-09-11T13:00:00.000Z');
  assert.equal(nextScheduledActionRun({ ...action, dayPreset: 'custom', customDate: '2026-12-01' }, groupMap, {}, at).nextRunAt, '2026-12-01T03:40:00.000Z');
  assert.equal(nextScheduledActionRun({ ...action, periodMode: 'once' }, groupMap, {}, at), null);
});

test('retry countdown uses the retry deadline instead of a past scheduled time', () => {
  const state = { actions: {} };
  markActionSchedulerState(state, candidate, { status: 'error', at: at.toISOString() }, at);
  assert.equal(nextScheduledActionRun(action, groupMap, state.actions.a, at).nextRunAt, '2026-09-08T03:42:00.000Z');
});

test('stopped periods are terminal across a restart, but an explicit retry reopens them', () => {
  const state = { actions: {} };
  markActionSchedulerState(state, candidate, { status: 'stopped', at: at.toISOString() }, at);
  const stored = JSON.parse(JSON.stringify(state));
  assert.equal(shouldRunScheduledCandidate(stored.actions.a.daily, candidate, date('2026-09-08T18:00')), false);
  assert.equal(nextScheduledActionRun(action, groupMap, stored.actions.a, at).nextRunAt, '2026-09-09T03:40:00.000Z');
  forceScheduledCandidateRetry(stored, candidate, at);
  assert.equal(shouldRunScheduledCandidate(stored.actions.a.daily, candidate, at), true);
});

test('progress spans every camera and reserves completion for OpenAI and email', () => {
  const progress = { stage: 'transcript', totalSelections: 2, completedSelections: 0, selectionTotalSeconds: 60, selectionProcessedSeconds: 30 };
  assert.equal(scheduledProgressPercent(progress), 22.5);
  assert.equal(scheduledProgressPercent({ ...progress, completedSelections: 1 }), 67.5);
  assert.equal(scheduledProgressPercent({ ...progress, stage: 'ask' }), 90);
  assert.equal(scheduledProgressPercent({ ...progress, stage: 'report' }), 97);
  assert.equal(scheduledProgressPercent({ ...progress, stage: 'done' }), 100);
});

test('active action definitions cannot be edited or deleted through the API', () => {
  const runtimes = new Map([['a', { candidate }]]);
  assert.doesNotThrow(() => assertScheduledActionsEditable([{ ...action, lastRun: { status: 'old' } }], runtimes));
  assert.throws(() => assertScheduledActionsEditable([], runtimes), error => error.statusCode === 409);
  assert.throws(() => assertScheduledActionsEditable([{ ...action, question: 'Changed' }], runtimes), error => error.statusCode === 409);
});

test('stopping a queued run persists cancellation and removes it from the queue', async () => {
  const controller = new AbortController();
  const runtimes = new Map([['a', { candidate, status: 'queued', controller }]]);
  const state = { actions: {} };
  let persisted;
  const result = await stopScheduledOpenAiAction({ actionId: 'a' }, {
    runtimes,
    persistRun: async (item, run) => { persisted = run; },
    mutateScheduler: async mutate => mutate(state)
  });
  assert.equal(result.status, 'stopped');
  assert.equal(controller.signal.aborted, true);
  assert.equal(persisted.status, 'stopped');
  assert.equal(runtimes.size, 0);
  assert.equal(shouldRunScheduledCandidate(state.actions.a.daily, candidate, at), false);
});

test('stop during a block cancels the request, skips OpenAI and emails, and preserves completed progress', async () => {
  const controller = new AbortController();
  const runtime = { candidate, controller, status: 'running' };
  const runtimes = new Map([['a', runtime]]);
  let chunks = 0;
  let saved;
  const run = await runScheduledOpenAiAction(candidate, {
    settings: { transcriptSeconds: 30 }, signal: controller.signal, runtime,
    services: {
      updateLastRun: async () => {},
      persistRun: async (item, result) => { saved = result; },
      notifyError: async () => assert.fail('user cancellation must not send an error email'),
      requestApi: async (pathname, options) => {
        if (pathname.startsWith('/api/recordings/search')) return { items: [{ startTime: candidate.from, endTime: candidate.to }] };
        assert.ok(pathname.startsWith('/api/recordings/transcript'));
        assert.equal(options.signal, controller.signal);
        if (++chunks === 1) return { durationSeconds: 30, text: 'Saved part' };
        const result = await stopScheduledOpenAiAction({ actionId: 'a' }, { runtimes });
        assert.equal(result.status, 'stopping');
        options.signal.throwIfAborted();
      }
    }
  });
  assert.equal(run.status, 'stopped');
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.progress.completedChunks, 1);
  assert.equal(saved.transcriptLines, 1);
  assert.equal(chunks, 2);
});

test('successful background run exposes all stages and finishes at 100 percent', async () => {
  const stages = [];
  const result = await runScheduledOpenAiAction(candidate, {
    settings: { transcriptSeconds: 30 },
    services: {
      updateLastRun: async (id, run) => stages.push([run.stage, run.progress.percent]),
      persistRun: async () => {},
      requestApi: async pathname => {
        if (pathname.startsWith('/api/recordings/search')) return { items: [{ startTime: candidate.from, endTime: candidate.to }] };
        if (pathname.startsWith('/api/recordings/transcript')) return { durationSeconds: 30, text: 'Part' };
        if (pathname === '/api/openai/ask') return { answer: 'Answer' };
        if (pathname === '/api/reports/send') return { sent: [] };
        assert.fail(pathname);
      }
    }
  });
  assert.equal(result.status, 'success');
  assert.equal(result.progress.percent, 100);
  assert.equal(result.progress.completedChunks, 6);
  assert.ok(stages.some(([stage, percent]) => stage === 'ask' && percent === 90));
  assert.ok(stages.some(([stage, percent]) => stage === 'report' && percent === 97));
  assert.ok(stages.every(([, percent], index) => !index || percent >= stages[index - 1][1]));
});

test('cancelling a local API request closes the connection to the audio endpoint', { timeout: 5000 }, async t => {
  const controller = new AbortController();
  let connectionClosed;
  const closed = new Promise(resolve => { connectionClosed = resolve; });
  const server = http.createServer((req, res) => {
    res.on('close', connectionClosed);
    controller.abort();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(localJsonApi(`http://127.0.0.1:${server.address().port}/audio`, { signal: controller.signal }), { name: 'AbortError' });
  await closed;
});
