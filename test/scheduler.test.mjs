import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'Asia/Yekaterinburg';

const {
  actionLastRunMatchesCandidate,
  markActionSchedulerState,
  normalizeStoredAction,
  reportMessageId,
  resolveScheduledDailyDate,
  scheduledActionConfigHash,
  scheduledActionCandidates,
  scheduledReportTypes,
  scheduledRetryCandidates,
  scheduledRetryDelayMs,
  shouldRunScheduledCandidate
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

function localDate(year, month, day, hour, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0);
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

test('режим «вчера» после выходных выбирает предыдущий рабочий день', () => {
  const monday = localDate(2026, 9, 7, 12);
  const previousWorkday = resolveScheduledDailyDate(action({
    dayPreset: 'yesterday',
    runOnWeekends: false
  }), monday);
  assert.equal(previousWorkday, '2026-09-04');

  const candidates = scheduledActionCandidates(action({
    dayPreset: 'yesterday',
    reportWeekly: false,
    runOnWeekends: false
  }), groupMap, monday);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].from, '2026-09-04T08:00');
});

test('ошибочный runKey повторяется с задержкой, успешный больше не запускается', () => {
  const now = localDate(2026, 9, 4, 18, 1);
  const candidate = scheduledActionCandidates(action(), groupMap, now)
    .find(item => item.periodMode === 'daily');
  const state = { actions: {} };
  const finishedAt = localDate(2026, 9, 4, 18, 2).toISOString();

  markActionSchedulerState(state, candidate, {
    status: 'error',
    at: finishedAt,
    startedAt: now.toISOString(),
    finishedAt,
    stage: 'search',
    error: 'temporary'
  }, now);

  const failedState = state.actions[candidate.action.id].daily;
  assert.equal(failedState.attempts, 1);
  assert.equal(Date.parse(failedState.nextRetryAt) - Date.parse(finishedAt), scheduledRetryDelayMs(1));
  assert.equal(shouldRunScheduledCandidate(failedState, candidate, localDate(2026, 9, 4, 18, 2, 30)), false);
  assert.equal(shouldRunScheduledCandidate(failedState, candidate, localDate(2026, 9, 4, 18, 3, 1)), true);

  markActionSchedulerState(state, candidate, {
    status: 'success',
    at: localDate(2026, 9, 4, 18, 4).toISOString()
  }, localDate(2026, 9, 4, 18, 4));
  const successState = state.actions[candidate.action.id].daily;
  assert.equal(shouldRunScheduledCandidate(successState, candidate, localDate(2026, 9, 5, 12)), false);
});

test('сохранённая ошибка остаётся кандидатом повтора после смены даты', () => {
  const friday = localDate(2026, 9, 4, 18, 1);
  const candidate = scheduledActionCandidates(action(), groupMap, friday)
    .find(item => item.periodMode === 'daily');
  const state = { actions: {} };

  markActionSchedulerState(state, candidate, {
    status: 'error',
    at: friday.toISOString(),
    startedAt: friday.toISOString(),
    finishedAt: friday.toISOString(),
    stage: 'search',
    error: 'temporary'
  }, friday);

  const sunday = localDate(2026, 9, 6, 12);
  const retries = scheduledRetryCandidates(action(), groupMap, state.actions[candidate.action.id], sunday);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].runKey, candidate.runKey);
  assert.equal(shouldRunScheduledCandidate(state.actions[candidate.action.id].daily, retries[0], sunday), true);
});

test('явный ручной запуск может вернуть в очередь просроченную ошибку', () => {
  const friday = localDate(2026, 9, 4, 18, 1);
  const candidate = scheduledActionCandidates(action(), groupMap, friday)
    .find(item => item.periodMode === 'daily');
  const state = { actions: {} };
  markActionSchedulerState(state, candidate, {
    status: 'error',
    at: friday.toISOString(),
    startedAt: friday.toISOString(),
    finishedAt: friday.toISOString(),
    error: 'temporary'
  }, friday);

  const muchLater = localDate(2026, 9, 20, 12);
  assert.equal(scheduledRetryCandidates(action(), groupMap, state.actions[candidate.action.id], muchLater).length, 0);
  assert.equal(scheduledRetryCandidates(
    action(),
    groupMap,
    state.actions[candidate.action.id],
    muchLater,
    { ignoreMaxAge: true }
  ).length, 1);
});

test('старое состояние ошибки без snapshot можно восстановить для повтора', () => {
  const friday = localDate(2026, 9, 4, 18, 1);
  const candidate = scheduledActionCandidates(action(), groupMap, friday)
    .find(item => item.periodMode === 'weekly');
  const legacyState = {
    weekly: {
      runKey: candidate.runKey,
      status: 'error',
      at: friday.toISOString(),
      from: candidate.from,
      to: candidate.to,
      error: 'legacy failure'
    }
  };

  const monday = localDate(2026, 9, 7, 12);
  const retries = scheduledRetryCandidates(action(), groupMap, legacyState, monday);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].runKey, candidate.runKey);
  assert.equal(retries[0].selections.length, 5);
});

