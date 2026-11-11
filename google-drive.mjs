import crypto from 'node:crypto';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const TEXT_MIME_TYPE = 'text/plain; charset=utf-8';
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const MAX_REQUEST_RETRIES = 3;
let defaultGoogleDriveClient = null;

class GoogleDriveError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'GoogleDriveError';
    this.statusCode = options.statusCode || 502;
    this.code = options.code || 'GOOGLE_DRIVE_ERROR';
    if (options.details) this.details = options.details;
  }
}

export function readGoogleDriveConfig(env = process.env) {
  const authType = normalizeAuthType(env.GOOGLE_DRIVE_AUTH_TYPE || 'auto');
  return {
    authType,
    rootFolderId: normalizeFolderId(env.GOOGLE_DRIVE_ROOT_FOLDER_ID || env.GOOGLE_DRIVE_FOLDER_ID || ''),
    clientId: String(env.GOOGLE_DRIVE_CLIENT_ID || env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: String(env.GOOGLE_DRIVE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '').trim(),
    refreshToken: String(env.GOOGLE_DRIVE_REFRESH_TOKEN || env.GOOGLE_REFRESH_TOKEN || '').trim(),
    clientEmail: String(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL || env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL || '').trim(),
    privateKey: normalizePrivateKey(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY || env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || ''),
    tokenUri: normalizeHttpsUrl(env.GOOGLE_DRIVE_TOKEN_URI || env.GOOGLE_TOKEN_URI || GOOGLE_TOKEN_URI, 'Google token URI'),
    scope: DRIVE_SCOPE
  };
}

export function createGoogleDriveClient(inputConfig = {}, dependencies = {}) {
  const config = normalizeConfig(inputConfig);
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const now = typeof dependencies.now === 'function' ? dependencies.now : () => Date.now();
  const sleep = typeof dependencies.sleepImpl === 'function' ? dependencies.sleepImpl : abortableDelay;
  if (typeof fetchImpl !== 'function') {
    throw new GoogleDriveError('Google Drive HTTP client is unavailable.', {
      statusCode: 500,
      code: 'GOOGLE_DRIVE_FETCH_UNAVAILABLE'
    });
  }

  const secrets = [config.clientSecret, config.refreshToken, config.privateKey].filter(Boolean);
  const deliveryLocks = new Map();
  const folderLocks = new Map();
  let accessToken = '';
  let accessTokenExpiresAt = 0;
  let accessTokenPromise = null;

  const clearAccessToken = () => {
    accessToken = '';
    accessTokenExpiresAt = 0;
  };

  const getAccessToken = async signal => {
    if (accessToken && now() < accessTokenExpiresAt - TOKEN_EXPIRY_SKEW_MS) return accessToken;
    if (!accessTokenPromise) {
      accessTokenPromise = requestAccessToken(config, fetchImpl, now, undefined, secrets, sleep)
        .then(token => {
          accessToken = token.accessToken;
          accessTokenExpiresAt = token.expiresAt;
          if (!secrets.includes(accessToken)) secrets.push(accessToken);
          return accessToken;
        })
        .finally(() => {
          accessTokenPromise = null;
        });
    }
    return awaitWithSignal(accessTokenPromise, signal);
  };

  const request = async (pathname, options = {}) => {
    const url = driveUrl(pathname, options.query, options.upload);
    const method = options.method || 'GET';
    const execute = async (forceTokenRefresh, retryAttempt = 0) => {
      if (forceTokenRefresh) clearAccessToken();
      const token = await getAccessToken(options.signal);
      const headers = new Headers(options.headers || {});
      headers.set('authorization', `Bearer ${token}`);
      headers.set('accept', 'application/json');
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body: options.body,
          signal: options.signal
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        if (retryAttempt < MAX_REQUEST_RETRIES && isIdempotentMethod(method)) {
          await sleep(retryDelayMs(retryAttempt), options.signal);
          return execute(forceTokenRefresh, retryAttempt + 1);
        }
        throw safeDriveError('Google Drive request failed before receiving a response.', {
          cause: error,
          operation: options.operation,
          secrets
        });
      }
      if (response.status === 401 && !forceTokenRefresh) return execute(true, retryAttempt);
      if (!response.ok) {
        const payload = await readResponsePayload(response);
        const reason = payload?.error?.errors?.[0]?.reason || payload?.error?.status || '';
        if (retryAttempt < MAX_REQUEST_RETRIES && isRetryableDriveResponse(response.status, reason, method)) {
          await sleep(retryDelayMs(retryAttempt, response.headers.get('retry-after')), options.signal);
          return execute(forceTokenRefresh, retryAttempt + 1);
        }
        throw safeDriveError(googleApiErrorMessage(payload, response.status), {
          statusCode: response.status,
          code: 'GOOGLE_DRIVE_API_ERROR',
          operation: options.operation,
          reason,
          secrets
        });
      }
      if (response.status === 204) return null;
      return readResponsePayload(response);
    };
    return execute(false);
  };

  const getRootFolder = async (rootFolderId, signal) => {
    const folderId = requireFolderId(rootFolderId || config.rootFolderId);
    const folder = await request(`/files/${encodeURIComponent(folderId)}`, {
      query: { fields: 'id,name,mimeType,trashed,driveId,capabilities(canAddChildren)' },
      signal,
      operation: 'check_root_folder'
    });
    assertWritableFolder(folder, 'The configured Google Drive destination');
    if (config.resolvedAuthType === 'service_account' && !folder.driveId) {
      throw new GoogleDriveError(
        'A service account can upload only to a Shared Drive. Use OAuth for a folder in My Drive.',
        { statusCode: 400, code: 'GOOGLE_DRIVE_SERVICE_ACCOUNT_REQUIRES_SHARED_DRIVE' }
      );
    }
    return folder;
  };

  const findFolder = async (rootFolder, folderName, signal) => {
    const q = [
      `'${escapeDriveQueryValue(rootFolder.id)}' in parents`,
      'trashed = false',
      `mimeType = '${FOLDER_MIME_TYPE}'`,
      `name = '${escapeDriveQueryValue(folderName)}'`
    ].join(' and ');
    const files = await listFiles(request, q, signal, 'find_camera_folder', rootFolder.driveId);
    if (!files.length) return null;
    const folder = files.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0];
    assertWritableFolder(folder, `Google Drive folder "${folderName}"`);
    return folder;
  };

  const createFolder = async (rootFolder, folderName, signal) => {
    try {
      const folder = await request('/files', {
        method: 'POST',
        query: { fields: 'id,name,mimeType,driveId,capabilities(canAddChildren)' },
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          name: folderName,
          mimeType: FOLDER_MIME_TYPE,
          parents: [rootFolder.id]
        }),
        signal,
        operation: 'create_camera_folder'
      });
      assertWritableFolder(folder, `Google Drive folder "${folderName}"`);
      return folder;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const recovered = await findFolder(rootFolder, folderName, signal).catch(() => null);
      if (recovered) return recovered;
      throw error;
    }
  };

  const ensureCameraFolder = async (rootFolder, file, signal) => {
    const folderName = cameraFolderName(file.channel, file.label);
    return withKeyLock(folderLocks, `${rootFolder.id}:${file.channel}`, async () =>
      await findFolder(rootFolder, folderName, signal)
      || await createFolder(rootFolder, folderName, signal));
  };

  const findTranscriptFile = async (folderId, deliveryKey, channel, signal, driveId = '') => {
    const q = [
      `'${escapeDriveQueryValue(folderId)}' in parents`,
      'trashed = false',
      `appProperties has { key='listenerDeliveryKey' and value='${escapeDriveQueryValue(deliveryKey)}' }`,
      `appProperties has { key='listenerChannel' and value='${escapeDriveQueryValue(channel)}' }`
    ].join(' and ');
    const files = await listFiles(request, q, signal, 'find_transcript_file', driveId);
    return files.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] || null;
  };

  const writeTranscriptFile = async ({ folderId, existing, file, deliveryKey, channel, signal }) => {
    const existingCoverage = storedTranscriptCoverage(existing);
    if (existing && file.completeness === 'partial'
      && (existingCoverage.completeness === 'complete'
        || existingCoverage.processedSeconds > file.processedSeconds)) {
      return { ...existing, created: false, updated: false, preserved: true };
    }
    const metadata = {
      name: transcriptFileName(file),
      mimeType: 'text/plain',
      appProperties: {
        listenerDeliveryKey: deliveryKey,
        listenerChannel: channel,
        listenerCompleteness: file.completeness,
        listenerProcessedSeconds: String(file.processedSeconds)
      }
    };
    if (!existing) metadata.parents = [folderId];
    const multipart = multipartRelated(metadata, Buffer.from(String(file.content ?? file.text ?? ''), 'utf8'));
    const pathname = existing
      ? `/files/${encodeURIComponent(existing.id)}`
      : '/files';
    const result = await request(pathname, {
      method: existing ? 'PATCH' : 'POST',
      upload: true,
      query: { uploadType: 'multipart', fields: 'id,name,mimeType,size,modifiedTime,webViewLink,appProperties' },
      headers: { 'content-type': `multipart/related; boundary=${multipart.boundary}` },
      body: multipart.body,
      signal,
      operation: existing ? 'update_transcript_file' : 'create_transcript_file'
    });
    return {
      ...result,
      appProperties: { ...metadata.appProperties, ...result?.appProperties },
      created: !existing,
      updated: Boolean(existing)
    };
  };

  const findUploadedCameraTranscripts = async options => {
    const actionId = String(options?.action?.id || '').trim();
    const runKey = String(options?.runKey || '').trim();
    if (!actionId || !runKey) {
      throw new GoogleDriveError('Google Drive lookup requires an action id and run key.', {
        statusCode: 400,
        code: 'GOOGLE_DRIVE_DELIVERY_KEY_REQUIRED'
      });
    }
    const sourceFiles = Array.isArray(options?.files) ? options.files : [];
    const files = sourceFiles.map(normalizeTranscriptFile);
    const rootFolder = await getRootFolder(options?.rootFolderId, options?.signal);
    const deliveryKey = crypto.createHash('sha256').update(JSON.stringify([actionId, runKey])).digest('hex');
    const uploads = [];
    for (const file of files) {
      options.signal?.throwIfAborted?.();
      const folder = await findFolder(rootFolder, cameraFolderName(file.channel, file.label), options.signal);
      if (!folder) continue;
      const driveId = folder.driveId || rootFolder.driveId || '';
      let existing = await findTranscriptFile(
        folder.id,
        deliveryKey,
        String(file.channel),
        options.signal,
        driveId
      );
      if (!existing) continue;
      const coverage = storedTranscriptCoverage(existing);
      const expectedName = transcriptFileName(file);
      let renamed = false;
      if (coverage.completeness === 'complete' && file.completeness === 'complete'
        && file.fileName && existing.name !== expectedName) {
        const updated = await request(`/files/${encodeURIComponent(existing.id)}`, {
          method: 'PATCH',
          query: { fields: 'id,name,mimeType,size,modifiedTime,webViewLink,appProperties' },
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ name: expectedName }),
          signal: options.signal,
          operation: 'rename_completed_transcript_file'
        });
        existing = { ...existing, ...updated };
        renamed = true;
      }
      uploads.push({
        channel: file.channel,
        label: file.label,
        folderId: folder.id,
        folderName: folder.name,
        fileId: existing.id,
        fileName: existing.name || transcriptFileName(file),
        webViewLink: existing.webViewLink || '',
        ...coverage,
        existing: true,
        skipped: coverage.completeness === 'complete',
        renamed
      });
    }
    return { ok: true, rootFolderId: rootFolder.id, deliveryKey, uploads };
  };

  const uploadCameraTranscripts = async options => {
    const actionId = String(options?.action?.id || '').trim();
    const runKey = String(options?.runKey || '').trim();
    if (!actionId || !runKey) {
      throw new GoogleDriveError('Google Drive upload requires an action id and run key.', {
        statusCode: 400,
        code: 'GOOGLE_DRIVE_DELIVERY_KEY_REQUIRED'
      });
    }
    const sourceFiles = Array.isArray(options?.files) ? options.files : [];
    if (!sourceFiles.length) {
      throw new GoogleDriveError('Google Drive upload requires at least one camera transcript.', {
        statusCode: 400,
        code: 'GOOGLE_DRIVE_FILES_REQUIRED'
      });
    }
    const files = sourceFiles.map(normalizeTranscriptFile);
    if (new Set(files.map(file => file.channel)).size !== files.length) {
      throw new GoogleDriveError('Google Drive upload accepts one transcript per camera.', {
        statusCode: 400,
        code: 'GOOGLE_DRIVE_DUPLICATE_CHANNEL'
      });
    }
    const rootFolder = await getRootFolder(options?.rootFolderId, options?.signal);
    const deliveryKey = crypto.createHash('sha256').update(JSON.stringify([actionId, runKey])).digest('hex');
    return withKeyLock(deliveryLocks, deliveryKey, async () => {
      const uploads = [];
      for (const file of files) {
        options.signal?.throwIfAborted?.();
        const channel = String(file.channel);
        const folder = await ensureCameraFolder(rootFolder, file, options.signal);
        const driveId = folder.driveId || rootFolder.driveId || '';
        let existing = await findTranscriptFile(folder.id, deliveryKey, channel, options.signal, driveId);
        let uploaded;
        try {
          uploaded = await writeTranscriptFile({
            folderId: folder.id,
            existing,
            file,
            deliveryKey,
            channel,
            signal: options.signal
          });
        } catch (error) {
          if (error?.name === 'AbortError' || existing) throw error;
          existing = await findTranscriptFile(folder.id, deliveryKey, channel, options.signal, driveId).catch(() => null);
          if (!existing) throw error;
          uploaded = await writeTranscriptFile({
            folderId: folder.id,
            existing,
            file,
            deliveryKey,
            channel,
            signal: options.signal
          });
          uploaded.recovered = true;
        }
        uploads.push({
          channel: file.channel,
          label: file.label,
          folderId: folder.id,
          folderName: folder.name,
          fileId: uploaded.id,
          fileName: uploaded.name || transcriptFileName(file),
          webViewLink: uploaded.webViewLink || '',
          ...storedTranscriptCoverage(uploaded),
          created: uploaded.created,
          updated: uploaded.updated,
          preserved: Boolean(uploaded.preserved),
          recovered: Boolean(uploaded.recovered)
        });
      }
      return {
        ok: true,
        rootFolderId: rootFolder.id,
        deliveryKey,
        uploads
      };
    });
  };

  return {
    authType: config.resolvedAuthType,
    rootFolderId: config.rootFolderId,
    findUploadedCameraTranscripts,
    uploadCameraTranscripts
  };
}

