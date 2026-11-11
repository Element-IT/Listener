import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  createGoogleDriveClient,
  readGoogleDriveConfig
} from '../google-drive.mjs';

const ROOT_ID = '1yaqWNPjJtPKWnfGUEQxZ2kkB_bv0sYSU';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function writableFolder(id, name) {
  return {
    id,
    name,
    mimeType: 'application/vnd.google-apps.folder',
    trashed: false,
    capabilities: { canAddChildren: true }
  };
}

test('readGoogleDriveConfig reads OAuth aliases and extracts a folder id from a shared link', () => {
  const config = readGoogleDriveConfig({
    GOOGLE_DRIVE_AUTH_TYPE: 'oauth',
    GOOGLE_DRIVE_FOLDER_ID: `https://drive.google.com/drive/folders/${ROOT_ID}?usp=drive_link`,
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REFRESH_TOKEN: 'refresh-token'
  });

  assert.equal(config.authType, 'oauth');
  assert.equal(config.rootFolderId, ROOT_ID);
  assert.equal(config.clientId, 'client-id');
  assert.equal(config.clientSecret, 'client-secret');
  assert.equal(config.refreshToken, 'refresh-token');
});

test('OAuth upload creates Cyrillic camera folder and TXT, then updates the same idempotent file with one cached token', async () => {
  const calls = [];
  let folderCreated = false;
  let fileCreated = false;
  let tokenCalls = 0;

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || 'GET';
    calls.push({ url, method, options });

    if (url.origin === 'https://oauth2.googleapis.com') {
      tokenCalls += 1;
      const form = new URLSearchParams(options.body);
      assert.equal(method, 'POST');
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('client_id'), 'oauth-client');
      assert.equal(form.get('client_secret'), 'oauth-secret');
      assert.equal(form.get('refresh_token'), 'oauth-refresh');
      return jsonResponse({ access_token: 'access-one', expires_in: 3600 });
    }

    assert.equal(options.headers.get('authorization'), 'Bearer access-one');
    assert.equal(url.searchParams.get('supportsAllDrives'), 'true');

    if (url.pathname === `/drive/v3/files/${ROOT_ID}`) {
      return jsonResponse({ ...writableFolder(ROOT_ID, 'Отчёты'), driveId: 'shared-drive-1' });
    }

    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const query = url.searchParams.get('q') || '';
      assert.equal(url.searchParams.get('includeItemsFromAllDrives'), 'true');
      assert.equal(url.searchParams.get('corpora'), 'drive');
      assert.equal(url.searchParams.get('driveId'), 'shared-drive-1');
      if (query.includes("mimeType = 'application/vnd.google-apps.folder'")) {
        assert.match(query, /name = '2 Бухгалтерия'/);
        return jsonResponse({
          files: folderCreated ? [writableFolder('folder-2', '2 Бухгалтерия')] : []
        });
      }
      assert.match(query, /listenerDeliveryKey/);
      assert.match(query, /listenerChannel.*value='2'/);
      return jsonResponse({
        files: fileCreated ? [{ id: 'transcript-2', name: 'старое.txt', mimeType: 'text/plain' }] : []
      });
    }

    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      assert.equal(url.searchParams.get('includeItemsFromAllDrives'), null);
      const body = JSON.parse(options.body);
      assert.equal(body.name, '2 Бухгалтерия');
      assert.deepEqual(body.parents, [ROOT_ID]);
      folderCreated = true;
      return jsonResponse({ ...writableFolder('folder-2', '2 Бухгалтерия'), driveId: 'shared-drive-1' });
    }

    if (url.pathname === '/drive/v3/files/transcript-2' && method === 'PATCH') {
      const body = JSON.parse(options.body);
      assert.equal(body.name, '2026-09-21 Бухгалтерия.txt');
      return jsonResponse({
        id: 'transcript-2',
        name: body.name,
        mimeType: 'text/plain',
        webViewLink: 'https://drive.google.com/file/d/transcript-2/view'
      });
    }

    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      assert.equal(url.searchParams.get('uploadType'), 'multipart');
      const body = Buffer.from(options.body).toString('utf8');
      assert.match(options.headers.get('content-type'), /^multipart\/related; boundary=listener_/);
      assert.match(body, /"name":"2026-09-21 Бухгалтерия.txt"/);
      assert.match(body, /"listenerChannel":"2"/);
      assert.match(body, /Камера: 02 — Бухгалтерия/);
      assert.match(body, /\[21\.09\.2026 09:00:00–09:00:04\] Доброе утро/);
      fileCreated = true;
      return jsonResponse({
        id: 'transcript-2',
        name: '2026-09-21 Бухгалтерия.txt',
        mimeType: 'text/plain',
        webViewLink: 'https://drive.google.com/file/d/transcript-2/view'
      });
    }

    if (url.pathname === '/upload/drive/v3/files/transcript-2' && method === 'PATCH') {
      const body = Buffer.from(options.body).toString('utf8');
      assert.match(body, /Исправленный текст/);
      assert.doesNotMatch(body, /"parents"/);
      return jsonResponse({
        id: 'transcript-2',
        name: '2026-09-21 Бухгалтерия.txt',
        mimeType: 'text/plain',
        webViewLink: 'https://drive.google.com/file/d/transcript-2/view'
      });
    }

    assert.fail(`Unexpected request: ${method} ${url}`);
  };

  const client = createGoogleDriveClient({
    authType: 'auto',
    rootFolderId: ROOT_ID,
    clientId: 'oauth-client',
    clientSecret: 'oauth-secret',
    refreshToken: 'oauth-refresh'
  }, {
    fetchImpl,
    now: () => Date.parse('2026-09-21T10:00:00Z')
  });
  assert.equal(client.authType, 'oauth');

  const base = {
    action: { id: 'action-1', name: 'Полная транскрибация' },
    runKey: 'daily:2026-09-21T07:00:2026-09-21T20:00:hash',
    files: [{
      channel: 2,
      label: 'Бухгалтерия',
      fileName: '2026-09-21 Бухгалтерия.txt',
      content: 'Камера: 02 — Бухгалтерия\n\n[21.09.2026 09:00:00–09:00:04] Доброе утро'
    }]
  };
  const created = await client.uploadCameraTranscripts(base);
  const found = await client.findUploadedCameraTranscripts({
    action: base.action,
    runKey: base.runKey,
    files: [{ channel: 2, label: 'Бухгалтерия', fileName: base.files[0].fileName }]
  });
  const updated = await client.uploadCameraTranscripts({
    ...base,
    files: [{ ...base.files[0], content: 'Камера: 02 — Бухгалтерия\n\nИсправленный текст' }]
  });

  assert.equal(tokenCalls, 1);
  assert.equal(created.uploads[0].created, true);
  assert.equal(created.uploads[0].updated, false);
  assert.equal(found.uploads[0].fileId, 'transcript-2');
  assert.equal(found.uploads[0].skipped, true);
  assert.equal(found.uploads[0].completeness, 'complete');
  assert.equal(found.uploads[0].renamed, true);
  assert.equal(found.uploads[0].fileName, '2026-09-21 Бухгалтерия.txt');
  assert.equal(updated.uploads[0].created, false);
  assert.equal(updated.uploads[0].updated, true);
  assert.equal(created.deliveryKey, updated.deliveryKey);
  assert.equal(created.deliveryKey.length, 64);
  assert.ok(calls.some(call => call.method === 'POST' && call.url.pathname === '/upload/drive/v3/files'));
  assert.ok(calls.some(call => call.method === 'PATCH' && call.url.pathname.endsWith('/transcript-2')));
});