test('несколько упавших периодов одного режима сохраняются в очереди', () => {
  const recurringAction = action({
    reportWeekly: false,
    runOnWeekends: true
  });
  const friday = localDate(2026, 9, 4, 12);
  const saturday = localDate(2026, 9, 5, 12);
  const fridayCandidate = scheduledActionCandidates(recurringAction, groupMap, friday)[0];
  const saturdayCandidate = scheduledActionCandidates(recurringAction, groupMap, saturday)[0];
  const state = { actions: {} };

  for (const [candidate, at] of [[fridayCandidate, friday], [saturdayCandidate, saturday]]) {
    markActionSchedulerState(state, candidate, {
      status: 'error',
      at: at.toISOString(),
      startedAt: at.toISOString(),
      finishedAt: at.toISOString(),
      error: 'temporary'
    }, at);
  }

  const modeState = state.actions[recurringAction.id].daily;
  assert.equal(modeState.pending.length, 2);
  const sunday = localDate(2026, 9, 6, 12);
  assert.equal(scheduledRetryCandidates(recurringAction, groupMap, state.actions[recurringAction.id], sunday).length, 2);

  markActionSchedulerState(state, fridayCandidate, {
    status: 'success',
    at: sunday.toISOString()
  }, sunday);
  assert.deepEqual(
    state.actions[recurringAction.id].daily.pending.map(item => item.runKey),
    [saturdayCandidate.runKey]
  );

  markActionSchedulerState(state, saturdayCandidate, {
    status: 'success',
    at: sunday.toISOString()
  }, sunday);
  const completed = state.actions[recurringAction.id].daily.completed;
  assert.equal(completed.some(item => item.runKey === fridayCandidate.runKey), true);
  assert.equal(completed.some(item => item.runKey === saturdayCandidate.runKey), true);
  assert.equal(shouldRunScheduledCandidate(
    completed.find(item => item.runKey === fridayCandidate.runKey),
    fridayCandidate,
    sunday
  ), false);
});

test('неподтверждённая SMTP-доставка считается терминальной', () => {
  const now = localDate(2026, 9, 4, 18, 1);
  const candidate = scheduledActionCandidates(action(), groupMap, now)[0];
  const state = { actions: {} };
  markActionSchedulerState(state, candidate, {
    status: 'delivery_uncertain',
    at: now.toISOString(),
    error: 'SMTP response was lost'
  }, now);

  const modeState = state.actions[candidate.action.id].daily;
  assert.equal(modeState.pending.length, 0);
  assert.equal(shouldRunScheduledCandidate(modeState, candidate, localDate(2026, 9, 5, 12)), false);
});

test('настройка обработки выходных входит в ключ конфигурации', () => {
  const weekday = localDate(2026, 9, 4, 12);
  const weekendsOff = scheduledActionCandidates(action({ reportWeekly: false, runOnWeekends: false }), groupMap, weekday)[0];
  const weekendsOn = scheduledActionCandidates(action({ reportWeekly: false, runOnWeekends: true }), groupMap, weekday)[0];
  assert.notEqual(weekendsOff.runKey, weekendsOn.runKey);

  const fridayEvening = localDate(2026, 9, 4, 18, 1);
  const weeklyOff = scheduledActionCandidates(action({ runOnWeekends: false }), groupMap, fridayEvening)
    .find(candidate => candidate.periodMode === 'weekly');
  const weeklyOn = scheduledActionCandidates(action({ runOnWeekends: true }), groupMap, fridayEvening)
    .find(candidate => candidate.periodMode === 'weekly');
  assert.equal(weeklyOff.runKey, weeklyOn.runKey);
});

test('успешный старый ключ блокирует совместимый кандидат после обновления', () => {
  const configuredAction = action({ reportWeekly: false, runOnWeekends: false });
  const now = localDate(2026, 9, 4, 12);
  const candidate = scheduledActionCandidates(configuredAction, groupMap, now)[0];
  const legacyHash = scheduledActionConfigHash(configuredAction, [group], 'daily', { legacy: true });
  const legacyLastRun = {
    status: 'success',
    runKey: `daily:${candidate.from}:${candidate.to}:${legacyHash}`
  };
  assert.equal(actionLastRunMatchesCandidate(legacyLastRun, candidate), true);
});

test('ошибка со старым ключом восстанавливается и после успеха блокирует новый совместимый ключ', () => {
  const configuredAction = action({ reportWeekly: false, runOnWeekends: false });
  const now = localDate(2026, 9, 4, 12);
  const currentCandidate = scheduledActionCandidates(configuredAction, groupMap, now)[0];
  const legacyHash = scheduledActionConfigHash(configuredAction, [group], 'daily', { legacy: true });
  const legacyRunKey = `daily:${currentCandidate.from}:${currentCandidate.to}:${legacyHash}`;
  const actionState = {
    daily: {
      runKey: legacyRunKey,
      status: 'error',
      at: now.toISOString(),
      from: currentCandidate.from,
      to: currentCandidate.to,
      error: 'legacy failure'
    }
  };

  const retries = scheduledRetryCandidates(configuredAction, groupMap, actionState, localDate(2026, 9, 5, 12));
  assert.equal(retries.length, 1);
  assert.equal(retries[0].runKey, legacyRunKey);

  const state = { actions: { [configuredAction.id]: actionState } };
  markActionSchedulerState(state, retries[0], {
    status: 'success',
    at: localDate(2026, 9, 5, 12).toISOString()
  }, localDate(2026, 9, 5, 12));
  const compatible = state.actions[configuredAction.id].daily.completed
    .find(item => item.runKey === currentCandidate.runKey);
  assert.ok(compatible);
  assert.equal(shouldRunScheduledCandidate(compatible, currentCandidate, localDate(2026, 9, 6, 12)), false);
});

test('стабильный Message-ID одинаков для повторов одного отчёта', () => {
  const payload = { deliveryKey: 'action-1:daily:2026-09-04' };
  assert.equal(reportMessageId(payload, 'daily'), reportMessageId(payload, 'daily'));
  assert.notEqual(reportMessageId(payload, 'daily'), reportMessageId(payload, 'weekly'));
});
