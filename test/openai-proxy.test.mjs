import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getGlobalDispatcher } from 'undici';
import { createOpenAiResponse, resolveOpenAiProxyUrl } from '../server.mjs';

const config = { apiKey: 'test-only-key', model: 'test-model', timeoutMs: 2000, maxOutputTokens: 30 };
const payload = { question: 'Say OK', transcript: 'Connection test only.', channels: [] };

async function localServer(t, handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  return { server, port, url: `http://127.0.0.1:${port}` };
}

function redirectTestFetch(t, origin) {
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    return realFetch(`${origin}/v1/responses`, options);
  });
  return realFetch;
}

async function connectProxy(t, origin) {
  const tunnels = [];
  const proxy = await localServer(t, (_req, res) => res.writeHead(405).end());
  proxy.server.on('connect', (req, client, head) => {
    tunnels.push({ target: req.url, headers: req.headers });
    const upstream = net.connect(origin.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => client.destroy());
  });
  return { ...proxy, tunnels };
}

function vpnxxxConfigFixture(t, appData = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-vpnxxx-'))) {
  const configDir = path.join(appData, 'vpnxxx', 'temp');
  const configPath = path.join(configDir, 'privoxy.conf');
  fs.mkdirSync(configDir, { recursive: true });
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  return { appData, configPath };
}

function useTestAppData(t, appData) {
  const previous = process.env.APPDATA;
  process.env.APPDATA = appData;
  t.after(() => {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
  });
}

test('OpenAI uses CONNECT with proxy auth without changing other requests or the global dispatcher', async t => {
  const requests = [];
  const origin = await localServer(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ output_text: 'OK' }));
  });
  const proxy = await connectProxy(t, origin);
  const directFetch = redirectTestFetch(t, origin.url);
  const globalDispatcher = getGlobalDispatcher();
  const proxyUrl = `http://proxy-user:proxy%2Bpassword@127.0.0.1:${proxy.port}`;
  const response = await createOpenAiResponse({ ...config, proxyUrl }, payload);

  assert.equal(response.output_text, 'OK');
  assert.equal(proxy.tunnels.length, 1);
  assert.equal(proxy.tunnels[0].target, `127.0.0.1:${origin.port}`);
  assert.equal(proxy.tunnels[0].headers['proxy-authorization'], `Basic ${Buffer.from('proxy-user:proxy+password').toString('base64')}`);
  assert.equal(proxy.tunnels[0].headers.authorization, undefined);
  assert.equal(requests[0].headers.authorization, `Bearer ${config.apiKey}`);
  assert.equal(requests[0].headers['proxy-authorization'], undefined);
  const body = JSON.parse(requests[0].body);
  assert.equal(body.model, config.model);
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, config.maxOutputTokens);
  assert.ok(body.input.includes(payload.question));
  assert.ok(body.input.includes(payload.transcript));
  assert.equal(getGlobalDispatcher(), globalDispatcher);
  await (await directFetch(origin.url)).text();
  assert.equal(proxy.tunnels.length, 1);
  assert.equal(requests.length, 2);
});

test('an unset or blank proxy leaves the existing direct fetch transport intact', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(Object.hasOwn(options, 'dispatcher'), false);
    return Response.json({ output_text: 'OK' });
  });
  for (const proxyUrl of [undefined, '', '   ']) {
    assert.equal((await createOpenAiResponse({ ...config, proxyUrl }, payload)).output_text, 'OK');
  }
});

test('vpnxxx auto proxy re-reads Privoxy listen-address for every OpenAI request', async t => {
  const origin = await localServer(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ output_text: 'OK' }));
  });
  const firstProxy = await connectProxy(t, origin);
  const secondProxy = await connectProxy(t, origin);
  const fixture = vpnxxxConfigFixture(t);
  useTestAppData(t, fixture.appData);
  redirectTestFetch(t, origin.url);

  fs.writeFileSync(fixture.configPath, `\uFEFF# generated by vpnxxx\r\nlisten-address 127.0.0.1:${firstProxy.port} # local bridge\r\n`);
  assert.equal((await createOpenAiResponse({ ...config, proxyUrl: 'vpnxxx://auto' }, payload)).output_text, 'OK');

  fs.writeFileSync(fixture.configPath, `listen-address 127.0.0.1:${secondProxy.port}\n`);
  assert.equal((await createOpenAiResponse({ ...config, proxyUrl: 'vpnxxx://auto' }, payload)).output_text, 'OK');

  assert.equal(firstProxy.tunnels.length, 1);
  assert.equal(secondProxy.tunnels.length, 1);
});

test('vpnxxx auto proxy uses USERPROFILE fallback and accepts supported loopback forms', t => {
  const userProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-vpnxxx-profile-'));
  const appData = path.join(userProfile, 'AppData', 'Roaming');
  const fixture = vpnxxxConfigFixture(t, appData);
  t.after(() => fs.rmSync(userProfile, { recursive: true, force: true }));

  fs.writeFileSync(fixture.configPath, 'listen-address 127.9.8.7:8118\n');
  assert.equal(resolveOpenAiProxyUrl('vpnxxx://auto', { USERPROFILE: userProfile }), 'http://127.9.8.7:8118');
  fs.writeFileSync(fixture.configPath, 'listen-address localhost:8118\n');
  assert.equal(resolveOpenAiProxyUrl('vpnxxx://auto', { USERPROFILE: userProfile }), 'http://127.0.0.1:8118');
  fs.writeFileSync(fixture.configPath, 'listen-address [::1]:8118\n');
  assert.equal(resolveOpenAiProxyUrl('vpnxxx://auto', { USERPROFILE: userProfile }), 'http://[::1]:8118');
  fs.writeFileSync(fixture.configPath, 'listen-address [::1]:8118\nlisten-address 127.0.0.1:8118\n');
  assert.equal(resolveOpenAiProxyUrl('vpnxxx://auto', { USERPROFILE: userProfile }), 'http://127.0.0.1:8118');
});