export async function findUploadedCameraTranscripts(options, config, dependencies) {
  if (config !== undefined || dependencies !== undefined) {
    return createGoogleDriveClient(config || readGoogleDriveConfig(), dependencies || {}).findUploadedCameraTranscripts(options);
  }
  defaultGoogleDriveClient ||= createGoogleDriveClient(readGoogleDriveConfig());
  return defaultGoogleDriveClient.findUploadedCameraTranscripts(options);
}

export async function uploadCameraTranscripts(options, config, dependencies) {
  if (config !== undefined || dependencies !== undefined) {
    return createGoogleDriveClient(config || readGoogleDriveConfig(), dependencies || {}).uploadCameraTranscripts(options);
  }
  defaultGoogleDriveClient ||= createGoogleDriveClient(readGoogleDriveConfig());
  return defaultGoogleDriveClient.uploadCameraTranscripts(options);
}

function normalizeConfig(input = {}) {
  const config = {
    authType: normalizeAuthType(input.authType || 'auto'),
    rootFolderId: normalizeFolderId(input.rootFolderId || ''),
    clientId: String(input.clientId || '').trim(),
    clientSecret: String(input.clientSecret || '').trim(),
    refreshToken: String(input.refreshToken || '').trim(),
    clientEmail: String(input.clientEmail || '').trim(),
    privateKey: normalizePrivateKey(input.privateKey || ''),
    tokenUri: normalizeHttpsUrl(input.tokenUri || GOOGLE_TOKEN_URI, 'Google token URI'),
    scope: String(input.scope || DRIVE_SCOPE).trim() || DRIVE_SCOPE
  };
  const oauthReady = Boolean(config.clientId && config.clientSecret && config.refreshToken);
  const serviceAccountReady = Boolean(config.clientEmail && config.privateKey);
  config.resolvedAuthType = config.authType === 'auto'
    ? oauthReady ? 'oauth' : serviceAccountReady ? 'service_account' : ''
    : config.authType;
  if (config.resolvedAuthType === 'oauth' && !oauthReady) {
    throw new GoogleDriveError('Google Drive OAuth credentials are incomplete.', {
      statusCode: 503,
      code: 'GOOGLE_DRIVE_OAUTH_NOT_CONFIGURED'
    });
  }
  if (config.resolvedAuthType === 'service_account' && !serviceAccountReady) {
    throw new GoogleDriveError('Google Drive service account credentials are incomplete.', {
      statusCode: 503,
      code: 'GOOGLE_DRIVE_SERVICE_ACCOUNT_NOT_CONFIGURED'
    });
  }
  if (!config.resolvedAuthType) {
    throw new GoogleDriveError('Google Drive credentials are not configured.', {
      statusCode: 503,
      code: 'GOOGLE_DRIVE_NOT_CONFIGURED'
    });
  }
  return config;
}

