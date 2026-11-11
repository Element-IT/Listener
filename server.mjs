import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import tls from 'node:tls';
import { setTimeout as waitFor } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import pg from 'pg';
import { createTranscriptionModelSettings } from './transcription-models.mjs';
import { createGoogleDriveClient, readGoogleDriveConfig } from './google-drive.mjs';
import { handleAudioFileTranscription, validateAudioUpload } from './audio-files.mjs';
import { assessIntervalCoverage, isTranscriptCachePayloadComplete } from './transcript-coverage.mjs';
import { createPcmSpool } from './pcm-spool.mjs';
import { createDeliveryOutbox, createMemoryDeliveryOutbox } from './delivery-outbox.mjs';
import { createDriveDeliveryWorker } from './drive-delivery.mjs';
import { XM_RECOVERY_PIPELINE, xmRecoveryPlans, readXmRecoveryPcm, shouldRecoverXmRecordingFromCache } from './xm-block-recovery.mjs';
import {
  convertLocalDateTime,
  formatDateTimeInZone,
  localDateTimeInZone,
  normalizeTimeZone,
  offsetDatePart as offsetZonedDatePart,
  zonedDatePart,
  zonedDateTimeToEpochMs
} from './time-zones.mjs';
import { ProxyAgent } from 'undici';

const { Client, Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const RUNTIME_DIR = path.join(__dirname, '.runtime');
const TRANSCRIPT_DIR = path.join(process.env.TEMP || process.env.TMP || RUNTIME_DIR, 'camera-audio-listener-transcripts');
const GIGAAM_WORKER_SCRIPT = path.join(__dirname, 'scripts', 'gigaam_worker.py');
const GIGAAM_SETUP_SCRIPT = path.join(__dirname, 'scripts', 'prepare_transcription.py');
const VPNXXX_AUTO_PROXY_URL = 'vpnxxx://auto';
const VPNXXX_PRIVOXY_CONFIG_MAX_BYTES = 64 * 1024;

loadDotEnv(path.join(__dirname, '.env'));

const PORT = numberFromEnv('PORT', 37841);
const DEFAULT_TIMEOUT_MS = 10000;
const XM_NO_RECORD_RET_CODES = new Set([119]);
const DATABASE_SCHEMA_VERSION = 3;
const ACTION_SCHEDULER_STATE_KEY = 'action_scheduler_state';
const ACTION_SCHEDULER_ENABLED = !process.argv.includes('--no-action-scheduler')
  && booleanFromEnv('ACTION_SCHEDULER_ENABLED', true);
const ACTION_SCHEDULER_INTERVAL_MS = Math.max(10, numberFromEnv('ACTION_SCHEDULER_INTERVAL_SECONDS', 30)) * 1000;
const ACTION_SCHEDULER_RETRY_DELAYS_MS = [60, 300, 900, 1800, 3600].map(seconds => seconds * 1000);
const ACTION_SCHEDULER_RETRY_MAX_AGE_MS = Math.max(1, numberFromEnv('ACTION_SCHEDULER_RETRY_MAX_AGE_HOURS', 168)) * 60 * 60 * 1000;
const MANUAL_ACTION_CLAIM_TTL_MS = Math.max(1, numberFromEnv('MANUAL_ACTION_CLAIM_TTL_HOURS', 36)) * 60 * 60 * 1000;
let gigaAmWorkerState = null;
let gigaAmWorkerError = '';
let gigaAmTranscriptionQueue = Promise.resolve();
let transcriberCheckPromise = null;
let transcriberCheckKey = '';
const ffmpegCheckCache = new Map();
let transcriptionPythonPath = '';
let transcriptionSetup = { stage: 'not_started' };
let transcriptionSetupRuntime = {};
let databasePoolPromise = null;
let actionSchedulerTimer = null;
let actionSchedulerRunning = false;
let actionSchedulerStateMutation = Promise.resolve();
const activeScheduledActions = new Set();
const scheduledActionRuntime = new Map();
const activeManualActions = new Map();
let activeTranscriptionRequests = 0;
let activeUploadedTranscriptions = 0;
let googleDriveClientState = null;
let driveDeliveryOutbox;
let driveDeliveryWorker;
const transcriptionModelSettings = createTranscriptionModelSettings({
  defaultModel: process.env.GIGAAM_MODEL || 'v3_e2e_rnnt',
  read: () => readAppSetting('transcription_model'),
  write: model => writeAppSetting('transcription_model', model),
  busyReason: () => {
    if (transcriptionPreparationPending(transcriptionSetup)) return 'Выполняется подготовка окружения транскрибации.';
    if (activeTranscriptionRequests || activeScheduledActions.size
      || (gigaAmWorkerState && !gigaAmWorkerState.closed && (!gigaAmWorkerState.runtimeInfo || gigaAmWorkerState.pending.size))) {
      return 'Выполняется транскрибация или фоновое действие. Смена модели временно недоступна.';
    }
    return '';
  },
  onChange: () => {
    if (gigaAmWorkerState && !gigaAmWorkerState.closed) gigaAmWorkerState.stop();
    gigaAmWorkerState = null;
    gigaAmWorkerError = '';
  }
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/config') {
      return json(res, 200, publicConfig());
    }

    if (url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        config: publicConfig(),
        ffmpeg: await checkFfmpeg(),
        transcriber: await readTranscriptionStatus()
      });
    }

    if (url.pathname === '/api/transcription/status') {
      requireMethod(req, 'GET');
      return json(res, 200, { ok: true, transcriber: await readTranscriptionStatus() });
    }

    if (url.pathname === '/api/audio-files/transcript') {
      return await transcribeUploadedFile(req, res, url.searchParams);
    }

    if (url.pathname === '/api/transcription/model') {
      requireMethod(req, 'POST');
      const payload = await readJsonBody(req, 4096);
      await transcriptionModelSettings.save(payload.model);
      return json(res, 200, { ok: true, transcriber: await readTranscriptionStatus() });
    }

    if (url.pathname === '/api/probe') {
      return json(res, 200, await probeCamera(cameraConfig()));
    }

    if (url.pathname === '/api/storage') {
      return await storageState(req, res, url.searchParams);
    }

    if (url.pathname === '/api/storage/action-status') {
      requireMethod(req, 'GET');
      const [actions, groups] = await Promise.all([readOpenAiActions(), readOpenAiGroups()]);
      return json(res, 200, { ok: true, actions, scheduler: await readPublicActionSchedulerState(actions, groups) });
    }

    if (url.pathname.startsWith('/api/storage/')) {
      return await storageMutation(req, res, url.pathname);
    }

    if (url.pathname === '/api/recordings/search') {
      const normalized = normalizeRecordingSearchTimeRange(url.searchParams);
      const result = await searchRecordings(cameraConfig(), normalized.params);
      return json(res, 200, { ...result, ...normalized.publicRange });
    }

    if (url.pathname === '/api/recordings/file') {
      return await streamRecordingFile(req, res, cameraConfig(), url.searchParams);
    }

    if (url.pathname === '/api/live/audio') {
      return await streamAudio(req, res, cameraConfig(), url.searchParams, 'live');
    }

    if (url.pathname === '/api/recordings/audio') {
      return await streamAudio(req, res, cameraConfig(), url.searchParams, 'archive');
    }

    if (url.pathname === '/api/live/transcript') {
      return await handleTranscriptionRequest(req, res, url.searchParams, 'live');
    }

    if (url.pathname === '/api/recordings/transcript') {
      return await handleTranscriptionRequest(req, res, url.searchParams, 'archive');
    }

    if (url.pathname === '/api/openai/ask') {
      return await askOpenAi(req, res);
    }

    if (url.pathname === '/api/reports/send') {
      return await sendReportEmail(req, res);
    }

    if (url.pathname === '/api/drive/status') {
      requireMethod(req, 'GET');
      return json(res, 200, { ok: true, drive: publicGoogleDriveConfig() });
    }

    if (url.pathname === '/api/drive/transcripts') {
      throw httpError(409, 'Прямая выгрузка из старой вкладки отключена. Обновите страницу и запустите действие: сервер проверит полноту и сохранит TXT в очередь отправки.');
    }

    if (url.pathname.startsWith('/api/')) {
      return json(res, 404, { ok: false, error: 'Unknown API route.' });
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    return sendError(res, error);
  }
});

if (isMainModule()) {
  server.listen(PORT, async () => {
    console.log(`Camera audio app: http://localhost:${PORT}`);
    await transcriptionModelSettings.initialize().catch(error => console.warn(`Transcription model settings: ${error.message}`));
    const runtime = await prepareTranscriber();
    console.log(`Transcription startup check: ${runtime.selectedDevice || 'unavailable'}; PyTorch ${runtime.torchVersion || 'unknown'}; CUDA ${runtime.cuda?.available ? 'available' : 'unavailable'}; GPU: ${(runtime.gpus || []).map(gpu => gpu.name).join(', ') || 'not detected'}`);
    if (runtime.error || runtime.reason === 'torch_cpu_only') {
      console.warn(`Transcription: ${runtime.error || 'PyTorch is CPU-only; CUDA acceleration is unavailable.'}`);
    }
    startActionScheduler();
  });
}

function isMainModule() {
  return process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

process.on('uncaughtException', error => {
  if (isExpectedDisconnect(error)) {
    console.warn(`stream disconnected: ${error.code || error.message}`);
    return;
  }

  console.error(error);
  process.exit(1);
});

process.on('unhandledRejection', error => {
  if (isExpectedDisconnect(error)) {
    console.warn(`stream disconnected: ${error.code || error.message}`);
    return;
  }

  console.warn(`unhandled async error: ${publicError(error)}`);
});

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function numberFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function booleanFromEnv(name, fallback = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function cameraConfig() {
  return {
    scheme: process.env.CAMERA_SCHEME || 'http',
    host: process.env.CAMERA_HOST || '127.0.0.1',
    httpPort: numberFromEnv('CAMERA_HTTP_PORT', 80),
    rtspPort: numberFromEnv('CAMERA_RTSP_PORT', 554),
    user: process.env.CAMERA_USER || 'admin',
    password: process.env.CAMERA_PASSWORD || '',
    vendor: (process.env.CAMERA_VENDOR || 'auto').toLowerCase(),
    rtspTemplate: process.env.RTSP_URL_TEMPLATE || '',
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    hikvisionTimeMode: (process.env.HIKVISION_TIME_MODE || 'local').toLowerCase(),
    audioFilter: normalizeAudioFilter(process.env.AUDIO_FILTER || 'voice'),
    xmAudioCodec: normalizeXmAudioCodec(process.env.XM_AUDIO_CODEC || 'mulaw'),
    pythonPath: transcriptionPythonPath || process.env.PYTHON_PATH || 'python',
    gigaamModel: transcriptionModelSettings.model,
    gigaamDevice: process.env.GIGAAM_DEVICE || 'auto',
    gigaamDownloadRoot: process.env.GIGAAM_DOWNLOAD_ROOT || defaultGigaAmDownloadRoot(),
    transcriptionChunkSeconds: numberFromEnv('TRANSCRIPTION_CHUNK_SECONDS', 20),
    transcriptionLiveSeconds: numberFromEnv('TRANSCRIPTION_LIVE_SECONDS', 18),
    transcriptionCaptureChunkSeconds: numberFromEnv('TRANSCRIPTION_CAPTURE_CHUNK_SECONDS', 30),
    transcriptionRecordingConcurrency: clampNumber(numberFromEnv('TRANSCRIPTION_RECORDING_CONCURRENCY', 1), 1, 4),
    transcriptionXmProgressive: booleanFromEnv('TRANSCRIPTION_XM_PROGRESSIVE', false),
    transcriptionArchiveMaxSeconds: numberFromEnv('TRANSCRIPTION_ARCHIVE_MAX_SECONDS', 0),
    transcriptionTimeoutMs: numberFromEnv('TRANSCRIPTION_TIMEOUT_MS', 30 * 60 * 1000),
    transcriptionCaptureTimeoutMs: numberFromEnv('TRANSCRIPTION_CAPTURE_TIMEOUT_MS', 30 * 60 * 1000)
  };
}

function defaultGigaAmDownloadRoot() {
  const tempDir = process.env.TEMP || process.env.TMP || '';
  if (tempDir.includes('~')) {
    return path.join(path.resolve(tempDir, '..', '..', '..'), '.cache', 'gigaam');
  }

  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, '.cache', 'gigaam');
  }

  return '';
}

function publicConfig() {
  const config = cameraConfig();
  return {
    host: config.host,
    scheme: config.scheme,
    httpPort: config.httpPort,
    rtspPort: config.rtspPort,
    user: config.user,
    hasPassword: Boolean(config.password),
    vendor: config.vendor,
    hasRtspTemplate: Boolean(config.rtspTemplate),
    hikvisionTimeMode: config.hikvisionTimeMode,
    audioFilter: config.audioFilter,
    xmAudioCodec: config.xmAudioCodec,
    transcription: {
      model: config.gigaamModel,
      device: config.gigaamDevice,
      chunkSeconds: config.transcriptionChunkSeconds,
      liveSeconds: config.transcriptionLiveSeconds,
      captureChunkSeconds: archiveCaptureChunkSeconds(config),
      recordingConcurrency: config.transcriptionRecordingConcurrency,
      xmProgressive: config.transcriptionXmProgressive,
      archiveMaxSeconds: config.transcriptionArchiveMaxSeconds
    },
    openAi: {
      hasApiKey: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
      proxyEnabled: Boolean(process.env.OPENAI_PROXY_URL?.trim())
    },
    reports: publicEmailConfig(),
    drive: publicGoogleDriveConfig(),
    database: publicDatabaseConfig(),
    scheduler: publicActionSchedulerConfig()
  };
}

function publicEmailConfig() {
  const config = emailConfig();
  return {
    smtpConfigured: Boolean(config.host && config.from),
    host: config.host || '',
    port: config.port,
    secure: config.secure,
    from: config.from || '',
    hasUser: Boolean(config.user)
  };
}

function publicActionSchedulerConfig() {
  return {
    enabled: ACTION_SCHEDULER_ENABLED && databaseConfig().enabled,
    intervalSeconds: Math.round(ACTION_SCHEDULER_INTERVAL_MS / 1000)
  };
}

function emailConfig() {
  const secure = booleanFromEnv('REPORT_SMTP_SECURE', false);
  return {
    host: process.env.REPORT_SMTP_HOST || process.env.SMTP_HOST || '',
    port: numberFromEnv('REPORT_SMTP_PORT', numberFromEnv('SMTP_PORT', secure ? 465 : 587)),
    secure,
    startTls: booleanFromEnv('REPORT_SMTP_STARTTLS', !secure),
    rejectUnauthorized: booleanFromEnv('REPORT_SMTP_REJECT_UNAUTHORIZED', true),
    timeoutMs: numberFromEnv('REPORT_SMTP_TIMEOUT_MS', 30000),
    retries: Math.max(1, numberFromEnv('REPORT_SMTP_RETRIES', 2)),
    retryDelayMs: Math.max(0, numberFromEnv('REPORT_SMTP_RETRY_DELAY_MS', 1500)),
    fallback587: booleanFromEnv('REPORT_SMTP_FALLBACK_587', true),
    user: process.env.REPORT_SMTP_USER || process.env.SMTP_USER || '',
    password: process.env.REPORT_SMTP_PASSWORD || process.env.SMTP_PASSWORD || '',
    from: process.env.REPORT_SMTP_FROM || process.env.SMTP_FROM || '',
    ehloName: process.env.REPORT_SMTP_EHLO || 'camera-audio-listener'
  };
}

function publicDatabaseConfig() {
  const config = databaseConfig();
  return {
    enabled: config.enabled,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    hasPassword: Boolean(config.password)
  };
}

function databaseConfig() {
  const url = process.env.DATABASE_URL || '';
  const parsed = url ? new URL(url) : null;
  return {
    enabled: (process.env.POSTGRES_ENABLED || 'true').toLowerCase() !== 'false',
    host: process.env.PGHOST || process.env.POSTGRES_HOST || parsed?.hostname || '127.0.0.1',
    port: numberFromEnv('PGPORT', Number(parsed?.port) || numberFromEnv('POSTGRES_PORT', 5432)),
    user: process.env.PGUSER || process.env.POSTGRES_USER || decodeURIComponent(parsed?.username || '') || 'postgres',
    password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || decodeURIComponent(parsed?.password || ''),
    database: process.env.PGDATABASE || process.env.POSTGRES_DATABASE || parsed?.pathname?.slice(1) || 'camera_audio_listener',
    maintenanceDatabase: process.env.POSTGRES_MAINTENANCE_DATABASE || 'postgres'
  };
}

async function databasePool() {
  const config = databaseConfig();
  if (!config.enabled) {
    throw httpError(503, 'PostgreSQL storage is disabled.');
  }

  if (!databasePoolPromise) {
    databasePoolPromise = createDatabasePool(config).catch(error => {
      databasePoolPromise = null;
      throw error;
    });
  }
  return databasePoolPromise;
}

async function createDatabasePool(config) {
  await ensureDatabaseExists(config);
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: numberFromEnv('POSTGRES_POOL_SIZE', 10),
    idleTimeoutMillis: 30000
  });
  await initDatabase(pool);
  return pool;
}

async function ensureDatabaseExists(config) {
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.maintenanceDatabase
  });

  await client.connect();
  try {
    const result = await client.query('select 1 from pg_database where datname = $1', [config.database]);
    if (!result.rowCount) {
      await client.query(`create database ${quoteIdentifier(config.database)}`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

async function initDatabase(pool) {
  await pool.query(`
    create table if not exists app_settings (
      key text primary key,
      value jsonb not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists channel_labels (
      channel smallint primary key check (channel between 1 and 16),
      label text not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists openai_groups (
      id text primary key,
      name text not null,
      channels jsonb not null,
      from_value text not null,
      to_value text not null,
      time_zone text not null default 'Europe/Moscow',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists openai_actions (
      id text primary key,
      name text not null,
      group_ids jsonb not null,
      question text not null,
      destination text not null default 'email',
      period_mode text not null default 'daily',
      day_preset text not null default 'today',
      custom_date text not null default '',
      report_daily boolean not null default false,
      report_weekly boolean not null default false,
      run_on_weekends boolean not null default true,
      last_run jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists openai_action_runs (
      id bigserial primary key,
      action_id text not null,
      action_name text not null default '',
      status text not null,
      model text not null default '',
      response_id text not null default '',
      answer text not null default '',
      error text not null default '',
      transcript_lines integer not null default 0,
      selections integer not null default 0,
      started_at timestamptz,
      finished_at timestamptz not null default now(),
      details jsonb not null default '{}'::jsonb
    );

    create table if not exists transcript_blocks (
      id bigserial primary key,
      cache_key text unique,
      mode text not null,
      vendor text not null default '',
      channel integer not null,
      stream text not null default '',
      from_value text not null default '',
      to_value text not null default '',
      offset_seconds numeric not null default 0,
      duration_seconds numeric not null default 0,
      audio_filter text not null default '',
      model text not null default '',
      text text not null default '',
      segments jsonb not null default '[]'::jsonb,
      payload jsonb not null,
      took_ms integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index if not exists transcript_blocks_channel_range_idx
      on transcript_blocks (channel, from_value, to_value, offset_seconds);

    alter table openai_actions
      add column if not exists report_daily boolean not null default false;

    alter table openai_actions
      add column if not exists report_weekly boolean not null default false;

    alter table openai_actions
      add column if not exists run_on_weekends boolean not null default true;

    alter table openai_actions
      add column if not exists destination text not null default 'email';

    alter table openai_groups
      add column if not exists time_zone text not null default 'Europe/Moscow';
  `);

  await pool.query(
    `insert into app_settings (key, value, updated_at)
     values ('schema_version', $1::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify(DATABASE_SCHEMA_VERSION)]
  );
}

async function dbQuery(sql, params = []) {
  const pool = await databasePool();
  return pool.query(sql, params);
}

async function dbTransaction(callback) {
  const pool = await databasePool();
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await callback(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function storageState(req, res, params) {
  requireMethod(req, 'GET');
  const [actions, groups] = await Promise.all([readOpenAiActions(), readOpenAiGroups()]);
  const transcripts = params.get('transcripts') === '1'
    ? await listTranscriptBlocks(params)
    : [];
  return json(res, 200, {
    ok: true,
    database: publicDatabaseConfig(),
    settings: await readAppSetting('ui_settings'),
    selectedChannel: await readAppSetting('selected_channel'),
    channelLabels: await readChannelLabels(),
    groups,
    actions,
    scheduler: await readPublicActionSchedulerState(actions, groups),
    openAiJobs: [],
    transcripts
  });
}

async function storageMutation(req, res, pathname) {
  requireMethod(req, 'POST');
  const payload = await readJsonBody(req);

  if (pathname === '/api/storage/settings') {
    if (payload.settings && typeof payload.settings === 'object') {
      await writeAppSetting('ui_settings', payload.settings);
    }
    if (payload.selectedChannel !== undefined) {
      await writeAppSetting('selected_channel', positiveInt(String(payload.selectedChannel), 1));
    }
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/storage/channel-labels') {
    await replaceChannelLabels(payload.labels);
    return json(res, 200, { ok: true, channelLabels: await readChannelLabels() });
  }

  if (pathname === '/api/storage/groups') {
    await replaceOpenAiGroups(payload.groups);
    return json(res, 200, { ok: true, groups: await readOpenAiGroups() });
  }

  if (pathname === '/api/storage/actions') {
    await replaceOpenAiActions(payload.actions);
    return json(res, 200, { ok: true, actions: await readOpenAiActions() });
  }

  if (pathname === '/api/storage/action-trigger') {
    return json(res, 202, {
      ok: true,
      ...await triggerScheduledOpenAiAction(payload)
    });
  }

  if (pathname === '/api/storage/action-stop') {
    return json(res, 200, { ok: true, ...await stopScheduledOpenAiAction(payload) });
  }

  if (pathname === '/api/storage/action-run/start') {
    return json(res, 200, {
      ok: true,
      ...await claimManualActionRun(payload)
    });
  }

  if (pathname === '/api/storage/action-run/release') {
    releaseManualActionRun(payload);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/storage/action-run') {
    try {
      await insertOpenAiActionRun(payload);
      await reconcileManualActionRun(payload).catch(error => {
        console.warn(`Could not reconcile manual action run with scheduler: ${publicError(error)}`);
      });
    } finally {
      releaseManualActionRun(payload);
    }
    return json(res, 200, { ok: true });
  }

  throw httpError(404, 'Unknown storage route.');
}

async function readAppSetting(key) {
  const result = await dbQuery('select value from app_settings where key = $1', [key]);
  return result.rows[0]?.value ?? null;
}

async function writeAppSetting(key, value) {
  await dbQuery(
    `insert into app_settings (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

async function readChannelLabels() {
  const result = await dbQuery('select channel, label from channel_labels order by channel');
  return result.rows.map(row => ({ channel: Number(row.channel), label: row.label }));
}

async function replaceChannelLabels(labels) {
  const normalized = Array.isArray(labels) ? labels.slice(0, 16) : [];
  await dbTransaction(async client => {
    for (let index = 0; index < 16; index += 1) {
      const channel = index + 1;
      const label = String(normalized[index] || `Канал ${channel}`).trim() || `Канал ${channel}`;
      await client.query(
        `insert into channel_labels (channel, label, updated_at)
         values ($1, $2, now())
         on conflict (channel) do update set label = excluded.label, updated_at = now()`,
        [channel, label]
      );
    }
  });
}

async function readOpenAiGroups() {
  const result = await dbQuery(`
    select id, name, channels, from_value, to_value, time_zone, created_at, updated_at
    from openai_groups
    order by created_at, name
  `);
  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    channels: Array.isArray(row.channels) ? row.channels : [],
    from: row.from_value,
    to: row.to_value,
    timeZone: normalizeTimeZone(row.time_zone, 'Europe/Moscow'),
    createdAt: row.created_at?.toISOString?.() || '',
    updatedAt: row.updated_at?.toISOString?.() || ''
  }));
}

async function replaceOpenAiGroups(groups) {
  const normalized = Array.isArray(groups) ? groups.map(normalizeStoredGroup).filter(Boolean) : [];
  await dbTransaction(async client => {
    const ids = normalized.map(group => group.id);
    if (ids.length) {
      await client.query('delete from openai_groups where not (id = any($1::text[]))', [ids]);
    } else {
      await client.query('delete from openai_groups');
    }

    for (const group of normalized) {
      await client.query(
        `insert into openai_groups (id, name, channels, from_value, to_value, time_zone, created_at, updated_at)
         values ($1, $2, $3::jsonb, $4, $5, $6, coalesce($7::timestamptz, now()), now())
         on conflict (id) do update
         set name = excluded.name,
             channels = excluded.channels,
             from_value = excluded.from_value,
             to_value = excluded.to_value,
             time_zone = excluded.time_zone,
             updated_at = now()`,
        [group.id, group.name, JSON.stringify(group.channels), group.from, group.to, group.timeZone, nullableTimestamp(group.createdAt)]
      );
    }
  });
}

function normalizeStoredGroup(group) {
  if (!group || typeof group !== 'object') return null;
  const channels = normalizeChannelArray(group.channels);
  const from = String(group.from || '').trim();
  const to = String(group.to || '').trim();
  if (!group.id || !channels.length || !from || !to) return null;
  return {
    id: String(group.id),
    name: String(group.name || 'Группа').trim() || 'Группа',
    channels,
    from,
    to,
    timeZone: normalizeTimeZone(group.timeZone, 'Europe/Moscow'),
    createdAt: group.createdAt || ''
  };
}

async function readOpenAiActions() {
  const result = await dbQuery(`
    select id, name, group_ids, question, destination, period_mode, day_preset, custom_date,
           report_daily, report_weekly, run_on_weekends, last_run, created_at, updated_at
    from openai_actions
    order by created_at, name
  `);
  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    groupIds: Array.isArray(row.group_ids) ? row.group_ids : [],
    question: row.question,
    destination: row.destination === 'drive' ? 'drive' : 'email',
    periodMode: row.period_mode,
    dayPreset: row.day_preset,
    customDate: row.custom_date,
    reportDaily: Boolean(row.report_daily),
    reportWeekly: Boolean(row.report_weekly),
    runOnWeekends: Boolean(row.run_on_weekends),
    lastRun: row.last_run || null,
    createdAt: row.created_at?.toISOString?.() || '',
    updatedAt: row.updated_at?.toISOString?.() || ''
  }));
}

async function replaceOpenAiActions(actions) {
  const normalized = Array.isArray(actions) ? actions.map(normalizeStoredAction).filter(Boolean) : [];
  assertScheduledActionsEditable(normalized);
  await dbTransaction(async client => {
    const ids = normalized.map(action => action.id);
    if (ids.length) {
      await client.query('delete from openai_actions where not (id = any($1::text[]))', [ids]);
    } else {
      await client.query('delete from openai_actions');
    }

    for (const action of normalized) {
      await client.query(
        `insert into openai_actions (id, name, group_ids, question, destination, period_mode, day_preset, custom_date,
                                     report_daily, report_weekly, run_on_weekends, last_run, created_at, updated_at)
         values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, coalesce($13::timestamptz, now()), now())
         on conflict (id) do update
         set name = excluded.name,
             group_ids = excluded.group_ids,
             question = excluded.question,
             destination = excluded.destination,
             period_mode = excluded.period_mode,
             day_preset = excluded.day_preset,
             custom_date = excluded.custom_date,
             report_daily = excluded.report_daily,
             report_weekly = excluded.report_weekly,
             run_on_weekends = excluded.run_on_weekends,
             updated_at = now()`,
        [
          action.id,
          action.name,
          JSON.stringify(action.groupIds),
          action.question,
          action.destination,
          action.periodMode,
          action.dayPreset,
          action.customDate,
          action.reportDaily,
          action.reportWeekly,
          action.runOnWeekends,
          action.lastRun ? JSON.stringify(action.lastRun) : null,
          nullableTimestamp(action.createdAt)
        ]
      );
    }
  });
}

function normalizeStoredAction(action) {
  if (!action || typeof action !== 'object') return null;
  const groupIds = Array.isArray(action.groupIds)
    ? action.groupIds.map(id => String(id)).filter(Boolean)
    : [];
  const question = String(action.question || '').trim();
  const destination = action.destination === 'drive' ? 'drive' : 'email';
  if (!action.id || !groupIds.length || (destination === 'email' && !question)) return null;
  const periodMode = ['daily', 'weekly', 'once'].includes(action.periodMode) ? action.periodMode : 'daily';
  return {
    id: String(action.id),
    name: String(action.name || question).trim() || 'Действие',
    groupIds,
    question,
    destination,
    periodMode,
    dayPreset: String(action.dayPreset || 'today'),
    customDate: String(action.customDate || ''),
    reportDaily: destination === 'email' && Boolean(action.reportDaily) && periodMode !== 'once',
    reportWeekly: destination === 'email' && Boolean(action.reportWeekly) && periodMode !== 'once',
    runOnWeekends: periodMode !== 'once' && (action.runOnWeekends === undefined ? true : Boolean(action.runOnWeekends)),
    lastRun: action.lastRun && typeof action.lastRun === 'object' ? action.lastRun : null,
    createdAt: action.createdAt || ''
  };
}

async function insertOpenAiActionRun(run) {
  if (!run || typeof run !== 'object') return;
  const details = run.details && typeof run.details === 'object' ? run.details : run;
  await dbQuery(
    `insert into openai_action_runs
       (action_id, action_name, status, model, response_id, answer, error, transcript_lines, selections, started_at, finished_at, details)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::timestamptz, now()), coalesce($11::timestamptz, now()), $12::jsonb)`,
    [
      String(run.actionId || run.id || ''),
      String(run.actionName || run.name || ''),
      String(run.status || ''),
      String(run.model || ''),
      String(run.responseId || ''),
      String(run.answer || ''),
      String(run.error || ''),
      Number.isFinite(Number(run.transcriptLines)) ? Number(run.transcriptLines) : 0,
      Number.isFinite(Number(run.selections)) ? Number(run.selections) : 0,
      nullableTimestamp(run.startedAt),
      nullableTimestamp(run.finishedAt),
      JSON.stringify(details)
    ]
  );
}

async function claimManualActionRun(run) {
  const candidate = await resolveManualActionCandidate(run);
  if (candidate) {
    throw httpError(409, 'Плановое действие запускается на сервере в фоне. Обновите страницу и нажмите «Запустить» ещё раз.');
  }
  const actionId = String(run?.actionId || candidate?.action?.id || '').trim();
  const runKey = candidate?.runKey || `manual:${crypto.randomUUID()}`;
  if (!actionId) throw httpError(400, 'Action id is required.');

  const activeKey = `${actionId}:${runKey}`;
  if (activeScheduledActions.has(activeKey)) {
    throw httpError(409, 'Этот период уже выполняется в фоне. Дождитесь завершения или остановите фоновый процесс.');
  }
  if (manualActionClaim(activeKey)) {
    throw httpError(409, 'Этот период уже запущен вручную.');
  }

  let reconcileEligible = false;
  if (candidate) {
    const schedulerState = await readActionSchedulerState();
    const modeState = schedulerState.actions?.[actionId]?.[candidate.periodMode];
    const candidateState = scheduledCandidateState(modeState, runKey);
    const stateIsTerminal = candidateState?.status === 'success' || candidateState?.status === 'delivery_uncertain';
    const hasPendingAttempt = Boolean(candidateState && !stateIsTerminal);
    const settings = await readAppSetting('ui_settings').catch(() => ({}));
    const isDueNow = scheduledActionCandidates(
      candidate.action,
      new Map(candidate.groups.map(group => [group.id, group])),
      new Date(),
      { settings }
    ).some(item => item.runKey === runKey);
    reconcileEligible = hasPendingAttempt || (!candidateState && isDueNow);
  }

  const deliveryKey = reconcileEligible
    ? `${actionId}:${runKey}`
    : `${actionId}:manual:${crypto.randomUUID()}`;
  if (activeScheduledActions.has(activeKey)) {
    throw httpError(409, 'Этот период уже выполняется в фоне. Дождитесь завершения или остановите фоновый процесс.');
  }
  if (manualActionClaim(activeKey)) {
    throw httpError(409, 'Этот период уже запущен вручную.');
  }
  activeManualActions.set(activeKey, {
    candidate,
    deliveryKey,
    reconcileEligible,
    expiresAt: Date.now() + MANUAL_ACTION_CLAIM_TTL_MS
  });

  return { runKey, deliveryKey, reconcileEligible };
}

function releaseManualActionRun(run) {
  const actionId = String(run?.actionId || '').trim();
  const runKey = String(run?.runKey || '').trim();
  if (!actionId || !runKey) return;
  activeManualActions.delete(`${actionId}:${runKey}`);
}

function manualActionClaim(activeKey) {
  const claim = activeManualActions.get(activeKey);
  if (!claim) return null;
  if (Number(claim.expiresAt) <= Date.now()) {
    activeManualActions.delete(activeKey);
    return null;
  }
  return claim;
}

async function resolveManualActionCandidate(run) {
  const actionId = String(run?.actionId || '').trim();
  const from = String(run?.from || '').trim();
  const to = String(run?.to || '').trim();
  const requestedPeriodMode = String(run?.periodMode || '').trim();
  const fromMs = localDateTimeMs(from);
  const toMs = localDateTimeMs(to);
  if (!actionId || !from || !to || !fromMs || !toMs || toMs <= fromMs) {
    return null;
  }

  const actions = await readOpenAiActions();
  const action = actions.find(item => item.id === actionId);
  if (!action || action.periodMode === 'once') return null;

  const periodMode = requestedPeriodMode || action.periodMode;
  if (periodMode !== 'daily' && periodMode !== 'weekly') return null;
  const groupMap = new Map((await readOpenAiGroups()).map(group => [group.id, group]));
  const groups = (action.groupIds || []).map(groupId => groupMap.get(groupId)).filter(Boolean);
  if (!groups.length) return null;

  const configHash = scheduledActionConfigHash(action, groups, periodMode);
  return {
    action,
    groups,
    selections: [],
    periodMode,
    from,
    to,
    dueAt: run?.startedAt || new Date().toISOString(),
    runKey: `${periodMode}:${from}:${to}:${configHash}`,
    configHash
  };
}

async function reconcileManualActionRun(run) {
  const details = run?.details && typeof run.details === 'object' ? run.details : run;
  if (
    !run
    || (run.status !== 'success' && run.status !== 'delivery_uncertain')
    || run.scheduled === true
    || details?.scheduled === true
  ) {
    return;
  }

  const actionId = String(run.actionId || run.id || '').trim();
  const suppliedRunKey = String(run.runKey || details?.runKey || '').trim();
  const activeKey = actionId && suppliedRunKey ? `${actionId}:${suppliedRunKey}` : '';
  const claim = activeKey ? manualActionClaim(activeKey) : null;
  const candidate = claim?.candidate || await resolveManualActionCandidate({
    ...run,
    from: run.from || details?.from,
    to: run.to || details?.to,
    periodMode: run.periodMode || details?.periodMode || details?.action?.periodMode
  });
  if (!candidate || (suppliedRunKey && suppliedRunKey !== candidate.runKey)) return;

  await mutateActionSchedulerState(state => {
    const modeState = state.actions?.[candidate.action.id]?.[candidate.periodMode];
    const candidateState = scheduledCandidateState(modeState, candidate.runKey, candidate);
    const stateIsTerminal = candidateState?.status === 'success' || candidateState?.status === 'delivery_uncertain';
    const hasPendingAttempt = Boolean(candidateState && !stateIsTerminal);
    if (!claim?.reconcileEligible && !hasPendingAttempt) return false;

    markActionSchedulerState(state, candidate, {
      ...run,
      status: run.status,
      runKey: candidate.runKey,
      scheduled: false
    });
    return true;
  });
}

async function updateOpenAiActionLastRun(actionId, lastRun) {
  if (!actionId || !lastRun || typeof lastRun !== 'object') return;
  await dbQuery(
    `update openai_actions
        set last_run = $2::jsonb
      where id = $1`,
    [String(actionId), JSON.stringify(lastRun)]
  );
}

function startActionScheduler() {
  if (!ACTION_SCHEDULER_ENABLED) {
    console.log('OpenAI action scheduler: disabled');
    return;
  }
  if (actionSchedulerTimer || !databaseConfig().enabled) return;

  const intervalSeconds = Math.round(ACTION_SCHEDULER_INTERVAL_MS / 1000);
  console.log(`OpenAI action scheduler: every ${intervalSeconds}s`);

  const tick = () => {
    runDriveDeliveryTick().catch(error => console.warn(`Drive outbox: ${publicError(error)}`));
    runActionSchedulerTick().catch(error => {
      console.warn(`OpenAI action scheduler failed: ${publicError(error)}`);
    });
  };
  const firstRunTimer = setTimeout(tick, 2000);
  firstRunTimer.unref?.();

  actionSchedulerTimer = setInterval(tick, ACTION_SCHEDULER_INTERVAL_MS);
  actionSchedulerTimer.unref?.();
}

function getDriveDeliveryOutbox() {
  return driveDeliveryOutbox ||= createDeliveryOutbox({ directory: path.join(RUNTIME_DIR, 'drive-outbox') });
}

function driveDeliveryScope(candidate) {
  const config = readGoogleDriveConfig();
  return JSON.stringify([config.rootFolderId, config.clientEmail || config.clientId,
    candidate.action.id, candidate.runKey]);
}

function durableDeliveryCandidate(candidate) {
  const { lastRun, ...action } = candidate.action;
  return { ...serializeScheduledCandidate(candidate), action, groups: candidate.groups || [] };
}

function deliverySettings(settings = {}) {
  return Object.fromEntries(['displayTimeZone', 'cameraTimeZone', 'vendor', 'stream', 'audioFilter', 'transcriptSeconds']
    .filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
}

function getDriveDeliveryWorker() {
  if (!driveDeliveryWorker) driveDeliveryWorker = createDriveDeliveryWorker({
    outbox: getDriveDeliveryOutbox(),
    canDeliver: async item => {
      if (!item.payload || item.scope !== driveDeliveryScope(item.payload.candidate)) return false;
      const [actions, state] = await Promise.all([readOpenAiActions(), readActionSchedulerState()]);
      const action = actions.find(value => value.id === item.actionId);
      if (!action || action.destination !== 'drive') return false;
      const candidate = item.payload.candidate;
      return scheduledCandidateState(state.actions?.[action.id]?.[candidate.periodMode], item.runKey)?.status !== 'stopped';
    },
    deliver: async (item, signal) => {
      assertDriveTranscriptComplete(item.payload.transcript);
      const files = item.payload.files;
      if (!Array.isArray(files) || files.length !== 1 || files[0].completeness !== 'complete'
        || Number(files[0].channel) !== Number(item.channel)) {
        throw Object.assign(new Error('Local complete TXT proof is missing'), { code: 'OUTBOX_INCOMPLETE_PAYLOAD' });
      }
      return getGoogleDriveClient().uploadCameraTranscripts({
        action: item.payload.candidate.action, runKey: item.runKey, files, signal
      });
    }
  });
  return driveDeliveryWorker;
}

async function runDriveDeliveryTick() {
  if (!ACTION_SCHEDULER_ENABLED || !databaseConfig().enabled) return;
  await getDriveDeliveryWorker().flush();
  const [actions, state, records] = await Promise.all([
    readOpenAiActions(), readActionSchedulerState(), getDriveDeliveryOutbox().list()
  ]);
  for (const action of actions) {
    if (action.lastRun && ['error', 'incomplete', 'delivery_pending'].includes(action.lastRun.status)) {
      const scoped = records.filter(item => item.scope === driveDeliveryScope({ action, runKey: action.lastRun.runKey }));
      if (scoped.length) {
        const uploads = new Map((action.lastRun.uploads || []).map(item => [Number(item.channel), item]));
        for (const item of scoped.filter(value => value.status === 'delivered')) uploads.set(Number(item.channel), item.upload);
        const queuedCameras = scoped.filter(item => item.status === 'pending').length;
        const updated = { ...action.lastRun, uploads: [...uploads.values()], queuedCameras,
          deliveryError: scoped.find(item => item.status === 'pending' && item.lastError)?.lastError || '',
          progress: { ...action.lastRun.progress, readyCameras: scoped.filter(item => item.payload?.files?.length).length, queuedCameras,
            uploadedCameras: scoped.filter(item => item.status === 'delivered').length } };
        await dbQuery('update openai_actions set last_run=$2::jsonb where id=$1 and last_run=$3::jsonb',
          [action.id, JSON.stringify(updated), JSON.stringify(action.lastRun)]);
      }
    }
    for (const mode of ['daily', 'weekly', 'once']) {
      for (const pending of scheduledPendingStates(state.actions?.[action.id]?.[mode])) {
        if (pending.status !== 'delivery_pending') continue;
        const ready = records.filter(item => item.actionId === action.id && item.runKey === pending.runKey);
        const candidate = ready.find(item => item.payload?.runCandidate)?.payload.runCandidate;
        if (!candidate) continue;
        const scope = driveDeliveryScope(candidate);
        const delivered = ready.filter(item => item.scope === scope && item.status === 'delivered');
        if (!candidate.selections.every(selection => delivered.some(item => Number(item.channel) === Number(selection.channel)))) continue;
        // Never replace the visible status of a newer/running period with an old
        // delivery completion, but always close that period in scheduler history.
        const run = { ...(action.lastRun?.runKey === pending.runKey ? action.lastRun : pending),
          status: 'success', stage: 'done', error: '', scheduled: true,
          at: new Date().toISOString(), finishedAt: new Date().toISOString(),
          uploads: delivered.map(item => item.upload), queuedCameras: 0, processingComplete: true, deliveryError: '',
          progress: { ...action.lastRun?.progress, stage: 'done', percent: 100,
            queuedCameras: 0, uploadedCameras: delivered.length,
            readyCameras: delivered.filter(item => item.payload?.files?.length).length, deliveryError: '' } };
        const reconciled = await mutateActionSchedulerState(latest => {
          const current = scheduledCandidateState(latest.actions?.[action.id]?.[mode], pending.runKey);
          if (current?.status !== 'delivery_pending') return false;
          markActionSchedulerState(latest, candidate, run);
        });
        if (reconciled === false) continue;
        await dbQuery(`update openai_actions set last_run=$2::jsonb
          where id=$1 and last_run->>'runKey'=$3 and last_run->>'status'='delivery_pending'`,
        [action.id, JSON.stringify(run), pending.runKey]);
      }
    }
  }
}

async function boundedDriveLookup(find, candidate, context, timeoutMs = 2000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal?.addEventListener('abort', abort, { once: true });
  let timer;
  try {
    return await Promise.race([
      find(candidate, { ...context, signal: controller.signal }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error('Drive lookup deferred'));
      }, timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener('abort', abort);
  }
}

async function runActionSchedulerTick() {
  if (actionSchedulerRunning) return;
  actionSchedulerRunning = true;

  try {
    const [schedulerState, settings, labels, groups, actions] = await Promise.all([
      readActionSchedulerState(),
      readAppSetting('ui_settings').catch(() => ({})),
      readChannelLabels().catch(() => []),
      readOpenAiGroups(),
      readOpenAiActions()
    ]);
    const groupMap = new Map(groups.map(group => [group.id, group]));
    const now = new Date();

    for (const action of actions) {
      const actionState = schedulerState.actions?.[action.id];
      const candidates = uniqueScheduledCandidates([
        ...(scheduledActionRuntime.get(action.id)?.status === 'queued' ? [scheduledActionRuntime.get(action.id).candidate] : []),
        ...scheduledActionCandidates(action, groupMap, now, { settings }),
        ...scheduledRetryCandidates(action, groupMap, actionState, now, { settings })
      ]);
      for (const candidate of candidates) {
        const queued = scheduledActionRuntime.get(action.id);
        const explicitlyQueued = queued?.status === 'queued' && queued.candidate.runKey === candidate.runKey;
        if (!explicitlyQueued && actionLastRunMatchesCandidate(action.lastRun, candidate)) continue;
        const liveSchedulerState = await readActionSchedulerState();
        const modeState = liveSchedulerState.actions?.[action.id]?.[candidate.periodMode];
        const candidateState = scheduledCandidateState(modeState, candidate.runKey, candidate);
        if (!shouldRunScheduledCandidate(candidateState, candidate, new Date())) continue;

        const activeKey = `${action.id}:${candidate.runKey}`;
        if (activeScheduledActions.has(activeKey)) continue;
        if (manualActionClaim(activeKey)) continue;

        const runtime = scheduledActionRuntime.get(action.id) || { candidate, controller: new AbortController() };
        if (runtime.controller.signal.aborted) continue;
        runtime.status = 'running';
        runtime.candidate = candidate;
        scheduledActionRuntime.set(action.id, runtime);
        activeScheduledActions.add(activeKey);
        let lastRun;
        try {
          lastRun = await runScheduledOpenAiAction(candidate, {
            settings,
            labels,
            previousState: candidateState,
            signal: runtime.controller.signal,
            runtime
          });
        } catch (error) {
          lastRun = await persistScheduledActionFailure(candidate, error, { signal: runtime.controller.signal });
        } finally {
          activeScheduledActions.delete(activeKey);
        }

        try {
          await mutateActionSchedulerState(state => markActionSchedulerState(state, candidate, lastRun));
        } finally {
          scheduledActionRuntime.delete(action.id);
        }
        if (lastRun.status === 'stopped') break;
      }
    }
  } finally {
    actionSchedulerRunning = false;
  }
}

async function triggerScheduledOpenAiAction(payload) {
  const actionId = String(payload?.actionId || '').trim();
  if (!actionId) throw httpError(400, 'Action id is required.');
  const existing = scheduledActionRuntime.get(actionId);
  if (existing) return { status: existing.status, runKey: existing.candidate.runKey, message: 'Действие уже в фоновой очереди.' };

  const activePrefix = `${actionId}:`;
  const activeRunKey = [...activeScheduledActions].find(key => key.startsWith(activePrefix));
  if (activeRunKey) {
    return {
      status: 'running',
      message: 'Действие уже выполняется в фоне.',
      runKey: activeRunKey.slice(activePrefix.length)
    };
  }
  if ([...activeManualActions.keys()].some(key => key.startsWith(activePrefix) && manualActionClaim(key))) {
    throw httpError(409, 'Действие уже выполняется вручную.');
  }

  const [actions, groups, schedulerState, settings] = await Promise.all([
    readOpenAiActions(),
    readOpenAiGroups(),
    readActionSchedulerState(),
    readAppSetting('ui_settings').catch(() => ({}))
  ]);
  const action = actions.find(item => item.id === actionId);
  if (!action) throw httpError(404, 'Действие не найдено.');
  if (action.periodMode === 'once' && action.destination !== 'drive') {
    throw httpError(409, 'Одноразовые действия запускаются в открытой странице.');
  }

  const groupMap = new Map(groups.map(group => [group.id, group]));
  const actionState = schedulerState.actions?.[action.id];
  const now = new Date();
  const actionGroups = (action.groupIds || []).map(groupId => groupMap.get(groupId)).filter(Boolean);
  const stoppedCandidate = restoreExplicitStoppedCandidate(action, actionGroups, settings);
  const candidates = uniqueScheduledCandidates([
    ...(action.periodMode === 'once' ? [oneTimeDriveCandidate(action, actionGroups, settings, now)] : []),
    ...(stoppedCandidate ? [stoppedCandidate] : []),
    ...scheduledRetryCandidates(action, groupMap, actionState, now, { ignoreMaxAge: true, settings }),
    ...scheduledActionCandidates(action, groupMap, now, { settings })
  ]);
  const preferredRunKey = String(action.lastRun?.runKey || '');
  const runnableCandidates = candidates.filter(item => {
      if (!['stopped', 'incomplete'].includes(action.lastRun?.status) && actionLastRunMatchesCandidate(action.lastRun, item)) return false;
      const modeState = actionState?.[item.periodMode];
      const itemState = scheduledCandidateState(modeState, item.runKey, item);
      return !itemState || (itemState.status !== 'success' && itemState.status !== 'delivery_uncertain');
    });
  const candidate = runnableCandidates.find(item => {
    const modeState = actionState?.[item.periodMode];
    const itemState = scheduledCandidateState(modeState, item.runKey, item);
    return itemState && itemState.status !== 'success' && itemState.status !== 'delivery_uncertain';
  }) || runnableCandidates.find(item => item.runKey === preferredRunKey)
    || runnableCandidates[0];
  if (!candidate) {
    throw httpError(409, 'Сейчас нет завершённого периода или ошибки, которую можно запустить повторно.');
  }

  const candidateState = scheduledCandidateState(actionState?.[candidate.periodMode], candidate.runKey, candidate);
  if (candidateState?.status === 'delivery_pending') {
    const outbox = getDriveDeliveryOutbox();
    for (const item of await outbox.list(driveDeliveryScope(candidate))) {
      if (item.status === 'pending') await outbox.retryNow(item.id);
    }
    runDriveDeliveryTick().catch(error => console.warn(`Drive delivery retry: ${publicError(error)}`));
    return { status: 'delivery_pending', runKey: candidate.runKey,
      message: 'Повтор отправки поставлен в очередь. Повторная транскрибация не требуется.' };
  }

  // Reserve before awaiting storage so simultaneous clicks cannot queue two runs.
  if (scheduledActionRuntime.has(actionId)) return { status: scheduledActionRuntime.get(actionId).status };
  scheduledActionRuntime.set(actionId, { candidate, status: 'queued', controller: new AbortController() });
  try {
    await mutateActionSchedulerState(state => forceScheduledCandidateRetry(state, candidate, now));
  } catch (error) {
    scheduledActionRuntime.delete(actionId);
    throw error;
  }
  const timer = setTimeout(() => {
    runActionSchedulerTick().catch(error => {
      console.warn(`Manual scheduler trigger failed: ${publicError(error)}`);
    });
  }, 0);
  timer.unref?.();

  return {
    status: 'queued',
    message: 'Действие поставлено в фоновую очередь.',
    runKey: candidate.runKey,
    from: candidate.from,
    to: candidate.to
  };
}

function forceScheduledCandidateRetry(state, candidate, now = new Date()) {
  const actionState = state.actions?.[candidate.action.id];
  const modeState = actionState?.[candidate.periodMode];
  if (!modeState || typeof modeState !== 'object' || ['stopped', 'incomplete'].includes(scheduledCandidateState(modeState, candidate.runKey)?.status)) {
    markActionSchedulerState(state, candidate, { status: 'queued', at: now.toISOString() }, now);
    const next = state.actions[candidate.action.id][candidate.periodMode];
    next.nextRetryAt = now.toISOString();
    next.firstAttemptAt = now.toISOString();
    next.attempts = 0;
    next.availabilityAttempts = 0;
    next.availabilityFingerprint = '';
    next.incompleteAudioAttempts = 0;
    next.incompleteAudioFingerprint = '';
    next.incompleteAudioCheckpoint = null;
    next.noProgressAttempts = 0;
    next.noProgressCheckpoint = null;
    next.pending.forEach(item => { if (item.runKey === candidate.runKey) Object.assign(item, {
      nextRetryAt: now.toISOString(), firstAttemptAt: now.toISOString(), attempts: 0,
      availabilityAttempts: 0, availabilityFingerprint: '',
      incompleteAudioAttempts: 0, incompleteAudioFingerprint: '', incompleteAudioCheckpoint: null,
      noProgressAttempts: 0, noProgressCheckpoint: null
    }); });
    return;
  }
  const retryAt = now.toISOString();
  const pending = scheduledPendingStates(modeState).map(item => item.runKey === candidate.runKey
    ? { ...item, attempts: 0, availabilityAttempts: 0, availabilityFingerprint: '',
      incompleteAudioAttempts: 0, incompleteAudioFingerprint: '', incompleteAudioCheckpoint: null,
      noProgressAttempts: 0, noProgressCheckpoint: null,
      firstAttemptAt: retryAt, nextRetryAt: retryAt }
    : item);
  const nextModeState = modeState.runKey === candidate.runKey
    ? { ...modeState, attempts: 0, availabilityAttempts: 0, availabilityFingerprint: '',
      incompleteAudioAttempts: 0, incompleteAudioFingerprint: '', incompleteAudioCheckpoint: null,
      noProgressAttempts: 0, noProgressCheckpoint: null,
      firstAttemptAt: retryAt, nextRetryAt: retryAt, pending }
    : { ...modeState, pending };
  state.actions = state.actions && typeof state.actions === 'object' ? state.actions : {};
  state.actions[candidate.action.id] = {
    ...(actionState || {}),
    [candidate.periodMode]: nextModeState
  };
}

function oneTimeDriveCandidate(action, groups, settings = {}, now = new Date()) {
  const selections = groups.flatMap(group => {
    const zone = normalizeTimeZone(group.timeZone, configuredDisplayTimeZone(settings));
    const fromMs = zonedDateTimeToEpochMs(group.from, zone);
    const toMs = zonedDateTimeToEpochMs(group.to, zone);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || toMs > now.getTime()) {
      throw httpError(400, 'Для одноразового действия выберите завершённый период группы.');
    }
    return (group.channels || []).map(channel => ({ groupId: group.id, groupName: group.name,
      channel: Number(channel), from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
      rangeSeconds: (toMs - fromMs) / 1000 }));
  });
  if (!selections.length) throw httpError(400, 'Для действия не выбраны камеры.');
  const from = earliestLocalDateTime(selections.map(item => item.from));
  const to = latestLocalDateTime(selections.map(item => item.to));
  const configHash = scheduledActionConfigHash(action, groups, 'once');
  return { action, groups, selections, from, to, dueAt: now.toISOString(), periodMode: 'once',
    runKey: `once:${from}:${to}:${configHash}`, configHash,
    timeZone: configuredDisplayTimeZone(settings), cameraTimeZone: configuredCameraTimeZone(settings) };
}

async function stopScheduledOpenAiAction(payload, services = {}) {
  const runtimes = services.runtimes || scheduledActionRuntime;
  const actionId = String(payload?.actionId || '');
  const runtime = runtimes.get(actionId);
  if (!runtime) throw httpError(409, 'Действие сейчас не выполняется в фоне.');
  if (runtime.status === 'stopping') return { status: 'stopping' };
  const wasQueued = runtime.status === 'queued';
  runtime.status = 'stopping';
  runtime.controller.abort();
  if (wasQueued) {
    const run = { status: 'stopped', scheduled: true, at: new Date().toISOString(), runKey: runtime.candidate.runKey, stage: 'queued' };
    await (services.persistRun || persistScheduledActionRun)(runtime.candidate, run);
    await (services.mutateScheduler || mutateActionSchedulerState)(state => markActionSchedulerState(state, runtime.candidate, run));
    runtimes.delete(actionId);
    return { status: 'stopped' };
  }
  return { status: 'stopping' };
}

function assertScheduledActionsEditable(actions, runtimes = scheduledActionRuntime) {
  for (const [id, runtime] of runtimes) {
    const next = actions.find(action => action.id === id);
    const definition = action => {
      const { lastRun, createdAt, ...fields } = normalizeStoredAction(action);
      return JSON.stringify(fields);
    };
    if (!next || definition(next) !== definition(runtime.candidate.action)) {
      throw httpError(409, 'Сначала остановите фоновое действие, затем изменяйте или удаляйте его.');
    }
  }
}

async function readPublicActionSchedulerState(actions = [], groups = []) {
  const state = await readActionSchedulerState().catch(() => ({ actions: {} }));
  const settings = await readAppSetting('ui_settings').catch(() => ({}));
  const enabled = ACTION_SCHEDULER_ENABLED && databaseConfig().enabled;
  const now = new Date();
  const groupMap = new Map(groups.map(group => [group.id, group]));
  return {
    enabled,
    running: actionSchedulerRunning,
    serverNow: now.toISOString(),
    timeZone: configuredDisplayTimeZone(settings),
    intervalSeconds: Math.round(ACTION_SCHEDULER_INTERVAL_MS / 1000),
    actions: state.actions || {},
    schedules: Object.fromEntries(actions.map(action => {
      const runtime = scheduledActionRuntime.get(action.id);
      const next = enabled && !runtime ? nextScheduledActionRun(action, groupMap, state.actions?.[action.id], now, settings) : null;
      return [action.id, {
        state: runtime?.status || (next && Date.parse(next.nextRunAt) <= now.getTime() ? 'waiting' : 'idle'),
        nextRunAt: next?.nextRunAt || '',
        periodMode: runtime?.candidate.periodMode || next?.periodMode || '',
        run: runtime?.lastRun || null
      }];
    }))
  };
}

function nextScheduledActionRun(action, groupMap, actionState, now = new Date(), settings = {}) {
  if (action.periodMode === 'once') return null;
  const upcoming = [];
  const consider = (candidate, earliest) => {
    if (actionLastRunMatchesCandidate(action.lastRun, candidate)) return;
    const state = scheduledCandidateState(actionState?.[candidate.periodMode], candidate.runKey, candidate);
    const at = Math.max(earliest, Date.parse(state?.nextRetryAt || '') || 0);
    if (!shouldRunScheduledCandidate(state, candidate, new Date(at))) return;
    upcoming.push({ nextRunAt: new Date(at).toISOString(), periodMode: candidate.periodMode, runKey: candidate.runKey });
  };
  for (const candidate of scheduledRetryCandidates(action, groupMap, actionState, now, { settings })) consider(candidate, now.getTime());
  for (let day = 0; day <= 14; day += 1) {
    const displayTimeZone = configuredDisplayTimeZone(settings);
    const probeDate = offsetZonedDatePart(zonedDatePart(now, displayTimeZone), day);
    const probe = day === 0 ? now : new Date(zonedDateTimeToEpochMs(`${probeDate}T00:00:00`, displayTimeZone));
    for (const candidate of scheduledActionCandidates(action, groupMap, probe, { includeFuture: true, settings })) {
      const at = Math.max(now.getTime(), probe.getTime(), Date.parse(candidate.dueAt));
      if (scheduledActionCandidates(action, groupMap, new Date(at), { settings }).some(item => item.runKey === candidate.runKey)) consider(candidate, at);
    }
  }
  return upcoming.sort((left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt))[0] || null;
}

async function readActionSchedulerState() {
  const value = await readAppSetting(ACTION_SCHEDULER_STATE_KEY);
  if (!value || typeof value !== 'object') return { actions: {} };
  return {
    ...value,
    actions: value.actions && typeof value.actions === 'object' ? value.actions : {}
  };
}

async function writeActionSchedulerState(state) {
  await writeAppSetting(ACTION_SCHEDULER_STATE_KEY, {
    ...state,
    updatedAt: new Date().toISOString(),
    actions: state.actions && typeof state.actions === 'object' ? state.actions : {}
  });
}

function mutateActionSchedulerState(mutator) {
  const operation = actionSchedulerStateMutation.then(async () => {
    const state = await readActionSchedulerState();
    const result = await mutator(state);
    if (result === false) return false;
    await writeActionSchedulerState(state);
    return result;
  });
  actionSchedulerStateMutation = operation.catch(() => undefined);
  return operation;
}

function markActionSchedulerState(state, candidate, lastRun, now = new Date()) {
  state.actions = state.actions && typeof state.actions === 'object' ? state.actions : {};
  const current = state.actions[candidate.action.id] && typeof state.actions[candidate.action.id] === 'object'
    ? state.actions[candidate.action.id]
    : {};
  const modeState = current[candidate.periodMode] && typeof current[candidate.periodMode] === 'object'
    ? current[candidate.periodMode]
    : {};
  const previous = scheduledCandidateState(modeState, candidate.runKey, candidate) || {};
  const sameRun = previous.runKey === candidate.runKey;
  const attempts = (sameRun ? Math.max(0, Number(previous.attempts) || 0) : 0) + 1;
  const status = lastRun?.status || 'unknown';
  const terminal = isTerminalScheduledStatus(status);
  const finishedAt = lastRun?.finishedAt || lastRun?.at || now.toISOString();
  const finishedAtMs = Date.parse(finishedAt);
  const nextRetryAt = terminal
    ? ''
    : new Date((Number.isFinite(finishedAtMs) ? finishedAtMs : now.getTime()) + scheduledRetryDelayMs(attempts)).toISOString();
  const entry = {
    runKey: candidate.runKey,
    status,
    at: lastRun?.at || new Date().toISOString(),
    from: candidate.from,
    to: candidate.to,
    error: lastRun?.error || '',
    stage: lastRun?.stage || '',
    attempts,
    availabilityAttempts: lastRun?.availabilityAttempts ?? (sameRun && status !== 'success' ? previous.availabilityAttempts || 0 : 0),
    availabilityFingerprint: lastRun?.availabilityFingerprint ?? (sameRun && status !== 'success' ? previous.availabilityFingerprint || '' : ''),
    incompleteAudioAttempts: lastRun?.incompleteAudioAttempts ?? (sameRun && status !== 'success' ? previous.incompleteAudioAttempts || 0 : 0),
    incompleteAudioFingerprint: lastRun?.incompleteAudioFingerprint ?? (sameRun && status !== 'success' ? previous.incompleteAudioFingerprint || '' : ''),
    incompleteAudioCheckpoint: lastRun?.incompleteAudioCheckpoint ?? (sameRun && status !== 'success' ? previous.incompleteAudioCheckpoint || null : null),
    noProgressAttempts: lastRun?.noProgressAttempts ?? (sameRun && status !== 'success' ? previous.noProgressAttempts || 0 : 0),
    noProgressCheckpoint: lastRun?.noProgressCheckpoint ?? (sameRun && status !== 'success' ? previous.noProgressCheckpoint || null : null),
    firstAttemptAt: sameRun && previous.firstAttemptAt
      ? previous.firstAttemptAt
      : (lastRun?.startedAt || lastRun?.at || now.toISOString()),
    lastAttemptAt: finishedAt,
    nextRetryAt,
    candidate: terminal ? undefined : serializeScheduledCandidate(candidate)
  };
  const pending = scheduledPendingStates(modeState)
    .filter(item => item.runKey !== candidate.runKey);
  const completed = scheduledCompletedStates(modeState)
    .filter(item => item.runKey !== candidate.runKey);
  if (!terminal) {
    pending.push(entry);
  } else {
    completed.push(entry);
    const currentConfigHash = scheduledActionConfigHash(candidate.action, candidate.groups || [], candidate.periodMode);
    if (candidate.configHash && candidate.configHash !== currentConfigHash) {
      const compatibleRunKey = `${candidate.periodMode}:${candidate.from}:${candidate.to}:${currentConfigHash}`;
      if (!completed.some(item => item.runKey === compatibleRunKey)) {
        completed.push({
          ...entry,
          runKey: compatibleRunKey,
          migratedFromRunKey: candidate.runKey
        });
      }
    }
  }

  state.actions[candidate.action.id] = {
    ...current,
    [candidate.periodMode]: {
      ...entry,
      pending: pending.slice(-50),
      completed: completed.slice(-50)
    }
  };
}

function scheduledPendingStates(modeState) {
  if (!modeState || typeof modeState !== 'object') return [];
  const pending = Array.isArray(modeState.pending)
    ? modeState.pending.filter(item => item && typeof item === 'object' && item.runKey)
    : [];
  if (
    modeState.status === 'error'
    && modeState.runKey
    && !pending.some(item => item.runKey === modeState.runKey)
  ) {
    pending.push({
      ...modeState,
      pending: undefined,
      completed: undefined
    });
  }
  return pending;
}

function scheduledCandidateState(modeState, runKey, candidate = null) {
  if (!modeState || !runKey) return null;
  if (modeState.runKey === runKey) return modeState;
  const exact = scheduledPendingStates(modeState).find(item => item.runKey === runKey)
    || scheduledCompletedStates(modeState).find(item => item.runKey === runKey);
  if (exact || !candidate) return exact || null;

  const legacyHash = scheduledActionConfigHash(candidate.action, candidate.groups || [], candidate.periodMode, { legacy: true });
  const legacyRunKey = `${candidate.periodMode}:${candidate.from}:${candidate.to}:${legacyHash}`;
  if (legacyRunKey === runKey) return null;
  return scheduledCompletedStates(modeState).find(item => item.runKey === legacyRunKey) || null;
}

function isTerminalScheduledStatus(status) {
  return ['success', 'delivery_uncertain', 'stopped', 'incomplete'].includes(status);
}

function actionLastRunMatchesCandidate(lastRun, candidate) {
  if (!lastRun || !isTerminalScheduledStatus(lastRun.status)) return false;
  if (lastRun.runKey === candidate.runKey) return true;
  const legacyHash = scheduledActionConfigHash(candidate.action, candidate.groups || [], candidate.periodMode, { legacy: true });
  return lastRun.runKey === `${candidate.periodMode}:${candidate.from}:${candidate.to}:${legacyHash}`;
}

function scheduledCompletedStates(modeState) {
  if (!modeState || typeof modeState !== 'object') return [];
  const completed = Array.isArray(modeState.completed)
    ? modeState.completed.filter(item => item && typeof item === 'object' && item.runKey)
    : [];
  if (
    isTerminalScheduledStatus(modeState.status)
    && modeState.runKey
    && !completed.some(item => item.runKey === modeState.runKey)
  ) {
    completed.push({
      ...modeState,
      pending: undefined,
      completed: undefined
    });
  }
  return completed;
}

function shouldRunScheduledCandidate(actionState, candidate, now = new Date()) {
  if (!actionState || actionState.runKey !== candidate.runKey) return true;
  if (actionState.status === 'delivery_pending') return false;
  if (isTerminalScheduledStatus(actionState.status)) return false;

  const firstAttemptAtMs = Date.parse(actionState.firstAttemptAt || actionState.at || '');
  if (Number.isFinite(firstAttemptAtMs) && now.getTime() - firstAttemptAtMs > ACTION_SCHEDULER_RETRY_MAX_AGE_MS) {
    return false;
  }

  const nextRetryAtMs = Date.parse(actionState.nextRetryAt || '');
  return !Number.isFinite(nextRetryAtMs) || now.getTime() >= nextRetryAtMs;
}

function scheduledRetryDelayMs(attempts) {
  const index = Math.min(
    ACTION_SCHEDULER_RETRY_DELAYS_MS.length - 1,
    Math.max(0, (Number(attempts) || 1) - 1)
  );
  return ACTION_SCHEDULER_RETRY_DELAYS_MS[index];
}

function serializeScheduledCandidate(candidate) {
  return {
    periodMode: candidate.periodMode,
    from: candidate.from,
    to: candidate.to,
    dueAt: candidate.dueAt,
    runKey: candidate.runKey,
    configHash: candidate.configHash,
    timeZone: candidate.timeZone,
    cameraTimeZone: candidate.cameraTimeZone,
    selections: (candidate.selections || []).map(selection => ({ ...selection }))
  };
}

function scheduledRetryCandidates(action, groupMap, actionState, now = new Date(), options = {}) {
  if (!action || !actionState || action.periodMode === 'once') return [];

  const groups = (action.groupIds || []).map(groupId => groupMap.get(groupId)).filter(Boolean);
  if (!groups.length) return [];

  return ['daily', 'weekly'].flatMap(periodMode => {
    if (periodMode === 'daily' && action.periodMode !== 'daily' && !action.reportDaily) return [];
    if (periodMode === 'weekly' && action.periodMode !== 'weekly' && !action.reportWeekly) return [];
    const configHash = scheduledActionConfigHash(action, groups, periodMode);
    const legacyConfigHash = scheduledActionConfigHash(action, groups, periodMode, { legacy: true });
    return scheduledPendingStates(actionState[periodMode]).map(state => {
      const firstAttemptAtMs = Date.parse(state.firstAttemptAt || state.at || '');
      if (!options.ignoreMaxAge && Number.isFinite(firstAttemptAtMs) && now.getTime() - firstAttemptAtMs > ACTION_SCHEDULER_RETRY_MAX_AGE_MS) {
        return null;
      }

      const storedConfigHash = String(state.runKey || '').slice(String(state.runKey || '').lastIndexOf(':') + 1);
      const matchingConfigHash = storedConfigHash === configHash
        ? configHash
        : storedConfigHash === legacyConfigHash
          ? legacyConfigHash
          : '';
      if (!matchingConfigHash) return null;
      const snapshot = restoreScheduledCandidateSnapshot(action, groups, state, periodMode, matchingConfigHash, options.settings);
      if (!snapshot || snapshot.runKey !== state.runKey || snapshot.configHash !== matchingConfigHash) return null;

      const selections = Array.isArray(snapshot.selections)
        ? snapshot.selections.filter(selection => selection && selection.from && selection.to && Number(selection.channel) > 0)
        : [];
      if (!selections.length) return null;

      return {
        action,
        groups,
        selections,
        periodMode,
        from: snapshot.from,
        to: snapshot.to,
        dueAt: snapshot.dueAt,
        runKey: snapshot.runKey,
        configHash: matchingConfigHash,
        timeZone: snapshot.timeZone || configuredDisplayTimeZone(options.settings),
        cameraTimeZone: snapshot.cameraTimeZone || configuredCameraTimeZone(options.settings)
      };
    }).filter(Boolean);
  });
}

function restoreExplicitStoppedCandidate(action, groups, settings = {}) {
  const lastRun = action?.lastRun;
  if (!['stopped', 'incomplete'].includes(lastRun?.status) || !lastRun.runKey) return null;
  const periodMode = lastRun.details?.period?.mode
    || (action.periodMode === 'weekly' ? 'weekly' : 'daily');
  const currentConfigHash = scheduledActionConfigHash(action, groups, periodMode);
  const legacyConfigHash = scheduledActionConfigHash(action, groups, periodMode, { legacy: true });
  const storedConfigHash = String(lastRun.runKey).slice(String(lastRun.runKey).lastIndexOf(':') + 1);
  const configHash = storedConfigHash === currentConfigHash
    ? currentConfigHash
    : storedConfigHash === legacyConfigHash
      ? legacyConfigHash
      : '';
  if (!configHash) return null;
  const snapshot = restoreScheduledCandidateSnapshot(action, groups, lastRun, periodMode, configHash, settings);
  if (!snapshot || snapshot.runKey !== lastRun.runKey) return null;
  return { action, groups, ...snapshot, configHash };
}

function restoreScheduledCandidateSnapshot(action, groups, state, periodMode, configHash, settings = {}) {
  if (state.candidate && typeof state.candidate === 'object') {
    return state.candidate;
  }

  const storedConfigHash = String(state.runKey || '').slice(String(state.runKey || '').lastIndexOf(':') + 1);
  const datePart = String(state.from || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart) || storedConfigHash !== configHash) return null;

  const retryAction = {
    ...action,
    dayPreset: 'custom',
    customDate: datePart,
    runOnWeekends: true
  };
  const selections = resolveScheduledActionSelections(retryAction, groups, new Date(), periodMode, settings);
  const from = earliestLocalDateTime(selections.map(selection => selection.from));
  const to = latestLocalDateTime(selections.map(selection => selection.to));
  if (!selections.length || from !== state.from || to !== state.to) return null;

  return {
    periodMode,
    from,
    to,
    dueAt: state.dueAt || state.at || new Date().toISOString(),
    runKey: state.runKey,
    configHash,
    timeZone: configuredDisplayTimeZone(settings),
    cameraTimeZone: configuredCameraTimeZone(settings),
    selections
  };
}

function uniqueScheduledCandidates(candidates) {
  const result = new Map();
  for (const candidate of candidates || []) {
    const key = candidate?.periodMode && candidate?.from && candidate?.to
      ? `${candidate.periodMode}:${candidate.from}:${candidate.to}`
      : candidate?.runKey;
    if (candidate?.runKey && key && !result.has(key)) result.set(key, candidate);
  }
  return [...result.values()];
}

function scheduledActionCandidates(action, groupMap, now = new Date(), options = {}) {
  if (!action || action.periodMode === 'once') return [];

  const periodModes = [];
  if (action.periodMode === 'daily' || action.reportDaily) periodModes.push('daily');
  if (action.periodMode === 'weekly' || action.reportWeekly) periodModes.push('weekly');

  return periodModes
    .map(periodMode => scheduledActionCandidate(action, groupMap, now, periodMode, options))
    .filter(Boolean);
}

function scheduledActionCandidate(action, groupMap, now, periodMode = action?.periodMode, options = {}) {
  if (!action || (periodMode !== 'daily' && periodMode !== 'weekly')) return null;

  const groups = (action.groupIds || []).map(groupId => groupMap.get(groupId)).filter(Boolean);
  if (!groups.length) return null;

  const settings = options.settings || {};
  const displayTimeZone = configuredDisplayTimeZone(settings);
  const selections = resolveScheduledActionSelections(action, groups, now, periodMode, settings);
  if (!selections.length) return null;

  const from = earliestLocalDateTime(selections.map(selection => selection.from));
  const to = latestLocalDateTime(selections.map(selection => selection.to));
  if (!from || !to) return null;

  let dueAtMs = Date.parse(to);
  if (!Number.isFinite(dueAtMs)) dueAtMs = zonedDateTimeToEpochMs(to, displayTimeZone);
  if (!Number.isFinite(dueAtMs)) return null;

  if (periodMode === 'weekly') {
    const weekStart = resolveScheduledWeeklyDates(action, now, settings)[0];
    const friday = offsetDatePart(weekStart, 4);
    const fridayEveningMs = zonedDateTimeToEpochMs(`${friday}T18:00`, displayTimeZone);
    const saturdayEndMs = zonedDateTimeToEpochMs(`${offsetDatePart(friday, 1)}T23:59:59`, displayTimeZone);
    dueAtMs = Math.max(dueAtMs, fridayEveningMs);
    if ((!options.includeFuture && now.getTime() < dueAtMs) || now.getTime() > saturdayEndMs) return null;
  } else if (!options.includeFuture && now.getTime() < dueAtMs) {
    return null;
  }

  const configHash = scheduledActionConfigHash(action, groups, periodMode);

  return {
    action,
    groups,
    selections,
    periodMode,
    from,
    to,
    dueAt: new Date(dueAtMs).toISOString(),
    runKey: `${periodMode}:${from}:${to}:${configHash}`,
    configHash,
    timeZone: displayTimeZone,
    cameraTimeZone: configuredCameraTimeZone(settings)
  };
}

function scheduledActionConfigHash(action, groups, periodMode, options = {}) {
  const config = {
    name: action.name,
    question: action.question,
    periodMode,
    dayPreset: action.dayPreset,
    customDate: action.customDate,
    groupIds: action.groupIds,
    reportDaily: Boolean(action.reportDaily),
    reportWeekly: Boolean(action.reportWeekly),
    groups: groups.map(group => ({
      id: group.id,
      name: group.name,
      channels: group.channels,
      from: group.from,
      to: group.to,
      ...(!options.legacy ? { timeZone: group.timeZone || 'Europe/Moscow' } : {})
    }))
  };
  if (!options.legacy) {
    config.destination = action.destination === 'drive' ? 'drive' : 'email';
    if (periodMode === 'daily') config.runOnWeekends = Boolean(action.runOnWeekends);
  }
  return crypto.createHash('sha1')
    .update(JSON.stringify(config))
    .digest('hex');
}

function resolveScheduledActionSelections(action, groups, now = new Date(), periodMode = action?.periodMode, settings = {}) {
  const selections = [];

  for (const group of groups) {
    const ranges = resolveScheduledGroupRanges(action, group, now, periodMode, settings);
    for (const range of ranges) {
      for (const channel of group.channels || []) {
        selections.push({
          groupId: group.id,
          groupName: group.name,
          channel,
          from: range.from,
          to: range.to,
          rangeSeconds: secondsBetween(range.from, range.to)
        });
      }
    }
  }

  return selections.filter(selection => selection.rangeSeconds > 0);
}

function resolveScheduledGroupRanges(action, group, now = new Date(), periodMode = action?.periodMode, settings = {}) {
  const dates = periodMode === 'weekly'
    ? resolveScheduledWeeklyDates(action, now, settings)
    : [resolveScheduledDailyDate(action, now, settings)];

  return dates.filter(date => periodMode !== 'daily' || action.runOnWeekends || !isWeekendDatePart(date)).map(date => {
    const legacyNaiveTime = !group.timeZone && !settings?.displayTimeZone && !settings?.cameraTimeZone
      && !process.env.DISPLAY_TIME_ZONE && !process.env.CAMERA_TIME_ZONE;
    if (legacyNaiveTime) {
      const from = combineDateAndTime(date, timeOnly(group.from));
      let to = combineDateAndTime(date, timeOnly(group.to));
      if (secondsBetween(from, to) <= 0) {
        to = combineDateAndTime(offsetDatePart(date, 1), timeOnly(group.to));
      }
      return secondsBetween(from, to) > 0 ? { from, to } : null;
    }
    const groupTimeZone = normalizeTimeZone(group.timeZone, 'Europe/Moscow');
    const displayTimeZone = configuredDisplayTimeZone(settings);
    const anchor = '2000-01-15';
    const fromDisplay = convertLocalDateTime(`${anchor}T${timeOnly(group.from)}`, groupTimeZone, displayTimeZone);
    const sourceToDate = timeOnly(group.to) <= timeOnly(group.from) ? offsetDatePart(anchor, 1) : anchor;
    const toDisplay = convertLocalDateTime(`${sourceToDate}T${timeOnly(group.to)}`, groupTimeZone, displayTimeZone);
    const fromLocal = combineDateAndTime(date, timeOnly(fromDisplay));
    let toLocal = combineDateAndTime(date, timeOnly(toDisplay));
    if (toDisplay.slice(0, 10) !== fromDisplay.slice(0, 10) || timeOnly(toDisplay) <= timeOnly(fromDisplay)) {
      toLocal = combineDateAndTime(offsetDatePart(date, 1), timeOnly(toDisplay));
    }
    const from = new Date(zonedDateTimeToEpochMs(fromLocal, displayTimeZone)).toISOString();
    const to = new Date(zonedDateTimeToEpochMs(toLocal, displayTimeZone)).toISOString();
    return secondsBetween(from, to) > 0 ? { from, to } : null;
  }).filter(Boolean);
}

function resolveScheduledDailyDate(action, now = new Date(), settings = {}) {
  if (action.dayPreset === 'custom' && action.customDate) return action.customDate;
  const offset = {
    yesterday: -1,
    today: 0,
    tomorrow: 1
  }[action.dayPreset] ?? 0;
  let date = offsetDatePart(zonedDatePart(now, configuredDisplayTimeZone(settings)), offset);
  if (action.dayPreset === 'yesterday' && !action.runOnWeekends) {
    while (isWeekendDatePart(date)) date = offsetDatePart(date, -1);
  }
  return date;
}

function resolveScheduledWeeklyDates(action, now = new Date(), settings = {}) {
  const start = startOfWeekDatePart(resolveScheduledDailyDate(action, now, settings));
  return Array.from({ length: 5 }, (_, index) => offsetDatePart(start, index));
}

function isWeekendDatePart(datePart) {
  const [year, month, day] = String(datePart || '').split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
  const weekday = new Date(year, month - 1, day).getDay();
  return weekday === 0 || weekday === 6;
}

async function runScheduledOpenAiAction(candidate, context) {
  const signal = context.signal;
  const services = context.services || {};
  const requestApi = services.requestApi || localJsonApi;
  const startedAt = new Date();
  const reportTypes = scheduledReportTypes(candidate);
  const destination = candidate.action.destination === 'drive' ? 'drive' : 'email';
  // Injected services get an isolated store unless a durable one is explicitly
  // supplied. Diagnostics/tests must never populate the production outbox.
  const outbox = destination === 'drive' ? services.deliveryOutbox
    || (Object.keys(services).length ? createMemoryDeliveryOutbox() : getDriveDeliveryOutbox()) : null;
  const deliveryScope = destination === 'drive' ? driveDeliveryScope(candidate) : '';
  const deliveryWorker = destination === 'drive' ? (Object.keys(services).length
    ? createDriveDeliveryWorker({ outbox, timeoutMs: services.deliveryTimeoutMs || 30000,
      now: services.deliveryNow || (() => Date.now()),
      deliver: (item, deliverySignal) => (services.uploadDriveTranscripts || uploadScheduledDriveTranscripts)(
        item.payload.candidate, item.payload.transcript,
        { settings: item.payload.settings, labels: item.payload.labels, signal: deliverySignal }) })
    : getDriveDeliveryWorker()) : null;
  let deliveryTask = Promise.resolve();
  const restoredCameras = new Map();
  let answerData = null;
  let reportData = null;
  let driveData = destination === 'drive' ? { ok: true, uploads: [] } : null;
  const transcriptResult = {
    contextLines: [], transcriptEntries: [], warnings: [], issues: [], knownRecordings: 0,
    completedRecordings: 0, failedSearches: 0, failedRecordings: 0,
    missingAudioRecordings: 0
  };
  let stage = 'search';
  const progress = {
    stage, completedChunks: 0, transcribedSeconds: 0, completedRecordings: 0, knownRecordings: 0,
    uploadedCameras: 0, partialUploadedCameras: 0, readyCameras: 0, queuedCameras: 0,
    totalSelections: candidate.selections.length, completedSelections: 0,
    selectionTotalSeconds: 0, selectionProcessedSeconds: 0, percent: 0
  };

  console.log(`OpenAI action scheduler: starting "${candidate.action.name}" for ${candidate.from} - ${candidate.to}`);
  const runningState = {
    status: 'running',
    scheduled: true,
    at: startedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    from: candidate.from,
    to: candidate.to,
    dueAt: candidate.dueAt,
    runKey: candidate.runKey,
    stage: 'search'
  };
  const onProgress = async update => {
    signal?.throwIfAborted();
    Object.assign(progress, update);
    stage = progress.stage;
    progress.percent = Math.max(progress.percent, scheduledProgressPercent(progress));
    const snapshot = {
      ...runningState, stage, progress: { ...progress },
      uploads: driveData?.uploads || [], diagnostics: transcriptResult.diagnostics || []
    };
    if (context.runtime) context.runtime.lastRun = snapshot;
    await (services.updateLastRun || updateOpenAiActionLastRun)(candidate.action.id, {
      ...snapshot
    }).catch(error => {
      console.warn(`OpenAI action scheduler could not save running status: ${publicError(error)}`);
    });
  };
  const mergeDriveUploads = uploadData => {
    const uploads = new Map((driveData?.uploads || []).map(item => [Number(item.channel), item]));
    for (const item of uploadData?.uploads || []) uploads.set(Number(item.channel), item);
    driveData = {
      ...(driveData || {}),
      ...(uploadData || {}),
      uploads: [...uploads.values()].sort((left, right) => Number(left.channel) - Number(right.channel))
    };
  };
  const refreshDelivery = async () => {
    if (!outbox) return [];
    const records = await outbox.list(deliveryScope);
    mergeDriveUploads({ uploads: records.filter(item => item.status === 'delivered').map(item => item.upload) });
    progress.queuedCameras = records.filter(item => item.status === 'pending').length;
    progress.readyCameras = records.filter(item => item.payload?.files?.length).length;
    progress.uploadedCameras = records.filter(item => item.status === 'delivered').length;
    progress.deliveryError = records.find(item => item.status === 'pending' && item.lastError)?.lastError || '';
    return records;
  };
  const kickDelivery = () => {
    deliveryTask = deliveryWorker.flush().catch(error => {
      console.warn(`Drive outbox delivery deferred: ${publicError(error)}`);
    });
  };
  const settleDelivery = async () => {
    if (!outbox) return;
    kickDelivery();
    let timer;
    await Promise.race([deliveryTask, new Promise(resolve => { timer = setTimeout(resolve, 250); })]);
    clearTimeout(timer);
    await refreshDelivery();
  };
  const uploadCompletedDriveCamera = async camera => {
    if (destination !== 'drive') return;
    const channel = Number(camera.channel);
    const diagnostics = (transcriptResult.diagnostics || []).filter(item => Number(item.channel) === channel);
    // Known incomplete audio stays solely in the block cache. It must never
    // become a deliverable TXT, even when most of the camera was processed.
    if (camera.issues.length || restoredCameras.has(channel)) return;
    const selections = candidate.selections.filter(selection => Number(selection.channel) === channel);
    const cameraCandidate = { ...candidate, selections };
    const cameraTranscript = {
      ...transcriptResult,
      contextLines: transcriptResult.contextLines.filter(line => String(line).includes(`| ${camera.label} |`)),
      transcriptEntries: transcriptResult.transcriptEntries.filter(entry => Number(entry.channel) === channel),
      warnings: camera.warnings,
      issues: camera.issues,
      diagnostics,
      knownRecordings: diagnostics.reduce((sum, item) => sum + (Number(item.recordings) || 0), 0),
      completedRecordings: diagnostics.reduce((sum, item) => sum + (Number(item.completedRecordings) || 0), 0),
      failedSearches: camera.issues.filter(issue => issue.code === 'SEARCH_FAILED').length,
      failedRecordings: camera.issues.filter(issue => issue.stage === 'transcript').length
    };
    assertDriveTranscriptComplete(cameraTranscript);
    if (!diagnostics.length || diagnostics.some(item => item.status !== 'complete')) {
      throw httpError(502, 'Нет подтверждения полной обработки камеры.', { stage: 'transcript', channel });
    }
    const files = buildDriveTranscriptFiles({ action: cameraCandidate.action, from: candidate.from, to: candidate.to,
      selections: selections.map(selection => ({ ...selection, label: channelLabelFromRows(context.labels, channel) })),
      entries: cameraTranscript.transcriptEntries, issues: [], diagnostics, settings: context.settings });
    // Save the exact, complete input before any network delivery. This includes
    // silence intervals in diagnostics even when ASR returned no words.
    await outbox.enqueue({ scope: deliveryScope, actionId: candidate.action.id,
      runKey: candidate.runKey, channel, payload: {
        candidate: durableDeliveryCandidate(cameraCandidate), runCandidate: durableDeliveryCandidate(candidate),
        transcript: cameraTranscript, files, settings: deliverySettings(context.settings), labels: context.labels || []
      } });
    kickDelivery();
    await refreshDelivery();
    await onProgress({
      stage: 'transcript',
      uploadedCameras: driveData.uploads.filter(item => item.completeness !== 'partial').length,
      readyCameras: progress.readyCameras, queuedCameras: progress.queuedCameras,
      lastReadyChannel: channel, lastReadyLabel: camera.label
    });
  };
  try {
    await onProgress({ stage: 'search' });
    const skipChannels = new Set();
    if (destination === 'drive') {
      let records = await refreshDelivery();
      const hasAllLocal = candidate.selections.every(selection => records.some(item => Number(item.channel) === Number(selection.channel)));
      if (!hasAllLocal) try {
        const findDriveTranscripts = services.findDriveTranscripts
          || (services.uploadDriveTranscripts ? async () => ({ ok: true, uploads: [] }) : findScheduledDriveTranscripts);
        const existing = await boundedDriveLookup(findDriveTranscripts, candidate, {
          ...context,
          settings: context.settings,
          labels: context.labels,
          signal
        }, services.driveLookupTimeoutMs || 2000);
        for (const item of existing?.uploads || []) {
          if (item.completeness === 'partial' || !item.fileId) continue;
          await outbox.rememberDelivered({ scope: deliveryScope, actionId: candidate.action.id,
            runKey: candidate.runKey, channel: Number(item.channel), upload: { ...item, completeness: 'complete' } });
        }
      } catch (error) {
        signal?.throwIfAborted();
        transcriptResult.warnings.push('Проверка Google Диска отложена. Обработка продолжается; готовые TXT сохраняются локально.');
      }
      records = await refreshDelivery();
      progress.processedCoverage = [];
      for (const item of records) {
        const channel = Number(item.channel);
        skipChannels.add(channel);
        restoredCameras.set(channel, item);
        for (const selection of candidate.selections.filter(value => Number(value.channel) === channel)) {
          progress.processedCoverage.push({ channel, from: selection.from, to: selection.to,
            processedSeconds: selection.rangeSeconds || secondsBetween(selection.from, selection.to) });
        }
      }
      if (records.length) {
        kickDelivery();
        await onProgress({
          stage: 'search',
          uploadedCameras: driveData.uploads.length,
          readyCameras: progress.readyCameras, queuedCameras: progress.queuedCameras, skippedCameras: skipChannels.size
        });
      }
    }
    await buildScheduledActionTranscript(candidate, {
      ...context,
      requestApi,
      result: transcriptResult,
      progress,
      onProgress,
      onCameraComplete: uploadCompletedDriveCamera,
      skipChannels, restoredCameras
    });
    if (destination === 'drive') {
      assertDriveTranscriptComplete(transcriptResult);
      await onProgress({ stage: 'drive' });
      await settleDelivery();
      answerData = { answer: '', model: '', responseId: '' };
    } else {
    await onProgress({ stage: 'ask' });
    answerData = await requestApi('/api/openai/ask', {
      signal,
      method: 'POST',
      body: {
        question: candidate.action.question,
        transcript: transcriptResult.contextLines.join('\n'),
        from: candidate.from,
        to: candidate.to,
        action: {
          id: candidate.action.id,
          name: candidate.action.name,
          periodMode: candidate.periodMode
        },
        groups: candidate.groups.map(group => ({
          id: group.id,
          name: group.name,
          channels: group.channels,
          from: group.from,
          to: group.to,
          timeZone: group.timeZone
        })),
        channels: candidate.selections.map(selection => ({
          channel: selection.channel,
          label: channelLabelFromRows(context.labels, selection.channel),
          group: selection.groupName,
          from: selection.from,
          to: selection.to
        }))
      }
    });

    if (reportTypes.length) {
      await onProgress({ stage: 'report' });
      // An accepted SMTP message cannot be recalled; stop waits for its receipt.
      reportData = await requestApi('/api/reports/send', {
        method: 'POST',
        body: {
          reportTypes,
          deliveryKey: `${candidate.action.id}:${candidate.runKey}`,
          generatedAt: new Date().toISOString(),
          timeZone: configuredDisplayTimeZone(context.settings),
          from: candidate.from,
          to: candidate.to,
          question: candidate.action.question,
          answer: answerData.answer || '',
          transcript: transcriptResult.contextLines.join('\n'),
          transcriptLines: transcriptResult.contextLines.length,
          warnings: transcriptResult.warnings,
          model: answerData.model || '',
          responseId: answerData.responseId || '',
          action: {
            id: candidate.action.id,
            name: candidate.action.name,
            periodMode: candidate.periodMode,
            reportDaily: candidate.action.reportDaily,
            reportWeekly: candidate.action.reportWeekly,
            runOnWeekends: candidate.action.runOnWeekends
          },
          groups: candidate.groups.map(group => ({
            id: group.id,
            name: group.name,
            channels: group.channels,
            from: group.from,
            to: group.to,
            timeZone: group.timeZone
          })),
          channels: candidate.selections.map(selection => ({
            channel: selection.channel,
            label: channelLabelFromRows(context.labels, selection.channel),
            group: selection.groupName,
            from: selection.from,
            to: selection.to
          }))
        }
      });
    }
    }

    signal?.throwIfAborted();
    const lastRun = {
      status: destination === 'drive' && progress.queuedCameras ? 'delivery_pending' : 'success',
      stage: destination === 'drive' && progress.queuedCameras ? 'drive' : 'done',
      processingComplete: true,
      queuedCameras: progress.queuedCameras || 0,
      deliveryError: progress.deliveryError || '',
      scheduled: true,
      at: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      from: candidate.from,
      to: candidate.to,
      dueAt: candidate.dueAt,
      model: answerData.model || '',
      responseId: answerData.responseId || '',
      answer: answerData.answer || '',
      transcriptLines: transcriptResult.contextLines.length,
      selections: candidate.selections.length,
      recordings: transcriptResult.knownRecordings,
      missingAudioRecordings: transcriptResult.missingAudioRecordings || 0,
      reports: reportData?.sent || [],
      uploads: driveData?.uploads || [],
      progress: { ...progress, stage: destination === 'drive' && progress.queuedCameras ? 'drive' : 'done',
        percent: destination === 'drive' && progress.queuedCameras ? 97 : 100 },
      warnings: transcriptResult.warnings,
      diagnostics: transcriptResult.diagnostics || [],
      runKey: candidate.runKey
    };
    if (transcriptResult.issues.length && destination === 'email') {
      lastRun.errorNotification = await (services.notifyError || sendScheduledActionErrorEmail)(candidate, {
        ...lastRun,
        error: 'Часть записей не обработана. Ответ сформирован по доступному тексту.',
        stage: 'transcript',
        details: { issues: transcriptResult.issues }
      });
    }
    signal?.throwIfAborted();
    try {
      await (services.persistRun || persistScheduledActionRun)(candidate, lastRun, {
        reportTypes,
        destination,
        uploads: driveData?.uploads || [],
        warnings: transcriptResult.warnings
      });
    } catch (error) {
      lastRun.persistenceError = publicError(error);
      console.warn(`OpenAI action scheduler completed but could not save success: ${lastRun.persistenceError}`);
    }
    console.log(`OpenAI action scheduler: finished "${candidate.action.name}"`);
    return lastRun;
  } catch (error) {
    await settleDelivery().catch(() => {});
    return persistScheduledActionFailure(candidate, error, {
      startedAt,
      stage,
      answerData,
      transcriptResult,
      reportData,
      driveData,
      progress,
      previousState: context.previousState,
      signal,
      services
    });
  }
}

function scheduledAvailabilityRetry(candidate, error, previousState = {}, now = new Date()) {
  const issues = error?.details?.issues || [];
  const availabilityCodes = new Set(['NO_RECORDINGS', 'ARCHIVE_UNCONFIRMED', 'ARCHIVE_GAPS']);
  if (error?.details?.failedSearches || error?.details?.failedRecordings
    || !issues.length || !issues.every(issue => availabilityCodes.has(issue.code))) {
    return {
      attempts: previousState?.runKey === candidate.runKey ? Number(previousState.availabilityAttempts) || 0 : 0,
      fingerprint: previousState?.runKey === candidate.runKey ? previousState.availabilityFingerprint || '' : '',
      exhausted: false
    };
  }
  const fingerprint = crypto.createHash('sha1').update(JSON.stringify(issues.map(issue => ({
    channel: issue.channel, code: issue.code, from: issue.from, to: issue.to, gaps: issue.gaps
  })).sort((a, b) => Number(a.channel) - Number(b.channel)))).digest('hex');
  const attempts = previousState?.runKey === candidate.runKey && previousState.availabilityFingerprint === fingerprint
    ? (Number(previousState.availabilityAttempts) || 0) + 1 : 1;
  const endMs = safeInstantMs(candidate.to, candidate.timeZone || 'Europe/Moscow');
  // Allow fresh archives time to be indexed. Old unavailable periods require
  // attention, not unlimited retries; a manual retry explicitly resets this.
  return { attempts, fingerprint, exhausted: attempts >= 3 && Number.isFinite(endMs) && now.getTime() - endMs > 86400000 };
}

function scheduledIncompleteAudioRetry(candidate, error, previousState = {}, progress = {}) {
  // A delivery/network failure is not an observation that the archive/audio
  // recovered. Keep this independent history without counting another check.
  const reset = () => ({
    attempts: previousState?.runKey === candidate.runKey ? Number(previousState.incompleteAudioAttempts) || 0 : 0,
    fingerprint: previousState?.runKey === candidate.runKey ? previousState.incompleteAudioFingerprint || '' : '',
    checkpoint: previousState?.runKey === candidate.runKey ? previousState.incompleteAudioCheckpoint || null : null,
    exhausted: false
  });
  const issues = error?.details?.issues;
  if (!Array.isArray(issues) || !issues.length || error?.details?.failedSearches
    || Number(error?.details?.failedRecordings || 0) > issues.length) return reset();

  const wrapperCodes = new Set(['INCOMPLETE_AUDIO', 'TRANSCRIPTION_FAILED', 'TRANSCRIPT_FAILED']);
  const transientMessage = /timed?\s*out|timeout|socket|network|CUDA|cuDNN|cuBLAS|out of memory|GigaAM|тайм.?аут|время ожидания|сетев/iu;
  const gaps = [];
  for (const issue of issues) {
    const nodes = [];
    const seen = new Set();
    const visit = node => {
      if (!node || typeof node !== 'object' || seen.has(node) || nodes.length >= 16) return;
      seen.add(node);
      nodes.push(node);
      visit(node.cause);
      visit(node.details);
    };
    visit(issue);
    const incomplete = nodes.find(node => node.code === 'INCOMPLETE_AUDIO');
    if (!incomplete || nodes.some(node => (
      (node.code && !wrapperCodes.has(node.code))
      || [408, 429, 504].includes(Number(node.statusCode || node.status))
      || transientMessage.test(String(node.error || node.message || ''))
    ))) return reset();

    const sources = [incomplete, ...nodes];
    const number = key => {
      const value = sources.find(node => typeof node[key] === 'number' && Number.isFinite(node[key]))?.[key];
      return value >= 0 ? value : null;
    };
    const timestamp = key => {
      const value = sources.find(node => typeof node[key] === 'string' && node[key])?.[key];
      const parsed = value ? safeInstantMs(value, candidate.cameraTimeZone || 'Europe/Moscow') : NaN;
      return Number.isFinite(parsed) ? parsed / 1000 : null;
    };
    const channel = Number(issue.channel);
    const fileName = String(issue.fileName || '').trim();
    const gap = {
      channel, fileName,
      offsetSeconds: number('offsetSeconds'),
      expectedSeconds: number('expectedDurationSeconds') ?? number('durationSeconds'),
      receivedSeconds: number('receivedDurationSeconds'),
      endOffsetSeconds: number('endOffsetSeconds'),
      missingFrom: timestamp('missingFrom'),
      missingTo: timestamp('missingTo')
    };
    if (!(channel > 0) || !fileName || (gap.offsetSeconds === null && gap.missingFrom === null)
      || (gap.expectedSeconds === null && gap.endOffsetSeconds === null && gap.missingTo === null)) return reset();
    gaps.push(gap);
  }
  gaps.sort((left, right) => left.channel - right.channel
    || left.fileName.localeCompare(right.fileName)
    || (left.offsetSeconds ?? left.missingFrom) - (right.offsetSeconds ?? right.missingFrom));
  const count = key => Math.max(0, Number(progress?.[key]) || 0);
  const checkpoint = {
    gaps,
    progress: {
      completedChunks: count('completedChunks'),
      completedRecordings: count('completedRecordings'),
      uploadedCameras: count('uploadedCameras'),
      transcribedSeconds: count('transcribedSeconds')
    }
  };
  const previous = previousState?.incompleteAudioCheckpoint;
  const closeNumber = (left, right) => left === right
    || (Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 0.25);
  const sameGaps = Array.isArray(previous?.gaps) && previous.gaps.length === gaps.length
    && gaps.every((gap, index) => {
      const prior = previous.gaps[index];
      return prior && prior.channel === gap.channel && prior.fileName === gap.fileName
        && ['offsetSeconds', 'expectedSeconds', 'receivedSeconds', 'endOffsetSeconds', 'missingFrom', 'missingTo']
          .every(key => closeNumber(prior[key], gap[key]));
    });
  const progressed = !previous?.progress || Object.entries(checkpoint.progress).some(([key, value]) => (
    value > Number(previous.progress[key] || 0) + (key === 'transcribedSeconds' ? 0.25 : 0)
  ));
  const sameFailure = previousState?.runKey === candidate.runKey
    && previousState.incompleteAudioFingerprint && sameGaps && !progressed;
  // Compare all retries to the first observation in the streak. This tolerates
  // timing jitter without hiding cumulative progress made in small increments.
  const retainedCheckpoint = sameFailure ? previous : checkpoint;
  const fingerprint = sameFailure ? previousState.incompleteAudioFingerprint
    : crypto.createHash('sha1').update(JSON.stringify(checkpoint)).digest('hex');
  const attempts = sameFailure ? (Number(previousState.incompleteAudioAttempts) || 0) + 1 : 1;
  return { attempts, fingerprint, checkpoint: retainedCheckpoint, exhausted: attempts >= 3 };
}

function scheduledProcessingNoProgressRetry(candidate, error, previousState = {}, progress = {}, diagnostics = [], now = new Date()) {
  const sameRun = previousState?.runKey === candidate.runKey;
  const retained = {
    attempts: sameRun ? Math.max(0, Number(previousState.noProgressAttempts) || 0) : 0,
    checkpoint: sameRun ? previousState.noProgressCheckpoint || null : null,
    exhausted: false,
    observed: false
  };
  const issues = error?.details?.issues;
  const archiveCodes = new Set(['NO_RECORDINGS', 'ARCHIVE_UNCONFIRMED', 'ARCHIVE_GAPS']);
  if (!Array.isArray(issues) || !issues.length || error?.details?.failedSearches
    || Number(error?.details?.failedRecordings || 0) > issues.length
    || ['drive', 'report', 'ask'].includes(error?.details?.stage)) return retained;

  let hasArchive = false;
  const receivedAudio = new Map();
  for (const issue of issues) {
    if (archiveCodes.has(issue?.code)) {
      hasArchive = true;
      continue;
    }
    // Only a fully classified shortfall is a substantive processing attempt.
    // In particular, a timeout/connection failure is never source absence.
    const audio = scheduledIncompleteAudioRetry(candidate, { details: { issues: [issue] } });
    if (!audio.attempts) return retained;
    for (const gap of audio.checkpoint.gaps) {
      const key = JSON.stringify([gap.channel, gap.fileName, gap.offsetSeconds, gap.expectedSeconds, gap.endOffsetSeconds]);
      if (Number.isFinite(gap.receivedSeconds)) receivedAudio.set(key, gap.receivedSeconds);
    }
  }

  const coverage = new Map();
  const includeCoverage = item => {
    const channel = Number(item?.channel);
    const from = safeInstantMs(item?.from, candidate.timeZone || 'Europe/Moscow');
    const to = safeInstantMs(item?.to, candidate.timeZone || 'Europe/Moscow');
    if (!(channel > 0) || !Number.isFinite(from) || !(to > from)) return;
    const key = JSON.stringify([channel, from, to]);
    const value = Math.min((to - from) / 1000, Math.max(0, Number(item.processedSeconds) || 0));
    coverage.set(key, Math.max(coverage.get(key) || 0, value));
  };
  // These are actual decoded/processed durations, not attempted selections,
  // cache hits, upload counts or the amount of recognized speech. The caller
  // includes complete local/remote cameras skipped in the current attempt.
  for (const item of diagnostics || []) includeCoverage(item);
  for (const item of progress?.processedCoverage || []) includeCoverage(item);
  const checkpoint = {
    version: 1,
    coverage: Object.fromEntries([...coverage].sort(([a], [b]) => a.localeCompare(b))),
    receivedAudio: Object.fromEntries([...receivedAudio].sort(([a], [b]) => a.localeCompare(b))),
    transcribedSeconds: coverage.size ? 0 : Math.max(0, Number(progress?.transcribedSeconds) || 0),
    hasArchive
  };
  const prior = retained.checkpoint?.version === 1 ? retained.checkpoint : null;
  const progressed = prior && (
    Object.entries(checkpoint.coverage).some(([key, value]) => value > Number(prior.coverage?.[key] || 0) + 0.25)
    || Object.entries(checkpoint.receivedAudio).some(([key, value]) => (
      // A different failure location is not itself progress. Complete decoded
      // blocks are measured above; only compare the same partial block here.
      Object.hasOwn(prior.receivedAudio || {}, key) && value > Number(prior.receivedAudio[key] || 0) + 0.25
    ))
    || checkpoint.transcribedSeconds > Number(prior.transcribedSeconds || 0) + 0.25
  );
  const attempts = !prior || progressed ? 1 : retained.attempts + 1;
  const mergeMaximum = (previous, current) => {
    const merged = { ...(previous || {}) };
    for (const [key, value] of Object.entries(current || {})) merged[key] = Math.max(Number(merged[key]) || 0, value);
    return merged;
  };
  // Preserve a high-water mark: disappearing cache/search results, a larger gap
  // or a different error code cannot reset the no-progress streak. Keep the
  // initial observation when there is only sub-tolerance timing jitter.
  const nextCheckpoint = !prior ? checkpoint : {
    version: 1,
    coverage: progressed ? mergeMaximum(prior.coverage, checkpoint.coverage) : { ...prior.coverage },
    receivedAudio: progressed ? mergeMaximum(prior.receivedAudio, checkpoint.receivedAudio) : {
      ...checkpoint.receivedAudio, ...prior.receivedAudio
    },
    transcribedSeconds: progressed ? Math.max(prior.transcribedSeconds || 0, checkpoint.transcribedSeconds) : prior.transcribedSeconds || 0,
    hasArchive: prior.hasArchive || hasArchive
  };
  const endMs = safeInstantMs(candidate.to, candidate.timeZone || 'Europe/Moscow');
  const archiveGraceElapsed = !nextCheckpoint.hasArchive
    || (Number.isFinite(endMs) && now.getTime() - endMs > 86400000);
  return { attempts, checkpoint: nextCheckpoint, exhausted: attempts >= 3 && archiveGraceElapsed, observed: true };
}

async function persistScheduledActionFailure(candidate, error, context = {}) {
  const stopped = Boolean(context.signal?.aborted);
  const deliveryUncertain = Boolean(error?.deliveryUncertain || error?.details?.deliveryUncertain);
  const availability = scheduledAvailabilityRetry(candidate, error, context.previousState);
  const incompleteAudio = scheduledIncompleteAudioRetry(candidate, error, context.previousState, context.progress);
  const noProgress = scheduledProcessingNoProgressRetry(candidate, error, context.previousState,
    context.progress, context.transcriptResult?.diagnostics);
  const lastRun = {
    status: stopped ? 'stopped' : deliveryUncertain ? 'delivery_uncertain'
      : noProgress.exhausted ? 'incomplete' : 'error',
    availabilityAttempts: availability.attempts,
    availabilityFingerprint: availability.fingerprint,
    incompleteAudioAttempts: incompleteAudio.attempts,
    incompleteAudioFingerprint: incompleteAudio.fingerprint,
    incompleteAudioCheckpoint: incompleteAudio.checkpoint,
    noProgressAttempts: noProgress.attempts,
    noProgressCheckpoint: noProgress.checkpoint,
    scheduled: true,
    at: new Date().toISOString(),
    startedAt: context.startedAt?.toISOString?.() || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    from: candidate.from,
    to: candidate.to,
    dueAt: candidate.dueAt,
    error: stopped ? '' : publicError(error) + (noProgress.exhausted
      ? ' Автоповторы этого периода прекращены после 3 проверок без прогресса. Период требует внимания. Кэш и готовые файлы сохранены; неполные камеры не выгружены. Доступен ручной повтор.' : ''),
    stage: error?.details?.stage || context.stage || 'scheduler',
    model: context.answerData?.model || '',
    responseId: context.answerData?.responseId || '',
    answer: context.answerData?.answer || '',
    transcriptLines: context.transcriptResult?.contextLines?.length || 0,
    selections: candidate.selections?.length || 0,
    recordings: context.transcriptResult?.knownRecordings || 0,
    missingAudioRecordings: context.transcriptResult?.missingAudioRecordings || 0,
    reports: context.reportData?.sent || [],
    uploads: context.driveData?.uploads || [],
    runKey: candidate.runKey,
    details: error.details,
    diagnostics: context.transcriptResult?.diagnostics || [],
    progress: context.progress ? { ...context.progress, stage: error?.details?.stage || context.stage } : undefined,
    warnings: context.transcriptResult?.warnings || []
  };
  if (!stopped && candidate.action.destination !== 'drive') {
    lastRun.errorNotification = await (context.services?.notifyError || sendScheduledActionErrorEmail)(candidate, lastRun);
  }
  if (context.signal?.aborted) {
    lastRun.status = 'stopped';
    lastRun.error = '';
  }
  await (context.services?.persistRun || persistScheduledActionRun)(candidate, lastRun, {
    errorDetails: error.details
  }).catch(persistError => {
    console.warn(`OpenAI action scheduler could not save failed run: ${publicError(persistError)}`);
  });
  console.warn(`OpenAI action scheduler: "${candidate.action.name}" failed at ${lastRun.stage}: ${lastRun.error}`);
  return lastRun;
}

function scheduledProgressPercent(progress) {
  if (progress.stage === 'done') return 100;
  if (progress.stage === 'drive') return 97;
  if (progress.stage === 'report') return 97;
  if (progress.stage === 'ask') return 90;
  const fraction = progress.selectionTotalSeconds > 0
    ? Math.min(1, (progress.selectionProcessedSeconds || 0) / progress.selectionTotalSeconds)
    : 0;
  return Math.round(900 * Math.min(1, ((progress.completedSelections || 0) + fraction) / Math.max(1, progress.totalSelections || 1))) / 10;
}

async function persistScheduledActionRun(candidate, lastRun, extraDetails = {}) {
  await updateOpenAiActionLastRun(candidate.action.id, lastRun);
  await insertOpenAiActionRun({
    ...lastRun,
    actionId: candidate.action.id,
    actionName: candidate.action.name,
    startedAt: lastRun.startedAt,
    finishedAt: lastRun.finishedAt,
    details: {
      ...lastRun,
      ...extraDetails,
      scheduled: true,
      action: {
        id: candidate.action.id,
        name: candidate.action.name,
        groupIds: candidate.action.groupIds,
        periodMode: candidate.action.periodMode,
        dayPreset: candidate.action.dayPreset,
        customDate: candidate.action.customDate,
        destination: candidate.action.destination,
        reportDaily: candidate.action.reportDaily,
        reportWeekly: candidate.action.reportWeekly,
        runOnWeekends: candidate.action.runOnWeekends
      },
      period: {
        mode: candidate.periodMode,
        from: candidate.from,
        to: candidate.to,
        dueAt: candidate.dueAt,
        runKey: candidate.runKey
      }
    }
  });
}

async function buildScheduledActionTranscript(candidate, context) {
  const result = context.result || {
    contextLines: [], transcriptEntries: [], warnings: [], issues: [], knownRecordings: 0,
    completedRecordings: 0, failedSearches: 0, failedRecordings: 0,
    missingAudioRecordings: 0
  };
  result.transcriptEntries ||= [];
  result.diagnostics ||= [];
  result.missingAudioRecordings ||= 0;
  const { contextLines, transcriptEntries, warnings, issues } = result;
  const requestApi = context.requestApi || localJsonApi;
  const progress = context.progress || {};
  const remainingSelections = new Map();
  const cameraOutcomes = new Map();
  for (const selection of candidate.selections) {
    const channel = Number(selection.channel);
    remainingSelections.set(channel, (remainingSelections.get(channel) || 0) + 1);
  }
  let selectionDiagnostic;
  const finishSelection = async (selection, warningStart, issueStart) => {
    if (selectionDiagnostic) {
      selectionDiagnostic.elapsedMs = Date.now() - selectionDiagnostic.startedAtMs;
      delete selectionDiagnostic.startedAtMs;
      selectionDiagnostic.issues = issues.slice(issueStart);
      if (selectionDiagnostic.status !== 'skipped') {
        selectionDiagnostic.status = selectionDiagnostic.issues.length ? 'incomplete' : 'complete';
      }
    }
    await context.onProgress?.({
      completedSelections: (progress.completedSelections || 0) + 1,
      selectionProcessedSeconds: 0,
      selectionTotalSeconds: 0
    });
    const channel = Number(selection.channel);
    const outcome = cameraOutcomes.get(channel) || { warnings: [], issues: [] };
    outcome.warnings.push(...warnings.slice(warningStart));
    outcome.issues.push(...issues.slice(issueStart));
    cameraOutcomes.set(channel, outcome);
    const remaining = Math.max(0, (remainingSelections.get(channel) || 1) - 1);
    remainingSelections.set(channel, remaining);
    if (!remaining) {
      await context.onCameraComplete?.({
        channel,
        label: channelLabelFromRows(context.labels, channel),
        warnings: outcome.warnings,
        issues: outcome.issues,
        result
      });
    }
  };

  for (const selection of candidate.selections) {
    context.signal?.throwIfAborted();
    const warningStart = warnings.length;
    const issueStart = issues.length;
    const label = `${selection.groupName} · ${channelLabelFromRows(context.labels, selection.channel)}`;
    selectionDiagnostic = {
      channel: Number(selection.channel), label, from: selection.from, to: selection.to,
      status: 'search', startedAtMs: Date.now(), searchMs: 0, processingMs: 0,
      recordings: 0, completedRecordings: 0, cachedChunks: 0, processedSeconds: 0, captureMs: 0, asrMs: 0
    };
    result.diagnostics.push(selectionDiagnostic);
    await context.onProgress?.({
      stage: 'search', channel: selection.channel, label,
      from: selection.from, to: selection.to, fileName: '', selectionProcessedSeconds: 0, selectionTotalSeconds: 0
    });
    if (context.skipChannels?.has(Number(selection.channel))) {
      selectionDiagnostic.status = 'skipped';
      await finishSelection(selection, warningStart, issueStart);
      continue;
    }
    const query = new URLSearchParams(scheduledCameraParams(context.settings, selection.channel));
    const cameraRange = selectionCameraRange(selection, context.settings);
    query.set('from', cameraRange.from);
    query.set('to', cameraRange.to);
    query.set('_', Date.now());

    const searchPath = `/api/recordings/search?${query}`;
    let searchData;
    const searchStartedAt = Date.now();
    try {
      searchData = await searchScheduledRecordings(requestApi, searchPath, { signal: context.signal });
    } catch (error) {
      context.signal?.throwIfAborted();
      result.failedSearches += 1;
      warnings.push(`${label}: поиск записей: ${publicError(error)}`);
      issues.push({
        stage: 'search', label, channel: selection.channel, from: selection.from, to: selection.to,
        code: 'SEARCH_FAILED', error: publicError(error), status: error.statusCode, details: error.details
      });
      selectionDiagnostic.searchMs = Date.now() - searchStartedAt;
      await finishSelection(selection, warningStart, issueStart);
      continue;
    }
    selectionDiagnostic.searchMs = Date.now() - searchStartedAt;
    selectionDiagnostic.searchOutcome = searchData.searchOutcome || (searchData.items?.length ? 'found' : 'empty');
    if (searchData.warning) warnings.push(`${label}: ${searchData.warning}`);

    const items = (searchData.items || [])
      .map(item => ({ item, coverage: recordingCoverageForRange(item, cameraRange.from, cameraRange.to, configuredCameraTimeZone(context.settings)) }))
      .filter(entry => entry.coverage && entry.coverage.durationSeconds > 0);

    const coverage = assessIntervalCoverage({
      from: new Date(zonedDateTimeToEpochMs(selection.from, configuredDisplayTimeZone(context.settings))).toISOString(),
      to: new Date(zonedDateTimeToEpochMs(selection.to, configuredDisplayTimeZone(context.settings))).toISOString(),
      intervals: items.map(entry => ({
        from: new Date(absoluteSegmentEpochMs(entry.item.startTime || cameraRange.from, entry.coverage.offsetSeconds, configuredCameraTimeZone(context.settings))).toISOString(),
        to: new Date(absoluteSegmentEpochMs(entry.item.startTime || cameraRange.from, entry.coverage.offsetSeconds + entry.coverage.durationSeconds, configuredCameraTimeZone(context.settings))).toISOString()
      }))
    });
    selectionDiagnostic.archiveCoverage = coverage;
    selectionDiagnostic.recordings = items.length;
    const unconfirmed = searchData.searchComplete === false || searchData.searchOutcome === 'unconfirmed';
    if (!items.length || unconfirmed || !coverage.complete) {
      const code = unconfirmed ? 'ARCHIVE_UNCONFIRMED' : !items.length ? 'NO_RECORDINGS' : 'ARCHIVE_GAPS';
      const reason = unconfirmed ? 'Регистратор не подтвердил доступность полного архива (Ret=119).'
        : !items.length ? 'Регистратор не вернул записи за выбранный период.'
        : `Архив не покрывает весь период: отсутствует ${Math.round(coverage.missingSeconds)} с.`;
      warnings.push(`${label}: ${reason}`);
      issues.push({
        stage: 'search', code, label, channel: selection.channel,
        from: selection.from, to: selection.to, error: reason,
        gaps: coverage.gaps, details: searchData.details
      });
    }

    result.knownRecordings += items.length;
    await context.onProgress?.({
      knownRecordings: result.knownRecordings,
      selectionTotalSeconds: items.reduce((sum, entry) => sum + entry.coverage.durationSeconds, 0)
    });
    if (!items.length) {
      await finishSelection(selection, warningStart, issueStart);
      continue;
    }

    const baseCompletedChunks = progress.completedChunks || 0;
    const processingStartedAt = Date.now();
    selectionDiagnostic.status = 'transcript';
    const baseTranscribedSeconds = progress.transcribedSeconds || 0;
    const recordingProgress = items.map(() => ({
      completedChunks: 0,
      transcribedSeconds: 0,
      selectionProcessedSeconds: 0
    }));
    const recordingContextLines = items.map(() => []);
    const recordingTranscriptEntries = items.map(() => []);
    let progressQueue = Promise.resolve();
    const publishRecordingProgress = (index, update = {}) => {
      if (update.recordingCapture) {
        selectionDiagnostic.captures ||= [];
        selectionDiagnostic.captures[index] = update.recordingCapture;
      }
      if (update.transcriptTiming?.cached) selectionDiagnostic.cachedChunks += 1;
      else if (update.transcriptTiming) {
        selectionDiagnostic.captureMs += Number(update.transcriptTiming.captureMs) || 0;
        selectionDiagnostic.asrMs += Number(update.transcriptTiming.asrMs) || 0;
      }
      const state = recordingProgress[index];
      for (const key of ['completedChunks', 'transcribedSeconds', 'selectionProcessedSeconds']) {
        if (Number.isFinite(Number(update[key]))) state[key] = Number(update[key]);
      }
      const aggregate = key => recordingProgress.reduce((sum, item) => sum + (Number(item[key]) || 0), 0);
      const globalUpdate = {
        ...update,
        completedChunks: baseCompletedChunks + aggregate('completedChunks'),
        transcribedSeconds: baseTranscribedSeconds + aggregate('transcribedSeconds'),
        selectionProcessedSeconds: aggregate('selectionProcessedSeconds')
      };
      progressQueue = progressQueue.then(() => context.onProgress?.(globalUpdate));
      return progressQueue;
    };

    let recordingResults = [];
    try {
      recordingResults = await mapWithConcurrency(
        items,
        cameraConfig().transcriptionRecordingConcurrency,
        async (entry, index) => {
          context.signal?.throwIfAborted();
          const localProgress = {};
          let failure = null;
          try {
            await transcribeScheduledRecording({
              item: entry.item,
              coverage: entry.coverage,
              selection,
              settings: context.settings,
              labels: context.labels,
              vendor: searchData.vendor || '',
              contextLines: recordingContextLines[index],
              transcriptEntries: recordingTranscriptEntries[index],
              requestApi,
              progress: localProgress,
              signal: context.signal,
              onProgress: update => {
                Object.assign(localProgress, update);
                return publishRecordingProgress(index, update);
              }
            });
            result.completedRecordings += 1;
            selectionDiagnostic.completedRecordings += 1;
            await publishRecordingProgress(index, { completedRecordings: result.completedRecordings });
          } catch (error) {
            context.signal?.throwIfAborted();
            failure = error;
          } finally {
            await publishRecordingProgress(index, {
              selectionProcessedSeconds: entry.coverage.durationSeconds
            });
          }
          return { entry, failure, index };
        }
      );
      // EOF or a timeout without audio proves only that capture failed. It
      // cannot establish silence or an audio gap in the source recording.
      result.failedRecordings += recordingResults.filter(item => item.failure).length;
      await progressQueue;
    } finally {
      selectionDiagnostic.processingMs = Date.now() - processingStartedAt;
      selectionDiagnostic.processedSeconds = recordingProgress.reduce((sum, item) => sum + item.transcribedSeconds, 0);
      for (const lines of recordingContextLines) contextLines.push(...lines);
      for (const entries of recordingTranscriptEntries) transcriptEntries.push(...entries);
    }

    for (const recordingResult of recordingResults) {
      if (!recordingResult.failure) continue;
      const recording = recordingResult.entry.item.fileName
        || recordingResult.entry.item.startTime
        || 'архивный фрагмент';
      warnings.push(`${label}: ${recording}: ${publicError(recordingResult.failure)}`);
      issues.push({
        stage: 'transcript', code: 'TRANSCRIPTION_FAILED', label, channel: selection.channel,
        fileName: recording, error: publicError(recordingResult.failure), status: recordingResult.failure.statusCode,
        ...recordingResult.failure.details
      });
    }
    await finishSelection(selection, warningStart, issueStart);
  }

  if (!result.completedRecordings && !contextLines.length && (result.failedSearches || result.failedRecordings)) {
    const firstIssue = issues.find(issue => issue.error);
    const cause = firstIssue ? ` Причина (${firstIssue.label}): ${firstIssue.error}` : '';
    throw httpError(
      502,
      `Не удалось получить пригодный транскрипт: ошибок поиска ${result.failedSearches}, ошибок записей ${result.failedRecordings}.${cause}`,
      {
        stage: result.failedRecordings ? 'transcript' : 'search',
        failedSearches: result.failedSearches,
        failedRecordings: result.failedRecordings,
        issues,
        warnings: warnings.slice(-100)
      }
    );
  }

  return result;
}

async function searchScheduledRecordings(requestApi, searchPath, options = {}) {
  const { signal } = options;
  const wait = options.delay || (ms => waitFor(ms, undefined, { signal }));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await requestApi(searchPath, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      const status = Number(error.statusCode || 0);
      const code = error.code || error.details?.code || error.cause?.code;
      const transient = [408, 502, 503, 504].includes(status)
        || ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE'].includes(code)
        || ((!status || status === 500) && /Request timed out|socket hang up/i.test(error.message || ''));
      if (attempt === 1 || !transient || (status >= 400 && status < 500 && status !== 408)) throw error;
      await wait(1000);
    }
  }
}

function assertDriveTranscriptComplete(result = {}) {
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const failedSearches = Number(result.failedSearches || 0);
  const failedRecordings = Number(result.failedRecordings || 0);
  const issues = [...(Array.isArray(result.issues) ? result.issues : [])];
  const addIncomplete = (item, reason) => issues.push({
    stage: 'transcript', code: 'INCOMPLETE_TRANSCRIPT', channel: item?.channel,
    from: item?.from || item?.start, to: item?.to || item?.end,
    error: reason
  });
  if (result.partial === true || result.completeness === 'partial' || result.complete === false) {
    addIncomplete(result, 'Полнота транскрибации не подтверждена.');
  }
  for (const diagnostic of Array.isArray(result.diagnostics) ? result.diagnostics : []) {
    const hasCameraIssue = () => issues.some(issue => !issue?.channel || Number(issue.channel) === Number(diagnostic.channel));
    if (!hasCameraIssue() && Array.isArray(diagnostic.issues)) issues.push(...diagnostic.issues);
    if (!hasCameraIssue() && (diagnostic.partial === true || diagnostic.completeness === 'partial'
      || diagnostic.archiveCoverage?.complete === false
      || (diagnostic.status && !['complete', 'skipped'].includes(diagnostic.status)))) {
      addIncomplete(diagnostic, 'Полнота обработки камеры или покрытия архива не подтверждена.');
    }
  }
  for (const entry of result.transcriptEntries || result.entries || []) {
    // Legacy audio_gap entries were generated from failed captures. They are
    // not proof of silence and must never become a complete Drive report.
    if (entry?.kind === 'audio_gap' || entry?.type === 'audio_gap' || entry?.audioGap === true
      || entry?.partial === true || entry?.completeness === 'partial') {
      addIncomplete(entry, 'Пропуск аудио не подтверждён как корректно обработанная тишина.');
    }
  }
  if (!issues.length && !failedSearches && !failedRecordings) return;
  const first = issues[0];
  const channels = [...new Set(issues.map(issue => issue.channel).filter(Boolean))].join(', ');
  throw httpError(502, `Период обработан не полностью${channels ? `; камеры: ${channels}` : ''}. ${first?.error || 'Не все записи обработаны.'} Доступные результаты сохранены локально; неполные камеры не выгружены.`, {
    stage: first?.stage || (failedSearches ? 'search' : 'transcript'),
    failedSearches,
    failedRecordings,
    warnings: warnings.slice(-100),
    issues
  });
}

function configuredCameraTimeZone(settings = {}) {
  return normalizeTimeZone(settings?.cameraTimeZone || process.env.CAMERA_TIME_ZONE, 'Europe/Moscow');
}

function configuredDisplayTimeZone(settings = {}) {
  return normalizeTimeZone(
    settings?.displayTimeZone || process.env.DISPLAY_TIME_ZONE || process.env.TZ,
    'Asia/Yekaterinburg'
  );
}

function normalizeRecordingSearchTimeRange(searchParams) {
  const params = new URLSearchParams(searchParams);
  const requestedFrom = String(params.get('from') || '').trim();
  const requestedTo = String(params.get('to') || '').trim();
  const sourceTimeZone = normalizeTimeZone(params.get('timeZone') || '', configuredDisplayTimeZone());
  const targetTimeZone = normalizeTimeZone(params.get('cameraTimeZone') || '', configuredCameraTimeZone());
  let cameraFrom = requestedFrom;
  let cameraTo = requestedTo;
  const hasExplicitZone = value => /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  try {
    if (requestedFrom && (params.has('timeZone') || hasExplicitZone(requestedFrom))) {
      cameraFrom = localDateTimeInZone(zonedDateTimeToEpochMs(requestedFrom, sourceTimeZone), targetTimeZone, { seconds: false });
    }
    if (requestedTo && (params.has('timeZone') || hasExplicitZone(requestedTo))) {
      cameraTo = localDateTimeInZone(zonedDateTimeToEpochMs(requestedTo, sourceTimeZone), targetTimeZone, { seconds: false });
    }
  } catch (error) {
    throw httpError(400, `Некорректный период или часовой пояс: ${publicError(error)}`);
  }
  if (cameraFrom) params.set('from', cameraFrom);
  if (cameraTo) params.set('to', cameraTo);
  params.delete('timeZone');
  params.delete('cameraTimeZone');
  return {
    params,
    publicRange: {
      requestedFrom,
      requestedTo,
      cameraFrom,
      cameraTo,
      displayTimeZone: sourceTimeZone,
      cameraTimeZone: targetTimeZone
    }
  };
}

function publicGoogleDriveConfig() {
  try {
    const config = readGoogleDriveConfig();
    const oauthConfigured = Boolean(config.clientId && config.clientSecret && config.refreshToken);
    const serviceAccountConfigured = Boolean(config.clientEmail && config.privateKey);
    const resolvedAuthType = config.authType === 'auto'
      ? oauthConfigured ? 'oauth' : serviceAccountConfigured ? 'service_account' : ''
      : config.authType;
    const credentialsConfigured = resolvedAuthType === 'oauth'
      ? oauthConfigured
      : resolvedAuthType === 'service_account' && serviceAccountConfigured;
    return {
      configured: Boolean(config.rootFolderId && credentialsConfigured),
      rootFolderId: config.rootFolderId || '',
      authType: resolvedAuthType,
      account: resolvedAuthType === 'service_account' ? config.clientEmail : '',
      folderUrl: config.rootFolderId ? `https://drive.google.com/drive/folders/${config.rootFolderId}` : ''
    };
  } catch (error) {
    return { configured: false, rootFolderId: '', authType: '', account: '', error: publicError(error) };
  }
}

async function mapWithConcurrency(items, requestedConcurrency, worker) {
  const values = Array.from(items || []);
  if (!values.length) return [];
  const concurrency = Math.min(values.length, clampNumber(Number(requestedConcurrency) || 1, 1, 4));
  const results = new Array(values.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: concurrency }, run));
  const rejected = settled.find(item => item.status === 'rejected');
  if (rejected) throw rejected.reason;
  return results;
}

async function transcribeScheduledRecording(options) {
  // Resolve the persisted model before taking the config snapshot and building
  // cache keys (also when invoked outside the normal server startup path).
  if (options.requestApi === localJsonApi) await transcriptionModelSettings.initialize();
  const config = cameraConfig();
  const vendor = normalizeVendor(options.vendor || options.settings?.vendor || config.vendor);
  if (config.transcriptionXmProgressive && vendor === 'xm' && options.requestApi === localJsonApi) {
    return transcribeXmScheduledRecordingStream({ ...options, config, vendor });
  }
  return transcribeScheduledRecordingByBlocks(options);
}

async function transcribeScheduledRecordingByBlocks(options) {
  let offsetSeconds = options.coverage.offsetSeconds;
  const endOffsetSeconds = options.coverage.offsetSeconds + options.coverage.durationSeconds;
  const chunkSeconds = scheduledTranscriptSeconds(options.settings);

  while (offsetSeconds < endOffsetSeconds - 0.05) {
    options.signal?.throwIfAborted();
    const remainingSeconds = Math.max(0, endOffsetSeconds - offsetSeconds);
    const durationSeconds = Math.min(chunkSeconds, remainingSeconds);
    const query = scheduledRecordingQuery(
      options.item,
      options.selection.channel,
      options.coverage,
      options.settings,
      options.vendor
    );
    query.set('duration', String(durationSeconds));
    query.set('offsetSeconds', String(offsetSeconds));
    query.set('_', Date.now());

    const chunk = {
      stage: 'transcript', channel: options.selection.channel,
      fileName: options.item.fileName || '', offsetSeconds, durationSeconds,
      from: scheduledChunkTime(options, offsetSeconds),
      to: scheduledChunkTime(options, offsetSeconds + durationSeconds)
    };
    await options.onProgress?.(chunk);
    let data;
    try {
      data = await (options.requestApi || localJsonApi)(`/api/recordings/transcript?${query}`, { signal: options.signal });
      options.signal?.throwIfAborted();
    } catch (error) {
      throw httpError(error.statusCode || 502, publicError(error), { ...chunk, cause: error.details });
    }
    const finalBlock = durationSeconds >= remainingSeconds - 0.05;
    if (!isTranscriptCachePayloadComplete(data, durationSeconds, { toleranceSeconds: finalBlock ? 1 : 0.1 })) {
      throw httpError(502, 'Получен неполный аудиофрагмент; требуется повторное получение, а не отметка об отсутствии речи.', {
        ...chunk, code: 'INCOMPLETE_AUDIO', expectedDurationSeconds: durationSeconds,
        receivedDurationSeconds: data.durationSeconds
      });
    }
    appendScheduledOpenAiContext({
      contextLines: options.contextLines,
      transcriptEntries: options.transcriptEntries,
      labels: options.labels,
      selection: options.selection,
      item: options.item,
      settings: options.settings,
      segments: data.segments,
      fallbackText: data.text,
      fallbackStartSeconds: offsetSeconds,
      fallbackEndSeconds: offsetSeconds + Math.max(
        0,
        Math.min(Number(data.durationSeconds) || durationSeconds, remainingSeconds)
      )
    });

    const consumedSeconds = Math.min(data.durationSeconds, remainingSeconds);
    offsetSeconds += consumedSeconds;
    const progress = options.progress || {};
    await options.onProgress?.({
      completedChunks: (progress.completedChunks || 0) + 1,
      transcribedSeconds: (progress.transcribedSeconds || 0) + consumedSeconds,
      selectionProcessedSeconds: (progress.selectionProcessedSeconds || 0) + consumedSeconds,
      transcriptTiming: { cached: Boolean(data.cached), ...(data.timings || {}) }
    });
    if (finalBlock) return;
  }
}

const XM_PROGRESSIVE_CACHE_PIPELINE = 'xm-continuous-pcm-v1';
const TRANSCRIPTION_PCM_SAMPLE_RATE = 16000;
const TRANSCRIPTION_PCM_BYTES_PER_SAMPLE = 2;
const XM_RECORDING_END_TOLERANCE_SECONDS = 1;
const XM_PARTIAL_TAIL_MIN_SECONDS = 0.25;

function xmArchiveEndShortfallIsTolerable(expectedSeconds, receivedSeconds) {
  if (!(expectedSeconds > 0) || !(receivedSeconds > 0)) return false;
  const toleranceSeconds = Math.min(XM_RECORDING_END_TOLERANCE_SECONDS, expectedSeconds * 0.1);
  return receivedSeconds + toleranceSeconds >= expectedSeconds;
}

function xmArchivePartialTailIsUsable(expectedSeconds, receivedSeconds) {
  return expectedSeconds > 0
    && receivedSeconds >= XM_PARTIAL_TAIL_MIN_SECONDS
    && receivedSeconds < expectedSeconds;
}

function xmRecoveryCacheVariants(options, block, context) {
  return xmRecoveryPlans(block, options.coverage.offsetSeconds).map(plan => {
    const query = new URLSearchParams(context.baseQuery);
    query.set('duration', String(block.durationSeconds));
    query.set('offsetSeconds', String(block.offsetSeconds));
    return { plan, cacheKey: transcriptCacheKey(context.config, query, {
      vendor: 'xm', channel: context.channel, stream: context.stream,
      audioFilter: context.audioFilter, durationSeconds: block.durationSeconds,
      offsetSeconds: block.offsetSeconds, pipeline: XM_RECOVERY_PIPELINE,
      anchorOffsetSeconds: plan.captureOffsetSeconds,
      sessionEndOffsetSeconds: block.offsetSeconds + block.durationSeconds
    }) };
  });
}

async function readXmRecoveryCache(options, block, context) {
  const readCache = context.services?.readCache || readTranscriptCache;
  for (const variant of xmRecoveryCacheVariants(options, block, context)) {
    const cached = await readCache(variant.cacheKey);
    if (cached?.source?.recovery?.sourceAudioComplete === true
      && isTranscriptCachePayloadComplete(cached, block.durationSeconds, { toleranceSeconds: 0.05 })) return cached;
  }
  return null;
}

async function transcribeXmRecoveryBlock(options, block, context) {
  const services = context.services || {};
  const cached = await readXmRecoveryCache(options, block, context);
  if (cached) return { ...cached, cached: true };
  const openSession = services.openSession || (capture => openXmArchivePcmSession(
    context.config, context.baseQuery, context.channel, context.stream,
    { ...capture, audioFilter: context.audioFilter }
  ));
  let lastError;
  for (const { plan, cacheKey } of xmRecoveryCacheVariants(options, block, context)) {
    options.signal?.throwIfAborted();
    let audio;
    const captureStartedAt = Date.now();
    try {
      audio = await readXmRecoveryPcm(plan, openSession, options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error.details?.code !== 'INCOMPLETE_AUDIO') throw error;
      lastError = error;
      // A warmup seek can land on another packet boundary. One direct request
      // is allowed; neither a short stream nor repeated EOF proves silence.
      continue;
    }
    const captureMs = Date.now() - captureStartedAt;
    const audioPath = path.join(TRANSCRIPT_DIR, `archive-recovery-${Date.now()}-${crypto.randomUUID()}.wav`);
    try {
      await (services.writeWav || writePcm16Wav)(audioPath, audio.pcm, TRANSCRIPTION_PCM_SAMPLE_RATE, 1);
      const asrStartedAt = Date.now();
      const result = await (services.transcribe || transcribeWithGigaAm)(context.config, audioPath, {
        chunkSeconds: context.config.transcriptionChunkSeconds,
        offsetSeconds: block.offsetSeconds, signal: options.signal
      });
      const asrMs = Date.now() - asrStartedAt;
      if (!isTranscriptCachePayloadComplete(result, audio.durationSeconds, { toleranceSeconds: 0.05 })
        || !isTranscriptCachePayloadComplete(result, block.durationSeconds, { toleranceSeconds: 0.05 })) {
        throw httpError(502, 'Модель вернула результат без подтверждённой длительности аудио.', {
          code: 'INVALID_ASR_DURATION', expectedDurationSeconds: audio.durationSeconds,
          receivedDurationSeconds: result.durationSeconds
        });
      }
      const payload = {
        ok: true, mode: 'archive', vendor: 'xm', channel: context.channel,
        stream: context.stream, audioFilter: context.audioFilter, model: context.config.gigaamModel,
        from: scheduledChunkTime(options, block.offsetSeconds),
        to: scheduledChunkTime(options, block.offsetSeconds + result.durationSeconds),
        offsetSeconds: block.offsetSeconds, durationSeconds: result.durationSeconds, partial: false,
        text: result.text, segments: result.segments || [],
        source: {
          version: 2, host: context.config.host, fileName: options.item.fileName || '',
          recordingStart: options.item.startTime,
          cameraTimeZone: configuredCameraTimeZone(options.settings),
          requestedDurationSeconds: block.durationSeconds,
          recovery: { ...plan, sourceAudioComplete: true, rawBytes: audio.stats.rawBytes,
            timingBasis: 'recorder-requested-seek-and-sample-count' }
        },
        tookMs: captureMs + asrMs,
        timings: { pipeline: XM_RECOVERY_PIPELINE, anchorOffsetSeconds: plan.captureOffsetSeconds,
          sessionEndOffsetSeconds: block.offsetSeconds + block.durationSeconds,
          discardSeconds: plan.discardSeconds, captureMs, asrMs, totalMs: captureMs + asrMs }
      };
      await (services.writeCache || writeTranscriptCache)(cacheKey, payload);
      await options.onProgress?.({ recordingCapture: {
        fileName: options.item.fileName || '', ...audio.stats,
        recovery: true, offsetSeconds: block.offsetSeconds,
        captureOffsetSeconds: plan.captureOffsetSeconds, discardSeconds: plan.discardSeconds
      } });
      return payload;
    } finally {
      await (services.unlink || (file => fs.promises.unlink(file).catch(() => {})))(audioPath);
    }
  }
  throw lastError || httpError(502, 'Не удалось получить аудиофрагмент целиком.', { code: 'INCOMPLETE_AUDIO' });
}

async function transcribeXmScheduledRecordingStream(options) {
  const config = options.config || cameraConfig();
  const channel = positiveInt(String(options.selection.channel), 1);
  const stream = String(options.settings?.stream || 'main');
  const audioFilter = normalizeAudioFilter(options.settings?.audioFilter || config.audioFilter);
  const chunkSeconds = scheduledTranscriptSeconds(options.settings);
  const endOffsetSeconds = options.coverage.offsetSeconds + options.coverage.durationSeconds;
  const baseQuery = scheduledRecordingQuery(
    options.item,
    channel,
    options.coverage,
    options.settings,
    'xm'
  );
  const blocks = [];
  const recoveryContext = { config, baseQuery, channel, stream, audioFilter };

  for (let offsetSeconds = options.coverage.offsetSeconds; offsetSeconds < endOffsetSeconds - 0.05;) {
    const durationSeconds = Math.min(chunkSeconds, endOffsetSeconds - offsetSeconds);
    const query = new URLSearchParams(baseQuery);
    query.set('duration', String(durationSeconds));
    query.set('offsetSeconds', String(offsetSeconds));
    const cacheKey = transcriptCacheKey(config, query, {
      vendor: 'xm', channel, stream, audioFilter, durationSeconds, offsetSeconds,
      pipeline: XM_PROGRESSIVE_CACHE_PIPELINE,
      anchorOffsetSeconds: options.coverage.offsetSeconds,
      sessionEndOffsetSeconds: endOffsetSeconds
    });
    blocks.push({ offsetSeconds, durationSeconds, cacheKey });
    offsetSeconds += durationSeconds;
  }

  let blockIndex = 0;
  let firstMissingCacheLookupMs = 0;
  let hasIncompleteCache = false;
  while (blockIndex < blocks.length) {
    options.signal?.throwIfAborted();
    const lookupStartedAt = Date.now();
    let cached = await readTranscriptCache(blocks[blockIndex].cacheKey);
    const storedPayload = cached;
    if (!isTranscriptCachePayloadComplete(cached, blocks[blockIndex].durationSeconds, {
      toleranceSeconds: 0.05
    })) cached = await readXmRecoveryCache(options, blocks[blockIndex], recoveryContext);
    const cacheLookupMs = Date.now() - lookupStartedAt;
    if (!isTranscriptCachePayloadComplete(cached, blocks[blockIndex].durationSeconds, {
      toleranceSeconds: 0.05
    })) {
      hasIncompleteCache = Boolean(storedPayload);
      firstMissingCacheLookupMs = cacheLookupMs;
      break;
    }
    const cachedBlock = blocks[blockIndex];
    await publishScheduledTranscriptBlock(options, cachedBlock, cached, { cached: true, cacheLookupMs });
    blockIndex += 1;
  }
  if (blockIndex >= blocks.length) return;

  assertTranscriptionPrepared();
  await transcriptionModelSettings.initialize().catch(() => {});
  if (transcriptionModelSettings.saving) {
    throw httpError(503, 'Выбор модели сохраняется. Повторите запрос после сохранения.');
  }
  requireCameraAuth(config);
  const ffmpeg = await checkFfmpeg(config.ffmpegPath);
  if (!ffmpeg.available) {
    throw httpError(503, 'ffmpeg is not available. Install ffmpeg or set FFMPEG_PATH to ffmpeg.exe.', ffmpeg);
  }
  const transcriber = await checkTranscriber(config.pythonPath);
  if (!transcriber.available) {
    throw httpError(503, 'GigaAM is not available. Install the Python gigaam package or set PYTHON_PATH.', transcriber);
  }

  await fs.promises.mkdir(TRANSCRIPT_DIR, { recursive: true });
  const useTargetedRecovery = await shouldRecoverXmRecordingFromCache(blocks, blockIndex, hasIncompleteCache,
    async block => {
      options.signal?.throwIfAborted();
      const cached = await readTranscriptCache(block.cacheKey);
      return isTranscriptCachePayloadComplete(cached, block.durationSeconds, {
        toleranceSeconds: 0.05
      }) || Boolean(await readXmRecoveryCache(options, block, recoveryContext));
    });
  if (useTargetedRecovery) {
    // Preserve the completed prefix. Each missing block has a bounded seek and
    // its own versioned filter anchor; do not decode the whole prefix again.
    activeTranscriptionRequests += 1;
    try {
      for (; blockIndex < blocks.length; blockIndex += 1) {
        const block = blocks[blockIndex];
        options.signal?.throwIfAborted();
        await options.onProgress?.(scheduledTranscriptChunkDetails(options, block));
        try {
          const cached = await readTranscriptCache(block.cacheKey);
          const payload = isTranscriptCachePayloadComplete(cached, block.durationSeconds, {
            toleranceSeconds: 0.05
          }) ? { ...cached, cached: true } : await transcribeXmRecoveryBlock(options, block, recoveryContext);
          await publishScheduledTranscriptBlock(options, block, payload, {
            ...payload.timings, cached: Boolean(payload.cached)
          }, false);
        } catch (error) {
          options.signal?.throwIfAborted();
          throw httpError(error.statusCode || 502, publicError(error), {
            ...scheduledTranscriptChunkDetails(options, block),
            pipeline: XM_RECOVERY_PIPELINE, cause: error.details
          });
        }
      }
      return;
    } finally {
      activeTranscriptionRequests -= 1;
    }
  }
  const firstBlockIndex = blockIndex;
  // Always start at the coverage anchor. The voice filter is stateful, so a
  // cached block must not depend on which earlier block happened to miss.
  const captureOffsetSeconds = options.coverage.offsetSeconds;
  const captureDurationSeconds = options.coverage.durationSeconds;
  const bytesPerChunk = Math.round(
    chunkSeconds * TRANSCRIPTION_PCM_SAMPLE_RATE * TRANSCRIPTION_PCM_BYTES_PER_SAMPLE
  );
  let session;
  let pcmSpool;
  let currentBlock = blocks[blockIndex];
  let totalAsrMs = 0;
  let totalCaptureMs = 0;
  activeTranscriptionRequests += 1;

  try {
    session = await openXmArchivePcmSession(config, baseQuery, channel, stream, {
      audioFilter,
      durationSeconds: captureDurationSeconds,
      offsetSeconds: captureOffsetSeconds,
      signal: options.signal
    });
    // Drain the recorder continuously even while ASR is loading/processing.
    // A temporary bounded PCM file keeps RAM bounded and still exposes the
    // first block immediately, without waiting for the whole recording.
    pcmSpool = await createPcmSpool(session.readable, {
      directory: TRANSCRIPT_DIR,
      maxBytes: Math.ceil((captureDurationSeconds + 0.1) * TRANSCRIPTION_PCM_SAMPLE_RATE * TRANSCRIPTION_PCM_BYTES_PER_SAMPLE),
      signal: options.signal
    });
    const iterator = chunkFixedPcm(pcmSpool.readable, bytesPerChunk)[Symbol.asyncIterator]();

    if (firstBlockIndex > 0) {
      const skippedCaptureStartedAt = Date.now();
      for (let skippedIndex = 0; skippedIndex < firstBlockIndex; skippedIndex += 1) {
        const skipped = await iterator.next();
        if (skipped.done) {
          throw httpError(502, 'Архивный поток оборвался до необработанного фрагмента; кэш сохранён.', {
            code: 'INCOMPLETE_AUDIO', offsetSeconds: currentBlock.offsetSeconds, endOffsetSeconds
          });
        }
        const skippedDurationSeconds = skipped.value.length
          / (TRANSCRIPTION_PCM_SAMPLE_RATE * TRANSCRIPTION_PCM_BYTES_PER_SAMPLE);
        if (skippedDurationSeconds + 0.1 < blocks[skippedIndex].durationSeconds) {
          throw httpError(502, 'Архивный поток короче сохранённого кэша; требуется повторное получение аудио.', {
            code: 'INCOMPLETE_AUDIO', offsetSeconds: currentBlock.offsetSeconds, endOffsetSeconds
          });
        }
      }
      totalCaptureMs += Date.now() - skippedCaptureStartedAt;
    }

    while (blockIndex < blocks.length) {
      options.signal?.throwIfAborted();
      currentBlock = blocks[blockIndex];
      const chunkDetails = scheduledTranscriptChunkDetails(options, currentBlock);
      await options.onProgress?.(chunkDetails);

      let cacheLookupMs = blockIndex === firstBlockIndex ? firstMissingCacheLookupMs : 0;
      let cached = null;
      if (blockIndex !== firstBlockIndex) {
        const lookupStartedAt = Date.now();
        cached = await readTranscriptCache(currentBlock.cacheKey);
        if (!isTranscriptCachePayloadComplete(cached, currentBlock.durationSeconds, {
          toleranceSeconds: 0.05
        })) cached = null;
        cacheLookupMs = Date.now() - lookupStartedAt;
      }

      const captureStartedAt = Date.now();
      const next = await iterator.next();
      const captureMs = Date.now() - captureStartedAt;
      totalCaptureMs += captureMs;
      if (next.done) {
        const captureStats = await session.done;
        if (blockIndex === blocks.length - 1) {
          const recovered = await transcribeXmRecoveryBlock(options, currentBlock, recoveryContext);
          await publishScheduledTranscriptBlock(options, currentBlock, recovered, recovered.timings, false);
          blockIndex += 1;
          continue;
        }
        throw httpError(502, 'Архивное аудио закончилось до конца периода; готовые блоки сохранены.', {
          code: 'INCOMPLETE_AUDIO', sourceGapConfirmed: false,
          offsetSeconds: currentBlock.offsetSeconds, endOffsetSeconds,
          expectedDurationSeconds: currentBlock.durationSeconds, receivedDurationSeconds: 0, captureStats
        });
      }

      const pcm = next.value;
      const pcmDurationSeconds = pcm.length
        / (TRANSCRIPTION_PCM_SAMPLE_RATE * TRANSCRIPTION_PCM_BYTES_PER_SAMPLE);
      const tolerableRecordingTail = blockIndex === blocks.length - 1
        && isTranscriptCachePayloadComplete({ durationSeconds: pcmDurationSeconds }, currentBlock.durationSeconds, {
          toleranceSeconds: 0.05
        });
      const usablePartialTail = !tolerableRecordingTail && xmArchivePartialTailIsUsable(
        currentBlock.durationSeconds,
        pcmDurationSeconds
      );
      if (usablePartialTail && blockIndex === blocks.length - 1) {
        // EOF is not proof that the source is silent: retry this exact block
        // before rejecting a whole day's export. Keep the original cache key
        // untouched because the new filter anchor is different.
        await session.done;
        const recovered = await transcribeXmRecoveryBlock(options, currentBlock, recoveryContext);
        await publishScheduledTranscriptBlock(options, currentBlock, recovered, recovered.timings, false);
        blockIndex += 1;
        continue;
      }
      if (pcmDurationSeconds + 0.1 < currentBlock.durationSeconds
        && !tolerableRecordingTail
        && !usablePartialTail) {
        throw httpError(502, 'XM archive audio block is shorter than expected.', {
          expectedDurationSeconds: currentBlock.durationSeconds,
          receivedDurationSeconds: pcmDurationSeconds
        });
      }

      if (cached) {
        await publishScheduledTranscriptBlock(options, currentBlock, cached, {
          cached: true, cacheLookupMs, captureMs
        }, false);
        blockIndex += 1;
        continue;
      }

      const audioPath = path.join(
        TRANSCRIPT_DIR,
        `archive-stream-${Date.now()}-${crypto.randomUUID()}.wav`
      );
      try {
        await writePcm16Wav(audioPath, pcm, TRANSCRIPTION_PCM_SAMPLE_RATE, 1);
        const asrStartedAt = Date.now();
        const result = await transcribeWithGigaAm(config, audioPath, {
          chunkSeconds: config.transcriptionChunkSeconds,
          offsetSeconds: currentBlock.offsetSeconds,
          signal: options.signal
        });
        const asrMs = Date.now() - asrStartedAt;
        totalAsrMs += asrMs;
        if (!isTranscriptCachePayloadComplete(result, pcmDurationSeconds, { toleranceSeconds: 0.1 })) {
          throw httpError(502, 'Модель вернула результат без подтверждённой длительности аудио.', {
            code: 'INVALID_ASR_DURATION', expectedDurationSeconds: pcmDurationSeconds,
            receivedDurationSeconds: result.durationSeconds
          });
        }
        const payload = {
          ok: true,
          mode: 'archive',
          vendor: 'xm',
          channel,
          stream,
          from: scheduledChunkTime(options, currentBlock.offsetSeconds),
          to: scheduledChunkTime(options, currentBlock.offsetSeconds + result.durationSeconds),
          offsetSeconds: currentBlock.offsetSeconds,
          audioFilter,
          model: config.gigaamModel,
          durationSeconds: result.durationSeconds,
          partial: usablePartialTail,
          source: {
            version: 1, host: config.host, fileName: options.item.fileName || '',
            recordingStart: options.item.startTime, cameraTimeZone: configuredCameraTimeZone(options.settings),
            requestedDurationSeconds: currentBlock.durationSeconds
          },
          text: result.text,
          segments: result.segments || [],
          tookMs: cacheLookupMs + captureMs + asrMs,
          timings: {
            pipeline: XM_PROGRESSIVE_CACHE_PIPELINE,
            anchorOffsetSeconds: options.coverage.offsetSeconds,
            sessionEndOffsetSeconds: endOffsetSeconds,
            cacheLookupMs,
            captureMs,
            asrMs,
            totalMs: cacheLookupMs + captureMs + asrMs
          }
        };
        await writeTranscriptCache(currentBlock.cacheKey, payload);
        await publishScheduledTranscriptBlock(options, currentBlock, payload, payload.timings, false);
        if (usablePartialTail) {
          const captureStats = await session.done;
          throw httpError(502, 'Получен неполный аудиофрагмент; кэш сохранён, недостающий интервал будет запрошен повторно.', {
            code: 'INCOMPLETE_AUDIO', expectedDurationSeconds: currentBlock.durationSeconds,
            receivedDurationSeconds: pcmDurationSeconds,
            captureStats,
            missingFrom: scheduledChunkTime(options, currentBlock.offsetSeconds + pcmDurationSeconds),
            missingTo: scheduledChunkTime(options, endOffsetSeconds)
          });
        }
      } finally {
        await fs.promises.unlink(audioPath).catch(() => {});
      }
      blockIndex += 1;
    }

    const extra = await iterator.next();
    const toleratedTailBytes = Math.ceil(
      0.1 * TRANSCRIPTION_PCM_SAMPLE_RATE * TRANSCRIPTION_PCM_BYTES_PER_SAMPLE
    );
    if (!extra.done && extra.value?.length > toleratedTailBytes) {
      throw httpError(502, 'XM archive audio produced more data than the requested recording range.');
    }
    await pcmSpool.done;
    const sessionStats = await session.done;
    await options.onProgress?.({ recordingCapture: { fileName: options.item.fileName || '', ...sessionStats } });
    console.log(
      `XM progressive transcription: channel ${channel}, ${formatDuration(captureDurationSeconds)}s audio, `
      + `${sessionStats.captureMs}ms capture, ${totalCaptureMs}ms waiting, ${totalAsrMs}ms ASR, `
      + `${sessionStats.rawBytes} raw bytes.`
    );
  } catch (error) {
    options.signal?.throwIfAborted();
    const details = scheduledTranscriptChunkDetails(options, currentBlock || blocks[firstBlockIndex]);
    throw httpError(error.statusCode || 502, publicError(error), {
      ...details,
      pipeline: XM_PROGRESSIVE_CACHE_PIPELINE,
      cause: error.details
    });
  } finally {
    await session?.close().catch(() => {});
    await pcmSpool?.close().catch(error => console.warn(`PCM spool cleanup failed: ${publicError(error)}`));
    activeTranscriptionRequests -= 1;
  }
}

function scheduledTranscriptChunkDetails(options, block) {
  return {
    stage: 'transcript',
    channel: options.selection.channel,
    fileName: options.item.fileName || '',
    offsetSeconds: block.offsetSeconds,
    durationSeconds: block.durationSeconds,
    from: scheduledChunkTime(options, block.offsetSeconds),
    to: scheduledChunkTime(options, block.offsetSeconds + block.durationSeconds)
  };
}

function scheduledChunkTime(options, offsetSeconds) {
  const base = options.item.startTime || options.coverage.from;
  if (!options.settings?.cameraTimeZone && !options.settings?.displayTimeZone) {
    return addSecondsToLocalDateTime(base, offsetSeconds);
  }
  const epoch = absoluteSegmentEpochMs(base, offsetSeconds, configuredCameraTimeZone(options.settings));
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : addSecondsToLocalDateTime(base, offsetSeconds);
}

async function publishScheduledTranscriptBlock(options, block, data, timing = {}, publishStage = true) {
  if (publishStage) await options.onProgress?.(scheduledTranscriptChunkDetails(options, block));
  appendScheduledOpenAiContext({
    contextLines: options.contextLines,
    transcriptEntries: options.transcriptEntries,
    labels: options.labels,
    selection: options.selection,
    item: options.item,
    settings: options.settings,
    segments: data.segments,
    fallbackText: data.text,
    fallbackStartSeconds: block.offsetSeconds,
    fallbackEndSeconds: block.offsetSeconds + Math.max(
      0,
      Number(data.durationSeconds) || block.durationSeconds
    )
  });
  const progress = options.progress || {};
  const transcribedDurationSeconds = transcriptPayloadDuration(data, block.durationSeconds);
  await options.onProgress?.({
    completedChunks: (progress.completedChunks || 0) + 1,
    transcribedSeconds: (progress.transcribedSeconds || 0) + transcribedDurationSeconds,
    selectionProcessedSeconds: (progress.selectionProcessedSeconds || 0) + block.durationSeconds,
    transcriptTiming: timing
  });
}

function transcriptPayloadDuration(payload, fallbackSeconds) {
  const durationSeconds = Number(payload?.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return Number(fallbackSeconds) || 0;
  return Math.min(durationSeconds, Number(fallbackSeconds) || durationSeconds);
}

async function* chunkFixedPcm(readable, bytesPerChunk) {
  if (!Number.isSafeInteger(bytesPerChunk) || bytesPerChunk <= 0) {
    throw new TypeError('PCM bytesPerChunk must be a positive integer.');
  }
  let pending = Buffer.alloc(0);
  for await (const value of readable) {
    const incoming = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!incoming.length) continue;
    let data = pending.length ? Buffer.concat([pending, incoming]) : incoming;
    let offset = 0;
    while (data.length - offset >= bytesPerChunk) {
      yield Buffer.from(data.subarray(offset, offset + bytesPerChunk));
      offset += bytesPerChunk;
    }
    pending = offset < data.length ? Buffer.from(data.subarray(offset)) : Buffer.alloc(0);
  }
  if (pending.length) yield pending;
}

async function writePcm16Wav(filePath, pcm, sampleRate, channels) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 !== 0) {
    throw httpError(502, 'Decoded PCM audio is empty or misaligned.');
  }
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * TRANSCRIPTION_PCM_BYTES_PER_SAMPLE;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * TRANSCRIPTION_PCM_BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  await fs.promises.writeFile(filePath, Buffer.concat([header, pcm]));
}

function scheduledCameraParams(settings, channel, vendorOverride = '') {
  const config = cameraConfig();
  return {
    vendor: normalizeVendor(vendorOverride || settings?.vendor || config.vendor || 'auto'),
    channel: String(channel),
    stream: String(settings?.stream || 'main'),
    audioFilter: normalizeAudioFilter(settings?.audioFilter || config.audioFilter)
  };
}

function scheduledRecordingQuery(item, channel, fallback, settings, vendorOverride = '') {
  const query = new URLSearchParams({
    ...scheduledCameraParams(settings, channel, vendorOverride),
    from: item.startTime || fallback.from || '',
    to: item.endTime || fallback.to || ''
  });

  if (item.playbackUri) query.set('source', item.playbackUri);
  if (item.fileName) query.set('fileName', item.fileName);
  if (item.localBeginTime) query.set('localBeginTime', item.localBeginTime);
  if (item.localEndTime) query.set('localEndTime', item.localEndTime);
  if (item.sizeBytes) query.set('sizeBytes', item.sizeBytes);

  return query;
}

function scheduledTranscriptSeconds(settings) {
  const config = cameraConfig();
  return Math.min(
    clampNumber(Number(settings?.transcriptSeconds || config.transcriptionLiveSeconds || 18), 5, 60),
    archiveCaptureChunkSeconds(config)
  );
}

function scheduledReportTypes(candidate) {
  if (candidate?.action?.destination === 'drive') return [];
  if (candidate?.periodMode === 'daily' && candidate.action?.reportDaily) return ['daily'];
  if (candidate?.periodMode === 'weekly' && candidate.action?.reportWeekly) return ['weekly'];
  return [];
}

function channelLabelFromRows(labels, channel) {
  const row = (labels || []).find(item => Number(item.channel) === Number(channel));
  return row?.label || `Канал ${channel}`;
}

function selectionCameraRange(selection, settings = {}) {
  const displayTimeZone = configuredDisplayTimeZone(settings);
  const cameraTimeZone = configuredCameraTimeZone(settings);
  const convert = value => localDateTimeInZone(
    zonedDateTimeToEpochMs(value, displayTimeZone),
    cameraTimeZone,
    { seconds: true }
  );
  return { from: convert(selection.from), to: convert(selection.to), cameraTimeZone, displayTimeZone };
}

function appendScheduledOpenAiContext(options) {
  const segments = normalizedTranscriptSegments(options.segments, options.fallbackText, {
    start: options.fallbackStartSeconds,
    end: options.fallbackEndSeconds
  });
  const label = channelLabelFromRows(options.labels, options.selection.channel);
  const cameraTimeZone = configuredCameraTimeZone(options.settings);
  const displayTimeZone = configuredDisplayTimeZone(options.settings);
  for (const segment of segments) {
    const startMs = absoluteSegmentEpochMs(options.item.startTime, segment.start, cameraTimeZone);
    const endMs = absoluteSegmentEpochMs(options.item.startTime, segment.end, cameraTimeZone);
    const range = formatScheduledSegmentTime(options.item, segment, options.settings);
    options.contextLines.push([
      `[${options.selection.groupName || 'Группа'} | ${label} | ${range}]`,
      String(segment.text || '').trim()
    ].filter(Boolean).join(' '));
    if (Array.isArray(options.transcriptEntries)) {
      options.transcriptEntries.push({
        channel: Number(options.selection.channel),
        label,
        groupName: options.selection.groupName || 'Группа',
        start: Number.isFinite(startMs) ? new Date(startMs).toISOString() : '',
        end: Number.isFinite(endMs) ? new Date(endMs).toISOString() : '',
        displayTimeZone,
        text: String(segment.text || '').trim()
      });
    }
  }
  return segments.length;
}

function normalizedTranscriptSegments(segments = [], fallbackText = '', fallbackRange = {}) {
  const normalized = Array.isArray(segments) && segments.length
    ? segments
    : fallbackText
      ? [{
          text: fallbackText,
          start: fallbackRange.start,
          end: fallbackRange.end
        }]
      : [];
  return normalized.filter(segment => String(segment.text || '').trim());
}

function formatScheduledSegmentTime(item, segment, settings = {}) {
  const cameraTimeZone = configuredCameraTimeZone(settings);
  const displayTimeZone = configuredDisplayTimeZone(settings);
  const start = absoluteSegmentEpochMs(item.startTime, segment.start, cameraTimeZone);
  const end = absoluteSegmentEpochMs(item.startTime, segment.end, cameraTimeZone);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    return `${formatReportDateTime(new Date(start).toISOString(), displayTimeZone)} - ${formatReportDateTime(new Date(end).toISOString(), displayTimeZone)}`;
  }
  return `${formatReportDateTime(item.startTime, displayTimeZone, cameraTimeZone)} - ${formatReportDateTime(item.endTime, displayTimeZone, cameraTimeZone)}`;
}

function absoluteSegmentEpochMs(baseValue, offsetSeconds, sourceTimeZone = 'Europe/Moscow') {
  if (!Number.isFinite(Number(offsetSeconds))) return null;
  try {
    const baseMs = zonedDateTimeToEpochMs(baseValue, sourceTimeZone);
    return baseMs + (Number(offsetSeconds) * 1000);
  } catch {
    return Number.NaN;
  }
}

function recordingCoverageForRange(item, fromValue, toValue, sourceTimeZone = 'Europe/Moscow') {
  const parse = value => {
    try { return zonedDateTimeToEpochMs(value, sourceTimeZone); } catch { return Number.NaN; }
  };
  const rangeStartMs = parse(fromValue);
  const rangeEndMs = parse(toValue);
  const itemStartMs = parse(item.startTime || fromValue);
  const itemEndMs = parse(item.endTime || toValue);

  if (![rangeStartMs, rangeEndMs, itemStartMs, itemEndMs].every(Number.isFinite)) {
    const fallbackSeconds = secondsBetween(item.startTime || fromValue, item.endTime || toValue);
    return fallbackSeconds > 0
      ? {
          offsetSeconds: 0,
          durationSeconds: fallbackSeconds,
          from: item.startTime || fromValue,
          to: item.endTime || toValue
        }
      : null;
  }

  const startMs = Math.max(rangeStartMs, itemStartMs);
  const endMs = Math.min(rangeEndMs, itemEndMs);
  if (endMs <= startMs) return null;

  return {
    offsetSeconds: Math.max(0, (startMs - itemStartMs) / 1000),
    durationSeconds: (endMs - startMs) / 1000,
    from: formatLocalDateTime(new Date(startMs)),
    to: formatLocalDateTime(new Date(endMs))
  };
}

async function localJsonApi(pathname, options = {}) {
  const url = new URL(pathname, `http://127.0.0.1:${PORT}`);
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {})
  };
  const request = {
    method: options.method || 'GET',
    headers,
    signal: options.signal
  };

  if (options.body !== undefined) {
    request.headers['Content-Type'] = request.headers['Content-Type'] || 'application/json; charset=utf-8';
    request.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, request);
  const text = await response.text();
  const data = safeJsonParse(text) || {};

  if (!response.ok) {
    throw httpError(response.status || 502, data.error || `HTTP ${response.status}`, data.details);
  }

  return data;
}

function earliestLocalDateTime(values) {
  return sortedLocalDateTimes(values)[0] || '';
}

function latestLocalDateTime(values) {
  const sorted = sortedLocalDateTimes(values);
  return sorted[sorted.length - 1] || '';
}

function sortedLocalDateTimes(values) {
  return values
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .sort((left, right) => localDateTimeMs(left) - localDateTimeMs(right));
}

function localDateTimeMs(value) {
  try {
    const parts = localDateParts(value);
    const date = new Date(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    return date.getTime();
  } catch {
    const fallback = new Date(value).getTime();
    return Number.isFinite(fallback) ? fallback : Number.NaN;
  }
}

function toDateInputLocal(date = new Date()) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 10);
}

function offsetDatePart(datePart, days) {
  const [year, month, day] = String(datePart).split('-').map(Number);
  const date = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    ? new Date(year, month - 1, day)
    : new Date();
  date.setDate(date.getDate() + Number(days || 0));
  return toDateInputLocal(date);
}

function startOfWeekDatePart(datePart) {
  const [year, month, day] = String(datePart).split('-').map(Number);
  const date = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    ? new Date(year, month - 1, day)
    : new Date();
  const weekday = date.getDay();
  const offset = weekday === 0 ? -6 : 1 - weekday;
  date.setDate(date.getDate() + offset);
  return toDateInputLocal(date);
}

function timeOnly(value) {
  return String(value || '').slice(11, 16) || '00:00';
}

function combineDateAndTime(datePart, timePart) {
  return `${datePart}T${timePart || '00:00'}`;
}

function formatLocalDateTime(date) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

async function listTranscriptBlocks(params) {
  const values = [];
  const where = [];
  const addValue = value => {
    values.push(value);
    return `$${values.length}`;
  };
  const channel = positiveInt(params.get('channel'), 0);
  if (channel) {
    where.push(`channel = ${addValue(channel)}`);
  }
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  if (from) {
    where.push(`to_value >= ${addValue(from)}`);
  }
  if (to) {
    where.push(`from_value <= ${addValue(to)}`);
  }

  const result = await dbQuery(
    `select cache_key, mode, vendor, channel, stream, from_value, to_value,
            offset_seconds, duration_seconds, audio_filter, model, text, segments,
            payload, took_ms, created_at, updated_at
       from transcript_blocks
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by channel, from_value, offset_seconds, created_at`,
    values
  );

  return result.rows.map(row => ({
    cacheKey: row.cache_key || '',
    mode: row.mode,
    vendor: row.vendor,
    channel: row.channel,
    stream: row.stream,
    from: row.from_value,
    to: row.to_value,
    offsetSeconds: Number(row.offset_seconds || 0),
    durationSeconds: Number(row.duration_seconds || 0),
    audioFilter: row.audio_filter,
    model: row.model,
    text: row.text,
    segments: Array.isArray(row.segments) ? row.segments : [],
    payload: row.payload || null,
    tookMs: row.took_ms || 0,
    createdAt: row.created_at?.toISOString?.() || '',
    updatedAt: row.updated_at?.toISOString?.() || ''
  }));
}

async function readStoredTranscriptBlock(cacheKey) {
  if (!cacheKey) return null;
  const result = await dbQuery(
    `select payload
       from transcript_blocks
      where cache_key = $1
      limit 1`,
    [cacheKey]
  );
  return result.rows[0]?.payload || null;
}

async function writeStoredTranscriptBlock(cacheKey, payload) {
  if (!payload || typeof payload !== 'object') return;
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  await dbQuery(
    `insert into transcript_blocks
       (cache_key, mode, vendor, channel, stream, from_value, to_value, offset_seconds,
        duration_seconds, audio_filter, model, text, segments, payload, took_ms, updated_at)
     values
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, now())
     on conflict (cache_key) do update
       set mode = excluded.mode,
           vendor = excluded.vendor,
           channel = excluded.channel,
           stream = excluded.stream,
           from_value = excluded.from_value,
           to_value = excluded.to_value,
           offset_seconds = excluded.offset_seconds,
           duration_seconds = excluded.duration_seconds,
           audio_filter = excluded.audio_filter,
           model = excluded.model,
           text = excluded.text,
           segments = excluded.segments,
           payload = excluded.payload,
           took_ms = excluded.took_ms,
           updated_at = now()`,
    [
      cacheKey || null,
      String(payload.mode || ''),
      String(payload.vendor || ''),
      positiveInt(String(payload.channel || ''), 0),
      String(payload.stream || ''),
      String(payload.from || ''),
      String(payload.to || ''),
      Number.isFinite(Number(payload.offsetSeconds)) ? Number(payload.offsetSeconds) : 0,
      Number.isFinite(Number(payload.durationSeconds)) ? Number(payload.durationSeconds) : 0,
      String(payload.audioFilter || ''),
      String(payload.model || ''),
      String(payload.text || ''),
      JSON.stringify(segments),
      JSON.stringify(payload),
      Number.isFinite(Number(payload.tookMs)) ? Number(payload.tookMs) : 0
    ]
  );
}

function normalizeChannelArray(channels) {
  if (!Array.isArray(channels)) return [];
  return [...new Set(
    channels
      .map(channel => positiveInt(String(channel), 0))
      .filter(channel => channel >= 1 && channel <= 16)
  )].sort((a, b) => a - b);
}

function nullableTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requireCameraAuth(config) {
  if (!config.host || !config.user || !config.password) {
    throw httpError(
      400,
      'Camera credentials are not configured. Set CAMERA_HOST, CAMERA_USER, and CAMERA_PASSWORD in .env or environment variables.'
    );
  }
}

async function probeCamera(config) {
  requireCameraAuth(config);

  const probes = [
    {
      vendor: 'xm',
      path: '/cgi-bin/login.cgi',
      method: 'POST',
      body: JSON.stringify({ Name: 'GetPreLoginInfo' }),
      headers: {
        'Content-Type': 'application/json; charset=UTF-8'
      },
      parse: body => {
        const data = safeJsonParse(body);
        return data && data.Ret === 100
          ? {
              device: 'Xiongmai/XM',
              tcpPort: data.TCPPort,
              language: data.Language,
              guiStyle: data.GuiStyle
            }
          : {};
      }
    },
    {
      vendor: 'hikvision',
      path: '/ISAPI/System/deviceInfo',
      parse: body => ({
        deviceName: xmlTag(body, 'deviceName'),
        model: xmlTag(body, 'model'),
        serialNumber: xmlTag(body, 'serialNumber'),
        firmwareVersion: xmlTag(body, 'firmwareVersion')
      })
    },
    {
      vendor: 'dahua',
      path: '/cgi-bin/magicBox.cgi?action=getSystemInfo',
      parse: body => parseKeyValue(body)
    },
    {
      vendor: 'dahua',
      path: '/cgi-bin/magicBox.cgi?action=getDeviceType',
      parse: body => parseKeyValue(body)
    }
  ];

  const attempts = [];
  for (const probe of probes) {
    try {
      const response = await cameraRequest(config, probe.path, {
        method: probe.method || 'GET',
        body: probe.body,
        headers: probe.headers
      });
      const text = response.body.toString('utf8');
      const data = compactObject(probe.parse(text));
      const success = response.statusCode >= 200 && response.statusCode < 300 && Object.keys(data).length > 0;
      attempts.push({
        vendor: probe.vendor,
        path: probe.path,
        status: response.statusCode,
        ok: success,
        bodyKind: bodyKind(text, response.headers['content-type']),
        data: Object.keys(data).length > 0 ? data : undefined
      });

      if (success) {
        return {
          ok: true,
          detectedVendor: probe.vendor,
          attempts
        };
      }
    } catch (error) {
      attempts.push({
        vendor: probe.vendor,
        path: probe.path,
        ok: false,
        error: publicError(error)
      });
    }
  }

  return {
    ok: false,
    detectedVendor: null,
    attempts
  };
}

async function searchRecordings(config, params) {
  requireCameraAuth(config);

  const vendor = normalizeVendor(params.get('vendor') || config.vendor);
  const channel = positiveInt(params.get('channel'), 1);
  const stream = params.get('stream') || 'main';
  const from = requiredParam(params, 'from');
  const to = requiredParam(params, 'to');

  if (vendor === 'auto') {
    const probe = await probeCamera(config);
    if (!probe.detectedVendor) {
      throw httpError(422, 'Could not detect camera API. Try vendor=hikvision or vendor=dahua manually.');
    }
    return searchRecordings(config, withParamOverride(params, 'vendor', probe.detectedVendor));
  }

  if (vendor === 'hikvision') {
    return searchHikvisionRecordings(config, channel, from, to);
  }

  if (vendor === 'dahua') {
    return searchDahuaRecordings(config, channel, from, to);
  }

  if (vendor === 'xm') {
    return searchXmRecordings(config, channel, stream, from, to);
  }

  throw httpError(422, 'Recording search is implemented for XM/Xiongmai CGI, Hikvision ISAPI, and Dahua CGI. Use archive audio with a custom RTSP template for generic devices.');
}

async function searchHikvisionRecordings(config, channel, from, to) {
  const attempts = [];
  const trackIds = hikvisionTrackIdCandidates(channel);
  const ranges = hikvisionTimeRangeCandidates(config, from, to);
  const metadataModes = [true, false];

  for (const trackId of trackIds) {
    for (const range of ranges) {
      for (const includeMetadata of metadataModes) {
        const result = await runHikvisionSearchAttempt(config, {
          trackId,
          from,
          to,
          range,
          includeMetadata
        });

        attempts.push(result.attempt);
        if (result.items.length > 0) {
          return {
            ok: true,
            vendor: 'hikvision',
            channel,
            from,
            to,
            items: result.items.map((item, index) => ({
              id: `hikvision-${index + 1}`,
              ...item
            })),
            attempts
          };
        }
      }
    }
  }

  return {
    ok: true,
    vendor: 'hikvision',
    channel,
    from,
    to,
    items: [],
    attempts
  };
}

async function runHikvisionSearchAttempt(config, options) {
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CMSearchDescription>',
    `  <searchID>${crypto.randomUUID()}</searchID>`,
    '  <trackList>',
    `    <trackID>${escapeXml(options.trackId)}</trackID>`,
    '  </trackList>',
    '  <timeSpanList>',
    '    <timeSpan>',
    `      <startTime>${escapeXml(options.range.start)}</startTime>`,
    `      <endTime>${escapeXml(options.range.end)}</endTime>`,
    '    </timeSpan>',
    '  </timeSpanList>',
    '  <maxResults>100</maxResults>',
    '  <searchResultPosition>0</searchResultPosition>',
    ...(options.includeMetadata
      ? [
          '  <metadataList>',
          '    <metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>',
          '  </metadataList>'
        ]
      : []),
    '</CMSearchDescription>'
  ].join('\n');

  const response = await cameraRequest(config, '/ISAPI/ContentMgmt/search', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/xml; charset=UTF-8'
    }
  });

  ensureOk(response, 'Hikvision recording search failed');
  const xml = response.body.toString('utf8');
  const items = parseHikvisionSearch(xml);

  return {
    items,
    attempt: compactObject({
      trackId: options.trackId,
      timeMode: options.range.mode,
      startTime: options.range.start,
      endTime: options.range.end,
      metadata: options.includeMetadata,
      status: response.statusCode,
      bodyKind: bodyKind(xml, response.headers['content-type']),
      responseStatus: xmlTag(xml, 'responseStatusStrg') || xmlTag(xml, 'statusString'),
      numOfMatches: xmlTag(xml, 'numOfMatches'),
      parsedItems: items.length
    })
  };
}

async function searchDahuaRecordings(config, channel, from, to) {
  const create = await cameraRequest(config, '/cgi-bin/mediaFileFind.cgi?action=factory.create', { method: 'GET' });
  ensureOk(create, 'Dahua media finder creation failed');

  const createValues = parseKeyValue(create.body.toString('utf8'));
  const handle = createValues.result || createValues.object || createValues.handle;
  if (!handle) {
    throw httpError(502, 'Dahua did not return a media finder handle.');
  }

  try {
    const findUrl = new URL('/cgi-bin/mediaFileFind.cgi', cameraBaseUrl(config));
    findUrl.searchParams.set('action', 'findFile');
    findUrl.searchParams.set('object', handle);
    findUrl.searchParams.set('condition.Channel', String(channel));
    findUrl.searchParams.set('condition.StartTime', toDahuaLocalTime(from));
    findUrl.searchParams.set('condition.EndTime', toDahuaLocalTime(to));
    findUrl.searchParams.set('condition.Types[0]', 'dav');

    const find = await cameraRequest(config, findUrl, { method: 'GET' });
    ensureOk(find, 'Dahua media search failed');

    const nextUrl = new URL('/cgi-bin/mediaFileFind.cgi', cameraBaseUrl(config));
    nextUrl.searchParams.set('action', 'findNextFile');
    nextUrl.searchParams.set('object', handle);
    nextUrl.searchParams.set('count', '100');

    const next = await cameraRequest(config, nextUrl, { method: 'GET' });
    ensureOk(next, 'Dahua media result fetch failed');

    return {
      ok: true,
      vendor: 'dahua',
      channel,
      from,
      to,
      items: parseDahuaMediaFiles(next.body.toString('utf8')).map((item, index) => ({
        id: `dahua-${index + 1}`,
        ...item
      }))
    };
  } finally {
    await cameraRequest(config, `/cgi-bin/mediaFileFind.cgi?action=close&object=${encodeURIComponent(handle)}`, { method: 'GET' }).catch(() => {});
    await cameraRequest(config, `/cgi-bin/mediaFileFind.cgi?action=destroy&object=${encodeURIComponent(handle)}`, { method: 'GET' }).catch(() => {});
  }
}

async function searchXmRecordings(config, channel, stream, from, to, services = {}) {
  const requestJson = services.requestJson || cameraJsonRequest;
  const login = await (services.login || xmLogin)(config);

  try {
    const xmChannel = Math.max(0, channel - 1);
    const query = xmRecordingSearchQuery(login, xmChannel, stream, from, to);

    const data = await requestJson(config, '/cgi-bin/opdev.cgi', query);
    if (data.Ret === 109) {
      return xmRecordingSearchResponse({
        channel,
        xmChannel,
        stream,
        from,
        to,
        warning: 'XM OPFileQuery returned Ret=109. No files were found for this period.',
        warningSeverity: 'info',
        searchOutcome: 'confirmed_empty',
        details: xmSearchErrorDetails(data, query, channel, xmChannel, stream),
        records: []
      });
    }

    if (data.Ret === 119) {
      const fallback = await searchXmRecordingsByDay(config, login, channel, xmChannel, stream, from, to, data, query, services);
      return fallback.result;
    }

    if (data.Ret !== 100) {
      if (isXmNoRecordResponse(data.Ret)) {
        return xmRecordingSearchResponse({
          channel,
          xmChannel,
          stream,
          from,
          to,
          xmRet: data.Ret,
          searchOutcome: 'unconfirmed',
          warning: 'XM archive search did not confirm whether recordings exist for this period.',
          warningSeverity: 'warning',
          message: 'XM archive availability could not be confirmed for this period.',
          details: xmSearchErrorDetails(data, query, channel, xmChannel, stream),
          records: []
        });
      }

      throw httpError(502, `XM recording search failed. Ret=${data.Ret ?? 'unknown'}`, {
        ...xmSearchErrorDetails(data, query, channel, xmChannel, stream),
        stage: 'search',
        searchOutcome: 'protocol_error',
        hint: ''
      });
    }

    const records = xmRecordList(data.OPFileQuery);
    return xmRecordingSearchResponse({ channel, xmChannel, stream, from, to, records });
  } finally {
    await (services.logout || xmLogout)(config, login).catch(() => {});
  }
}

function xmRecordingSearchQuery(login, xmChannel, stream, from, to) {
  const streamNo = stream === 'sub' ? 1 : 0;
  return {
    Name: 'OPFileQuery',
    OPFileQuery: {
      Channel: xmChannel,
      DriverTypeMask: '0x0000FFFF',
      StreamType: `0x${toHex(streamNo, 8)}`,
      Type: 'h264',
      Event: '*',
      BeginTime: toXmLocalTime(from),
      EndTime: toXmLocalTime(to)
    },
    SessionID: login.sessionId,
    Salt: login.salt
  };
}

async function searchXmRecordingsByDay(config, login, channel, xmChannel, stream, from, to, originalData, originalQuery, services = {}) {
  const requestJson = services.requestJson || cameraJsonRequest;
  const attempts = [];
  const records = [];
  const ranges = xmSearchDayRanges(from, to);
  const fallbackDetails = () => ({
    strategy: 'daily OPFileQuery after Ret=119',
    original: xmSearchErrorDetails(originalData, originalQuery, channel, xmChannel, stream),
    attempts: [...attempts]
  });

  for (const range of ranges) {
    const query = xmRecordingSearchQuery(login, xmChannel, stream, range.from, range.to);
    let data;
    try {
      data = await requestJson(config, '/cgi-bin/opdev.cgi', query);
    } catch (error) {
      attempts.push({
        ...xmSearchErrorDetails({ Ret: error.statusCode || 'request_failed' }, query, channel, xmChannel, stream),
        error: publicError(error),
        code: error.code || error.details?.code || error.cause?.code || ''
      });
      // A failed daily query cannot prove that the requested archive is empty,
      // even if an earlier day returned some records successfully.
      error.details = {
        ...error.details,
        stage: 'search',
        searchOutcome: 'transient_error',
        fallback: fallbackDetails()
      };
      throw error;
    }
    attempts.push(xmSearchErrorDetails(data, query, channel, xmChannel, stream));
    if (data.Ret === 100) {
      records.push(...xmRecordList(data.OPFileQuery));
    } else if (data.Ret !== 109 && data.Ret !== 119) {
      throw httpError(502, `XM daily recording search failed. Ret=${data.Ret ?? 'unknown'}`, {
        ...xmSearchErrorDetails(data, query, channel, xmChannel, stream),
        stage: 'search',
        searchOutcome: 'protocol_error',
        fallback: fallbackDetails()
      });
    }
  }

  const filteredRecords = uniqueXmRecords(records).filter(record => xmRecordOverlaps(record, from, to));
  const complete = ranges.length > 0
    && ranges.at(-1).to.slice(0, 10) >= toXmLocalTime(to).slice(0, 10)
    && attempts.every(attempt => attempt.ret === 100 || attempt.ret === 109);
  const searchOutcome = complete ? (filteredRecords.length ? 'found' : 'confirmed_empty') : 'unconfirmed';
  const details = {
    ...fallbackDetails(),
    searchOutcome,
    searchComplete: complete,
    ...(complete ? {} : { hint: xmRet119Hint() })
  };
  return {
    result: xmRecordingSearchResponse({
      channel,
      xmChannel,
      stream,
      from,
      to,
      searchOutcome,
      warningSeverity: complete ? 'info' : 'warning',
      warning: !complete
        ? 'Direct XM OPFileQuery returned Ret=119; daily archive search could not confirm availability for the whole requested period.'
        : filteredRecords.length
          ? 'Direct XM OPFileQuery returned Ret=119; records were found through daily archive search.'
          : 'Direct XM OPFileQuery returned Ret=119; daily archive search confirmed no records inside the selected period.',
      details,
      records: filteredRecords
    }),
    details
  };
}

function xmRecordingSearchResponse(options) {
  const searchOutcome = options.searchOutcome || (options.records?.length ? 'found' : 'confirmed_empty');
  const response = {
    ok: true,
    vendor: 'xm',
    channel: options.channel,
    deviceChannel: options.xmChannel,
    stream: options.stream,
    from: options.from,
    to: options.to,
    searchOutcome,
    searchComplete: searchOutcome !== 'unconfirmed',
    items: (options.records || []).map((item, index) => ({
      id: `xm-${index + 1}`,
      startTime: xmTimeToIso(item.BeginTime),
      endTime: xmTimeToIso(item.EndTime),
      localBeginTime: item.BeginTime,
      localEndTime: item.EndTime,
      fileName: item.FileName || item.File || '',
      filePath: item.FileName || item.File || '',
      fileLength: item.FileLength || '',
      sizeBytes: xmFileLengthBytes(item.FileLength),
      diskNo: item.DiskNo,
      serialNo: item.SerialNo
    }))
  };

  if (options.warning) response.warning = options.warning;
  if (options.warningSeverity) response.warningSeverity = options.warningSeverity;
  if (options.details) response.details = options.details;
  return response;
}

function xmSearchDayRanges(from, to) {
  const startParts = localDateParts(from);
  const endParts = localDateParts(to);
  const day = new Date(Number(startParts.year), Number(startParts.month) - 1, Number(startParts.day));
  const endDay = new Date(Number(endParts.year), Number(endParts.month) - 1, Number(endParts.day));
  const ranges = [];

  while (day <= endDay && ranges.length < 32) {
    const year = String(day.getFullYear()).padStart(4, '0');
    const month = String(day.getMonth() + 1).padStart(2, '0');
    const date = String(day.getDate()).padStart(2, '0');
    ranges.push({
      from: `${year}-${month}-${date}T00:00:00`,
      to: `${year}-${month}-${date}T23:59:59`
    });
    day.setDate(day.getDate() + 1);
  }

  return ranges;
}

function uniqueXmRecords(records) {
  const seen = new Set();
  return records.filter(record => {
    const key = record.FileName || record.File || `${record.BeginTime}-${record.EndTime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function xmRecordOverlaps(record, from, to) {
  const rangeStart = new Date(from);
  const rangeEnd = new Date(to);
  const recordStart = new Date(xmTimeToIso(record.BeginTime));
  const recordEnd = new Date(xmTimeToIso(record.EndTime));

  if ([rangeStart, rangeEnd, recordStart, recordEnd].some(date => Number.isNaN(date.getTime()))) {
    return true;
  }

  return recordEnd > rangeStart && recordStart < rangeEnd;
}

function xmSearchErrorDetails(data, query, channel, xmChannel, stream) {
  return {
    vendor: 'xm',
    action: 'OPFileQuery',
    ret: data.Ret ?? 'unknown',
    channel,
    deviceChannel: xmChannel,
    stream,
    streamType: query.OPFileQuery.StreamType,
    beginTime: query.OPFileQuery.BeginTime,
    endTime: query.OPFileQuery.EndTime,
    responseName: data.Name || '',
    responseKeys: Object.keys(data).filter(key => key !== 'SessionID' && key !== 'Salt').slice(0, 20)
  };
}

function xmRet119Hint() {
  return 'Регистратор отклонил OPFileQuery для этого периода/канала. На XM это часто выглядит так, когда выбранная дата уже вне доступной глубины архива или индекс записей для дня недоступен: свежие даты могут работать, а старые возвращать Ret=119 вместо пустого списка. Проверьте более свежий интервал, другой канал/поток или этот день в web-интерфейсе регистратора.';
}

function xmPlaybackDetails(details) {
  return compactObject(details);
}

function isXmNoRecordResponse(ret) {
  return XM_NO_RECORD_RET_CODES.has(Number(ret));
}

function xmRecordList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

async function xmLogin(config) {
  const saltResponse = await cameraJsonRequest(config, '/cgi-bin/login.cgi', { Name: 'GetSalt' });
  if (saltResponse.Ret !== 100 || !saltResponse.Salt) {
    throw httpError(401, `XM GetSalt failed. Ret=${saltResponse.Ret ?? 'unknown'}`);
  }

  const sign = xmMd5_8(`${saltResponse.Salt}${xmMd5_8(config.password)}`);
  const loginResponse = await cameraJsonRequest(config, '/cgi-bin/login.cgi', {
    Name: 'Login',
    LoginEncryptionType: 'MD5_8',
    User: config.user,
    Sign: sign,
    Salt: saltResponse.Salt
  });

  if (loginResponse.Ret !== 100 || !loginResponse.SessionID) {
    throw httpError(401, `XM login failed. Ret=${loginResponse.Ret ?? 'unknown'}`);
  }

  return {
    salt: saltResponse.Salt,
    sessionId: loginResponse.SessionID,
    channelNum: loginResponse.ChannelNum,
    deviceType: loginResponse['DeviceType '] || loginResponse.DeviceType || ''
  };
}

async function xmLogout(config, login) {
  if (!login?.salt) return;
  await cameraJsonRequest(config, '/cgi-bin/login.cgi', {
    Name: 'Logout',
    SessionID: login.sessionId,
    Salt: login.salt
  });
}

async function streamAudio(req, res, config, params, mode) {
  requireCameraAuth(config);

  const ffmpeg = await checkFfmpeg(config.ffmpegPath);
  if (!ffmpeg.available) {
    return json(res, 503, {
      ok: false,
      error: 'ffmpeg is not available. Install ffmpeg or set FFMPEG_PATH to ffmpeg.exe.',
      ffmpeg
    });
  }

  const vendor = normalizeVendor(params.get('vendor') || config.vendor);
  const channel = positiveInt(params.get('channel'), 1);
  const stream = params.get('stream') || 'main';
  const source = params.get('source') || '';
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const audioFilter = normalizeAudioFilter(params.get('audioFilter') || config.audioFilter);

  if (vendor === 'xm' && mode === 'archive') {
    return streamXmArchiveAudio(req, res, config, params, channel, stream);
  }

  const rtspUrl = buildRtspUrl(config, {
    vendor,
    channel,
    stream,
    source,
    from: mode === 'archive' ? from : '',
    to: mode === 'archive' ? to : ''
  });

  const filename = `camera-${mode}-audio-${channel}-${Date.now()}.mp3`;
  const headers = {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no'
  };

  if (params.get('download') === '1') {
    headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  }

  res.writeHead(200, headers);

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-rtsp_transport',
    'tcp',
    '-i',
    rtspUrl,
    '-vn'
  ];
  addAudioFilterArgs(args, audioFilter);
  args.push(
    '-ac',
    '1',
    '-ar',
    '44100',
    '-b:a',
    '96k',
    '-f',
    'mp3',
    'pipe:1'
  );

  const child = spawn(config.ffmpegPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let stderr = '';
  child.stdout.pipe(res);
  child.stdout.on('error', error => handleStreamError(error, 'ffmpeg stdout failed', config));
  child.stderr.on('error', error => handleStreamError(error, 'ffmpeg stderr failed', config));
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });

  const stop = () => {
    if (!child.killed) child.kill('SIGTERM');
  };

  req.on('aborted', stop);
  req.on('error', error => {
    handleStreamError(error, 'client request failed', config);
    stop();
  });
  res.on('close', stop);
  res.on('error', error => {
    handleStreamError(error, 'client audio response failed', config);
    stop();
  });

  child.on('error', error => {
    console.warn(`ffmpeg start failed: ${redactSecrets(error.message, config)}`);
    if (!res.writableEnded) res.end();
  });

  child.on('close', code => {
    if (code !== 0 && code !== null && stderr) {
      console.warn(`ffmpeg exited with ${code}: ${redactSecrets(stderr, config)}`);
    }
    if (!res.writableEnded) res.end();
  });
}

async function transcribeUploadedFile(req, res, params) {
  requireMethod(req, 'POST');
  validateAudioUpload(params, req.headers);
  assertTranscriptionPrepared();
  if (activeUploadedTranscriptions >= 2) throw httpError(429, 'Уже обрабатываются два загруженных файла. Дождитесь окончания и повторите попытку.');
  activeUploadedTranscriptions += 1;
  activeTranscriptionRequests += 1;
  const signal = requestAbortSignal(req, res);
  try {
    await transcriptionModelSettings.initialize();
    if (transcriptionModelSettings.saving) throw httpError(503, 'Выбор модели сохраняется. Повторите запрос после сохранения.');
    const config = cameraConfig();
    if (params.get('model') && params.get('model') !== config.gigaamModel) {
      throw httpError(409, 'Модель в настройках изменилась. Запустите транскрибацию файлов заново.');
    }
    const [ffmpeg, transcriber] = await Promise.all([checkFfmpeg(config.ffmpegPath), checkTranscriber(config.pythonPath)]);
    signal.throwIfAborted();
    if (!ffmpeg.available) throw httpError(503, 'FFmpeg недоступен. Проверьте настройку FFMPEG_PATH.');
    if (!transcriber.available) throw httpError(503, 'GigaAM недоступна. Проверьте окружение транскрибации в настройках.');
    const settings = await readAppSetting('ui_settings').catch(() => ({}));
    return await handleAudioFileTranscription(req, res, params, {
      config, signal, tempRoot: TRANSCRIPT_DIR,
      timeZone: normalizeTimeZone(params.get('timeZone'), configuredDisplayTimeZone(settings)),
      audioFilter: audioFilterGraph(normalizeAudioFilter(params.get('audioFilter') || settings?.audioFilter || config.audioFilter)),
      transcribe: transcribeWithGigaAm, chunkFixedPcm, writePcm16Wav, publicError
    });
  } finally {
    activeUploadedTranscriptions -= 1;
    activeTranscriptionRequests -= 1;
  }
}

async function handleTranscriptionRequest(req, res, params, mode) {
  assertTranscriptionPrepared();
  await transcriptionModelSettings.initialize().catch(() => {});
  if (transcriptionModelSettings.saving) throw httpError(503, 'Выбор модели сохраняется. Повторите запрос после сохранения.');
  activeTranscriptionRequests += 1;
  try {
    return await transcribeAudio(req, res, cameraConfig(), params, mode);
  } finally {
    activeTranscriptionRequests -= 1;
  }
}

async function transcribeAudio(req, res, config, params, mode) {
  requireCameraAuth(config);
  const requestStartedAt = Date.now();
  const vendor = normalizeVendor(params.get('vendor') || config.vendor);
  const channel = positiveInt(params.get('channel'), 1);
  const stream = params.get('stream') || 'main';
  const source = params.get('source') || '';
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const audioFilter = normalizeAudioFilter(params.get('audioFilter') || config.audioFilter);
  const durationSeconds = transcriptionDurationSeconds(params, config, mode);
  const offsetSeconds = positiveFloat(params.get('offsetSeconds'));
  const captureFrom = mode === 'archive' && from && offsetSeconds > 0 ? addSecondsToLocalDateTime(from, offsetSeconds) : from;
  const captureTo = mode === 'archive' && captureFrom && durationSeconds > 0 ? addSecondsToLocalDateTime(captureFrom, durationSeconds) : to;
  const cacheKey = mode === 'archive'
    ? transcriptCacheKey(config, params, { vendor, channel, stream, audioFilter, durationSeconds, offsetSeconds })
    : '';
  const signal = requestAbortSignal(req, res);
  let cacheLookupMs = 0;

  if (cacheKey) {
    const cacheStartedAt = Date.now();
    const cached = await readTranscriptCache(cacheKey);
    cacheLookupMs = Date.now() - cacheStartedAt;
    if (isTranscriptCachePayloadComplete(cached, durationSeconds)) {
      const servedInMs = Date.now() - requestStartedAt;
      return json(res, 200, {
        ...cached,
        cached: true,
        cacheLookupMs,
        servedInMs
      });
    }
  }

  const prerequisitesStartedAt = Date.now();
  const ffmpeg = await checkFfmpeg(config.ffmpegPath);
  if (!ffmpeg.available) {
    return json(res, 503, {
      ok: false,
      error: 'ffmpeg is not available. Install ffmpeg or set FFMPEG_PATH to ffmpeg.exe.',
      ffmpeg
    });
  }

  const transcriber = await checkTranscriber(config.pythonPath);
  if (!transcriber.available) {
    return json(res, 503, {
      ok: false,
      error: 'GigaAM is not available. Install the Python gigaam package or set PYTHON_PATH.',
      transcriber
    });
  }
  const prerequisitesMs = Date.now() - prerequisitesStartedAt;

  await fs.promises.mkdir(TRANSCRIPT_DIR, { recursive: true });

  const audioPath = path.join(TRANSCRIPT_DIR, `${mode}-${Date.now()}-${crypto.randomUUID()}.wav`);

  try {
    const captureStartedAt = Date.now();
    if (mode === 'archive' && vendor === 'xm') {
      await captureXmArchiveWav(config, params, channel, stream, audioPath, {
        audioFilter,
        durationSeconds,
        offsetSeconds,
        signal
      });
    } else {
      await captureRtspWav(config, {
        vendor,
        channel,
        stream,
        source,
        from: mode === 'archive' ? captureFrom : '',
        to: mode === 'archive' ? captureTo : ''
      }, audioPath, {
        audioFilter,
        durationSeconds,
        signal
      });
    }
    const captureMs = Date.now() - captureStartedAt;

    if (signal.aborted) return;
    await ensureAudioFileHasData(audioPath);

    const asrStartedAt = Date.now();
    const result = await transcribeWithGigaAm(config, audioPath, {
      chunkSeconds: config.transcriptionChunkSeconds,
      offsetSeconds,
      signal
    });
    const asrMs = Date.now() - asrStartedAt;

    if (signal.aborted) return;

    const totalMs = Date.now() - requestStartedAt;

    const payload = {
      ok: true,
      mode,
      vendor,
      channel,
      stream,
      from: captureFrom,
      to: captureTo,
      offsetSeconds,
      audioFilter,
      model: config.gigaamModel,
      durationSeconds: result.durationSeconds,
      source: {
        version: 1, host: config.host, fileName: params.get('fileName') || '',
        recordingStart: from, cameraTimeZone: configuredCameraTimeZone(), requestedDurationSeconds: durationSeconds
      },
      text: result.text,
      segments: result.segments || [],
      tookMs: totalMs,
      timings: {
        cacheLookupMs,
        prerequisitesMs,
        captureMs,
        asrMs,
        totalMs
      }
    };

    if (cacheKey) {
      await writeTranscriptCache(cacheKey, payload);
    } else {
      writeStoredTranscriptBlock('', payload).catch(error => {
        console.warn(`PostgreSQL live transcript write failed: ${error.message}`);
      });
    }

    return json(res, 200, payload);
  } finally {
    fs.promises.unlink(audioPath).catch(() => {});
  }
}

async function askOpenAi(req, res) {
  requireMethod(req, 'POST');

  const signal = requestAbortSignal(req, res);
  const payload = await readJsonBody(req);
  const question = String(payload.question || '').trim();
  const transcript = String(payload.transcript || '').trim();
  const from = String(payload.from || '').trim();
  const to = String(payload.to || '').trim();
  const channels = Array.isArray(payload.channels) ? payload.channels : [];

  if (!question) {
    throw httpError(400, 'Question is required.');
  }

  const config = openAiConfig();
  if (!config.apiKey) {
    throw httpError(400, 'OPENAI_API_KEY is not configured. Add it to .env or the environment.');
  }

  const startedAt = Date.now();
  const data = await createOpenAiResponse(config, {
    question,
    transcript,
    from,
    to,
    channels
  }, signal);
  const answer = extractOpenAiAnswer(data);

  return json(res, 200, {
    ok: true,
    answer,
    model: data.model || config.model,
    responseId: data.id || '',
    tookMs: Date.now() - startedAt
  });
}

async function sendReportEmail(req, res) {
  requireMethod(req, 'POST');

  const payload = await readJsonBody(req, 8 * 1024 * 1024);
  const config = emailConfig();
  if (!config.host || !config.from) {
    throw httpError(400, 'SMTP is not configured. Set REPORT_SMTP_HOST and REPORT_SMTP_FROM in .env.');
  }
  if (!isEmailAddress(extractEmailAddress(config.from))) {
    throw httpError(400, 'REPORT_SMTP_FROM must be a valid email address.');
  }

  const recipients = normalizeEmailList(payload.recipients || await readReportRecipients());
  if (!recipients.length) {
    throw httpError(400, 'Report recipients are not configured. Add emails in settings.');
  }

  const reportTypes = normalizeReportTypes(payload);
  if (!reportTypes.length) {
    throw httpError(400, 'Report type is required.');
  }

  const sent = [];
  for (const reportType of reportTypes) {
    const message = reportEmailMessage(payload, reportType, recipients);
    const result = await sendSmtpMail(config, message);
    sent.push({
      reportType,
      recipients: recipients.length,
      messageId: result.messageId,
      smtpResponse: result.smtpResponse,
      transport: result.transport,
      attempts: result.attempts,
      attachments: (message.attachments || []).map(attachment => ({
        fileName: attachment.fileName,
        sizeBytes: attachment.content.length
      }))
    });
  }

  return json(res, 200, {
    ok: true,
    sent
  });
}

async function readReportRecipients() {
  try {
    const settings = await readAppSetting('ui_settings');
    const recipients = normalizeEmailList(settings?.reportEmails || '');
    if (recipients.length) return recipients;
  } catch {}
  return normalizeEmailList(process.env.REPORT_EMAIL_TO || process.env.REPORT_RECIPIENTS || '');
}

async function sendScheduledActionErrorEmail(candidate, run, services = {}) {
  try {
    const config = services.config || emailConfig();
    const recipients = normalizeEmailList(await (services.readRecipients || readReportRecipients)());
    if (!recipients.length) return { status: 'skipped', reason: 'Почты для отчётов не указаны.' };
    if (!config.host || !isEmailAddress(extractEmailAddress(config.from))) {
      throw new Error('SMTP не настроен для отправки уведомления об ошибке.');
    }
    const message = scheduledActionErrorMessage(candidate, run, recipients);
    const sent = await (services.sendMail || sendSmtpMail)(config, message);
    return {
      status: 'sent', at: new Date().toISOString(), recipients: recipients.length,
      messageId: sent.messageId, smtpResponse: sent.smtpResponse
    };
  } catch (error) {
    const message = redactDiagnosticText(publicError(error));
    console.warn(`Background action error notification failed: ${message}`);
    return {
      status: error.deliveryUncertain ? 'delivery_uncertain' : 'error',
      at: new Date().toISOString(), error: message,
      details: error.details ? redactDiagnosticText(JSON.stringify(error.details)) : undefined
    };
  }
}

function scheduledActionErrorMessage(candidate, run, recipients) {
  const displayTimeZone = normalizeTimeZone(candidate?.timeZone, configuredDisplayTimeZone());
  const stageLabels = {
    search: 'Поиск записей', transcript: 'Подготовка аудио и транскрибация',
    ask: 'Запрос к OpenAI', report: 'Отправка отчёта', drive: 'Загрузка на Google Диск', scheduler: 'Планировщик'
  };
  const progress = run.progress || {};
  const lines = [
    run.status === 'success' ? 'Фоновое действие выполнено с пропусками' : 'Ошибка фонового действия',
    `Действие: ${candidate.action.name}`,
    `Период: ${formatReportDateTime(candidate.from, displayTimeZone)} - ${formatReportDateTime(candidate.to, displayTimeZone)}`,
    `Часовой пояс: ${displayTimeZone}`,
    `Этап: ${stageLabels[run.stage] || run.stage || 'Выполнение'}`,
    `Время ошибки: ${formatReportDateTime(run.finishedAt || run.at, displayTimeZone)}`,
    `Вопрос: ${candidate.action.question || ''}`,
    `Ошибка: ${run.error || ''}`,
    `Готово частей: ${progress.completedChunks || 0}; аудио: ${progress.transcribedSeconds || 0} сек.; записей: ${progress.completedRecordings || 0}/${progress.knownRecordings || 0}`,
    progress.label ? `Камера/группа: ${progress.label}` : '',
    progress.fileName ? `Запись: ${progress.fileName}` : '',
    progress.from ? `Фрагмент: ${formatReportDateTime(progress.from, displayTimeZone)} - ${formatReportDateTime(progress.to, displayTimeZone)}` : '',
    '',
    'Выбранные камеры:',
    ...(candidate.selections || []).map(selection =>
      `${selection.groupName || 'Группа'}: камера ${selection.channel}, ${formatReportDateTime(selection.from, displayTimeZone)} - ${formatReportDateTime(selection.to, displayTimeZone)}`),
    ...(run.warnings?.length ? ['', 'Предупреждения:', ...run.warnings] : []),
    ...(run.details ? ['', 'Технические детали:', JSON.stringify(run.details, null, 2)] : [])
  ];
  const text = redactDiagnosticText(lines.join('\n')).slice(0, 64000);
  return {
    to: recipients,
    subject: redactDiagnosticText(`Ошибка фонового действия: ${candidate.action.name}`),
    text,
    html: `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtmlText(text)}</pre>`
  };
}

function redactDiagnosticText(value) {
  let text = String(value || '');
  for (const [key, secret] of Object.entries(process.env)) {
    if (!/(?:PASSWORD|PASS|API_KEY|TOKEN|SECRET)$/.test(key) || !secret) continue;
    text = text.replaceAll(secret, '***').replaceAll(encodeURIComponent(secret), '***');
  }
  return text.replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1***@');
}

function normalizeReportTypes(payload) {
  const values = Array.isArray(payload.reportTypes)
    ? payload.reportTypes
    : [payload.reportType];
  return [...new Set(values.map(value => String(value || '').toLowerCase()).filter(value => value === 'daily' || value === 'weekly'))];
}

function normalizeReportWarnings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 100);
}

function normalizeEmailList(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[,\n;]/);
  return [...new Set(values.map(item => String(item || '').trim()).filter(item => isEmailAddress(extractEmailAddress(item))))];
}

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function reportEmailMessage(payload, reportType, recipients) {
  const action = payload.action && typeof payload.action === 'object' ? payload.action : {};
  const warnings = normalizeReportWarnings(payload.warnings);
  const reportLabel = reportType === 'weekly' ? 'за неделю' : 'за день';
  const subject = `Отчет ${reportLabel}: ${action.name || 'действие камер'}`;
  const generatedAt = payload.generatedAt || new Date().toISOString();
  const displayTimeZone = normalizeTimeZone(payload.timeZone, configuredDisplayTimeZone());
  const period = `${formatReportDateTime(payload.from, displayTimeZone)} - ${formatReportDateTime(payload.to, displayTimeZone)}`;
  const attachment = buildReportDocxAttachment({ ...payload, recipients }, reportType);

  const text = [
    `Отчет ${reportLabel}`,
    `Действие: ${action.name || 'без названия'}`,
    `Сформирован: ${formatReportDateTime(generatedAt, displayTimeZone)}`,
    `Часовой пояс: ${displayTimeZone}`,
    `Период: ${period}`,
    ...(warnings.length ? [`Предупреждений при обработке: ${warnings.length}`] : []),
    '',
    `DOCX-файл прикреплен: ${attachment.fileName}`
  ].join('\n');

  const html = [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.45;color:#18212a">',
    `<h2>${escapeHtmlText(`Отчет ${reportLabel}`)}</h2>`,
    `<p><strong>Действие:</strong> ${escapeHtmlText(action.name || 'без названия')}</p>`,
    `<p><strong>Сформирован:</strong> ${escapeHtmlText(formatReportDateTime(generatedAt, displayTimeZone))}</p>`,
    `<p><strong>Часовой пояс:</strong> ${escapeHtmlText(displayTimeZone)}</p>`,
    `<p><strong>Период:</strong> ${escapeHtmlText(period)}</p>`,
    ...(warnings.length ? [`<p><strong>Предупреждений при обработке:</strong> ${warnings.length}</p>`] : []),
    `<p>DOCX-файл прикреплен: <strong>${escapeHtmlText(attachment.fileName)}</strong></p>`,
    '</body></html>'
  ].join('');

  return {
    to: recipients,
    subject,
    text,
    html,
    messageId: reportMessageId(payload, reportType),
    attachments: [attachment]
  };
}

function reportMessageId(payload, reportType) {
  const deliveryKey = String(payload.deliveryKey || '').trim();
  if (!deliveryKey) return `${crypto.randomUUID()}@camera-audio-listener`;
  const digest = crypto.createHash('sha256').update(`${deliveryKey}:${reportType}`).digest('hex');
  return `${digest}@camera-audio-listener`;
}

function buildReportDocxAttachment(payload, reportType) {
  const action = payload.action && typeof payload.action === 'object' ? payload.action : {};
  const displayTimeZone = normalizeTimeZone(payload.timeZone, configuredDisplayTimeZone());
  const fromDate = reportDateKey(payload.from, displayTimeZone) || zonedDatePart(new Date(), displayTimeZone);
  const toDate = reportDateKey(payload.to, displayTimeZone) || fromDate;
  const typePart = reportType === 'weekly' ? 'weekly' : 'daily';
  const namePart = slugFilePart(action.name || 'camera-report');
  const fileName = `camera-report-${typePart}-${fromDate}${toDate !== fromDate ? `-${toDate}` : ''}-${namePart}.docx`;

  return {
    fileName,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    content: buildReportDocx(payload, reportType)
  };
}

function buildReportDocx(payload, reportType) {
  const documentXml = reportDocxDocumentXml(payload, reportType);
  const coreXml = reportDocxCoreXml(payload, reportType);

  return createZipArchive([
    { name: '[Content_Types].xml', content: docxContentTypesXml() },
    { name: '_rels/.rels', content: docxRootRelsXml() },
    { name: 'docProps/core.xml', content: coreXml },
    { name: 'docProps/app.xml', content: docxAppXml() },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/styles.xml', content: reportDocxStylesXml() },
    { name: 'word/settings.xml', content: docxSettingsXml() },
    { name: 'word/_rels/document.xml.rels', content: docxDocumentRelsXml() }
  ]);
}

function reportDocxDocumentXml(payload, reportType) {
  const action = payload.action && typeof payload.action === 'object' ? payload.action : {};
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const channels = Array.isArray(payload.channels) ? payload.channels : [];
  const transcript = String(payload.transcript || '').trim();
  const transcriptLines = transcript ? transcript.split(/\r?\n/).filter(line => line.trim()) : [];
  const reportLabel = reportType === 'weekly' ? 'за неделю' : 'за день';
  const generatedAt = payload.generatedAt || new Date().toISOString();
  const question = String(payload.question || '').trim() || 'Вопрос не указан.';
  const answer = String(payload.answer || '').trim() || 'Ответ не получен.';
  const warnings = normalizeReportWarnings(payload.warnings);
  const displayTimeZone = normalizeTimeZone(payload.timeZone, configuredDisplayTimeZone());

  const blocks = [
    wParagraph('OPENAI API', 'Kicker'),
    wParagraph(`Отчет ${reportLabel}`, 'ReportTitle'),
    wParagraph(action.name || 'Архив камер', 'Subtitle'),
    wTable([
      ['Действие', action.name || 'без названия'],
      ['Сформирован', formatReportDateTime(generatedAt, displayTimeZone)],
      ['Период анализа', `${formatReportDateTime(payload.from, displayTimeZone)} - ${formatReportDateTime(payload.to, displayTimeZone)}`],
      ['Часовой пояс', displayTimeZone],
      ['Модель', payload.model || 'не указана'],
      ['ID ответа', payload.responseId || 'не указан']
    ], [2100, 7260], false),
    wParagraph('Вопрос', 'Heading1'),
    ...wParagraphsForText(question, 'BodyText'),
    wParagraph('Ответ ChatGPT', 'Heading1'),
    ...wParagraphsForText(answer, 'AnswerText'),
    ...(warnings.length ? [
      wParagraph('Предупреждения обработки', 'Heading1'),
      ...warnings.flatMap(warning => wParagraphsForText(warning, 'BodyText'))
    ] : []),
    wParagraph('Метки по дням', 'Heading1'),
    ...reportDaySectionsXml(payload, channels, displayTimeZone),
    wParagraph('Группы и камеры', 'Heading1'),
    ...reportGroupBlocksXml(groups, channels, displayTimeZone),
    wParagraph('Служебная информация', 'Heading1'),
    wTable([
      ['Тип отчета', reportLabel],
      ['Получателей', String(normalizeEmailList(payload.recipients || '').length || 'из настроек')],
      ['Фрагментов транскрипта', String(transcriptLines.length || payload.transcriptLines || 0)],
      ['Предупреждений', String(warnings.length)]
    ], [2600, 6760], false)
  ];

  if (transcriptLines.length) {
    blocks.push(
      wParagraph('Приложение: подгруженный текст', 'Heading1'),
      ...transcriptLines.flatMap(line => wParagraphsForText(line, 'TranscriptText'))
    );
  }

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 w15 wp14">',
    '<w:body>',
    blocks.join(''),
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>',
    '</w:body>',
    '</w:document>'
  ].join('');
}

function reportDaySectionsXml(payload, channels, timeZone = configuredDisplayTimeZone()) {
  const days = reportDaysBetween(payload.from, payload.to, channels, timeZone);
  if (!days.length) {
    return [wParagraph('Даты не определены.', 'MutedText')];
  }

  const result = [];
  for (const day of days) {
    const dayChannels = channels.filter(item => reportRangeOverlapsDay(item.from, item.to, day, timeZone));
    result.push(wParagraph(`Метка дня: ${formatReportDayLabel(day)}`, 'DayHeading', { keepNext: true }));

    if (!dayChannels.length) {
      result.push(wParagraph('За этот день обработанных камер нет.', 'MutedText'));
      continue;
    }

    result.push(wTable([
      ['Группа', 'Камера', 'Интервал', 'Период'],
      ...dayChannels.map(item => [
        item.group || 'Группа',
        item.label || `Канал ${item.channel || ''}`,
        reportTimeRange(item.from, item.to, timeZone),
        `${formatReportDateTime(item.from, timeZone)} - ${formatReportDateTime(item.to, timeZone)}`
      ])
    ], [2160, 2160, 1440, 3600], true));
  }
  return result;
}

function reportGroupBlocksXml(groups, channels, timeZone = configuredDisplayTimeZone()) {
  if (!groups.length && !channels.length) {
    return [wParagraph('Группы и камеры не указаны.', 'MutedText')];
  }

  const blocks = [];
  if (groups.length) {
    blocks.push(wTable([
      ['Группа', 'Камеры', 'Исходный период'],
      ...groups.map(group => [
        group.name || 'Группа',
        (group.channels || []).join(', ') || 'не указаны',
        `${formatReportDateTime(group.from, timeZone, normalizeTimeZone(group.timeZone, timeZone))} - ${formatReportDateTime(group.to, timeZone, normalizeTimeZone(group.timeZone, timeZone))}`
      ])
    ], [2400, 2400, 4560], true));
  }

  if (channels.length) {
    blocks.push(wParagraph('Обработанные каналы', 'Heading2'));
    blocks.push(wTable([
      ['Группа', 'Камера', 'Период'],
      ...channels.map(item => [
        item.group || 'Группа',
        item.label || `Канал ${item.channel || ''}`,
        `${formatReportDateTime(item.from, timeZone)} - ${formatReportDateTime(item.to, timeZone)}`
      ])
    ], [2400, 2400, 4560], true));
  }

  return blocks;
}

function reportDaysBetween(fromValue, toValue, channels = [], timeZone = configuredDisplayTimeZone()) {
  const dates = new Set();
  const start = reportDateFromKey(reportDateKey(fromValue, timeZone));
  const end = reportDateFromKey(reportDateKey(toValue, timeZone));

  if (start && end) {
    const cursor = new Date(start.getTime());
    while (cursor.getTime() <= end.getTime()) {
      dates.add(toDateInputLocal(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  for (const item of channels) {
    const from = reportDateKey(item.from, timeZone);
    const to = reportDateKey(item.to, timeZone);
    if (from) dates.add(from);
    if (to) dates.add(to);
  }

  return [...dates].sort();
}

function reportRangeOverlapsDay(fromValue, toValue, day, timeZone = configuredDisplayTimeZone()) {
  const start = safeInstantMs(fromValue, timeZone);
  const end = safeInstantMs(toValue, timeZone);
  const dayStart = safeInstantMs(`${day}T00:00:00`, timeZone);
  const dayEnd = safeInstantMs(`${offsetDatePart(day, 1)}T00:00:00`, timeZone);
  if (![start, end, dayStart, dayEnd].every(Number.isFinite)) return reportDateKey(fromValue, timeZone) === day;
  return start < dayEnd && end > dayStart;
}

function reportDateKey(value, timeZone = configuredDisplayTimeZone()) {
  if (!value) return '';
  try {
    return zonedDatePart(zonedDateTimeToEpochMs(value, timeZone), timeZone);
  } catch {
    return '';
  }
}

function reportDateFromKey(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(year, month - 1, day);
}

function formatReportDayLabel(day) {
  const date = reportDateFromKey(day);
  if (!date) return day;
  return date.toLocaleDateString('ru-RU', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function reportTimeRange(fromValue, toValue, timeZone = configuredDisplayTimeZone()) {
  return `${formatReportTimeOnly(fromValue, timeZone)} - ${formatReportTimeOnly(toValue, timeZone)}`;
}

function formatReportTimeOnly(value, timeZone = configuredDisplayTimeZone()) {
  try {
    return localDateTimeInZone(zonedDateTimeToEpochMs(value, timeZone), timeZone).slice(11, 16);
  } catch {
    return '';
  }
}

function wParagraphsForText(text, styleId = 'BodyText') {
  const lines = String(text || '').split(/\r?\n/);
  const paragraphs = [];
  let buffer = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (buffer.length) {
        paragraphs.push(wParagraph(buffer.join(' '), styleId));
        buffer = [];
      }
      continue;
    }
    buffer.push(trimmed);
  }

  if (buffer.length) paragraphs.push(wParagraph(buffer.join(' '), styleId));
  return paragraphs.length ? paragraphs : [wParagraph('', styleId)];
}

function wParagraph(text, styleId = 'BodyText', options = {}) {
  const pPr = [
    styleId ? `<w:pStyle w:val="${escapeXml(styleId)}"/>` : '',
    options.keepNext ? '<w:keepNext/>' : '',
    options.align ? `<w:jc w:val="${escapeXml(options.align)}"/>` : ''
  ].filter(Boolean).join('');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${wRun(text)}</w:p>`;
}

function wRun(text) {
  const value = String(text || '');
  return `<w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>`;
}

function wTable(rows, widths, header = true) {
  const grid = widths.map(width => `<w:gridCol w:w="${width}"/>`).join('');
  const body = rows.map((row, rowIndex) => {
    const cells = widths.map((width, cellIndex) => {
      const text = row[cellIndex] === undefined || row[cellIndex] === null ? '' : row[cellIndex];
      const cellFill = header && rowIndex === 0 ? '<w:shd w:fill="F2F4F7"/>' : '';
      return [
        '<w:tc>',
        `<w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:vAlign w:val="center"/>${cellFill}</w:tcPr>`,
        wParagraph(String(text), header && rowIndex === 0 ? 'TableHeader' : 'TableText'),
        '</w:tc>'
      ].join('');
    }).join('');
    const rowPr = header && rowIndex === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
    return `<w:tr>${rowPr}${cells}</w:tr>`;
  }).join('');

  return [
    '<w:tbl>',
    '<w:tblPr>',
    '<w:tblW w:w="9360" w:type="dxa"/>',
    '<w:tblInd w:w="120" w:type="dxa"/>',
    '<w:tblLayout w:type="fixed"/>',
    '<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar>',
    '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D9E1E8"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D9E1E8"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D9E1E8"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D9E1E8"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D9E1E8"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D9E1E8"/></w:tblBorders>',
    '</w:tblPr>',
    `<w:tblGrid>${grid}</w:tblGrid>`,
    body,
    '</w:tbl>',
    wParagraph('', 'TableAfter')
  ].join('');
}

function reportDocxStylesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:color w:val="18212A"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>',
    wStyle('Normal', 'Normal', { basedOn: '', fontSize: 22, color: '18212A', after: 120, line: 264 }),
    wStyle('Kicker', 'Kicker', { basedOn: 'Normal', fontSize: 18, color: '5B6873', bold: true, caps: true, after: 80 }),
    wStyle('ReportTitle', 'Report Title', { basedOn: 'Normal', fontSize: 34, color: '0B2545', bold: true, before: 40, after: 80 }),
    wStyle('Subtitle', 'Subtitle', { basedOn: 'Normal', fontSize: 24, color: '43515C', after: 220 }),
    wStyle('Heading1', 'Heading 1', { basedOn: 'Normal', fontSize: 32, color: '2E74B5', bold: true, before: 320, after: 160, outline: 0 }),
    wStyle('Heading2', 'Heading 2', { basedOn: 'Normal', fontSize: 26, color: '2E74B5', bold: true, before: 240, after: 120, outline: 1 }),
    wStyle('DayHeading', 'Day Label', { basedOn: 'Normal', fontSize: 24, color: '1F4D78', bold: true, before: 180, after: 100, fill: 'E8EEF5' }),
    wStyle('BodyText', 'Body Text', { basedOn: 'Normal', fontSize: 22, color: '18212A', after: 120, line: 264 }),
    wStyle('AnswerText', 'Answer Text', { basedOn: 'Normal', fontSize: 22, color: '18212A', after: 120, line: 280, fill: 'F4F6F9' }),
    wStyle('MutedText', 'Muted Text', { basedOn: 'Normal', fontSize: 20, color: '5B6873', after: 120, line: 260 }),
    wStyle('TranscriptText', 'Transcript Text', { basedOn: 'Normal', fontSize: 18, color: '28323C', after: 60, line: 240 }),
    wStyle('TableText', 'Table Text', { basedOn: 'Normal', fontSize: 20, color: '18212A', after: 0, line: 240 }),
    wStyle('TableHeader', 'Table Header', { basedOn: 'Normal', fontSize: 20, color: '0B2545', bold: true, after: 0, line: 240 }),
    wStyle('TableAfter', 'Table After', { basedOn: 'Normal', fontSize: 4, after: 80, line: 120 }),
    '</w:styles>'
  ].join('');
}

function wStyle(styleId, name, options = {}) {
  const basedOn = options.basedOn ? `<w:basedOn w:val="${escapeXml(options.basedOn)}"/>` : '';
  const pPr = [
    options.before !== undefined || options.after !== undefined || options.line !== undefined
      ? `<w:spacing w:before="${options.before || 0}" w:after="${options.after || 0}"${options.line ? ` w:line="${options.line}" w:lineRule="auto"` : ''}/>`
      : '',
    options.outline !== undefined ? `<w:outlineLvl w:val="${options.outline}"/>` : '',
    options.fill ? `<w:shd w:fill="${escapeXml(options.fill)}"/>` : ''
  ].filter(Boolean).join('');
  const rPr = [
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>',
    options.bold ? '<w:b/>' : '',
    options.caps ? '<w:caps/>' : '',
    options.color ? `<w:color w:val="${escapeXml(options.color)}"/>` : '',
    options.fontSize ? `<w:sz w:val="${options.fontSize}"/>` : ''
  ].filter(Boolean).join('');

  return [
    `<w:style w:type="paragraph" w:styleId="${escapeXml(styleId)}">`,
    `<w:name w:val="${escapeXml(name)}"/>`,
    basedOn,
    pPr ? `<w:pPr>${pPr}</w:pPr>` : '',
    rPr ? `<w:rPr>${rPr}</w:rPr>` : '',
    '</w:style>'
  ].join('');
}

function docxContentTypesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    '</Types>'
  ].join('');
}

function docxRootRelsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    '</Relationships>'
  ].join('');
}

function docxDocumentRelsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>',
    '</Relationships>'
  ].join('');
}

function docxSettingsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:defaultTabStop w:val="720"/>',
    '<w:characterSpacingControl w:val="doNotCompress"/>',
    '</w:settings>'
  ].join('');
}

function docxAppXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    '<Application>Camera Audio Listener</Application>',
    '<DocSecurity>0</DocSecurity>',
    '<ScaleCrop>false</ScaleCrop>',
    '<Company></Company>',
    '<LinksUpToDate>false</LinksUpToDate>',
    '<SharedDoc>false</SharedDoc>',
    '<HyperlinksChanged>false</HyperlinksChanged>',
    '<AppVersion>1.0</AppVersion>',
    '</Properties>'
  ].join('');
}

function reportDocxCoreXml(payload, reportType) {
  const action = payload.action && typeof payload.action === 'object' ? payload.action : {};
  const reportLabel = reportType === 'weekly' ? 'за неделю' : 'за день';
  const now = new Date().toISOString();
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<dc:title>${escapeXml(`Отчет ${reportLabel}: ${action.name || 'архив камер'}`)}</dc:title>`,
    '<dc:creator>Camera Audio Listener</dc:creator>',
    '<cp:lastModifiedBy>Camera Audio Listener</cp:lastModifiedBy>',
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`,
    '</cp:coreProperties>'
  ].join('');
}

function createZipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), 'utf8');
    const compressed = zlib.deflateRawSync(content);
    const crc = crc32(content);
    const { dosDate, dosTime } = dosDateTime(new Date());

    const localHeader = Buffer.alloc(30 + name.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    name.copy(localHeader, 30);

    localParts.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + name.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    name.copy(centralHeader, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

let crc32Table = null;

function crc32(buffer) {
  if (!crc32Table) {
    crc32Table = Array.from({ length: 256 }, (_, index) => {
      let current = index;
      for (let bit = 0; bit < 8; bit += 1) {
        current = current & 1 ? (0xedb88320 ^ (current >>> 1)) : (current >>> 1);
      }
      return current >>> 0;
    });
  }

  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function slugFilePart(value) {
  const ascii = String(value || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || 'report';
}

function openAiConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
    proxyUrl: String(process.env.OPENAI_PROXY_URL || '').trim(),
    timeoutMs: numberFromEnv('OPENAI_TIMEOUT_MS', 120000),
    maxOutputTokens: numberFromEnv('OPENAI_MAX_OUTPUT_TOKENS', 1200)
  };
}

function createOpenAiProxyAgent(value) {
  const proxyUrl = resolveOpenAiProxyUrl(value);
  if (!proxyUrl) return undefined;

  try {
    const url = new URL(proxyUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Invalid proxy URL');
    }
    return new ProxyAgent({ uri: url.href, proxyTunnel: true });
  } catch {
    throw httpError(500, `Invalid OPENAI_PROXY_URL. Use an HTTP(S) proxy URL or ${VPNXXX_AUTO_PROXY_URL}.`);
  }
}

function resolveOpenAiProxyUrl(value, env = process.env) {
  const proxyUrl = String(value || '').trim();
  if (proxyUrl !== VPNXXX_AUTO_PROXY_URL) return proxyUrl;

  const appData = String(env.APPDATA || '').trim()
    || (String(env.USERPROFILE || '').trim() ? path.join(String(env.USERPROFILE).trim(), 'AppData', 'Roaming') : '');
  if (!appData) {
    throw vpnxxxProxyError('APPDATA is unavailable', 'VPNXXX_APPDATA_UNAVAILABLE');
  }

  let configText;
  try {
    configText = readBoundedUtf8File(
      path.join(appData, 'vpnxxx', 'temp', 'privoxy.conf'),
      VPNXXX_PRIVOXY_CONFIG_MAX_BYTES
    );
  } catch (error) {
    if (error?.code === 'VPNXXX_CONFIG_TOO_LARGE') {
      throw vpnxxxProxyError('privoxy.conf is too large to read safely', error.code);
    }
    throw vpnxxxProxyError('privoxy.conf is unavailable; start or restart vpnxxx', 'VPNXXX_CONFIG_UNAVAILABLE');
  }

  const listeners = parseVpnxxxPrivoxyListeners(configText);
  if (listeners.length === 0) {
    throw vpnxxxProxyError('privoxy.conf has no valid loopback listen-address', 'VPNXXX_LISTENER_NOT_FOUND');
  }
  const ports = new Set(listeners.map(listener => new URL(listener).port));
  if (ports.size > 1) {
    throw vpnxxxProxyError('privoxy.conf has loopback listen-address entries with different ports', 'VPNXXX_LISTENER_AMBIGUOUS');
  }
  return listeners.find(listener => listener.startsWith('http://127.0.0.1:'))
    || listeners.find(listener => listener.startsWith('http://127.'))
    || listeners[0];
}

function readBoundedUtf8File(filePath, maxBytes) {
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let totalBytesRead = 0;
    while (totalBytesRead < buffer.length) {
      const bytesRead = fs.readSync(handle, buffer, totalBytesRead, buffer.length - totalBytesRead, null);
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    if (totalBytesRead > maxBytes) {
      const error = new Error('File exceeds configured read limit.');
      error.code = 'VPNXXX_CONFIG_TOO_LARGE';
      throw error;
    }
    return buffer.subarray(0, totalBytesRead).toString('utf8');
  } finally {
    fs.closeSync(handle);
  }
}

function parseVpnxxxPrivoxyListeners(configText) {
  const listeners = new Set();
  for (const rawLine of String(configText || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = /^listen-address\s+(\S+)\s*$/i.exec(line);
    if (!match) continue;
    const proxyUrl = loopbackProxyUrl(match[1]);
    if (proxyUrl) listeners.add(proxyUrl);
  }
  return [...listeners];
}

function loopbackProxyUrl(endpoint) {
  let host;
  let portText;
  const bracketedIpv6 = /^\[([^\]]+)\]:(\d+)$/.exec(endpoint);
  if (bracketedIpv6) {
    [, host, portText] = bracketedIpv6;
  } else {
    const hostAndPort = /^([^:\s]+):(\d+)$/.exec(endpoint);
    if (!hostAndPort) return '';
    [, host, portText] = hostAndPort;
  }

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '';

  const normalizedHost = host.toLowerCase();
  if (normalizedHost === 'localhost') return `http://127.0.0.1:${port}`;
  if (net.isIP(normalizedHost) === 4 && Number(normalizedHost.split('.')[0]) === 127) {
    return `http://${normalizedHost}:${port}`;
  }
  if (net.isIP(normalizedHost) === 6 && normalizedHost === '::1') {
    return `http://[::1]:${port}`;
  }
  return '';
}

function vpnxxxProxyError(reason, code) {
  return httpError(502, `OpenAI proxy auto-detection failed: ${reason}.`, {
    transport: 'proxy',
    proxy: 'vpnxxx',
    code
  });
}

async function createOpenAiResponse(config, payload, signal) {
  const timeout = new AbortController();
  const abort = () => timeout.abort();
  let timedOut = false;
  let dispatcher;
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, config.timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  try {
    timeout.signal.throwIfAborted();
    dispatcher = createOpenAiProxyAgent(config.proxyUrl);
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        store: false,
        max_output_tokens: config.maxOutputTokens,
        instructions: [
          'Ты анализируешь транскрипты аудио с камер наблюдения.',
          'Отвечай на русском языке, опирайся только на предоставленный транскрибированный текст.',
          'Если данных недостаточно или речь не найдена, скажи об этом прямо.'
        ].join(' '),
        input: openAiInput(payload)
      }),
      signal: timeout.signal,
      ...(dispatcher ? { dispatcher } : {})
    });
    const text = await response.text();
    const data = safeJsonParse(text);

    if (!response.ok) {
      throw httpError(response.status || 502, `OpenAI API error. ${data?.error?.message || safePreview(text, 300)}`, {
        status: response.status,
        type: data?.error?.type || '',
        code: data?.error?.code || '',
        param: data?.error?.param || ''
      });
    }
    if (!data) {
      throw httpError(502, `OpenAI API returned non-JSON response: ${safePreview(text, 300)}`);
    }

    return data;
  } catch (error) {
    if (signal?.aborted) {
      throw httpError(499, 'OpenAI request was cancelled.');
    }
    if (timedOut) {
      throw httpError(504, `OpenAI request timed out after ${config.timeoutMs} ms.`, {
        transport: dispatcher ? 'proxy' : 'direct', timeoutMs: config.timeoutMs
      });
    }
    if (error.statusCode) throw error;
    const cause = redactDiagnosticText(error.cause?.message || error.message);
    throw httpError(502, dispatcher
      ? `OpenAI proxy connection failed. Проверьте, что VPN/прокси включён и доступен. ${cause}`
      : `OpenAI connection failed. ${cause}`, {
      transport: dispatcher ? 'proxy' : 'direct',
      code: error.cause?.code || error.code || ''
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await dispatcher?.destroy();
  }
}

function openAiInput(payload) {
  const channels = payload.channels
    .map(channel => `${channel.label || `Канал ${channel.channel || ''}`}`.trim())
    .filter(Boolean)
    .join(', ');

  return [
    `Период: ${payload.from || 'не указан'} - ${payload.to || 'не указан'}`,
    `Камеры: ${channels || 'не указаны'}`,
    '',
    'Вопрос пользователя:',
    payload.question,
    '',
    'Транскрибированный текст:',
    payload.transcript || 'Текст не найден.'
  ].join('\n');
}

function extractOpenAiAnswer(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') {
        parts.push(content.text);
      } else if (typeof content.content === 'string') {
        parts.push(content.content);
      }
    }
  }

  return parts.join('\n').trim();
}

async function sendSmtpMail(config, message) {
  const attempts = [];

  for (const transport of smtpTransportCandidates(config)) {
    for (let attempt = 1; attempt <= config.retries; attempt += 1) {
      try {
        const result = await sendSmtpMailOnce(transport, message);
        return {
          ...result,
          transport: publicSmtpTransport(transport),
          attempts
        };
      } catch (error) {
        attempts.push({
          transport: publicSmtpTransport(transport),
          attempt,
          error: publicError(error)
        });

        if (error.deliveryUncertain) {
          error.details = {
            ...(error.details && typeof error.details === 'object' ? error.details : {}),
            deliveryUncertain: true,
            attempts
          };
          throw error;
        }
        if (!isRetryableSmtpError(error)) {
          error.details = {
            ...(error.details && typeof error.details === 'object' ? error.details : {}),
            attempts
          };
          throw error;
        }
        if (attempt < config.retries && config.retryDelayMs > 0) {
          await delay(config.retryDelayMs);
        }
      }
    }
  }

  throw httpError(504, `SMTP connection failed after ${attempts.length} attempts.`, { attempts });
}

async function sendSmtpMailOnce(config, message) {
  let socket = await openSmtpSocket(config);
  let reader = createSmtpReader(socket, config.timeoutMs);
  let dataWritten = false;

  try {
    await reader.read([220]);
    await reader.command(`EHLO ${config.ehloName}`, [250]);

    if (!config.secure && config.startTls) {
      await reader.command('STARTTLS', [220]);
      reader.detach();
      socket = await upgradeSmtpTls(socket, config);
      reader = createSmtpReader(socket, config.timeoutMs);
      await reader.command(`EHLO ${config.ehloName}`, [250]);
    }

    if (config.user || config.password) {
      const auth = Buffer.from(`\u0000${config.user}\u0000${config.password}`, 'utf8').toString('base64');
      await reader.command(`AUTH PLAIN ${auth}`, [235, 503]);
    }

    const fromAddress = extractEmailAddress(config.from);
    await reader.command(`MAIL FROM:<${fromAddress}>`, [250]);
    for (const recipient of message.to) {
      await reader.command(`RCPT TO:<${extractEmailAddress(recipient)}>`, [250, 251]);
    }
    await reader.command('DATA', [354]);

    const messageId = message.messageId || `${crypto.randomUUID()}@camera-audio-listener`;
    socket.write(`${smtpData(formatMailMessage(config, message, messageId))}\r\n.\r\n`);
    dataWritten = true;
    const accepted = await reader.read([250]);
    await reader.command('QUIT', [221]).catch(() => null);

    return {
      messageId,
      smtpResponse: safePreview(accepted.raw, 600)
    };
  } catch (error) {
    if (dataWritten && !error?.details?.response) {
      error.deliveryUncertain = true;
      error.details = {
        ...(error.details && typeof error.details === 'object' ? error.details : {}),
        deliveryUncertain: true
      };
    }
    throw error;
  } finally {
    reader.detach();
    socket.end();
  }
}

function smtpTransportCandidates(config) {
  const primary = { ...config };
  const candidates = [primary];
  const hasFallback587 = config.fallback587 && !(Number(config.port) === 587 && !config.secure && config.startTls);

  if (hasFallback587) {
    candidates.push({
      ...config,
      port: 587,
      secure: false,
      startTls: true
    });
  }

  return candidates;
}

function publicSmtpTransport(config) {
  return {
    host: config.host,
    port: config.port,
    secure: Boolean(config.secure),
    startTls: Boolean(config.startTls)
  };
}

function isRetryableSmtpError(error) {
  const message = `${error?.code || ''} ${error?.message || ''}`;
  return error?.statusCode === 502
    || error?.statusCode === 504
    || /timeout|timed out|ETIMEDOUT|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|closed unexpectedly/i.test(message);
}

function openSmtpSocket(config) {
  return new Promise((resolve, reject) => {
    const options = {
      host: config.host,
      port: config.port,
      servername: config.host,
      rejectUnauthorized: config.rejectUnauthorized
    };
    const socket = config.secure ? tls.connect(options) : net.connect(options);
    const eventName = config.secure ? 'secureConnect' : 'connect';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(httpError(504, 'SMTP connection timed out.'));
    }, config.timeoutMs);

    socket.once(eventName, () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(httpError(502, `SMTP connection failed: ${error.message}`));
    });
  });
}

function upgradeSmtpTls(socket, config) {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({
      socket,
      servername: config.host,
      rejectUnauthorized: config.rejectUnauthorized
    });
    const timer = setTimeout(() => {
      secureSocket.destroy();
      reject(httpError(504, 'SMTP STARTTLS timed out.'));
    }, config.timeoutMs);

    secureSocket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(secureSocket);
    });
    secureSocket.once('error', error => {
      clearTimeout(timer);
      reject(httpError(502, `SMTP STARTTLS failed: ${error.message}`));
    });
  });
}

function createSmtpReader(socket, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let buffer = '';
  let waiting = null;

  const cleanupWaiter = () => {
    if (!waiting) return;
    clearTimeout(waiting.timer);
    waiting = null;
  };
  const fail = error => {
    if (!waiting) return;
    const waiter = waiting;
    cleanupWaiter();
    waiter.reject(error);
  };
  const pump = () => {
    if (!waiting) return;
    const response = takeSmtpResponse(buffer);
    if (!response) return;
    buffer = response.rest;
    const waiter = waiting;
    cleanupWaiter();
    if (!waiter.expected.includes(response.code)) {
      waiter.reject(httpError(502, `SMTP command failed. Code=${response.code}`, {
        response: safePreview(response.raw, 600)
      }));
      return;
    }
    waiter.resolve(response);
  };
  const onData = chunk => {
    buffer += chunk.toString('utf8');
    pump();
  };

  socket.on('data', onData);
  socket.on('error', fail);
  socket.on('close', () => fail(httpError(502, 'SMTP connection closed unexpectedly.')));

  return {
    read(expected) {
      return new Promise((resolve, reject) => {
        waiting = {
          expected,
          resolve,
          reject,
          timer: setTimeout(() => {
            fail(httpError(504, 'SMTP response timed out.'));
          }, timeoutMs)
        };
        pump();
      });
    },
    command(command, expected) {
      socket.write(`${command}\r\n`);
      return this.read(expected);
    },
    detach() {
      cleanupWaiter();
      socket.off('data', onData);
      socket.off('error', fail);
    }
  };
}

function takeSmtpResponse(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const newlineIndex = buffer.indexOf('\n', offset);
    if (newlineIndex === -1) return null;

    const rawLine = buffer.slice(offset, newlineIndex + 1);
    const line = rawLine.replace(/\r?\n$/, '');
    const match = line.match(/^(\d{3})([ -])/);
    offset = newlineIndex + 1;

    if (match && match[2] === ' ') {
      return {
        code: Number(match[1]),
        raw: buffer.slice(0, offset),
        rest: buffer.slice(offset)
      };
    }
  }
  return null;
}

function formatMailMessage(config, message, messageId) {
  const attachments = Array.isArray(message.attachments) ? message.attachments.filter(attachment => attachment?.content) : [];
  const mixedBoundary = `camera-report-mixed-${crypto.randomUUID()}`;
  const alternativeBoundary = `camera-report-alt-${crypto.randomUUID()}`;
  const headers = [
    `From: ${formatMailAddress(config.from)}`,
    `To: ${message.to.map(formatMailAddress).join(', ')}`,
    `Subject: ${encodeMimeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    `Content-Type: ${attachments.length ? 'multipart/mixed' : 'multipart/alternative'}; boundary="${attachments.length ? mixedBoundary : alternativeBoundary}"`
  ];

  const alternativePart = [
    `--${alternativeBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    message.text,
    '',
    `--${alternativeBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    message.html,
    '',
    `--${alternativeBoundary}--`
  ].join('\r\n');

  if (!attachments.length) {
    return [
      ...headers,
      '',
      alternativePart,
      ''
    ].join('\r\n');
  }

  const attachmentParts = attachments.map(attachment => {
    const fileName = safeAttachmentFileName(attachment.fileName || 'report.docx');
    const content = Buffer.isBuffer(attachment.content)
      ? attachment.content
      : Buffer.from(String(attachment.content || ''), 'utf8');
    return [
      `--${mixedBoundary}`,
      `Content-Type: ${attachment.contentType || 'application/octet-stream'}; name="${escapeMailHeaderParam(fileName)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${escapeMailHeaderParam(fileName)}"`,
      '',
      foldBase64(content)
    ].join('\r\n');
  });

  return [
    ...headers,
    '',
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    '',
    alternativePart,
    ...attachmentParts,
    `--${mixedBoundary}--`,
    ''
  ].join('\r\n');
}

function smtpData(value) {
  return String(value || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

function foldBase64(buffer) {
  return buffer.toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

function safeAttachmentFileName(value) {
  const cleaned = String(value || 'report.docx')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '-')
    .slice(0, 120);
  return cleaned.endsWith('.docx') ? cleaned : `${cleaned || 'report'}.docx`;
}

function escapeMailHeaderParam(value) {
  return String(value || '').replace(/["\\\r\n]/g, '_');
}

function formatMailAddress(value) {
  const text = String(value || '').trim();
  const email = extractEmailAddress(text);
  const display = text.replace(/<[^>]+>/, '').trim().replace(/^"|"$/g, '');
  if (!display || display === email) return `<${email}>`;
  return `${encodeMimeHeader(display)} <${email}>`;
}

function extractEmailAddress(value) {
  const text = String(value || '').trim();
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim();
}

function encodeMimeHeader(value) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (!/[^\x20-\x7e]/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function formatReportDateTime(value, timeZone = configuredDisplayTimeZone(), sourceTimeZone = timeZone) {
  if (!value) return '';
  try {
    return formatDateTimeInZone(zonedDateTimeToEpochMs(value, sourceTimeZone), timeZone, 'ru-RU');
  } catch {
    return String(value);
  }
}

function escapeHtmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function captureRtspWav(config, options, outputPath, capture) {
  const rtspUrl = buildRtspUrl(config, options);
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-rtsp_transport',
    'tcp',
    '-i',
    rtspUrl,
    '-vn'
  ];

  addAudioFilterArgs(args, capture.audioFilter);
  if (capture.durationSeconds > 0) {
    args.push('-t', formatDuration(capture.durationSeconds));
  }
  args.push(
    '-ac',
    '1',
    '-ar',
    '16000',
    '-acodec',
    'pcm_s16le',
    '-f',
    'wav',
    outputPath
  );

  return runProcess(config.ffmpegPath, args, {
    label: 'ffmpeg transcription capture failed',
    timeoutMs: captureTimeoutMs(capture.durationSeconds, config),
    signal: capture.signal,
    redactConfig: config
  });
}

async function openXmArchivePcmSession(config, params, channel, stream, capture, dependencies = {}) {
  if (!(capture.durationSeconds > 0) || !Number.isFinite(capture.durationSeconds)) {
    throw httpError(400, 'Progressive XM capture duration must be finite and positive.');
  }
  const startedAt = Date.now();
  const fileName = params.get('fileName') || '';
  const baseLocalBeginTime = params.get('localBeginTime') || toXmLocalTime(params.get('from') || new Date().toISOString());
  const localBeginTime = addSecondsToLocalDateTime(baseLocalBeginTime, capture.offsetSeconds || 0, ' ');
  const localEndTime = addSecondsToLocalDateTime(localBeginTime, capture.durationSeconds, ' ');
  const loginStartedAt = Date.now();
  const loginXm = dependencies.login || xmLogin;
  const logoutXm = dependencies.logout || xmLogout;
  const spawnProcess = dependencies.spawnProcess || spawn;
  const openWebSocket = dependencies.openWebSocket || openXmWebSocket;
  const sendCameraJson = dependencies.cameraJsonRequest || cameraJsonRequest;
  const login = await loginXm(config);
  const loginMs = Date.now() - loginStartedAt;
  const xmChannel = Math.max(0, channel - 1);
  const streamName = stream === 'sub' ? 'Sub' : 'Main';
  const xmAudioCodec = normalizeXmAudioCodec(params.get('xmAudioCodec') || config.xmAudioCodec);
  const playbackOperation = fileName ? 'StartDownLoad' : 'StartPlay';
  const playbackMode = fileName ? 'PlayByName' : 'PlayByTime';
  const wsPath = `/websocket-bin/Type=HttpPlayBack?Salt=${encodeURIComponent(login.salt)}&Channel=${xmChannel}&Stream=${streamName}&XMHead=1`;
  const ffmpegArgs = [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-f', xmAudioCodec, '-ar', '8000', '-ac', '1', '-i', 'pipe:0'
  ];
  addAudioFilterArgs(ffmpegArgs, capture.audioFilter);
  ffmpegArgs.push(
    '-ac', '1', '-ar', String(TRANSCRIPTION_PCM_SAMPLE_RATE),
    '-acodec', 'pcm_s16le', '-f', 's16le', 'pipe:1'
  );

  let ffmpeg;
  try {
    ffmpeg = spawnProcess(config.ffmpegPath, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (error) {
    await logoutXm(config, login).catch(() => {});
    throw error;
  }
  // ChildProcess can auto-drain stdout on exit before our caller attaches its
  // iterator. Pipe immediately so even a fast short recording is retained.
  const pcmOutput = new PassThrough({ highWaterMark: 64 * 1024 });
  pcmOutput.on('error', () => {});
  ffmpeg.stdout.pipe(pcmOutput);
  const expectedRawBytes = Math.ceil(capture.durationSeconds * 8000);
  const stats = {
    loginMs,
    firstAudioMs: 0,
    captureMs: 0,
    rawBytes: 0,
    sourceSeconds: capture.durationSeconds,
    pauseCount: 0,
    pausedMs: 0,
    websocketFrames: 0,
    continuationFrames: 0
  };
  let wsHandle;
  let stderr = '';
  let commandStarted = false;
  let settled = false;
  let cleaned = false;
  let idleTimer;
  let resolveDone;
  let rejectDone;
  let pausedAt = 0;
  const websocketController = new AbortController();
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // A session may fail before the caller starts consuming stdout.
  done.catch(() => {});

  const idleTimeoutMs = Math.max(
    30000,
    Math.min(Number(config.transcriptionCaptureTimeoutMs) || 120000, 120000)
  );
  const touchIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      finish(httpError(504, 'Timed out while waiting for XM archive audio.', {
        channel, localBeginTime, localEndTime, fileName,
        receivedAudioBytes: stats.rawBytes,
        idleTimeoutMs
      }));
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (pausedAt) stats.pausedMs += Date.now() - pausedAt;
    pausedAt = 0;
    clearTimeout(idleTimer);
    capture.signal?.removeEventListener('abort', abort);
    websocketController.abort();
    try { wsHandle?.destroy(); } catch {}
    if (ffmpeg.exitCode === null && !ffmpeg.killed) ffmpeg.kill('SIGTERM');
    await logoutXm(config, login).catch(() => {});
  };
  const finish = error => {
    if (settled) return;
    settled = true;
    if (error) pcmOutput.destroy(error);
    stats.captureMs = Date.now() - startedAt;
    cleanup().finally(() => {
      if (error) rejectDone(error);
      else resolveDone({ ...stats });
    });
  };
  const abort = () => finish(httpError(499, 'Transcription request was cancelled.'));
  const input = createXmAudioChunkWriter(ffmpeg.stdin, capture.durationSeconds, {
    pause: () => {
      if (!pausedAt) {
        pausedAt = Date.now();
        stats.pauseCount += 1;
      }
      clearTimeout(idleTimer);
      wsHandle?.pause();
    },
    resume: () => {
      if (pausedAt) stats.pausedMs += Date.now() - pausedAt;
      pausedAt = 0;
      wsHandle?.resume();
      touchIdleTimer();
    },
    stop: () => wsHandle?.destroy(),
    onError: error => finish(httpError(502, `Archive audio pipe failed: ${publicError(error)}`, {
      channel, localBeginTime, localEndTime, fileName, receivedAudioBytes: stats.rawBytes
    }))
  });
  const audioDemuxer = createXmG711Demuxer(chunk => {
    if (settled) return;
    if (!stats.firstAudioMs) stats.firstAudioMs = Date.now() - startedAt;
    touchIdleTimer();
    input.write(chunk);
    stats.rawBytes = input.bytesWritten;
  });

  ffmpeg.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });
  ffmpeg.stderr.on('error', error => handleStreamError(error, 'xm progressive ffmpeg stderr failed', config));
  ffmpeg.stdout.on('error', error => finish(error));
  ffmpeg.on('error', error => finish(error));
  ffmpeg.on('close', (code, signal) => {
    stats.rawBytes = input.bytesWritten;
    if (code !== 0) {
      finish(httpError(502, `ffmpeg failed while decoding XM archive audio. ${redactSecrets(stderr, config)}`.trim(), {
        channel, localBeginTime, localEndTime, fileName, exitCode: code, signal,
        receivedAudioBytes: stats.rawBytes
      }));
      return;
    }
    const receivedRawSeconds = stats.rawBytes / 8000;
    if (stats.rawBytes < expectedRawBytes
      && !xmArchiveEndShortfallIsTolerable(capture.durationSeconds, receivedRawSeconds)) {
      if (xmArchivePartialTailIsUsable(capture.durationSeconds, receivedRawSeconds)) {
        stats.partial = true;
        stats.receivedSeconds = receivedRawSeconds;
        finish();
        return;
      }
      finish(httpError(502, 'XM archive audio ended before the requested range was received.', {
        code: 'INCOMPLETE_AUDIO', sourceGapConfirmed: false,
        expectedDurationSeconds: capture.durationSeconds, receivedDurationSeconds: receivedRawSeconds,
        channel, localBeginTime, localEndTime, fileName,
        expectedAudioBytes: expectedRawBytes,
        receivedAudioBytes: stats.rawBytes
      }));
      return;
    }
    finish();
  });

  const playbackOptions = {
    Name: 'HttpPlayBack',
    HttpPlayBack: {
      Opr: playbackOperation,
      PlayMode: playbackMode,
      Channel: xmChannel,
      Stream: streamName,
      ExactSeek: 1
    },
    Salt: login.salt
  };
  if (fileName) {
    playbackOptions.HttpPlayBack.PlayByName = { LocalTime: localBeginTime, FileName: fileName };
  } else {
    playbackOptions.HttpPlayBack.PlayByTime = { BeginTime: localBeginTime, EndTime: localEndTime };
  }

  if (capture.signal?.aborted) {
    abort();
    await done;
  } else {
    capture.signal?.addEventListener('abort', abort, { once: true });
  }
  touchIdleTimer();
  try {
    wsHandle = await openWebSocket(config, wsPath, {
      signal: websocketController.signal,
      onFrame: frame => {
        stats.websocketFrames += 1;
        if (frame.opcode === 0) stats.continuationFrames += 1;
      },
      onText: async text => {
        if (settled) return;
        const message = safeJsonParse(text);
        if (message?.Ret === 100 && message.State === 'Begin' && !commandStarted) {
          commandStarted = true;
          const commandResult = await sendCameraJson(config, '/cgi-bin/websocket.cgi', playbackOptions);
          if (commandResult?.Ret !== undefined && commandResult.Ret !== 100 && commandResult.Ret !== 0) {
            finish(httpError(502, `XM transcription command failed. Ret=${commandResult.Ret}`, {
              channel, localBeginTime, localEndTime, fileName, ret: commandResult.Ret
            }));
          }
        } else if (message?.Ret !== undefined && message.Ret !== 0 && message.Ret !== 100) {
          finish(httpError(502, `XM transcription websocket returned Ret=${message.Ret}`, {
            channel, localBeginTime, localEndTime, fileName, ret: message.Ret
          }));
        }
      },
      onBinary: buffer => {
        if (!settled && buffer.length) audioDemuxer.push(buffer);
      },
      onClose: () => {
        audioDemuxer.flush();
        input.end();
      },
      onError: error => finish(error)
    });
    if (settled || input.ended) wsHandle.destroy();
    else if (input.backpressured) wsHandle.pause();
  } catch (error) {
    finish(error);
    await done;
  }

  return {
    readable: pcmOutput,
    stats,
    done,
    close: async () => {
      if (!settled) finish(httpError(499, 'Progressive XM capture was closed.'));
      await done.catch(() => {});
    }
  };
}

async function uploadDriveTranscriptsRequest(req, res) {
  requireMethod(req, 'POST');
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    throw httpError(403, 'Ручная загрузка на Google Диск разрешена только из локального интерфейса приложения.');
  }
  const payload = await readJsonBody(req, 16 * 1024 * 1024);
  const settings = await readAppSetting('ui_settings').catch(() => ({}));
  const files = buildDriveTranscriptFiles({
    action: payload.action || {},
    from: payload.from,
    to: payload.to,
    selections: payload.selections,
    entries: payload.entries,
    issues: payload.issues,
    diagnostics: payload.diagnostics,
    failedSearches: payload.failedSearches,
    failedRecordings: payload.failedRecordings,
    partial: payload.partial,
    completeness: payload.completeness,
    complete: payload.complete,
    settings: { ...settings, displayTimeZone: payload.timeZone || settings.displayTimeZone }
  });
  const result = await getGoogleDriveClient().uploadCameraTranscripts({
    action: payload.action,
    runKey: String(payload.runKey || `manual:${crypto.randomUUID()}`),
    files,
    signal: requestAbortSignal(req, res)
  });
  return json(res, 200, result);
}

function isLoopbackAddress(value) {
  const address = String(value || '').trim().toLowerCase().split('%', 1)[0];
  if (address === '::1' || address === 'localhost') return true;
  if (address.startsWith('::ffff:')) return isLoopbackAddress(address.slice('::ffff:'.length));
  const match = /^(\d{1,3})(?:\.(\d{1,3})){3}$/.exec(address);
  return Boolean(match && Number(match[1]) === 127);
}

function getGoogleDriveClient() {
  const config = readGoogleDriveConfig();
  const signature = crypto.createHash('sha256').update(JSON.stringify([
    config.authType, config.rootFolderId, config.clientId, config.clientSecret,
    config.refreshToken, config.clientEmail, config.privateKey, config.tokenUri
  ])).digest('hex');
  if (!googleDriveClientState || googleDriveClientState.signature !== signature) {
    googleDriveClientState = { signature, client: createGoogleDriveClient(config) };
  }
  return googleDriveClientState.client;
}

async function findScheduledDriveTranscripts(candidate, context = {}) {
  const selections = (candidate.selections || []).map(selection => ({
    ...selection,
    label: channelLabelFromRows(context.labels, selection.channel)
  }));
  const files = buildDriveTranscriptFiles({
    action: candidate.action,
    from: candidate.from,
    to: candidate.to,
    selections,
    entries: [],
    settings: context.settings
  });
  return getGoogleDriveClient().findUploadedCameraTranscripts({
    action: candidate.action,
    runKey: candidate.runKey,
    files,
    signal: context.signal
  });
}

async function uploadScheduledDriveTranscripts(candidate, transcriptResult, context = {}) {
  assertDriveTranscriptComplete(transcriptResult);
  const files = buildDriveTranscriptFiles({
    action: candidate.action,
    from: candidate.from,
    to: candidate.to,
    selections: candidate.selections.map(selection => ({
      ...selection,
      label: channelLabelFromRows(context.labels, selection.channel)
    })),
    entries: transcriptResult.transcriptEntries,
    issues: transcriptResult.issues,
    diagnostics: transcriptResult.diagnostics,
    settings: context.settings
  });
  return getGoogleDriveClient().uploadCameraTranscripts({
    action: candidate.action,
    runKey: candidate.runKey,
    files,
    signal: context.signal
  });
}

function buildDriveTranscriptFiles(payload = {}) {
  // A marked partial report is still incomplete. Keep recovery data locally;
  // generating an export is allowed only when no known failure remains.
  assertDriveTranscriptComplete(payload);
  const displayTimeZone = configuredDisplayTimeZone(payload.settings);
  const selections = Array.isArray(payload.selections) ? payload.selections : [];
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const channels = new Map();
  for (const selection of selections) {
    const channel = positiveInt(String(selection?.channel || ''), 0);
    if (!channel) continue;
    const current = channels.get(channel) || { channel, label: String(selection.label || `Канал ${channel}`).trim() || `Канал ${channel}`, selections: [] };
    current.selections.push(selection);
    channels.set(channel, current);
  }
  for (const entry of entries) {
    const channel = positiveInt(String(entry?.channel || ''), 0);
    if (!channel || channels.has(channel)) continue;
    channels.set(channel, { channel, label: String(entry.label || `Канал ${channel}`).trim() || `Канал ${channel}`, selections: [] });
  }
  if (!channels.size) throw httpError(400, 'Для загрузки на Google Диск не выбраны камеры.');

  const periodFrom = payload.from || earliestLocalDateTime(selections.map(item => item.from));
  const periodTo = payload.to || latestLocalDateTime(selections.map(item => item.to));
  const periodLabel = `${formatReportDateTime(periodFrom, displayTimeZone)} - ${formatReportDateTime(periodTo, displayTimeZone)}`;
  const dateSlug = driveDateSlug(periodFrom, periodTo, displayTimeZone);
  const actionName = safeDriveFilePart(payload.action?.name || 'Транскрибация');

  return [...channels.values()].sort((left, right) => left.channel - right.channel).map(camera => {
    const diagnostics = (payload.diagnostics || []).filter(item => Number(item.channel) === camera.channel);
    const processedSeconds = diagnostics.reduce((sum, item) => sum + Math.max(0, Number(item.processedSeconds) || 0), 0);
    const seen = new Set();
    const cameraEntries = entries
      .filter(entry => Number(entry?.channel) === camera.channel && String(entry?.text || '').trim())
      .map(entry => {
        const startMs = safeInstantMs(entry.start, displayTimeZone);
        const endMs = safeInstantMs(entry.end, displayTimeZone);
        return { ...entry, startMs, endMs, text: String(entry.text || '').trim() };
      })
      .sort((left, right) => (left.startMs || 0) - (right.startMs || 0))
      .filter(entry => {
        const key = `${entry.startMs}:${entry.endMs}:${entry.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const lines = [
      `Камера: ${String(camera.channel).padStart(2, '0')} — ${camera.label}`,
      `Период: ${periodLabel}`,
      `Часовой пояс: ${displayTimeZone}`,
      `Действие: ${payload.action?.name || 'Транскрибация'}`,
      '',
      ...(cameraEntries.length
        ? cameraEntries.map(entry => `[${formatReportDateTime(entry.start, displayTimeZone)}–${formatReportDateTime(entry.end, displayTimeZone)}] ${entry.text}`)
        : ['Речь в выбранном периоде не обнаружена.'])
    ];
    return {
      channel: camera.channel,
      label: camera.label,
      completeness: 'complete',
      processedSeconds,
      fileName: `${String(camera.channel).padStart(2, '0')} ${safeDriveFilePart(camera.label)} — ${dateSlug} — ${actionName}.txt`,
      content: `\uFEFF${lines.join('\n')}\n`
    };
  });
}

function safeInstantMs(value, sourceTimeZone) {
  try { return zonedDateTimeToEpochMs(value, sourceTimeZone); } catch { return Number.NaN; }
}

function driveDateSlug(from, to, timeZone) {
  const format = value => {
    try { return localDateTimeInZone(zonedDateTimeToEpochMs(value, timeZone), timeZone).replace('T', '_').replaceAll(':', '-'); }
    catch { return 'period'; }
  };
  return `${format(from)}--${format(to)}`;
}

function safeDriveFilePart(value) {
  return String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Транскрибация';
}

async function captureXmArchiveWav(config, params, channel, stream, outputPath, capture) {
  if (!(capture.durationSeconds > 0) || capture.durationSeconds > archiveCaptureChunkSeconds(config)) {
    throw httpError(400, 'Archive audio must be captured in bounded chunks.');
  }
  const fileName = params.get('fileName') || '';
  const baseLocalBeginTime = params.get('localBeginTime') || toXmLocalTime(params.get('from') || new Date().toISOString());
  const localBeginTime = addSecondsToLocalDateTime(baseLocalBeginTime, capture.offsetSeconds || 0, ' ');
  const localEndTime = capture.durationSeconds > 0
    ? addSecondsToLocalDateTime(localBeginTime, capture.durationSeconds, ' ')
    : toXmLocalTime(params.get('localEndTime') || params.get('to') || addSecondsToLocalDateTime(localBeginTime, 60, ' '));
  const login = await xmLogin(config);
  const xmChannel = Math.max(0, channel - 1);
  const streamName = stream === 'sub' ? 'Sub' : 'Main';
  const xmAudioCodec = normalizeXmAudioCodec(params.get('xmAudioCodec') || config.xmAudioCodec);
  const wsPath = `/websocket-bin/Type=HttpPlayBack?Salt=${encodeURIComponent(login.salt)}&Channel=${xmChannel}&Stream=${streamName}&XMHead=1`;
  const playbackOperation = fileName ? 'StartDownLoad' : 'StartPlay';
  const playbackMode = fileName ? 'PlayByName' : 'PlayByTime';

  const ffmpegArgs = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-f',
    xmAudioCodec,
    '-ar',
    '8000',
    '-ac',
    '1',
    '-i',
    'pipe:0'
  ];
  addAudioFilterArgs(ffmpegArgs, capture.audioFilter);
  // The G.711 input is bounded below, so ffmpeg can drain it without an early pipe close.
  ffmpegArgs.push(
    '-ac',
    '1',
    '-ar',
    '16000',
    '-acodec',
    'pcm_s16le',
    '-f',
    'wav',
    outputPath
  );

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(config.ffmpegPath, ffmpegArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    });
    let wsHandle;
    let closed = false;
    let commandStarted = false;
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      finish(httpError(504, 'Timed out while preparing archive audio for transcription.', xmPlaybackDetails({
        action: 'HttpPlayBack',
        operation: playbackOperation,
        playbackMode,
        channel,
        deviceChannel: xmChannel,
        stream: streamName,
        localBeginTime,
        localEndTime,
        fileName,
        websocket: wsPath.replace(/Salt=[^&]+/, 'Salt=***')
      })));
    }, captureTimeoutMs(capture.durationSeconds, config));

    const cleanup = async () => {
      if (closed) return;
      closed = true;
      capture.signal?.removeEventListener('abort', abort);

      try {
        wsHandle?.destroy();
      } catch {}

      if (ffmpeg.exitCode === null && !ffmpeg.killed) {
        ffmpeg.kill('SIGTERM');
      }

      await xmLogout(config, login).catch(() => {});
    };

    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup().finally(() => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    };

    const input = createXmAudioChunkWriter(ffmpeg.stdin, capture.durationSeconds, {
      pause: () => wsHandle?.pause(),
      resume: () => wsHandle?.resume(),
      stop: () => wsHandle?.destroy(),
      onError: error => finish(httpError(502, `Archive audio pipe failed: ${publicError(error)}`, {
        channel, localBeginTime, localEndTime, fileName,
        receivedAudioBytes: input.bytesWritten
      }))
    });
    const audioDemuxer = createXmG711Demuxer(chunk => input.write(chunk));
    ffmpeg.stderr.on('error', error => handleStreamError(error, 'xm transcription ffmpeg stderr failed', config));
    ffmpeg.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    ffmpeg.on('error', error => finish(error));
    ffmpeg.on('close', (code, signal) => {
      if (code !== 0) {
        finish(httpError(502, `ffmpeg failed while preparing archive audio. ${redactSecrets(stderr, config)}`.trim(), {
          channel, localBeginTime, localEndTime, fileName, exitCode: code, signal,
          durationSeconds: capture.durationSeconds, receivedAudioBytes: input.bytesWritten
        }));
        return;
      }
      finish();
    });

    const abort = () => {
      finish(httpError(499, 'Transcription request was cancelled.'));
    };
    if (capture.signal?.aborted) {
      abort();
      return;
    }
    capture.signal?.addEventListener('abort', abort, { once: true });

    const playbackOptions = {
      Name: 'HttpPlayBack',
      HttpPlayBack: {
        Opr: playbackOperation,
        PlayMode: playbackMode,
        Channel: xmChannel,
        Stream: streamName,
        ExactSeek: 1
      },
      Salt: login.salt
    };

    if (fileName) {
      playbackOptions.HttpPlayBack.PlayByName = {
        LocalTime: localBeginTime,
        FileName: fileName
      };
    } else {
      playbackOptions.HttpPlayBack.PlayByTime = {
        BeginTime: localBeginTime,
        EndTime: localEndTime
      };
    }

    openXmWebSocket(config, wsPath, {
      onText: async text => {
        if (settled) return;
        const message = safeJsonParse(text);
        if (message?.Ret === 100 && message.State === 'Begin' && !commandStarted) {
          commandStarted = true;
          try {
            const commandResult = await cameraJsonRequest(config, '/cgi-bin/websocket.cgi', playbackOptions);
            if (commandResult?.Ret !== undefined && commandResult.Ret !== 100 && commandResult.Ret !== 0) {
              finish(httpError(502, `XM transcription command failed. Ret=${commandResult.Ret}`, xmPlaybackDetails({
                action: 'HttpPlayBack',
                operation: playbackOperation,
                playbackMode,
                ret: commandResult.Ret,
                channel,
                deviceChannel: xmChannel,
                stream: streamName,
                localBeginTime,
                localEndTime,
                fileName
              })));
            }
          } catch (error) {
            console.warn(`xm transcription command failed: ${redactSecrets(error.message, config)}`);
            finish(error);
          }
        } else if (message?.Ret !== undefined && message.Ret !== 0 && message.Ret !== 100) {
          finish(httpError(502, `XM transcription websocket returned Ret=${message.Ret}`, xmPlaybackDetails({
            action: 'HttpPlayBackWebSocket',
            operation: playbackOperation,
            playbackMode,
            ret: message.Ret,
            channel,
            deviceChannel: xmChannel,
            stream: streamName,
            localBeginTime,
            localEndTime,
            fileName
          })));
        }
      },
      onBinary: buffer => {
        if (!settled && !input.ended && buffer.length > 0) {
          audioDemuxer.push(buffer);
        }
      },
      onClose: () => {
        audioDemuxer.flush();
        input.end();
      },
      onError: error => {
        finish(error);
      }
    })
      .then(handle => {
        wsHandle = handle;
        if (settled || input.ended) handle.destroy();
        else if (input.backpressured) handle.pause();
      })
      .catch(error => {
        finish(error);
      });
  });
}

function createXmAudioChunkWriter(input, durationSeconds, handlers = {}) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw httpError(400, 'Audio chunk duration must be finite and positive.');
  }
  // Mono G.711 at 8 kHz carries exactly 8,000 bytes per second.
  const byteLimit = Math.ceil(durationSeconds * 8000);
  let bytesWritten = 0;
  let ended = false;
  let backpressured = false;
  const end = () => {
    if (ended) return;
    ended = true;
    if (!input.destroyed && !input.writableEnded) input.end();
    handlers.stop?.();
  };
  input.on('error', error => {
    ended = true;
    handlers.stop?.();
    handlers.onError?.(error);
  });
  input.on('drain', () => {
    backpressured = false;
    if (!ended) handlers.resume?.();
  });
  return {
    get bytesWritten() { return bytesWritten; },
    get ended() { return ended; },
    get backpressured() { return backpressured; },
    end,
    write(chunk) {
      if (ended || !chunk.length) return;
      const data = chunk.subarray(0, byteLimit - bytesWritten);
      bytesWritten += data.length;
      if (!input.write(data)) {
        backpressured = true;
        handlers.pause?.();
      }
      if (bytesWritten >= byteLimit) end();
    }
  };
}

async function streamRecordingFile(req, res, config, params) {
  requireCameraAuth(config);

  const vendor = normalizeVendor(params.get('vendor') || config.vendor);
  const channel = positiveInt(params.get('channel'), 1);
  const stream = params.get('stream') || 'main';

  if (vendor === 'xm') {
    return streamXmArchiveFile(req, res, config, params, channel, stream);
  }

  throw httpError(422, 'Recording file download is implemented for XM/Xiongmai archive search results.');
}

async function streamXmArchiveFile(req, res, config, params, channel, stream) {
  const fileName = params.get('fileName') || '';
  if (!fileName) {
    return json(res, 400, {
      ok: false,
      error: 'XM archive file download requires fileName from /api/recordings/search.'
    });
  }

  const localBeginTime = params.get('localBeginTime') || toXmLocalTime(params.get('from') || new Date().toISOString());
  const login = await xmLogin(config);
  const xmChannel = Math.max(0, channel - 1);
  const streamName = stream === 'sub' ? 'Sub' : 'Main';
  const wsPath = `/websocket-bin/Type=HttpPlayBack?Salt=${encodeURIComponent(login.salt)}&Channel=${xmChannel}&Stream=${streamName}&XMHead=0`;
  const downloadName = recordingDownloadName(fileName);
  const sizeBytes = positiveNumber(params.get('sizeBytes'));
  let wsHandle;
  let closed = false;
  let commandStarted = false;
  let bytesSent = 0;

  const cleanup = async () => {
    if (closed) return;
    closed = true;

    try {
      wsHandle?.close();
    } catch {}

    await xmLogout(config, login).catch(() => {});
  };

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDispositionAttachment(downloadName),
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no'
  };

  if (Number.isFinite(sizeBytes)) {
    headers['X-Recording-Size-Bytes'] = String(sizeBytes);
  }

  res.writeHead(200, headers);

  req.on('aborted', cleanup);
  req.on('error', error => {
    handleStreamError(error, 'client recording request failed', config);
    cleanup();
  });
  res.on('close', cleanup);
  res.on('error', error => {
    handleStreamError(error, 'client recording response failed', config);
    cleanup();
  });

  const playbackOptions = {
    Name: 'HttpPlayBack',
    HttpPlayBack: {
      Opr: 'StartDownLoad',
      PlayMode: 'PlayByName',
      Channel: xmChannel,
      Stream: streamName,
      ExactSeek: 1,
      PlayByName: {
        LocalTime: localBeginTime,
        FileName: fileName
      }
    },
    Salt: login.salt
  };

  try {
    wsHandle = await openXmWebSocket(config, wsPath, {
      onText: async text => {
        const message = safeJsonParse(text);
        if (message?.Ret === 100 && message.State === 'Begin' && !commandStarted) {
          commandStarted = true;
          await cameraJsonRequest(config, '/cgi-bin/websocket.cgi', playbackOptions).catch(error => {
            console.warn(`xm file download command failed: ${redactSecrets(error.message, config)}`);
            cleanup();
          });
        } else if (message?.Ret !== undefined && message.Ret !== 0 && message.Ret !== 100) {
          console.warn(`xm file download websocket returned Ret=${message.Ret}`);
          cleanup();
        }
      },
      onBinary: buffer => {
        if (res.writableEnded) return;
        bytesSent += buffer.length;
        const writeOk = safeStreamWrite(res, buffer, error => {
          handleStreamError(error, 'recording file write failed', config);
          cleanup();
        });
        if (!writeOk && (res.destroyed || res.writableEnded)) {
          cleanup();
        } else if (!writeOk) {
          wsHandle?.pause?.();
          res.once('drain', () => wsHandle?.resume?.());
        }
      },
      onClose: () => {
        if (!res.writableEnded) res.end();
        xmLogout(config, login).catch(() => {});
      },
      onError: error => {
        console.warn(`xm file download websocket failed after ${bytesSent} bytes: ${redactSecrets(error.message || String(error), config)}`);
        cleanup();
      }
    });
  } catch (error) {
    console.warn(`xm file download setup failed: ${redactSecrets(error.message, config)}`);
    cleanup();
    if (!res.writableEnded) res.end();
  }
}

async function streamXmArchiveAudio(req, res, config, params, channel, stream) {
  const fileName = params.get('fileName') || '';
  const localBeginTime = params.get('localBeginTime') || toXmLocalTime(params.get('from') || new Date().toISOString());
  const localEndTime = params.get('localEndTime') || toXmLocalTime(params.get('to') || addSecondsToLocalDateTime(localBeginTime, 60, ' '));
  const login = await xmLogin(config);
  const xmChannel = Math.max(0, channel - 1);
  const streamName = stream === 'sub' ? 'Sub' : 'Main';
  const playbackOperation = fileName ? 'StartDownLoad' : 'StartPlay';
  const playbackMode = fileName ? 'PlayByName' : 'PlayByTime';
  const rawMode = params.get('raw') === '1';
  const audioFilter = normalizeAudioFilter(params.get('audioFilter') || config.audioFilter);
  const xmAudioCodec = normalizeXmAudioCodec(params.get('xmAudioCodec') || config.xmAudioCodec);
  const xmHead = rawMode && params.get('xmHead') === '0' ? '0' : '1';
  const wsPath = `/websocket-bin/Type=HttpPlayBack?Salt=${encodeURIComponent(login.salt)}&Channel=${xmChannel}&Stream=${streamName}&XMHead=${xmHead}`;

  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-f',
    xmAudioCodec,
    '-ar',
    '8000',
    '-ac',
    '1',
    '-i',
    'pipe:0'
  ];
  addAudioFilterArgs(ffmpegArgs, audioFilter);
  ffmpegArgs.push(
    '-ac',
    '1',
    '-ar',
    '44100',
    '-b:a',
    '96k',
    '-f',
    'mp3',
    'pipe:1'
  );

  const ffmpeg = rawMode
    ? null
    : spawn(config.ffmpegPath, ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

  let stderr = '';
  let wsHandle;
  let closed = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;

    try {
      wsHandle?.close();
    } catch {}

    if (ffmpeg && !ffmpeg.killed) {
      ffmpeg.kill('SIGTERM');
    }

    await xmLogout(config, login).catch(() => {});
  };

  const audioDemuxer = rawMode
    ? null
    : createXmG711Demuxer(chunk => {
        safeStreamWrite(ffmpeg.stdin, chunk, error => {
          handleStreamError(error, 'xm ffmpeg stdin failed', config);
          cleanup();
        });
      });

  res.writeHead(200, {
    'Content-Type': rawMode ? 'application/octet-stream' : 'audio/mpeg',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no'
  });

  if (ffmpeg) {
    ffmpeg.stdout.pipe(res);
    ffmpeg.stdin.on('error', error => handleStreamError(error, 'xm ffmpeg stdin failed', config));
    ffmpeg.stdout.on('error', error => handleStreamError(error, 'xm ffmpeg stdout failed', config));
    ffmpeg.stderr.on('error', error => handleStreamError(error, 'xm ffmpeg stderr failed', config));
    ffmpeg.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    ffmpeg.on('close', code => {
      if (code !== 0 && code !== null && stderr) {
        console.warn(`xm ffmpeg exited with ${code}: ${redactSecrets(stderr, config)}`);
      }
      if (!res.writableEnded) res.end();
    });
    ffmpeg.on('error', error => {
      console.warn(`xm ffmpeg start failed: ${redactSecrets(error.message, config)}`);
      if (!res.writableEnded) res.end();
    });
  }

  req.on('aborted', cleanup);
  req.on('error', error => {
    handleStreamError(error, 'client xm audio request failed', config);
    cleanup();
  });
  res.on('close', cleanup);
  res.on('error', error => {
    handleStreamError(error, 'client xm audio response failed', config);
    cleanup();
  });

  const playbackOptions = {
    Name: 'HttpPlayBack',
    HttpPlayBack: {
      Opr: playbackOperation,
      PlayMode: playbackMode,
      Channel: xmChannel,
      Stream: streamName,
      ExactSeek: 1
    },
    Salt: login.salt
  };

  if (fileName) {
    playbackOptions.HttpPlayBack.PlayByName = {
      LocalTime: localBeginTime,
      FileName: fileName
    };
  } else {
    playbackOptions.HttpPlayBack.PlayByTime = {
      BeginTime: localBeginTime,
      EndTime: localEndTime
    };
  }

  try {
    wsHandle = await openXmWebSocket(config, wsPath, {
      onText: async text => {
        const message = safeJsonParse(text);
        if (message?.Ret === 100 && message.State === 'Begin') {
          await cameraJsonRequest(config, '/cgi-bin/websocket.cgi', playbackOptions).then(commandResult => {
            if (commandResult?.Ret !== undefined && commandResult.Ret !== 100 && commandResult.Ret !== 0) {
              console.warn(`xm playback command returned Ret=${commandResult.Ret}`);
              cleanup();
            }
          }).catch(error => {
            console.warn(`xm playback command failed: ${redactSecrets(error.message, config)}`);
            cleanup();
          });
        } else if (message?.Ret !== undefined && message.Ret !== 0 && message.Ret !== 100) {
          console.warn(`xm playback websocket returned Ret=${message.Ret}`);
          cleanup();
        }
      },
      onBinary: buffer => {
        if (rawMode) {
          if (!res.writableEnded) res.write(buffer);
        } else if (buffer.length > 0) {
          audioDemuxer.push(buffer);
        }
      },
      onClose: () => {
        if (rawMode) {
          if (!res.writableEnded) res.end();
        } else {
          audioDemuxer.flush();
          if (ffmpeg.stdin.writable) {
            ffmpeg.stdin.end();
          }
        }
        xmLogout(config, login).catch(() => {});
      },
      onError: error => {
        console.warn(`xm playback websocket failed: ${redactSecrets(error.message || String(error), config)}`);
        cleanup();
      }
    });
  } catch (error) {
    console.warn(`xm playback setup failed: ${redactSecrets(error.message, config)}`);
    cleanup();
  }
}

function buildRtspUrl(config, options) {
  const vendor = normalizeVendor(options.vendor);

  if (options.source) {
    return withRtspCredentials(options.source, config);
  }

  if (config.rtspTemplate) {
    return fillTemplate(config.rtspTemplate, {
      user: encodeURIComponent(config.user),
      password: encodeURIComponent(config.password),
      host: config.host,
      rtspPort: String(config.rtspPort),
      channel: String(options.channel),
      stream: options.stream || 'main',
      subtype: streamToDahuaSubtype(options.stream || 'main')
    });
  }

  if (vendor === 'hikvision' || vendor === 'auto') {
    const base = rtspBase(config);
    const trackId = `${options.channel}01`;

    if (options.from && options.to) {
      return `${base}/Streaming/tracks/${trackId}?starttime=${toHikvisionRtspTime(options.from, config)}&endtime=${toHikvisionRtspTime(options.to, config)}`;
    }

    const streamNo = options.stream === 'sub' ? '02' : '01';
    return `${base}/Streaming/Channels/${options.channel}${streamNo}`;
  }

  if (vendor === 'dahua') {
    const base = rtspBase(config);
    const subtype = streamToDahuaSubtype(options.stream || 'main');

    if (options.from && options.to) {
      return `${base}/cam/playback?channel=${options.channel}&subtype=${subtype}&starttime=${toDahuaRtspTime(options.from)}&endtime=${toDahuaRtspTime(options.to)}`;
    }

    return `${base}/cam/realmonitor?channel=${options.channel}&subtype=${subtype}`;
  }

  if (vendor === 'xm') {
    const base = rtspBase(config);
    const streamNo = options.stream === 'sub' ? 1 : 0;
    const user = encodeURIComponent(config.user);
    const password = encodeURIComponent(config.password);
    return `${base}/user=${user}_password=${password}_channel=${options.channel}_stream=${streamNo}.sdp?real_stream`;
  }

  throw httpError(422, 'Set CAMERA_VENDOR to xm, hikvision, or dahua, or define RTSP_URL_TEMPLATE for this device.');
}

function rtspBase(config) {
  const user = encodeURIComponent(config.user);
  const password = encodeURIComponent(config.password);
  return `rtsp://${user}:${password}@${config.host}:${config.rtspPort}`;
}

function withRtspCredentials(source, config) {
  try {
    const url = new URL(source);
    if (!url.username) url.username = config.user;
    if (!url.password) url.password = config.password;
    return url.toString();
  } catch {
    throw httpError(400, 'Invalid playback RTSP source.');
  }
}

function fillTemplate(template, values) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => values[key] ?? match);
}

function normalizeVendor(value) {
  const vendor = String(value || 'auto').toLowerCase();
  if (vendor === 'xiongmai' || vendor === 'xmeye') return 'xm';
  return vendor;
}

function streamToDahuaSubtype(stream) {
  return stream === 'sub' ? '1' : '0';
}

async function cameraRequest(config, pathOrUrl, options = {}) {
  const target = typeof pathOrUrl === 'string' ? new URL(pathOrUrl, cameraBaseUrl(config)) : pathOrUrl;
  const method = options.method || 'GET';
  const body = options.body ? Buffer.from(options.body) : null;
  const baseHeaders = {
    Accept: '*/*',
    ...(options.headers || {})
  };

  if (body && !baseHeaders['Content-Length']) {
    baseHeaders['Content-Length'] = String(body.length);
  }

  const first = await cameraHttpRequest(target, {
    method,
    headers: baseHeaders,
    body,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS
  });

  if (first.statusCode !== 401) return first;

  const challenge = first.headers['www-authenticate'] || '';
  if (/digest/i.test(challenge)) {
    const uri = `${target.pathname}${target.search}`;
    const auth = digestHeader(challenge, method, uri, config.user, config.password);
    return cameraHttpRequest(target, {
      method,
      headers: {
        ...baseHeaders,
        Authorization: auth
      },
      body,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS
    });
  }

  const basic = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`;
  return cameraHttpRequest(target, {
    method,
    headers: {
      ...baseHeaders,
      Authorization: basic
    },
    body,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS
  });
}

async function cameraJsonRequest(config, pathOrUrl, payload, options = {}) {
  const response = await cameraRequest(config, pathOrUrl, {
    method: options.method || 'POST',
    body: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      ...(options.headers || {})
    },
    timeoutMs: options.timeoutMs
  });

  ensureOk(response, 'Camera JSON request failed');
  const text = response.body.toString('utf8').replace(/\0+$/g, '').trim();
  const data = safeJsonParse(text);
  if (!data) {
    throw httpError(502, `Camera returned non-JSON response: ${safePreview(text)}`);
  }
  return data;
}

function cameraBaseUrl(config) {
  const port = config.httpPort;
  const defaultPort = config.scheme === 'https' ? 443 : 80;
  const portPart = port && port !== defaultPort ? `:${port}` : '';
  return `${config.scheme}://${config.host}${portPart}`;
}

async function cameraHttpRequest(target, options) {
  try {
    return await rawHttpRequest(target, options);
  } catch (error) {
    const code = error.code || error.cause?.code;
    if (!['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EACCES'].includes(code)) throw error;
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const address = `${target.hostname}:${port}`;
    const message = code === 'ETIMEDOUT'
      ? `Регистратор ${address} не ответил за ${options.timeoutMs / 1000} с (ETIMEDOUT).`
      : `Нет связи с регистратором ${address} (${code}).`;
    const failure = httpError(code === 'ETIMEDOUT' ? 504 : 502,
      `${message} Проверьте доступность регистратора и локальную сеть.`, {
        host: target.hostname, port, endpoint: target.pathname, code, timeoutMs: options.timeoutMs
      });
    failure.code = code;
    throw failure;
  }
}

function rawHttpRequest(target, options) {
  const lib = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      target,
      {
        method: options.method,
        headers: options.headers,
        timeout: options.timeoutMs
      },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );

    req.on('timeout', () => req.destroy(Object.assign(
      new Error(`Request timed out after ${options.timeoutMs} ms.`), { code: 'ETIMEDOUT' }
    )));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function openXmWebSocket(config, wsPath, handlers) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    let settled = false;
    const request = http.request({
      host: config.host,
      port: config.httpPort || 80,
      path: wsPath,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        Origin: cameraBaseUrl(config)
      },
      timeout: DEFAULT_TIMEOUT_MS
    });
    const cleanupHandshake = () => handlers.signal?.removeEventListener('abort', abort);
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanupHandshake();
      reject(error);
    };
    const succeed = value => {
      if (settled) return false;
      settled = true;
      cleanupHandshake();
      resolve(value);
      return true;
    };
    const abort = () => {
      const error = httpError(499, 'WebSocket connection was cancelled.');
      request.destroy(error);
      fail(error);
    };

    request.on('upgrade', (response, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if (response.statusCode !== 101) {
        socket.destroy();
        fail(new Error(`WebSocket upgrade failed with HTTP ${response.statusCode}`));
        return;
      }

      const parser = createWebSocketFrameParser({
        onFrame: handlers.onFrame,
        onText: handlers.onText,
        onBinary: handlers.onBinary,
        onClose: () => {
          handlers.onClose?.();
          socket.destroy();
        },
        onPing: payload => sendWebSocketFrame(socket, 0xA, payload)
      });

      socket.on('data', chunk => {
        try {
          parser.push(chunk);
        } catch (error) {
          handlers.onError?.(error);
          socket.destroy();
        }
      });
      socket.on('close', () => handlers.onClose?.());
      socket.on('error', error => handlers.onError?.(error));
      if (head?.length) parser.push(head);

      const handle = {
        destroy: () => socket.destroy(),
        close: () => {
          if (!socket.destroyed) {
            sendWebSocketFrame(socket, 0x8, Buffer.alloc(0));
            socket.end();
          }
        },
        pause: () => socket.pause(),
        resume: () => socket.resume()
      };
      if (!succeed(handle)) socket.destroy();
    });

    request.on('response', response => {
      response.resume();
      fail(new Error(`WebSocket upgrade failed with HTTP ${response.statusCode}`));
    });
    request.on('timeout', () => request.destroy(new Error('WebSocket upgrade timed out.')));
    request.on('error', fail);
    if (handlers.signal?.aborted) {
      abort();
      return;
    }
    handlers.signal?.addEventListener('abort', abort, { once: true });
    request.end();
  });
}

function createWebSocketFrameParser(handlers) {
  let buffer = Buffer.alloc(0);

  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        const opcode = first & 0x0f;
        const masked = Boolean(second & 0x80);
        let length = second & 0x7f;
        let offset = 2;

        if (length === 126) {
          if (buffer.length < offset + 2) return;
          length = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (buffer.length < offset + 8) return;
          const bigLength = buffer.readBigUInt64BE(offset);
          if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('WebSocket frame is too large.');
          }
          length = Number(bigLength);
          offset += 8;
        }

        let mask;
        if (masked) {
          if (buffer.length < offset + 4) return;
          mask = buffer.subarray(offset, offset + 4);
          offset += 4;
        }

        if (buffer.length < offset + length) return;

        let payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        handlers.onFrame?.({ opcode, final: Boolean(first & 0x80), length });

        if (masked) {
          payload = Buffer.from(payload);
          for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= mask[index % 4];
          }
        }

        if (opcode === 0x1) {
          settleMaybePromise(handlers.onText?.(payload.toString('utf8')), handlers.onError);
        } else if (opcode === 0x2) {
          settleMaybePromise(handlers.onBinary?.(payload), handlers.onError);
        } else if (opcode === 0x8) {
          handlers.onClose?.();
          return;
        } else if (opcode === 0x9) {
          handlers.onPing?.(payload);
        }
      }
    }
  };
}

function createXmG711Demuxer(onAudio) {
  const audioHeaderPrefix = Buffer.from([0x00, 0x00, 0x01, 0xfa, 0x0a, 0x02]);
  const audioHeaderLength = 8;
  const minPayloadLength = 80;
  const maxPayloadLength = 1280;
  const payloadAlignment = 80;
  let buffer = Buffer.alloc(0);

  return {
    push(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
      if (!incoming.length) return;
      buffer = buffer.length ? Buffer.concat([buffer, incoming]) : incoming;

      while (buffer.length >= audioHeaderPrefix.length) {
        const index = buffer.indexOf(audioHeaderPrefix);
        if (index === -1) {
          buffer = buffer.subarray(Math.max(0, buffer.length - audioHeaderPrefix.length + 1));
          return;
        }

        if (buffer.length < index + audioHeaderLength) {
          buffer = buffer.subarray(index);
          return;
        }

        const payloadLength = buffer.readUInt16LE(index + audioHeaderPrefix.length);
        if (payloadLength < minPayloadLength
          || payloadLength > maxPayloadLength
          || payloadLength % payloadAlignment !== 0) {
          // A matching byte sequence inside video data must not pin an
          // unbounded buffer or hide the next real XM audio frame.
          buffer = buffer.subarray(index + 1);
          continue;
        }

        const payloadStart = index + audioHeaderLength;
        const payloadEnd = payloadStart + payloadLength;
        if (buffer.length < payloadEnd) {
          buffer = buffer.subarray(index);
          return;
        }

        onAudio(buffer.subarray(payloadStart, payloadEnd));
        buffer = buffer.subarray(payloadEnd);
      }
    },
    flush() {
      buffer = Buffer.alloc(0);
    }
  };
}

function settleMaybePromise(value, onError) {
  if (value && typeof value.catch === 'function') {
    value.catch(error => onError?.(error));
  }
}

function sendWebSocketFrame(socket, opcode, payload) {
  if (!socket || socket.destroyed || !socket.writable) return false;

  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const mask = crypto.randomBytes(4);
  let headerLength = 2;

  if (data.length >= 126 && data.length <= 65535) {
    headerLength += 2;
  } else if (data.length > 65535) {
    headerLength += 8;
  }

  const frame = Buffer.alloc(headerLength + 4 + data.length);
  frame[0] = 0x80 | opcode;

  let offset = 2;
  if (data.length < 126) {
    frame[1] = 0x80 | data.length;
  } else if (data.length <= 65535) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(data.length, offset);
    offset += 2;
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(data.length), offset);
    offset += 8;
  }

  mask.copy(frame, offset);
  offset += 4;

  for (let index = 0; index < data.length; index += 1) {
    frame[offset + index] = data[index] ^ mask[index % 4];
  }

  try {
    return socket.write(frame);
  } catch (error) {
    socket.destroy(error);
    return false;
  }
}

function digestHeader(challenge, method, uri, username, password) {
  const params = parseAuthParams(challenge);
  const realm = params.realm || '';
  const nonce = params.nonce || '';
  const qop = (params.qop || '').split(',').map(part => part.trim()).find(part => part === 'auth') || '';
  const algorithm = (params.algorithm || 'MD5').toUpperCase();

  if (algorithm !== 'MD5') {
    throw httpError(502, `Unsupported digest algorithm: ${algorithm}`);
  }

  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    ['username', username],
    ['realm', realm],
    ['nonce', nonce],
    ['uri', uri],
    ['response', response]
  ];

  if (params.opaque) parts.push(['opaque', params.opaque]);

  let header = `Digest ${parts.map(([key, value]) => `${key}="${escapeAuth(value)}"`).join(', ')}`;
  header += `, algorithm=${algorithm}`;

  if (qop) {
    header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  }

  return header;
}

function parseAuthParams(challenge) {
  const params = {};
  const rest = challenge.replace(/^\s*digest\s+/i, '');
  const pattern = /([a-zA-Z0-9_-]+)=("((?:\\"|[^"])*)"|[^,]*)/g;
  let match;

  while ((match = pattern.exec(rest))) {
    params[match[1].toLowerCase()] = (match[3] ?? match[2] ?? '').replace(/\\"/g, '"').trim();
  }

  return params;
}

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

function escapeAuth(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function ensureOk(response, message) {
  if (response.statusCode >= 200 && response.statusCode < 300) return;
  const body = response.body.toString('utf8').slice(0, 500);
  throw httpError(response.statusCode || 502, `${message}. HTTP ${response.statusCode}. ${body}`);
}

function parseHikvisionSearch(xml) {
  const blocks = [...xml.matchAll(/<searchMatchItem\b[^>]*>([\s\S]*?)<\/searchMatchItem>/gi)];
  return blocks.map(match => {
    const block = match[1];
    return compactObject({
      sourceId: xmlTag(block, 'sourceID'),
      trackId: xmlTag(block, 'trackID'),
      startTime: xmlTag(block, 'startTime'),
      endTime: xmlTag(block, 'endTime'),
      playbackUri: xmlTag(block, 'playbackURI'),
      rawType: xmlTag(block, 'metadataDescriptor')
    });
  });
}

function parseDahuaMediaFiles(text) {
  const files = new Map();
  const pattern = /items\[(\d+)\]\.([^=\r\n]+)=([^\r\n]*)/g;
  let match;

  while ((match = pattern.exec(text))) {
    const index = Number.parseInt(match[1], 10);
    const key = match[2];
    const value = match[3];
    if (!files.has(index)) files.set(index, {});
    files.get(index)[key] = value;
  }

  return [...files.entries()].sort(([a], [b]) => a - b).map(([, item]) => compactObject({
    channel: item.Channel,
    startTime: item.StartTime,
    endTime: item.EndTime,
    filePath: item.FilePath,
    length: item.Length,
    disk: item.Disk,
    flags: item.Flags
  }));
}

function parseKeyValue(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index === -1) continue;
    values[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return values;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(String(text || '').replace(/\0+$/g, '').trim());
  } catch {
    return null;
  }
}

function xmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1].trim()) : '';
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function compactObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function requireMethod(req, method) {
  if ((req.method || 'GET').toUpperCase() !== method) {
    throw httpError(405, `Method ${req.method || 'GET'} is not allowed for this route.`);
  }
}

function readJsonBody(req, limitBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let receivedBytes = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    req.setEncoding('utf8');
    req.on('data', chunk => {
      receivedBytes += Buffer.byteLength(chunk, 'utf8');
      if (receivedBytes > limitBytes) {
        finish(httpError(413, 'Request body is too large.'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body.trim()) {
        finish(null, {});
        return;
      }

      const data = safeJsonParse(body);
      if (!data) {
        finish(httpError(400, 'Request body must be valid JSON.'));
        return;
      }

      finish(null, data);
    });
    req.on('error', finish);
  });
}

function requiredParam(params, name) {
  const value = params.get(name);
  if (!value) throw httpError(400, `Missing required parameter: ${name}`);
  return value;
}

function positiveInt(value, fallback) {
  const number = Number.parseInt(value || '', 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveNumber(value) {
  const number = Number.parseInt(value || '', 10);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function normalizeXmAudioCodec(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'alaw' || normalized === 'pcm_alaw' || normalized === 'g711a') return 'alaw';
  return 'mulaw';
}

function normalizeAudioFilter(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'none' || normalized === 'raw' || normalized === 'off') return 'off';
  if (normalized === 'strong' || normalized === 'heavy') return 'strong';
  return 'voice';
}

function addAudioFilterArgs(args, preset) {
  const graph = audioFilterGraph(preset);
  if (graph) {
    args.push('-af', graph);
  }
}

function audioFilterGraph(preset) {
  if (preset === 'off') return '';
  if (preset === 'strong') {
    return 'highpass=f=180,lowpass=f=3000,afftdn=nr=18:nf=-32';
  }

  return 'highpass=f=120,lowpass=f=3400,afftdn=nr=10:nf=-35';
}

function transcribeWithGigaAm(config, audioPath, options = {}) {
  // Serialize access so cancelling a block never kills another request's worker.
  const operation = gigaAmTranscriptionQueue.then(async () => {
    options.signal?.throwIfAborted();
    const worker = getGigaAmWorker(config);
    const abort = () => worker.stop();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      return await worker.request({
        audioPath,
        chunkSeconds: options.chunkSeconds || config.transcriptionChunkSeconds,
        offsetSeconds: options.offsetSeconds || 0
      }, config.transcriptionTimeoutMs);
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  });
  gigaAmTranscriptionQueue = operation.catch(() => {});
  return operation;
}

function getGigaAmWorker(config) {
  const key = JSON.stringify({
    pythonPath: config.pythonPath,
    model: config.gigaamModel,
    device: config.gigaamDevice,
    downloadRoot: config.gigaamDownloadRoot
  });

  if (gigaAmWorkerState && gigaAmWorkerState.key === key && !gigaAmWorkerState.closed) {
    return gigaAmWorkerState;
  }

  if (gigaAmWorkerState && !gigaAmWorkerState.closed) {
    gigaAmWorkerState.stop();
  }

  gigaAmWorkerState = createGigaAmWorker(config, key);
  return gigaAmWorkerState;
}

function createGigaAmWorker(config, key) {
  gigaAmWorkerError = '';
  const args = [
    GIGAAM_WORKER_SCRIPT,
    '--model',
    config.gigaamModel,
    '--device',
    config.gigaamDevice || 'auto'
  ];

  if (config.gigaamDownloadRoot) {
    args.push('--download-root', config.gigaamDownloadRoot);
  }

  const child = spawn(config.pythonPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: gigaAmWorkerEnvironment(config)
  });
  const pending = new Map();
  const state = {
    key,
    child,
    pending,
    closed: false,
    stderr: '',
    stdoutBuffer: '',
    request(payload, timeoutMs) {
      return state.readyPromise.then(() => new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const requestPayload = { ...payload, id };
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(httpError(504, 'GigaAM transcription timed out.'));
        }, timeoutMs);

        pending.set(id, { resolve, reject, timer });
        const ok = safeStreamWrite(child.stdin, `${JSON.stringify(requestPayload)}\n`, error => {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        });

        if (!ok) {
          clearTimeout(timer);
          pending.delete(id);
          reject(httpError(503, 'GigaAM worker is not writable.'));
        }
      }));
    },
    stop() {
      state.closed = true;
      state.readyReject?.(httpError(499, 'Transcription was cancelled.'));
      rejectPendingWorkerRequests(state, httpError(503, 'GigaAM worker was stopped.'));
      if (!child.killed) child.kill('SIGTERM');
    }
  };

  let readySettled = false;
  state.readyPromise = new Promise((resolve, reject) => {
    state.readyResolve = value => {
      if (readySettled) return;
      readySettled = true;
      resolve(value);
    };
    state.readyReject = error => {
      if (readySettled) return;
      readySettled = true;
      reject(error);
    };
  });
  state.readyPromise.catch(() => {});

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    state.stdoutBuffer += chunk;
    const lines = state.stdoutBuffer.split(/\r?\n/);
    state.stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      const message = safeJsonParse(line);
      if (!message) continue;
      handleGigaAmWorkerMessage(state, message);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    state.stderr = (state.stderr + chunk).slice(-4000);
  });

  child.on('error', error => {
    gigaAmWorkerError = error.message;
    state.readyReject(error);
    rejectPendingWorkerRequests(state, error);
  });

  child.on('close', code => {
    const unexpectedExit = !state.closed;
    state.closed = true;
    if (gigaAmWorkerState === state) {
      gigaAmWorkerState = null;
    }

    const message = `GigaAM worker exited with code ${code ?? 'unknown'}. ${state.stderr}`.trim();
    const error = httpError(503, message);
    if (unexpectedExit && !gigaAmWorkerError) gigaAmWorkerError = message;
    state.readyReject(error);
    rejectPendingWorkerRequests(state, error);
  });

  return state;
}

function handleGigaAmWorkerMessage(state, message) {
  if (message.type === 'ready') {
    if (message.ok) {
      state.runtimeInfo = message.runtime || { actualDevice: message.device };
      gigaAmWorkerError = '';
      state.readyResolve(message);
    } else {
      gigaAmWorkerError = message.error || 'GigaAM failed to start.';
      state.readyReject(httpError(503, `GigaAM failed to start. ${message.error || ''}`.trim()));
    }
    return;
  }

  const request = state.pending.get(message.id);
  if (!request) return;

  clearTimeout(request.timer);
  state.pending.delete(message.id);

  if (message.ok) {
    request.resolve(message);
  } else {
    request.reject(httpError(502, `GigaAM transcription failed. ${message.error || ''}`.trim()));
  }
}

function rejectPendingWorkerRequests(state, error) {
  for (const request of state.pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  state.pending.clear();
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };

    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        if (!child.killed) child.kill('SIGTERM');
        reject(error);
      } else {
        resolve({ stderr });
      }
    };

    const abort = () => {
      finish(httpError(499, 'Request was cancelled.'));
    };

    const timer = setTimeout(() => {
      finish(httpError(504, `${options.label || 'Process'} timed out.`));
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

    if (options.signal?.aborted) {
      abort();
      return;
    }

    options.signal?.addEventListener('abort', abort, { once: true });

    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.stderr.on('error', error => handleStreamError(error, `${options.label || 'process'} stderr failed`, options.redactConfig));
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0 && code !== null) {
        const message = `${options.label || 'Process failed'}. ${redactSecrets(stderr, options.redactConfig || {})}`.trim();
        finish(httpError(502, message));
        return;
      }
      finish();
    });
  });
}

function requestAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on('aborted', abort);
  req.on('error', abort);
  res.on('close', abort);
  return controller.signal;
}

async function ensureAudioFileHasData(filePath) {
  const stats = await fs.promises.stat(filePath).catch(() => null);
  if (!stats || stats.size <= 1024) {
    throw httpError(502, 'No audio was captured for transcription.');
  }
}

function transcriptionDurationSeconds(params, config, mode) {
  const explicit = positiveFloat(params.get('duration'));

  if (mode === 'live') {
    return clampNumber(explicit || config.transcriptionLiveSeconds, 5, 60);
  }

  let seconds = explicit || secondsBetween(params.get('from'), params.get('to')) || 0;
  if (config.transcriptionArchiveMaxSeconds > 0 && (!seconds || seconds > config.transcriptionArchiveMaxSeconds)) {
    seconds = config.transcriptionArchiveMaxSeconds;
  }
  // Every API request returns one bounded block; callers advance by durationSeconds.
  const chunkSeconds = archiveCaptureChunkSeconds(config);
  return seconds > 0 ? Math.min(seconds, chunkSeconds) : chunkSeconds;
}

function archiveCaptureChunkSeconds(config) {
  const value = Number(config.transcriptionCaptureChunkSeconds);
  return Number.isFinite(value) && value > 0 ? clampNumber(value, 5, 60) : 30;
}

function transcriptCacheKey(config, params, values) {
  const keyData = {
    version: 3,
    host: config.host,
    vendor: values.vendor,
    channel: values.channel,
    stream: values.stream,
    source: params.get('source') || '',
    fileName: params.get('fileName') || '',
    localBeginTime: params.get('localBeginTime') || '',
    from: params.get('from') || '',
    to: params.get('to') || '',
    audioFilter: values.audioFilter,
    xmAudioCodec: config.xmAudioCodec,
    model: config.gigaamModel,
    chunkSeconds: config.transcriptionChunkSeconds,
    durationSeconds: values.durationSeconds,
    offsetSeconds: values.offsetSeconds || 0
  };
  if (values.pipeline) keyData.pipeline = String(values.pipeline);
  if (Number.isFinite(Number(values.anchorOffsetSeconds))) {
    keyData.anchorOffsetSeconds = Number(values.anchorOffsetSeconds);
  }
  if (Number.isFinite(Number(values.sessionEndOffsetSeconds))) {
    keyData.sessionEndOffsetSeconds = Number(values.sessionEndOffsetSeconds);
  }

  return crypto.createHash('sha1').update(JSON.stringify(keyData)).digest('hex');
}

async function readTranscriptCache(cacheKey) {
  try {
    const stored = await readStoredTranscriptBlock(cacheKey);
    if (stored) return stored;
  } catch (error) {
    console.warn(`PostgreSQL transcript cache read failed: ${error.message}`);
  }

  try {
    return JSON.parse(await fs.promises.readFile(path.join(TRANSCRIPT_DIR, `${cacheKey}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function writeTranscriptCache(cacheKey, payload) {
  try {
    await writeStoredTranscriptBlock(cacheKey, payload);
  } catch (error) {
    console.warn(`PostgreSQL transcript cache write failed: ${error.message}`);
  }

  const cachePath = path.join(TRANSCRIPT_DIR, `${cacheKey}.json`);
  await fs.promises.writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8');
}

function gigaAmWorkerEnvironment(config) {
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8'
  };
  const pathKey = Object.keys(env).find(name => name.toLowerCase() === 'path') || 'PATH';
  const ffmpegDir = path.dirname(config.ffmpegPath || '');

  if (ffmpegDir && ffmpegDir !== '.') {
    const currentPath = env[pathKey] || '';
    const normalizedDir = path.resolve(ffmpegDir).toLowerCase();
    const alreadyPresent = currentPath
      .split(path.delimiter)
      .filter(Boolean)
      .some(entry => path.resolve(entry).toLowerCase() === normalizedDir);

    if (!alreadyPresent) {
      env[pathKey] = [ffmpegDir, currentPath].filter(Boolean).join(path.delimiter);
    }
  }

  return env;
}

function captureTimeoutMs(durationSeconds, config) {
  const baseSeconds = durationSeconds > 0 ? durationSeconds : 60;
  return Math.max(90000, Math.min(config.transcriptionCaptureTimeoutMs, (baseSeconds * 4000) + 60000));
}

function formatDuration(seconds) {
  return String(Math.max(0.1, Number(seconds)).toFixed(3));
}

function secondsBetween(from, to) {
  if (!from || !to) return 0;
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.max(0, (end.getTime() - start.getTime()) / 1000);
}

function addSecondsToLocalDateTime(value, seconds, separator = 'T') {
  const parts = localDateParts(value);
  const date = new Date(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  date.setSeconds(date.getSeconds() + Math.max(0, Number(seconds) || 0));

  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}${separator}${hour}:${minute}:${second}`;
}

function positiveFloat(value) {
  const number = Number.parseFloat(value || '');
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function toHex(value, width) {
  return Number(value).toString(16).padStart(width, '0');
}

function recordingDownloadName(fileName) {
  const baseName = String(fileName || 'recording.h264').split(/[\\/]/).filter(Boolean).pop() || 'recording.h264';
  const cleaned = baseName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  if (!cleaned) return `recording-${Date.now()}.h264`;
  return path.extname(cleaned) ? cleaned : `${cleaned}.h264`;
}

function contentDispositionAttachment(fileName) {
  const fallback = String(fileName || 'recording.h264')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

function encodeRfc5987(value) {
  return encodeURIComponent(String(value || 'recording.h264'))
    .replace(/['()]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');
}

function withParamOverride(params, name, value) {
  const clone = new URLSearchParams(params);
  clone.set(name, value);
  return clone;
}

function hikvisionTrackIdCandidates(channel) {
  return uniqueStrings([
    `${channel}01`,
    String(channel)
  ]);
}

function hikvisionTimeRangeCandidates(config, from, to) {
  const modes = uniqueStrings([
    config.hikvisionTimeMode,
    'local',
    'utc'
  ]);

  return modes.map(mode => {
    if (mode === 'utc') {
      return {
        mode,
        start: toHikvisionUtcIso(from),
        end: toHikvisionUtcIso(to)
      };
    }

    return {
      mode: 'local',
      start: toHikvisionLocalIso(from),
      end: toHikvisionLocalIso(to)
    };
  });
}

function toHikvisionLocalIso(value) {
  const parts = localDateParts(value);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`;
}

function toHikvisionUtcIso(value) {
  const date = parseDate(value);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toHikvisionRtspTime(value, config) {
  if (config.hikvisionTimeMode === 'utc') {
    const date = parseDate(value);
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  const parts = localDateParts(value);
  return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}Z`;
}

function toDahuaLocalTime(value) {
  const parts = localDateParts(value);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function toDahuaRtspTime(value) {
  const parts = localDateParts(value);
  return `${parts.year}_${parts.month}_${parts.day}_${parts.hour}_${parts.minute}_${parts.second}`;
}

function toXmLocalTime(value) {
  const parts = localDateParts(value);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function xmTimeToIso(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return text;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
}

function xmFileLengthBytes(value) {
  if (!value) return undefined;
  const text = String(value);
  const parsed = text.startsWith('0x') || text.startsWith('0X') ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed * 1024 : undefined;
}

function xmMd5_8(value) {
  const hash = crypto.createHash('md5').update(String(value), 'binary').digest();
  const chars = [];

  for (let index = 0; index <= 7; index += 1) {
    const code = (hash[2 * index] + hash[2 * index + 1]) % 62;
    if (code <= 9) {
      chars.push(String.fromCharCode(code + 48));
    } else if (code <= 35) {
      chars.push(String.fromCharCode(code + 55));
    } else {
      chars.push(String.fromCharCode(code + 61));
    }
  }

  return chars.join('');
}

function parseDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, `Invalid date/time value: ${value}`);
  }
  return date;
}

function localDateParts(value) {
  const localMatch = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (localMatch) {
    return {
      year: localMatch[1],
      month: localMatch[2],
      day: localMatch[3],
      hour: localMatch[4],
      minute: localMatch[5],
      second: localMatch[6] || '00'
    };
  }

  const date = parseDate(value);
  return {
    year: String(date.getFullYear()).padStart(4, '0'),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
    hour: String(date.getHours()).padStart(2, '0'),
    minute: String(date.getMinutes()).padStart(2, '0'),
    second: String(date.getSeconds()).padStart(2, '0')
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(value => String(value).toLowerCase()))];
}

function bodyKind(text, contentType = '') {
  const trimmed = String(text || '').trim();
  const type = Array.isArray(contentType) ? contentType.join('; ') : String(contentType || '');

  if (!trimmed) return 'empty';
  if (/xml/i.test(type) || /^<\?xml\b/i.test(trimmed) || /^<[a-zA-Z0-9_:.-]+[\s>]/.test(trimmed)) {
    if (/^\s*<html\b/i.test(trimmed)) return 'html';
    return 'xml';
  }
  if (/^\s*[{[]/.test(trimmed)) return 'json';
  return type || 'text';
}

function safePreview(text, length = 180) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, length);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function checkFfmpeg(command = cameraConfig().ffmpegPath, options = {}) {
  const cacheKey = String(command || 'ffmpeg');
  if (!options.bypassCache && ffmpegCheckCache.has(cacheKey)) {
    return ffmpegCheckCache.get(cacheKey);
  }

  const spawnProcess = options.spawnProcess || spawn;
  const check = new Promise(resolve => {
    let child;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      child = spawnProcess(command, ['-version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      finish({
        available: false,
        command,
        error: error.message
      });
      return;
    }

    let output = '';
    child.stdout.on('data', chunk => {
      output = (output + chunk.toString('utf8')).slice(0, 300);
    });

    child.on('error', error => {
      finish({
        available: false,
        command,
        error: error.message
      });
    });

    child.on('close', code => {
      finish({
        available: code === 0,
        command,
        code,
        version: output.split(/\r?\n/)[0] || ''
      });
    });
  });

  if (!options.bypassCache) {
    ffmpegCheckCache.set(cacheKey, check);
    check.then(result => {
      // A missing binary may be installed while the server is running, so only
      // successful checks live for the lifetime of the process.
      if (!result.available && ffmpegCheckCache.get(cacheKey) === check) {
        ffmpegCheckCache.delete(cacheKey);
      }
    });
  }
  return check;
}

function clearFfmpegCheckCache(command = '') {
  if (command) ffmpegCheckCache.delete(String(command));
  else ffmpegCheckCache.clear();
}

function transcriptionRuntimeStatus(runtime, worker, modelError = '') {
  const active = worker && !worker.closed ? worker : null;
  return {
    ...runtime,
    ...(active?.runtimeInfo || {}),
    actualDevice: active?.runtimeInfo?.actualDevice || null,
    available: Boolean(runtime.available && !modelError),
    modelState: modelError ? 'error' : !active ? 'not_loaded'
      : !active.runtimeInfo ? 'loading' : active.pending.size ? 'transcribing' : 'ready',
    modelError: modelError || undefined
  };
}

async function readTranscriptionStatus() {
  await transcriptionModelSettings.initialize().catch(() => {});
  const modelSettings = transcriptionModelSettings.snapshot();
  if (transcriptionPreparationPending(transcriptionSetup)) {
    return {
      ...transcriptionSetupRuntime, available: false, actualDevice: null,
      ...modelSettings, modelState: 'preparing', setup: transcriptionSetup
    };
  }
  const runtime = await checkTranscriber();
  return {
    ...transcriptionRuntimeStatus(runtime, gigaAmWorkerState, gigaAmWorkerError),
    ...modelSettings,
    setup: transcriptionSetup
  };
}

function transcriptionPreparationPending(setup) {
  return ['checking', 'creating', 'installing_torch', 'installing_gigaam', 'verifying'].includes(setup.stage);
}

function assertTranscriptionPrepared() {
  if (transcriptionPreparationPending(transcriptionSetup)) {
    throw httpError(503, 'Подготовка окружения транскрибации ещё выполняется. Дождитесь окончания установки в настройках.');
  }
}

async function prepareTranscriber() {
  const config = cameraConfig();
  transcriptionSetup = { stage: 'checking' };
  try {
    const result = await runTranscriptionSetup(config, update => {
      if (update.runtime) transcriptionSetupRuntime = update.runtime;
      transcriptionSetup = { stage: update.stage, variant: update.variant || transcriptionSetup.variant };
      console.log(`Transcription setup: ${update.stage}${update.variant ? ` (${update.variant})` : ''}`);
    });
    transcriptionPythonPath = result.pythonPath;
    transcriptionSetup = {
      stage: result.setupError ? 'fallback' : 'ready',
      source: result.source,
      variant: result.runtime?.cuda?.version ? `CUDA ${result.runtime.cuda.version}` : 'CPU',
      error: result.setupError || undefined
    };
    transcriberCheckKey = JSON.stringify({ command: transcriptionPythonPath, device: config.gigaamDevice });
    transcriberCheckPromise = Promise.resolve({ ...result.runtime, command: transcriptionPythonPath });
    if (result.setupError) console.warn(`Transcription setup: ${result.setupError}`);
  } catch (error) {
    transcriptionSetup = { stage: 'fallback', source: 'configured', error: error.message };
    console.warn(`Transcription setup: ${error.message}`);
  }
  return checkTranscriber();
}

function runTranscriptionSetup(config, onProgress, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [GIGAAM_SETUP_SCRIPT, '--device', config.gigaamDevice,
      '--runtime-dir', process.env.GIGAAM_RUNTIME_DIR || path.join(RUNTIME_DIR, 'python')];
    if (!booleanFromEnv('GIGAAM_AUTO_INSTALL', true)) args.push('--no-install');
    const child = (options.spawnProcess || spawn)(config.pythonPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: gigaAmWorkerEnvironment(config)
    });
    let buffer = '';
    let stderr = '';
    let result;
    let failure;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('Transcription runtime setup timed out.'));
    }, options.timeoutMs || 65 * 60 * 1000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = (lines.pop() || '').slice(-64000);
      for (const line of lines) {
        const message = safeJsonParse(line);
        if (message?.stage === 'done') result = message;
        else if (message?.stage === 'failed') failure = message.error;
        else if (message?.stage && transcriptionPreparationPending(message)) onProgress(message);
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-1500); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code === 0 && result?.pythonPath && typeof result.runtime?.available === 'boolean') {
        finish(null, result);
      } else {
        finish(new Error(failure || stderr.trim() || 'Invalid transcription setup response.'));
      }
    });
  });
}

function checkTranscriber(command = cameraConfig().pythonPath) {
  const config = cameraConfig();
  const key = JSON.stringify({ command, device: config.gigaamDevice });
  if (transcriberCheckPromise && transcriberCheckKey === key) return transcriberCheckPromise;
  transcriberCheckKey = key;

  transcriberCheckPromise = new Promise(resolve => {
    let child;
    let timer;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command, package: 'gigaam', requestedDevice: config.gigaamDevice, ...result });
    };

    try {
      child = spawn(command, [GIGAAM_WORKER_SCRIPT, '--check-runtime', '--device', config.gigaamDevice], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: gigaAmWorkerEnvironment(config)
      });
    } catch (error) {
      finish({ available: false, error: error.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ available: false, error: 'Python/GigaAM/CUDA check timed out.' });
    }, 30000);

    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk.toString('utf8')).slice(-64000);
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-1000);
    });
    child.on('error', error => {
      finish({ available: false, error: error.message });
    });
    child.on('close', codeValue => {
      const parsed = stdout.trim().split(/\r?\n/).map(line => safeJsonParse(line)).reverse()
        .find(value => value && typeof value.available === 'boolean');
      finish({
        ...parsed,
        available: codeValue === 0 && Boolean(parsed?.available),
        code: codeValue,
        error: codeValue === 0 && parsed ? parsed.error
          : stderr.trim() || 'Python/GigaAM check returned an invalid response.'
      });
    });
  });

  return transcriberCheckPromise;
}

function serveStatic(requestPath, res) {
  const safePath = decodeURIComponent(requestPath.split('?')[0]);
  const relativePath = safePath === '/' ? 'index.html' : safePath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relativePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return json(res, 403, { ok: false, error: 'Forbidden.' });
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      return json(res, 404, { ok: false, error: 'Not found.' });
    }

    res.writeHead(200, {
      'Content-Type': mimeType(filePath),
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[ext] || 'application/octet-stream';
}

function json(res, status, body) {
  if (res.headersSent) {
    res.end();
    return;
  }

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendError(res, error) {
  const status = error.statusCode || 500;
  const body = {
    ok: false,
    error: publicError(error)
  };

  if (error.details !== undefined) {
    body.details = error.details;
  }

  return json(res, status, body);
}

function publicError(error) {
  return error && error.message ? error.message : String(error);
}

function httpError(statusCode, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function redactSecrets(text, config) {
  let result = String(text || '');
  if (config.password) {
    result = result.replaceAll(config.password, '***');
    result = result.replaceAll(encodeURIComponent(config.password), '***');
  }
  if (config.user) {
    result = result.replace(new RegExp(`${escapeRegExp(config.user)}:[^@\\s]+@`, 'g'), `${config.user}:***@`);
  }
  return result;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeStreamWrite(stream, chunk, onError) {
  if (!stream || stream.destroyed || stream.writableEnded || stream.writable === false) {
    return false;
  }

  try {
    return stream.write(chunk);
  } catch (error) {
    onError?.(error);
    return false;
  }
}

function handleStreamError(error, label, config = {}) {
  if (isExpectedDisconnect(error)) return;
  console.warn(`${label}: ${redactSecrets(error.message || String(error), config)}`);
}

function isExpectedDisconnect(error) {
  const code = error?.code || '';
  if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
    return true;
  }

  return /socket hang up|aborted|premature close|write after end/i.test(error?.message || '');
}

export {
  oneTimeDriveCandidate,
  searchXmRecordings,
  writePcm16Wav,
  cameraRequest,
  searchScheduledRecordings,
  transcriptCacheKey,
  runTranscriptionSetup,
  transcriptionPreparationPending,
  transcriptionRuntimeStatus,
  xmArchiveEndShortfallIsTolerable,
  xmArchivePartialTailIsUsable,
  checkTranscriber,
  createOpenAiResponse,
  resolveOpenAiProxyUrl,
  runScheduledOpenAiAction,
  stopScheduledOpenAiAction,
  assertScheduledActionsEditable,
  forceScheduledCandidateRetry,
  nextScheduledActionRun,
  scheduledProgressPercent,
  localJsonApi,
  actionLastRunMatchesCandidate,
  buildScheduledActionTranscript,
  buildDriveTranscriptFiles,
  buildReportDocxAttachment,
  checkFfmpeg,
  chunkFixedPcm,
  clearFfmpegCheckCache,
  createXmG711Demuxer,
  createXmAudioChunkWriter,
  isWeekendDatePart,
  isLoopbackAddress,
  markActionSchedulerState,
  normalizeStoredAction,
  normalizeRecordingSearchTimeRange,
  publicGoogleDriveConfig,
  openXmArchivePcmSession,
  openXmWebSocket,
  reportMessageId,
  resolveScheduledDailyDate,
  resolveScheduledWeeklyDates,
  restoreExplicitStoppedCandidate,
  scheduledActionConfigHash,
  scheduledActionCandidates,
  scheduledReportTypes,
  scheduledActionErrorMessage,
  sendScheduledActionErrorEmail,
  scheduledRetryCandidates,
  scheduledRetryDelayMs,
  scheduledAvailabilityRetry,
  scheduledIncompleteAudioRetry,
  scheduledProcessingNoProgressRetry,
  shouldRunScheduledCandidate,
  transcribeScheduledRecording,
  transcribeXmRecoveryBlock,
  transcriptionDurationSeconds
};