test('service account auth signs an RS256 JWT and exchanges it at the configured token endpoint', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  let assertion = '';

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/token') {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      assertion = form.get('assertion');
      return jsonResponse({ access_token: 'service-access', expires_in: 3600 });
    }
    if (url.pathname === `/drive/v3/files/${ROOT_ID}`) {
      assert.equal(options.headers.get('authorization'), 'Bearer service-access');
      return jsonResponse(writableFolder(ROOT_ID, 'Обычная папка'));
    }
    assert.fail(`Unexpected request: ${options.method || 'GET'} ${url}`);
  };

  const issuedAt = Date.parse('2026-09-21T12:00:00Z');
  const client = createGoogleDriveClient({
    authType: 'service-account',
    rootFolderId: ROOT_ID,
    clientEmail: 'listener@example-project.iam.gserviceaccount.com',
    privateKey: privateKeyPem,
    tokenUri: 'https://accounts.example.test/token'
  }, { fetchImpl, now: () => issuedAt });

  await assert.rejects(
    client.uploadCameraTranscripts({
      action: { id: 'a' },
      runKey: 'run',
      files: [{ channel: 1, label: 'Холл', content: 'текст' }]
    }),
    error => error.code === 'GOOGLE_DRIVE_SERVICE_ACCOUNT_REQUIRES_SHARED_DRIVE' && error.statusCode === 400
  );

  const [encodedHeader, encodedClaims, encodedSignature] = assertion.split('.');
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url'));
  const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url'));
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(claims.iss, 'listener@example-project.iam.gserviceaccount.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive');
  assert.equal(claims.aud, 'https://accounts.example.test/token');
  assert.equal(claims.iat, issuedAt / 1000);
  assert.equal(claims.exp, issuedAt / 1000 + 3600);
  assert.equal(
    crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      publicKey,
      Buffer.from(encodedSignature, 'base64url')
    ),
    true
  );
});

