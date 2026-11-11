import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { buildScheduledActionTranscript, cameraRequest, searchScheduledRecordings } from '../server.mjs';

async function localCamera(t, handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  return {
    server,
    config: {
      scheme: 'http', host: '127.0.0.1', httpPort: server.address().port,
      user: 'camera-test-user', password: 'camera-test-password'
    }
  };
}

function transportError(message, statusCode, code) {
  return Object.assign(new Error(message), {
    statusCode,
    details: { code, host: '192.0.2.15', port: 80, endpoint: '/cgi-bin/login.cgi' }
  });
}

test('camera timeout identifies the endpoint without leaking URL credentials or query secrets', async t => {
  const { config } = await localCamera(t, request => request.resume());
  const target = new URL(`http://url-user:url-password@127.0.0.1:${config.httpPort}/cgi-bin/login.cgi?token=private-query`);
  await assert.rejects(cameraRequest(config, target, { timeoutMs: 20 }), error => {
    assert.equal(error.statusCode, 504);
    assert.equal(error.details.host, config.host);
    assert.equal(error.details.port, config.httpPort);
    assert.equal(error.details.endpoint, '/cgi-bin/login.cgi');
    assert.equal(error.details.code, 'ETIMEDOUT');
    assert.equal(error.details.timeoutMs, 20);
    const diagnostic = `${error.message} ${JSON.stringify(error.details)}`;
    for (const secret of ['url-user', 'url-password', config.user, config.password, 'private-query', '?token=']) {
      assert.ok(!diagnostic.includes(secret), `diagnostic exposed ${secret}`);
    }
    return true;
  });
});

test('camera connection refusal is a gateway error with the failing address', async t => {
  const { server, config } = await localCamera(t, (_request, response) => response.end());
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(cameraRequest(config, '/cgi-bin/login.cgi', { timeoutMs: 1000 }), error => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.details.code, 'ECONNREFUSED');
    assert.equal(error.details.host, config.host);
    assert.equal(error.details.port, config.httpPort);
    assert.equal(error.details.endpoint, '/cgi-bin/login.cgi');
    return true;
  });
});

test('scheduled search recovers from a transient failure after one bounded delay', async () => {
  const controller = new AbortController();
  const result = { ok: true, items: [{ fileName: 'recording.h264' }] };
  const delays = [];
  let attempts = 0;
  const actual = await searchScheduledRecordings(async (pathname, options) => {
    assert.equal(pathname, '/api/recordings/search?channel=2');
    assert.equal(options.signal, controller.signal);
    attempts += 1;
    if (attempts === 1) throw transportError('Camera timed out', 504, 'ETIMEDOUT');
    return result;
  }, '/api/recordings/search?channel=2', {
    signal: controller.signal,
    delay: async milliseconds => delays.push(milliseconds)
  });
  assert.equal(actual, result);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1000]);
});

test('scheduled search retries transient HTTP statuses and legacy network failures', async () => {
  const errors = [
    ...[408, 502, 503, 504].map(status => transportError('Upstream unavailable', status, '')),
    Object.assign(new Error('Socket disconnected'), { code: 'ECONNRESET' }),
    transportError('Connection refused', 500, 'ECONNREFUSED'),
    Object.assign(new Error('Request timed out after 10000 ms.'), { statusCode: 500 })
  ];
  for (const failure of errors) {
    let attempts = 0;
    const result = { ok: true, items: [] };
    assert.equal(await searchScheduledRecordings(async () => {
      attempts += 1;
      if (attempts === 1) throw failure;
      return result;
    }, '/api/recordings/search', { delay: async () => {} }), result);
    assert.equal(attempts, 2, `failure was not retried: ${failure.statusCode || failure.code}`);
  }
});

test('scheduled search leaves authentication and validation failures untouched', async () => {
  for (const status of [400, 401, 403, 422]) {
    const failure = transportError('Invalid search or credentials', status, '');
    let attempts = 0;
    await assert.rejects(searchScheduledRecordings(async () => {
      attempts += 1;
      throw failure;
    }, '/api/recordings/search', {
      delay: async () => assert.fail('permanent failure must not delay or retry')
    }), error => error === failure);
    assert.equal(attempts, 1);
  }
});

test('an empty successful search is not repeated', async () => {
  const empty = { ok: true, items: [], warning: 'No recordings for the selected period' };
  let attempts = 0;
  assert.equal(await searchScheduledRecordings(async () => {
    attempts += 1;
    return empty;
  }, '/api/recordings/search', {
    delay: async () => assert.fail('empty success must not delay or retry')
  }), empty);
  assert.equal(attempts, 1);
});

test('scheduled search stops after two failed attempts and preserves the final error details', async () => {
  const failures = [
    transportError('First timeout', 504, 'ETIMEDOUT'),
    transportError('Connection refused after timeout', 502, 'ECONNREFUSED')
  ];
  let attempts = 0;
  let waits = 0;
  await assert.rejects(searchScheduledRecordings(async () => {
    throw failures[attempts++];
  }, '/api/recordings/search', {
    delay: async () => { waits += 1; }
  }), error => error === failures[1]);
  assert.equal(attempts, 2);
  assert.equal(waits, 1);
});

test('scheduled search respects cancellation before the first request', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchScheduledRecordings(async () => {
    assert.fail('cancelled search must not contact camera');
  }, '/api/recordings/search', { signal: controller.signal }), { name: 'AbortError' });
});

test('scheduled search does not retry after cancellation during the backoff', async () => {
  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(searchScheduledRecordings(async () => {
    attempts += 1;
    throw transportError('Camera timed out', 504, 'ETIMEDOUT');
  }, '/api/recordings/search', {
    signal: controller.signal,
    delay: async () => { controller.abort(); }
  }), { name: 'AbortError' });
  assert.equal(attempts, 1);
});

test('an aborted in-flight search is never retried', async () => {
  let attempts = 0;
  const failure = new DOMException('Search was cancelled', 'AbortError');
  await assert.rejects(searchScheduledRecordings(async () => {
    attempts += 1;
    throw failure;
  }, '/api/recordings/search', {
    delay: async () => assert.fail('AbortError must not be retried')
  }), error => error === failure);
  assert.equal(attempts, 1);
});

test('background action error surfaces the camera and transport cause instead of only a failure count', async () => {
  const failure = transportError('Регистратор 192.0.2.15:80 не ответил за 10 с (ETIMEDOUT).', 504, 'ETIMEDOUT');
  let requests = 0;
  await assert.rejects(buildScheduledActionTranscript({
    selections: [{
      groupName: 'Ежедневные группы', channel: 2,
      from: '2026-10-06T07:30', to: '2026-10-06T17:30'
    }]
  }, {
    settings: { vendor: 'xm', timeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow' },
    labels: [{ channel: 2, label: '02 Бухгалтерия' }],
    requestApi: async pathname => {
      assert.ok(pathname.startsWith('/api/recordings/search?'));
      requests += 1;
      throw failure;
    }
  }), error => {
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /ошибок поиска 1, ошибок записей 0/);
    assert.ok(error.message.includes('02 Бухгалтерия'));
    assert.ok(error.message.includes('192.0.2.15:80'));
    assert.ok(error.message.includes('ETIMEDOUT'));
    assert.equal(error.details.stage, 'search');
    assert.equal(error.details.issues[0].channel, 2);
    assert.deepEqual(error.details.issues[0].details, failure.details);
    return true;
  });
  assert.equal(requests, 2);
});