async function requestAccessToken(config, fetchImpl, now, signal, secrets, sleep) {
  const params = new URLSearchParams();
  if (config.resolvedAuthType === 'oauth') {
    params.set('client_id', config.clientId);
    params.set('client_secret', config.clientSecret);
    params.set('refresh_token', config.refreshToken);
    params.set('grant_type', 'refresh_token');
  } else {
    const issuedAt = Math.floor(now() / 1000);
    const assertion = createServiceAccountAssertion(config, issuedAt);
    params.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    params.set('assertion', assertion);
  }

  for (let attempt = 0; attempt <= MAX_REQUEST_RETRIES; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(config.tokenUri, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: params.toString(),
        signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (attempt < MAX_REQUEST_RETRIES) {
        await sleep(retryDelayMs(attempt), signal);
        continue;
      }
      const reason = networkErrorCode(error);
      throw safeDriveError(
        `Google authorization request failed after ${attempt + 1} attempts${reason ? ` (${reason})` : ''}.`,
        {
          cause: error,
          operation: 'authorize',
          reason,
          secrets
        }
      );
    }

    const payload = await readResponsePayload(response);
    if (response.ok && payload?.access_token) {
      const expiresInSeconds = Math.max(60, Number(payload.expires_in) || 3600);
      return {
        accessToken: String(payload.access_token),
        expiresAt: now() + expiresInSeconds * 1000
      };
    }

    if (attempt < MAX_REQUEST_RETRIES && isRetryableAuthorizationResponse(response.status)) {
      await sleep(retryDelayMs(attempt, response.headers.get('retry-after')), signal);
      continue;
    }

    const reason = String(payload?.error || '').trim();
    const temporary = isRetryableAuthorizationResponse(response.status);
    const refreshTokenInvalid = config.resolvedAuthType === 'oauth' && reason === 'invalid_grant';
    throw safeDriveError(
      refreshTokenInvalid
        ? 'Срок действия Google refresh token истёк или токен был отозван. Переведите OAuth-приложение в статус In production и создайте новый refresh token.'
        : temporary
        ? `Google authorization temporarily unavailable after ${attempt + 1} attempts (HTTP ${response.status || 502}).`
        : `Google authorization was rejected${reason ? ` (${reason})` : ''}.`,
      {
        statusCode: response.status || 502,
        code: refreshTokenInvalid ? 'GOOGLE_DRIVE_REFRESH_TOKEN_INVALID' : 'GOOGLE_DRIVE_AUTH_FAILED',
        operation: 'authorize',
        reason,
        secrets
      }
    );
  }

  throw safeDriveError('Google authorization request failed.', {
    operation: 'authorize',
    secrets
  });
}