test('Drive API failures redact OAuth secrets from public errors', async () => {
  const secret = 'very-private-refresh-token';
  const fetchImpl = async input => {
    const url = new URL(String(input));
    if (url.origin === 'https://oauth2.googleapis.com') {
      return jsonResponse({ access_token: 'short-lived-access', expires_in: 3600 });
    }
    return jsonResponse({ error: { message: `backend accidentally echoed ${secret}`, status: 'PERMISSION_DENIED' } }, 403);
  };
  const client = createGoogleDriveClient({
    authType: 'oauth',
    rootFolderId: ROOT_ID,
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: secret
  }, { fetchImpl });

  await assert.rejects(
    client.uploadCameraTranscripts({
      action: { id: 'a' }, runKey: 'run',
      files: [{ channel: 1, label: 'Холл', content: 'текст' }]
    }),
    error => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.match(error.message, /\*\*\*/);
      assert.equal(error.details.operation, 'check_root_folder');
      return true;
    }
  );
});

test('OAuth token exchange retries transient network failures before using the Drive API', async () => {
  let tokenRequests = 0;
  const delays = [];
  const fetchImpl = async input => {
    const url = new URL(String(input));
    if (url.origin === 'https://oauth2.googleapis.com') {
      tokenRequests += 1;
      if (tokenRequests < 3) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
        });
      }
      return jsonResponse({ access_token: 'recovered-access', expires_in: 3600 });
    }
    if (url.pathname === `/drive/v3/files/${ROOT_ID}`) {
      return jsonResponse(writableFolder(ROOT_ID, 'Записи'));
    }
    assert.fail(`Unexpected request: ${url}`);
  };
  const client = createGoogleDriveClient({
    authType: 'oauth', rootFolderId: ROOT_ID,
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh'
  }, {
    fetchImpl,
    sleepImpl: async milliseconds => { delays.push(milliseconds); }
  });

  const result = await client.findUploadedCameraTranscripts({
    action: { id: 'a' }, runKey: 'run', files: []
  });

  assert.equal(result.ok, true);
  assert.equal(tokenRequests, 3);
  assert.deepEqual(delays, [250, 500]);
});

test('OAuth token exchange retries temporary HTTP failures', async () => {
  let tokenRequests = 0;
  const delays = [];
  const fetchImpl = async input => {
    const url = new URL(String(input));
    if (url.origin === 'https://oauth2.googleapis.com') {
      tokenRequests += 1;
      if (tokenRequests === 1) {
        return jsonResponse({ error: 'temporarily_unavailable' }, 503);
      }
      return jsonResponse({ access_token: 'recovered-access', expires_in: 3600 });
    }
    if (url.pathname === `/drive/v3/files/${ROOT_ID}`) {
      return jsonResponse(writableFolder(ROOT_ID, 'Записи'));
    }
    assert.fail(`Unexpected request: ${url}`);
  };
  const client = createGoogleDriveClient({
    authType: 'oauth', rootFolderId: ROOT_ID,
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh'
  }, {
    fetchImpl,
    sleepImpl: async milliseconds => { delays.push(milliseconds); }
  });

  const result = await client.findUploadedCameraTranscripts({
    action: { id: 'a' }, runKey: 'run', files: []
  });

  assert.equal(result.ok, true);
  assert.equal(tokenRequests, 2);
  assert.deepEqual(delays, [250]);
});

