import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'Asia/Yekaterinburg';

const {
  normalizeStoredAction,
  scheduledActionCandidates,
  scheduledReportTypes
} = await import('../server.mjs');

const group = {
  id: 'group-1',
  name: 'Тестовая группа',
  channels: [2],
  from: '2026-09-01T08:00',
  to: '2026-09-01T08:30'
};
const groupMap = new Map([[group.id, group]]);

function action(overrides = {}) {
  return {
    id: 'action-1',
    name: 'Тестовое действие',
    groupIds: [group.id],
    question: 'Что происходило?',
    periodMode: 'daily',
    dayPreset: 'today',
    customDate: '',
    reportDaily: true,
    reportWeekly: true,
    runOnWeekends: false,
    ...overrides
  };
}

function localDate(year, month, day, hour, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

test('старые действия сохраняют прежнюю обработку выходных, новые могут её отключить', () => {
  const base = action({ runOnWeekends: undefined });
  assert.equal(normalizeStoredAction(base).runOnWeekends, true);
  assert.equal(normalizeStoredAction({ ...base, runOnWeekends: false }).runOnWeekends, false);
  assert.equal(normalizeStoredAction({ ...base, periodMode: 'once', runOnWeekends: true }).runOnWeekends, false);
});

test('в пятницу недельный кандидат появляется только вечером и получает отдельный отчёт', () => {
  const before = scheduledActionCandidates(action(), groupMap, localDate(2026, 9, 4, 17, 59));
  assert.deepEqual(before.map(candidate => candidate.periodMode), ['daily']);

  const after = scheduledActionCandidates(action(), groupMap, localDate(2026, 9, 4, 18, 1));
  assert.deepEqual(after.map(candidate => candidate.periodMode), ['daily', 'weekly']);

  const daily = after.find(candidate => candidate.periodMode === 'daily');
  const weekly = after.find(candidate => candidate.periodMode === 'weekly');
  assert.deepEqual(scheduledReportTypes(daily), ['daily']);
  assert.deepEqual(scheduledReportTypes(weekly), ['weekly']);
  assert.equal(weekly.selections.length, 5);
  assert.equal(weekly.from, '2026-08-31T08:00');
  assert.equal(weekly.to, '2026-09-04T08:30');
});

test('суббота служит окном догоняющей отправки того же недельного отчёта', () => {
  const fridayWeekly = scheduledActionCandidates(action(), groupMap, localDate(2026, 9, 4, 18, 1))
    .find(candidate => candidate.periodMode === 'weekly');
  const saturday = scheduledActionCandidates(action(), groupMap, localDate(2026, 9, 5, 12));

  assert.deepEqual(saturday.map(candidate => candidate.periodMode), ['weekly']);
  assert.equal(saturday[0].runKey, fridayWeekly.runKey);
});

test('дневные действия пропускают выходные, если галочка снята', () => {
  const saturdayOff = scheduledActionCandidates(action(), groupMap, localDate(2026, 9, 5, 12));
  assert.equal(saturdayOff.some(candidate => candidate.periodMode === 'daily'), false);

  const saturdayOn = scheduledActionCandidates(action({ runOnWeekends: true }), groupMap, localDate(2026, 9, 5, 12));
  assert.equal(saturdayOn.some(candidate => candidate.periodMode === 'daily'), true);

  const sundayOff = scheduledActionCandidates(action(), groupMap, localDate(2026, 9, 6, 12));
  const sundayOn = scheduledActionCandidates(action({ runOnWeekends: true }), groupMap, localDate(2026, 9, 6, 12));
  assert.deepEqual(sundayOff, []);
  assert.deepEqual(sundayOn.map(candidate => candidate.periodMode), ['daily']);
});

test('ночной пятничный интервал откладывает недельный отчёт до завершения в субботу', () => {
  const nightGroup = {
    ...group,
    from: '2026-09-01T22:00',
    to: '2026-09-02T02:00'
  };
  const nightMap = new Map([[nightGroup.id, nightGroup]]);

  const friday = scheduledActionCandidates(action(), nightMap, localDate(2026, 9, 4, 23));
  assert.equal(friday.some(candidate => candidate.periodMode === 'weekly'), false);

  const saturday = scheduledActionCandidates(action(), nightMap, localDate(2026, 9, 5, 2, 1));
  const weekly = saturday.find(candidate => candidate.periodMode === 'weekly');
  assert.ok(weekly);
  assert.equal(weekly.to, '2026-09-05T02:00');
  assert.deepEqual(scheduledReportTypes(weekly), ['weekly']);
});