function createServiceAccountAssertion(config, issuedAt) {
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const claims = base64UrlJson({
    iss: config.clientEmail,
    scope: config.scope,
    aud: config.tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3600
  });
  const unsigned = `${header}.${claims}`;
  try {
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), config.privateKey).toString('base64url');
    return `${unsigned}.${signature}`;
  } catch (error) {
    throw new GoogleDriveError('Google Drive service account private key is invalid.', {
      statusCode: 503,
      code: 'GOOGLE_DRIVE_PRIVATE_KEY_INVALID',
      cause: error
    });
  }
}

async function listFiles(request, q, signal, operation, driveId = '') {
  const files = [];
  let pageToken = '';
  do {
    const payload = await request('/files', {
      query: {
        q,
        spaces: 'drive',
        includeItemsFromAllDrives: 'true',
        ...(driveId ? { corpora: 'drive', driveId } : {}),
        pageSize: '100',
        fields: 'nextPageToken,files(id,name,mimeType,driveId,capabilities(canAddChildren),appProperties,webViewLink)',
        ...(pageToken ? { pageToken } : {})
      },
      signal,
      operation
    });
    files.push(...(Array.isArray(payload?.files) ? payload.files : []));
    pageToken = String(payload?.nextPageToken || '');
  } while (pageToken);
  return files;
}

