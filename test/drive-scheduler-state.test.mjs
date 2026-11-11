import assert from 'node:assert/strict';
import test from 'node:test';
import { oneTimeDriveCandidate, markActionSchedulerState, shouldRunScheduledCandidate,
  nextScheduledActionRun, scheduledActionCandidates } from '../server.mjs';

test('a one-time Drive action uses exact group dates and timezone on the server', () => {
  const action = { id: 'once-drive', name: 'Once', destination: 'drive', periodMode: 'once', groupIds: ['g'] };
  const groups = [{ id: 'g', name: 'Room', channels: [14], from: '2026-11-02T11:00', to: '2026-11-02T12:00', timeZone: 'Asia/Yekaterinburg' }];
  const candidate = oneTimeDriveCandidate(action, groups, {}, new Date('2026-11-03T12:00Z'));
  assert.equal(candidate.periodMode, 'once');
  assert.equal(candidate.from, '2026-11-02T06:00:00.000Z');
  assert.equal(candidate.to, '2026-11-02T07:00:00.000Z');
  assert.equal(candidate.selections[0].rangeSeconds, 3600);
  assert.throws(() => oneTimeDriveCandidate(action, groups, {}, new Date('2026-11-01T00:00Z')), /завершённый период/);
  assert.throws(() => oneTimeDriveCandidate(action, [], {}, new Date()), /не выбраны камеры/);
});

test('delivery-pending periods never re-enter processing after restart and do not block the next day', () => {
  const action = { id: 'daily-drive', name: 'Daily', destination: 'drive', periodMode: 'daily', dayPreset: 'today',
    groupIds: ['g'], runOnWeekends: false };
  const group = { id: 'g', name: 'Room', channels: [1], from: '2026-11-02T07:30', to: '2026-11-02T17:30', timeZone: 'Asia/Yekaterinburg' };
  const groups = new Map([['g', group]]);
  const settings = { displayTimeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow' };
  const at = new Date('2026-11-02T12:31Z');
  const candidate = scheduledActionCandidates(action, groups, at, { settings })[0];
  const state = { actions: {} };
  markActionSchedulerState(state, candidate, { status: 'delivery_pending', at: at.toISOString() }, at);
  const reloaded = JSON.parse(JSON.stringify(state));
  assert.equal(shouldRunScheduledCandidate(reloaded.actions[action.id].daily, candidate, new Date('2026-11-03T00:00Z')), false);
  assert.equal(nextScheduledActionRun(action, groups, reloaded.actions[action.id], at, settings).nextRunAt, '2026-11-03T12:30:00.000Z');
});
