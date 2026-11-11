import assert from 'node:assert/strict';
import test from 'node:test';

const { searchXmRecordings } = await import('../server.mjs');

const from = '2026-10-13T05:30:00';
const to = '2026-10-13T15:30:00';
const record = {
  BeginTime: '2026-10-13 05:30:00',
  EndTime: '2026-10-13 06:30:00',
  FileName: '/archive/channel-5.h264'
};

function fakeCamera(responses) {
  const requests = [];
  let loggedOut = false;
  return {
    requests,
    get loggedOut() { return loggedOut; },
    services: {
      login: async () => ({ sessionId: 'test-session', salt: 'test-salt' }),
      logout: async () => { loggedOut = true; },
      requestJson: async (config, path, query) => {
        requests.push({ path, from: query.OPFileQuery.BeginTime, to: query.OPFileQuery.EndTime });
        const response = responses[requests.length - 1];
        assert.notEqual(response, undefined, 'unexpected extra recorder request');
        if (response instanceof Error) throw response;
        return response;
      }
    }
  };
}

test('XM direct and daily searches distinguish confirmed empty archives from unconfirmed Ret=119', async () => {
  for (const responses of [
    [{ Ret: 109 }],
    [{ Ret: 100, OPFileQuery: [] }],
    [{ Ret: 119 }, { Ret: 109 }],
    [{ Ret: 119 }, { Ret: 100, OPFileQuery: [] }]
  ]) {
    const camera = fakeCamera(responses);
    const result = await searchXmRecordings({}, 5, 'main', from, to, camera.services);
    assert.equal(result.searchOutcome, 'confirmed_empty');
    assert.equal(result.searchComplete, true);
    assert.deepEqual(result.items, []);
    if (result.warning) assert.equal(result.warningSeverity, 'info');
    assert.equal(camera.loggedOut, true);
  }

  const camera = fakeCamera([{ Ret: 119 }, { Ret: 119 }]);
  const result = await searchXmRecordings({}, 5, 'main', from, to, camera.services);
  assert.equal(result.searchOutcome, 'unconfirmed');
  assert.equal(result.searchComplete, false);
  assert.equal(result.warningSeverity, 'warning');
  assert.equal(result.details.attempts[0].ret, 119);
  assert.match(result.warning, /could not confirm/i);
  assert.doesNotMatch(result.warning, /no records/i);
});

test('XM recovered daily search returns an informational warning with complete found records', async () => {
  const camera = fakeCamera([{ Ret: 119 }, { Ret: 100, OPFileQuery: [record] }]);
  const result = await searchXmRecordings({}, 5, 'main', from, to, camera.services);
  assert.equal(result.searchOutcome, 'found');
  assert.equal(result.searchComplete, true);
  assert.equal(result.warningSeverity, 'info');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].fileName, record.FileName);
  assert.equal(result.details.attempts[0].ret, 100);
  assert.equal(camera.requests[1].from, '2026-10-13 00:00:00');
  assert.equal(camera.requests[1].to, '2026-10-13 23:59:59');
  assert.equal(camera.loggedOut, true);
});

test('XM daily fallback preserves a network failure instead of reporting an empty archive', async () => {
  const failure = new Error('Recorder connection timed out.');
  failure.code = 'ETIMEDOUT';
  failure.statusCode = 504;
  failure.details = { host: '192.0.2.10', code: 'ETIMEDOUT' };
  const camera = fakeCamera([{ Ret: 119 }, failure]);
  await assert.rejects(searchXmRecordings({}, 5, 'main', from, to, camera.services), error => {
    assert.equal(error, failure);
    assert.equal(error.statusCode, 504);
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(error.details.host, '192.0.2.10');
    assert.equal(error.details.stage, 'search');
    assert.equal(error.details.searchOutcome, 'transient_error');
    assert.equal(error.details.fallback.attempts[0].code, 'ETIMEDOUT');
    return true;
  });
  assert.equal(camera.loggedOut, true);
});

test('XM daily fallback preserves recorder protocol rejection', async () => {
  const camera = fakeCamera([{ Ret: 119 }, { Ret: 101 }]);
  await assert.rejects(searchXmRecordings({}, 5, 'main', from, to, camera.services), error => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.details.stage, 'search');
    assert.equal(error.details.searchOutcome, 'protocol_error');
    assert.equal(error.details.ret, 101);
    assert.equal(error.details.fallback.attempts[0].ret, 101);
    return true;
  });
  assert.equal(camera.loggedOut, true);
});

test('XM multi-day fallback cannot claim completeness when a later day fails', async () => {
  const failure = new Error('Recorder reset the connection.');
  failure.code = 'ECONNRESET';
  failure.statusCode = 502;
  const camera = fakeCamera([{ Ret: 119 }, { Ret: 100, OPFileQuery: [record] }, failure]);
  await assert.rejects(
    searchXmRecordings({}, 5, 'main', from, '2026-10-14T15:30:00', camera.services),
    error => {
      assert.equal(error, failure);
      assert.deepEqual(error.details.fallback.attempts.map(item => item.ret), [100, 502]);
      return true;
    }
  );
  assert.equal(camera.loggedOut, true);
});

test('XM multi-day fallback keeps found records explicitly incomplete when another day is unconfirmed', async () => {
  const camera = fakeCamera([{ Ret: 119 }, { Ret: 100, OPFileQuery: [record] }, { Ret: 119 }]);
  const result = await searchXmRecordings({}, 5, 'main', from, '2026-10-14T15:30:00', camera.services);
  assert.equal(result.items.length, 1);
  assert.equal(result.searchOutcome, 'unconfirmed');
  assert.equal(result.searchComplete, false);
  assert.equal(result.warningSeverity, 'warning');
  assert.deepEqual(result.details.attempts.map(item => item.ret), [100, 119]);
});

test('XM daily fallback does not claim complete coverage beyond its 32-day query limit', async () => {
  const camera = fakeCamera([{ Ret: 119 }, ...Array.from({ length: 32 }, () => ({ Ret: 109 }))]);
  const result = await searchXmRecordings({}, 5, 'main', '2026-09-01T05:30:00', '2026-10-13T15:30:00', camera.services);
  assert.equal(result.searchOutcome, 'unconfirmed');
  assert.equal(result.searchComplete, false);
  assert.equal(camera.requests.length, 33);
});