test('expired OAuth refresh token reports the required user action without retrying', async () => {
  let tokenRequests = 0;
  const fetchImpl = async input => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://oauth2.googleapis.com');
    tokenRequests += 1;
    return jsonResponse({
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.'
    }, 400);
  };
  const client = createGoogleDriveClient({
    authType: 'oauth', rootFolderId: ROOT_ID,
    clientId: 'id', clientSecret: 'secret', refreshToken: 'expired-refresh-token'
  }, { fetchImpl, sleepImpl: async () => assert.fail('invalid_grant must not be retried') });

  await assert.rejects(
    client.findUploadedCameraTranscripts({ action: { id: 'a' }, runKey: 'run', files: [] }),
    error => {
      assert.equal(error.code, 'GOOGLE_DRIVE_REFRESH_TOKEN_INVALID');
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /refresh token.*истёк|refresh token.*отозван/i);
      assert.doesNotMatch(error.message, /expired-refresh-token/);
      assert.equal(error.details.reason, 'invalid_grant');
      return true;
    }
  );
  assert.equal(tokenRequests, 1);
});

test('OAuth token exchange surfaces a safe network code after bounded retries', async () => {
  let tokenRequests = 0;
  const delays = [];
  const fetchImpl = async input => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://oauth2.googleapis.com');
    tokenRequests += 1;
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('private transport details'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    });
  };
  const client = createGoogleDriveClient({
    authType: 'oauth', rootFolderId: ROOT_ID,
    clientId: 'id', clientSecret: 'secret', refreshToken: 'private-refresh-token'
  }, {
    fetchImpl,
    sleepImpl: async milliseconds => { delays.push(milliseconds); }
  });

  await assert.rejects(
    client.findUploadedCameraTranscripts({ action: { id: 'a' }, runKey: 'run', files: [] }),
    error => {
      assert.equal(error.code, 'GOOGLE_DRIVE_REQUEST_FAILED');
      assert.match(error.message, /after 4 attempts \(UND_ERR_CONNECT_TIMEOUT\)/);
      assert.doesNotMatch(error.message, /private-refresh-token|private transport details/);
      assert.equal(error.details.reason, 'UND_ERR_CONNECT_TIMEOUT');
      return true;
    }
  );
  assert.equal(tokenRequests, 4);
  assert.deepEqual(delays, [250, 500, 1000]);
});

test('retryable Drive throttling uses bounded backoff before surfacing folder capabilities', async () => {
  let rootRequests = 0;
  const delays = [];
  const fetchImpl = async input => {
    const url = new URL(String(input));
    if (url.origin === 'https://oauth2.googleapis.com') {
      return jsonResponse({ access_token: 'retry-access', expires_in: 3600 });
    }
    if (url.pathname === `/drive/v3/files/${ROOT_ID}`) {
      rootRequests += 1;
      if (rootRequests === 1) {
        return jsonResponse({ error: { message: 'slow down', errors: [{ reason: 'rateLimitExceeded' }] } }, 429);
      }
      return jsonResponse({
        ...writableFolder(ROOT_ID, 'Недоступная папка'),
        capabilities: { canAddChildren: false }
      });
    }
    assert.fail(`Unexpected request: ${url}`);
  };
  const client = createGoogleDriveClient({
    authType: 'oauth', rootFolderId: ROOT_ID,
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh'
  }, {
    fetchImpl,
    sleepImpl: async milliseconds => { delays.push(milliseconds); }
  });

  await assert.rejects(
    client.uploadCameraTranscripts({
      action: { id: 'a' }, runKey: 'run',
      files: [{ channel: 1, label: 'Холл', content: 'текст' }]
    }),
    error => error.code === 'GOOGLE_DRIVE_FOLDER_NOT_WRITABLE'
  );
  assert.equal(rootRequests, 2);
  assert.deepEqual(delays, [250]);
});

