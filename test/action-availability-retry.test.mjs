import assert from 'node:assert/strict';
import test from 'node:test';
import {
  scheduledAvailabilityRetry, scheduledActionCandidates, markActionSchedulerState,
  forceScheduledCandidateRetry, shouldRunScheduledCandidate, nextScheduledActionRun,
  restoreExplicitStoppedCandidate
} from '../server.mjs';

const settings = { displayTimeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow' };
const group = {
  id: 'availability-group', name: 'Рабочее время', channels: [5, 6],
  from: '2026-10-13T07:30', to: '2026-10-13T17:30', timeZone: 'Asia/Yekaterinburg'
};
const groupMap = new Map([[group.id, group]]);
const action = {
  id: 'availability-action', name: 'Ежедневный', destination: 'drive', question: '',
  groupIds: [group.id], periodMode: 'daily', dayPreset: 'today', customDate: '',
  reportDaily: false, reportWeekly: false, runOnWeekends: false
};
const periodDay = new Date('2026-10-13T18:00:00+05:00');
const later = new Date('2026-10-23T16:30:00+05:00');
const candidate = scheduledActionCandidates(action, groupMap, periodDay, { settings })[0];
const issue = (overrides = {}) => ({
  channel: 5, code: 'NO_RECORDINGS', from: candidate.from, to: candidate.to, ...overrides
});
const failure = issues => ({ details: { issues } });
const previous = result => ({
  runKey: candidate.runKey,
  availabilityAttempts: result.attempts,
  availabilityFingerprint: result.fingerprint
});

test('an old unavailable archive becomes exhausted only after three identical checks', () => {
  for (const code of ['NO_RECORDINGS', 'ARCHIVE_UNCONFIRMED', 'ARCHIVE_GAPS']) {
    const error = failure([issue({ code })]);
    const first = scheduledAvailabilityRetry(candidate, error, {}, later);
    const second = scheduledAvailabilityRetry(candidate, error, previous(first), later);
    const third = scheduledAvailabilityRetry(candidate, error, previous(second), later);
    assert.equal(first.attempts, 1);
    assert.equal(first.exhausted, false);
    assert.equal(second.attempts, 2);
    assert.equal(second.exhausted, false);
    assert.equal(third.attempts, 3);
    assert.equal(third.exhausted, true);
    assert.equal(first.fingerprint, third.fingerprint);
  }
});

test('fresh archives remain retryable through the first 24 hours even after repeated empty searches', () => {
  const fresh = scheduledActionCandidates(action, groupMap, new Date('2026-10-23T18:00:00+05:00'), { settings })[0];
  const error = failure([issue({ from: fresh.from, to: fresh.to })]);
  const first = scheduledAvailabilityRetry(fresh, error, {}, later);
  const state = { runKey: fresh.runKey, availabilityAttempts: 9, availabilityFingerprint: first.fingerprint };
  const endMs = Date.parse(fresh.to);
  assert.equal(scheduledAvailabilityRetry(fresh, error, state, new Date(endMs + 60000)).exhausted, false);
  assert.equal(scheduledAvailabilityRetry(fresh, error, state, new Date(endMs + 86400000)).exhausted, false);
  assert.equal(scheduledAvailabilityRetry(fresh, error, state, new Date(endMs + 86400001)).exhausted, true);
});

test('network and transcription failures preserve archive history without counting or becoming terminal', () => {
  const oldAvailability = scheduledAvailabilityRetry(candidate, failure([issue()]), {}, later);
  const state = { ...previous(oldAvailability), availabilityAttempts: 20 };
  for (const issues of [[], [issue({ code: 'SEARCH_FAILED' })], [issue({ code: 'TRANSCRIPT_FAILED' })],
    [issue(), issue({ channel: 6, code: 'SEARCH_FAILED' })], [issue({ code: undefined })]]) {
    assert.deepEqual(scheduledAvailabilityRetry(candidate, failure(issues), state, later), {
      attempts: 20, fingerprint: state.availabilityFingerprint, exhausted: false
    });
  }
});

test('changed camera coverage or a different period resets the consecutive availability count', () => {
  const original = issue({ code: 'ARCHIVE_GAPS', gaps: [{ from: candidate.from, to: candidate.to }] });
  const first = scheduledAvailabilityRetry(candidate, failure([original]), {}, later);
  const state = { ...previous(first), availabilityAttempts: 2 };
  for (const changed of [
    { ...original, channel: 6 },
    { ...original, code: 'NO_RECORDINGS' },
    { ...original, from: '2026-10-13T03:30:00.000Z' },
    { ...original, to: '2026-10-13T11:30:00.000Z' },
    { ...original, gaps: [{ from: '2026-10-13T03:30:00.000Z', to: candidate.to }] }
  ]) {
    const retry = scheduledAvailabilityRetry(candidate, failure([changed]), state, later);
    assert.equal(retry.attempts, 1);
    assert.equal(retry.exhausted, false);
    assert.notEqual(retry.fingerprint, first.fingerprint);
  }
  const nextPeriod = scheduledAvailabilityRetry({ ...candidate, runKey: 'different-period' }, failure([original]), state, later);
  assert.equal(nextPeriod.attempts, 1);
  assert.equal(nextPeriod.exhausted, false);
});

test('camera result order and descriptive text do not reset an otherwise identical failure', () => {
  const issues = [issue({ channel: 5, error: 'first message' }), issue({ channel: 6 })];
  const first = scheduledAvailabilityRetry(candidate, failure(issues), {}, later);
  const second = scheduledAvailabilityRetry(candidate, failure([
    issues[1], { ...issues[0], error: 'new diagnostic wording' }
  ]), previous(first), later);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.attempts, 2);
});