test('vpnxxx auto proxy fails safely for missing, unsafe, ambiguous, or oversized config', t => {
  const fixture = vpnxxxConfigFixture(t);
  const secret = 'must-not-leak-from-config';
  const assertSafeFailure = (code) => error => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.details.transport, 'proxy');
    assert.equal(error.details.proxy, 'vpnxxx');
    assert.equal(error.details.code, code);
    assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), new RegExp(secret));
    return true;
  };

  assert.throws(
    () => resolveOpenAiProxyUrl('vpnxxx://auto', { APPDATA: fixture.appData }),
    assertSafeFailure('VPNXXX_CONFIG_UNAVAILABLE')
  );

  fs.writeFileSync(fixture.configPath, `# ${secret}\nlisten-address 0.0.0.0:8118\nlisten-address 127.0.0.1:0\n`);
  assert.throws(
    () => resolveOpenAiProxyUrl('vpnxxx://auto', { APPDATA: fixture.appData }),
    assertSafeFailure('VPNXXX_LISTENER_NOT_FOUND')
  );

  fs.writeFileSync(fixture.configPath, 'listen-address 127.0.0.1:8118\nlisten-address localhost:8119\n');
  assert.throws(
    () => resolveOpenAiProxyUrl('vpnxxx://auto', { APPDATA: fixture.appData }),
    assertSafeFailure('VPNXXX_LISTENER_AMBIGUOUS')
  );

  fs.writeFileSync(fixture.configPath, Buffer.alloc(64 * 1024 + 1, 32));
  assert.throws(
    () => resolveOpenAiProxyUrl('vpnxxx://auto', { APPDATA: fixture.appData }),
    assertSafeFailure('VPNXXX_CONFIG_TOO_LARGE')
  );
});

test('invalid proxy configuration fails before sending and never exposes credentials', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', () => assert.fail('must not send'));
  for (const proxyUrl of ['bad://proxy-user:private-password@host', 'not a URL', 'http://host/path', 'http://user:%ZZ@host', 'VPNXXX://auto', 'vpnxxx://other']) {
    await assert.rejects(createOpenAiResponse({ ...config, proxyUrl }, payload), error => {
      assert.equal(error.statusCode, 500);
      assert.match(error.message, /OPENAI_PROXY_URL/);
      assert.doesNotMatch(error.message, /proxy-user|private-password|%ZZ/);
      return true;
    });
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('an unavailable proxy fails with diagnostics and never falls back to a direct request', async t => {
  let originRequests = 0;
  const origin = await localServer(t, (_req, res) => {
    originRequests += 1;
    res.end('{}');
  });
  const proxy = await localServer(t);
  await new Promise(resolve => proxy.server.close(resolve));
  redirectTestFetch(t, origin.url);
  await assert.rejects(createOpenAiResponse({ ...config, proxyUrl: proxy.url }, payload), error => {
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /proxy connection failed/);
    assert.equal(error.details.transport, 'proxy');
    assert.equal(error.details.code, 'ECONNREFUSED');
    return true;
  });
  assert.equal(originRequests, 0);
});

test('OpenAI HTTP errors retain their status and structured details through the proxy', async t => {
  const origin = await localServer(t, (_req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: {
      message: 'Country, region, or territory not supported',
      type: 'request_forbidden', code: 'unsupported_country_region_territory'
    } }));
  });
  const proxy = await connectProxy(t, origin);
  redirectTestFetch(t, origin.url);
  await assert.rejects(createOpenAiResponse({ ...config, proxyUrl: proxy.url }, payload), error => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.details.code, 'unsupported_country_region_territory');
    assert.match(error.message, /OpenAI API error/);
    assert.doesNotMatch(error.message, /proxy connection failed/);
    return true;
  });
});

test('a stalled proxy times out with 504 instead of being reported as a user cancellation', async t => {
  const proxy = await localServer(t);
  proxy.server.on('connect', () => {});
  await assert.rejects(createOpenAiResponse({ ...config, proxyUrl: proxy.url, timeoutMs: 100 }, payload), error => {
    assert.equal(error.statusCode, 504);
    assert.equal(error.details.transport, 'proxy');
    assert.equal(error.details.timeoutMs, 100);
    return true;
  });
});

test('stopping an in-flight proxied request cancels it with 499', async t => {
  const proxy = await localServer(t);
  const controller = new AbortController();
  proxy.server.on('connect', () => controller.abort());
  await assert.rejects(createOpenAiResponse({ ...config, proxyUrl: proxy.url }, payload, controller.signal), error => {
    assert.equal(error.statusCode, 499);
    return true;
  });
});

test('an already cancelled request never opens a connection', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', () => assert.fail('must not send'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createOpenAiResponse(config, payload, controller.signal), { statusCode: 499 });
  assert.equal(fetchMock.mock.callCount(), 0);
});