function transcriptStoreFixture(initialFile = null) {
  let stored = initialFile;
  const writes = [];
  const renames = [];
  const client = createGoogleDriveClient({
    authType: 'oauth', rootFolderId: ROOT_ID,
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh'
  }, {
    fetchImpl: async (input, options = {}) => {
      const url = new URL(String(input));
      const method = options.method || 'GET';
      if (url.origin === 'https://oauth2.googleapis.com') {
        return jsonResponse({ access_token: 'mock-access', expires_in: 3600 });
      }
      if (url.pathname === `/drive/v3/files/${ROOT_ID}`) {
        return jsonResponse(writableFolder(ROOT_ID, 'Транскрипции'));
      }
      if (url.pathname === '/drive/v3/files' && method === 'GET') {
        const folderQuery = (url.searchParams.get('q') || '').includes("mimeType = 'application/vnd.google-apps.folder'");
        return jsonResponse({ files: folderQuery ? [writableFolder('folder-1', '1 Холл')] : stored ? [stored] : [] });
      }
      if (url.pathname === '/drive/v3/files/transcript-1' && method === 'PATCH') {
        const metadata = JSON.parse(options.body);
        renames.push(metadata);
        stored = { ...stored, ...metadata };
        return jsonResponse(stored);
      }
      if (url.pathname.startsWith('/upload/drive/v3/files') && ['POST', 'PATCH'].includes(method)) {
        const body = Buffer.from(options.body).toString('utf8');
        const metadata = JSON.parse(body.split('\r\n\r\n')[1].split('\r\n')[0]);
        assert.equal(url.pathname, method === 'POST' ? '/upload/drive/v3/files' : '/upload/drive/v3/files/transcript-1');
        assert.equal(url.searchParams.get('uploadType'), 'multipart');
        if (method === 'POST') assert.deepEqual(metadata.parents, ['folder-1']);
        else assert.equal(metadata.parents, undefined);
        writes.push({ method, metadata, body });
        stored = { id: 'transcript-1', webViewLink: 'https://drive.google.com/file/d/transcript-1/view', ...metadata };
        return jsonResponse(stored);
      }
      assert.fail(`Unexpected mock request: ${method} ${url}`);
    }
  });
  const base = { action: { id: 'partial-action' }, runKey: 'daily:2026-10-28' };
  const file = { channel: 1, label: 'Холл', fileName: 'Холл.txt', content: 'Готовый текст' };
  return { client, writes, renames, base, file, stored: () => stored };
}