function driveUrl(pathname, query = {}, upload = false) {
  const url = new URL(`${upload ? DRIVE_UPLOAD_BASE : DRIVE_API_BASE}${pathname}`);
  for (const [key, value] of Object.entries({
    ...query,
    supportsAllDrives: 'true'
  })) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

function multipartRelated(metadata, content) {
  const boundary = `listener_${crypto.randomUUID().replaceAll('-', '')}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`
    + `${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\nContent-Type: ${TEXT_MIME_TYPE}\r\n\r\n`,
    'utf8'
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { boundary, body: Buffer.concat([prefix, content, suffix]) };
}

function normalizeTranscriptFile(file) {
  const numericChannel = Number(file?.channel);
  if (!Number.isInteger(numericChannel) || numericChannel < 1) {
    throw new GoogleDriveError('Camera transcript has an invalid channel number.', {
      statusCode: 400,
      code: 'GOOGLE_DRIVE_CHANNEL_INVALID'
    });
  }
  const label = sanitizeDriveName(file?.label || `Канал ${numericChannel}`);
  const completeness = file?.completeness ?? 'complete';
  const processedSeconds = Number(file?.processedSeconds ?? 0);
  if (!['partial', 'complete'].includes(completeness)
    || !Number.isFinite(processedSeconds) || processedSeconds < 0) {
    throw new GoogleDriveError('Camera transcript has invalid completeness metadata.', {
      statusCode: 400,
      code: 'GOOGLE_DRIVE_COMPLETENESS_INVALID'
    });
  }
  return {
    ...file,
    channel: numericChannel,
    label,
    completeness,
    processedSeconds,
    fileName: file?.fileName ? sanitizeDriveName(file.fileName) : ''
  };
}

function storedTranscriptCoverage(file) {
  const processedSeconds = Number(file?.appProperties?.listenerProcessedSeconds);
  return {
    // Files written before completeness metadata existed were complete exports.
    completeness: file?.appProperties?.listenerCompleteness === 'partial' ? 'partial' : 'complete',
    processedSeconds: Number.isFinite(processedSeconds) && processedSeconds >= 0 ? processedSeconds : 0
  };
}

function cameraFolderName(channel, label) {
  return sanitizeDriveName(`${Number(channel)} ${label}`);
}

function transcriptFileName(file) {
  const fallback = `camera-${file.channel}-transcript.txt`;
  const name = sanitizeDriveName(file.fileName || fallback);
  return name.toLowerCase().endsWith('.txt') ? name : `${name}.txt`;
}

function sanitizeDriveName(value) {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return cleaned || 'Без названия';
}

function assertWritableFolder(folder, label) {
  if (!folder?.id || folder.mimeType !== FOLDER_MIME_TYPE || folder.trashed) {
    throw new GoogleDriveError(`${label} is not an available folder.`, {
      statusCode: 400,
      code: 'GOOGLE_DRIVE_FOLDER_INVALID'
    });
  }
  if (folder.capabilities?.canAddChildren !== true) {
    throw new GoogleDriveError(`${label} does not allow file uploads. Grant the connected account Editor access.`, {
      statusCode: 403,
      code: 'GOOGLE_DRIVE_FOLDER_NOT_WRITABLE'
    });
  }
}

function requireFolderId(value) {
  const folderId = normalizeFolderId(value);
  if (!folderId) {
    throw new GoogleDriveError('Google Drive root folder is not configured.', {
      statusCode: 503,
      code: 'GOOGLE_DRIVE_ROOT_FOLDER_NOT_CONFIGURED'
    });
  }
  return folderId;
}

function normalizeFolderId(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/folders\/([A-Za-z0-9_-]+)/);
  const id = match ? match[1] : text;
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : '';
}