test('incomplete periods stay terminal after state reload while the next daily period remains scheduled', () => {
  const availability = scheduledAvailabilityRetry(candidate, failure([issue()]), {}, later);
  const state = { actions: {} };
  const lastRun = {
    status: 'incomplete', at: periodDay.toISOString(), from: candidate.from, to: candidate.to,
    runKey: candidate.runKey, availabilityAttempts: 3, availabilityFingerprint: availability.fingerprint
  };
  markActionSchedulerState(state, candidate, lastRun, periodDay);
  const reloaded = JSON.parse(JSON.stringify(state));
  const mode = reloaded.actions[action.id].daily;
  assert.equal(mode.pending.length, 0);
  assert.equal(mode.completed.some(item => item.runKey === candidate.runKey && item.status === 'incomplete'), true);
  assert.equal(mode.nextRetryAt, '');
  assert.equal(shouldRunScheduledCandidate(mode, candidate, later), false);
  const next = nextScheduledActionRun({ ...action, lastRun }, groupMap, reloaded.actions[action.id], periodDay, settings);
  assert.equal(next.nextRunAt, '2026-10-14T12:30:00.000Z');
  assert.notEqual(next.runKey, candidate.runKey);
});

test('an explicit manual retry reopens an incomplete period and clears availability history', () => {
  const initial = scheduledAvailabilityRetry(candidate, failure([issue()]), {}, later);
  const state = { actions: {} };
  markActionSchedulerState(state, candidate, {
    status: 'incomplete', at: periodDay.toISOString(), availabilityAttempts: 3,
    availabilityFingerprint: initial.fingerprint
  }, periodDay);
  const reloaded = JSON.parse(JSON.stringify(state));
  forceScheduledCandidateRetry(reloaded, candidate, later);
  const mode = reloaded.actions[action.id].daily;
  assert.equal(mode.status, 'queued');
  assert.equal(mode.attempts, 0);
  assert.equal(mode.availabilityAttempts, 0);
  assert.equal(mode.availabilityFingerprint, '');
  assert.equal(mode.nextRetryAt, later.toISOString());
  assert.equal(mode.completed.some(item => item.runKey === candidate.runKey), false);
  assert.equal(mode.pending.length, 1);
  assert.equal(mode.pending[0].availabilityAttempts, 0);
  assert.equal(mode.pending[0].availabilityFingerprint, '');
  assert.equal(shouldRunScheduledCandidate(mode, candidate, later), true);
  assert.equal(scheduledAvailabilityRetry(candidate, failure([issue()]), mode, later).attempts, 1);
});

test('manual restoration of an incomplete action keeps the original date and camera selections', () => {
  const storedAction = JSON.parse(JSON.stringify({
    ...action,
    lastRun: {
      status: 'incomplete', runKey: candidate.runKey, from: candidate.from,
      to: candidate.to, dueAt: candidate.dueAt
    }
  }));
  const restored = restoreExplicitStoppedCandidate(storedAction, [group], settings);
  assert.ok(restored);
  assert.equal(restored.runKey, candidate.runKey);
  assert.equal(restored.from, candidate.from);
  assert.equal(restored.to, candidate.to);
  assert.deepEqual(restored.selections, candidate.selections);
  assert.equal(restoreExplicitStoppedCandidate({ ...storedAction, lastRun: { ...storedAction.lastRun, status: 'success' } }, [group], settings), null);
});