test('partial Drive transcript stays retryable and marked until upgraded in place to a complete file', async () => {
  const state = transcriptStoreFixture();
  const partial = { ...state.file, fileName: 'Холл — НЕПОЛНАЯ.txt', completeness: 'partial', processedSeconds: 35982.5 };
  const created = await state.client.uploadCameraTranscripts({ ...state.base, files: [partial] });
  assert.equal(created.uploads[0].completeness, 'partial');
  assert.equal(created.uploads[0].processedSeconds, 35982.5);
  assert.equal(created.uploads[0].fileId, 'transcript-1');
  assert.equal(created.uploads[0].created, true);
  assert.equal(state.writes[0].metadata.appProperties.listenerCompleteness, 'partial');
  assert.equal(state.writes[0].metadata.appProperties.listenerProcessedSeconds, '35982.5');

  const found = await state.client.findUploadedCameraTranscripts({ ...state.base, files: [state.file] });
  assert.equal(found.uploads[0].completeness, 'partial');
  assert.equal(found.uploads[0].processedSeconds, 35982.5);
  assert.equal(found.uploads[0].skipped, false);
  assert.equal(found.uploads[0].renamed, false);
  assert.equal(found.uploads[0].fileName, partial.fileName);
  assert.deepEqual(state.renames, []);

  const morePartial = await state.client.uploadCameraTranscripts({
    ...state.base, files: [{ ...partial, processedSeconds: 35990, content: 'Больше обработанного текста' }]
  });
  assert.equal(morePartial.uploads[0].fileId, created.uploads[0].fileId);
  assert.equal(morePartial.uploads[0].updated, true);
  assert.equal(morePartial.uploads[0].processedSeconds, 35990);
  assert.equal(state.writes[1].method, 'PATCH');
  assert.equal(state.writes[1].metadata.appProperties.listenerCompleteness, 'partial');
  assert.match(state.writes[1].body, /Больше обработанного текста/);

  const completed = await state.client.uploadCameraTranscripts({
    ...state.base, files: [{ ...state.file, completeness: 'complete', processedSeconds: 36000 }]
  });
  assert.equal(completed.uploads[0].fileId, created.uploads[0].fileId);
  assert.equal(completed.uploads[0].completeness, 'complete');
  assert.equal(completed.uploads[0].processedSeconds, 36000);
  assert.equal(completed.uploads[0].updated, true);
  assert.equal(state.writes[2].method, 'PATCH');
  assert.equal(state.writes[2].metadata.name, state.file.fileName);
  assert.equal(state.writes[2].metadata.appProperties.listenerCompleteness, 'complete');
  assert.equal(state.writes[2].metadata.appProperties.listenerProcessedSeconds, '36000');
  assert.equal(state.writes[0].metadata.appProperties.listenerDeliveryKey, state.writes[2].metadata.appProperties.listenerDeliveryKey);
  const foundComplete = await state.client.findUploadedCameraTranscripts({ ...state.base, files: [state.file] });
  assert.equal(foundComplete.uploads[0].skipped, true);
  assert.equal(foundComplete.uploads[0].completeness, 'complete');
});

test('partial uploads cannot replace more processed partial files or complete files including legacy exports', async () => {
  for (const existing of [
    { completeness: 'partial', processedSeconds: 35990 },
    { completeness: 'complete', processedSeconds: 36000 },
    null
  ]) {
    const storedFile = {
      id: 'transcript-1', name: existing?.completeness === 'partial' ? 'НЕПОЛНАЯ.txt' : 'Полная.txt',
      mimeType: 'text/plain', webViewLink: 'https://drive.google.com/file/d/transcript-1/view',
      ...(existing ? { appProperties: {
        listenerCompleteness: existing.completeness,
        listenerProcessedSeconds: String(existing.processedSeconds)
      } } : {})
    };
    const state = transcriptStoreFixture(storedFile);
    const result = await state.client.uploadCameraTranscripts({
      ...state.base,
      files: [{ ...state.file, completeness: 'partial', processedSeconds: 35982, content: 'Менее полный текст' }]
    });
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.renames, []);
    assert.deepEqual(state.stored(), storedFile);
    assert.equal(result.uploads[0].fileId, storedFile.id);
    assert.equal(result.uploads[0].fileName, storedFile.name);
    assert.equal(result.uploads[0].completeness, existing?.completeness || 'complete');
    assert.equal(result.uploads[0].processedSeconds, existing?.processedSeconds || 0);
    assert.equal(result.uploads[0].created, false);
    assert.equal(result.uploads[0].updated, false);
    assert.equal(result.uploads[0].preserved, true);
    const found = await state.client.findUploadedCameraTranscripts({
      ...state.base, files: [{ ...state.file, fileName: 'НЕПОЛНАЯ.txt', completeness: 'partial' }]
    });
    assert.equal(found.uploads[0].skipped, existing?.completeness !== 'partial');
    assert.equal(found.uploads[0].fileName, storedFile.name);
    assert.deepEqual(state.renames, []);
  }
});

test('invalid completeness metadata is rejected before any Drive write', async () => {
  const state = transcriptStoreFixture();
  for (const metadata of [
    { completeness: 'unknown' }, { processedSeconds: -1 }, { processedSeconds: Infinity }, { processedSeconds: 'invalid' }
  ]) {
    await assert.rejects(state.client.uploadCameraTranscripts({ ...state.base, files: [{ ...state.file, ...metadata }] }),
      error => error.code === 'GOOGLE_DRIVE_COMPLETENESS_INVALID');
  }
  assert.deepEqual(state.writes, []);
});