function normalizePrivateKey(value) {
  return String(value || '').trim().replace(/\\n/g, '\n');
}

function normalizeAuthType(value) {
  const normalized = String(value || 'auto').trim().toLowerCase().replaceAll('-', '_');
  if (['auto', 'oauth', 'service_account'].includes(normalized)) return normalized;
  throw new GoogleDriveError('GOOGLE_DRIVE_AUTH_TYPE must be auto, oauth, or service_account.', {
    statusCode: 503,
    code: 'GOOGLE_DRIVE_AUTH_TYPE_INVALID'
  });
}

function normalizeHttpsUrl(value, label) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') throw new Error('HTTPS is required');
    return url.toString();
  } catch {
    throw new GoogleDriveError(`${label} must be a valid HTTPS URL.`, {
      statusCode: 503,
      code: 'GOOGLE_DRIVE_URL_INVALID'
    });
  }
}

function escapeDriveQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

async function withKeyLock(locks, key, callback) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  locks.set(key, current);
  await previous.catch(() => {});
  try {
    return await callback();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted?.();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function isIdempotentMethod(method) {
  return ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

function isRetryableAuthorizationResponse(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function networkErrorCode(error) {
  return String(error?.cause?.code || error?.code || '').trim().slice(0, 80);
}

function isRetryableDriveResponse(status, reason, method) {
  const normalizedReason = String(reason || '').toLowerCase();
  if (status === 429) return true;
  if (status === 403 && ['ratelimitexceeded', 'userratelimitexceeded', 'sharingratelimitexceeded'].includes(normalizedReason)) {
    return true;
  }
  return status >= 500 && status <= 599 && isIdempotentMethod(method);
}

function retryDelayMs(attempt, retryAfter = '') {
  const retryAfterText = String(retryAfter || '').trim();
  const retryAfterSeconds = Number(retryAfterText);
  if (retryAfterText && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(30_000, retryAfterSeconds * 1000);
  }
  return Math.min(4000, 250 * (2 ** Math.max(0, attempt)));
}

function abortableDelay(milliseconds, signal) {
  signal?.throwIfAborted?.();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => done(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    function done(error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readResponsePayload(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 1000) };
  }
}

function googleApiErrorMessage(payload, status) {
  const message = payload?.error?.message || payload?.message;
  return message
    ? `Google Drive API error (${status}): ${String(message).slice(0, 500)}`
    : `Google Drive API error (${status}).`;
}

function safeDriveError(message, options = {}) {
  const safeMessage = redactSecrets(String(message || 'Google Drive request failed.'), options.secrets || []);
  const safeReason = redactSecrets(String(options.reason || ''), options.secrets || []).slice(0, 200);
  return new GoogleDriveError(safeMessage, {
    statusCode: options.statusCode || 502,
    code: options.code || 'GOOGLE_DRIVE_REQUEST_FAILED',
    details: {
      operation: String(options.operation || 'drive_request'),
      ...(safeReason ? { reason: safeReason } : {})
    }
  });
}

function redactSecrets(value, secrets) {
  let result = String(value || '');
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.replaceAll(secret, '***').replaceAll(encodeURIComponent(secret), '***');
  }
  return result;
}

export { GoogleDriveError };
