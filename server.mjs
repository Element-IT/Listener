import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import pg from 'pg';

const { Client, Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const RUNTIME_DIR = path.join(__dirname, '.runtime');
const TRANSCRIPT_DIR = path.join(process.env.TEMP || process.env.TMP || RUNTIME_DIR, 'camera-audio-listener-transcripts');
const GIGAAM_WORKER_SCRIPT = path.join(__dirname, 'scripts', 'gigaam_worker.py');

loadDotEnv(path.join(__dirname, '.env'));

const PORT = numberFromEnv('PORT', 3000);
const DEFAULT_TIMEOUT_MS = 10000;
const XM_NO_RECORD_RET_CODES = new Set([119]);
const DATABASE_SCHEMA_VERSION = 2;
const ACTION_SCHEDULER_STATE_KEY = 'action_scheduler_state';
const ACTION_SCHEDULER_ENABLED = !process.argv.includes('--no-action-scheduler')
  && booleanFromEnv('ACTION_SCHEDULER_ENABLED', true);
const ACTION_SCHEDULER_INTERVAL_MS = Math.max(10, numberFromEnv('ACTION_SCHEDULER_INTERVAL_SECONDS', 30)) * 1000;
const ACTION_SCHEDULER_RETRY_DELAYS_MS = [60, 300, 900, 1800, 3600].map(seconds => seconds * 1000);
const ACTION_SCHEDULER_RETRY_MAX_AGE_MS = Math.max(1, numberFromEnv('ACTION_SCHEDULER_RETRY_MAX_AGE_HOURS', 168)) * 60 * 60 * 1000;
const MANUAL_ACTION_CLAIM_TTL_MS = Math.max(1, numberFromEnv('MANUAL_ACTION_CLAIM_TTL_HOURS', 36)) * 60 * 60 * 1000;
let gigaAmWorkerState = null;
let transcriberCheckPromise = null;
let databasePoolPromise = null;
let actionSchedulerTimer = null;
let actionSchedulerRunning = false;
let actionSchedulerStateMutation = Promise.resolve();
const activeScheduledActions = new Set();
const activeManualActions = new Map();

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
        transcriber: await checkTranscriber()
      });
    }

    if (url.pathname === '/api/probe') {
      return json(res, 200, await probeCamera(cameraConfig()));
    }

    if (url.pathname === '/api/storage') {
      return await storageState(req, res, url.searchParams);
    }

    if (url.pathname.startsWith('/api/storage/')) {
      return await storageMutation(req, res, url.pathname);
    }

    if (url.pathname === '/api/recordings/search') {
      const result = await searchRecordings(cameraConfig(), url.searchParams);
      return json(res, 200, result);
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
      return await transcribeAudio(req, res, cameraConfig(), url.searchParams, 'live');
    }

    if (url.pathname === '/api/recordings/transcript') {
      return await transcribeAudio(req, res, cameraConfig(), url.searchParams, 'archive');
    }

    if (url.pathname === '/api/openai/ask') {
      return await askOpenAi(req, res);
    }

    if (url.pathname === '/api/reports/send') {
      return await sendReportEmail(req, res);
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
  server.listen(PORT, () => {
    console.log(`Camera audio app: http://localhost:${PORT}`);
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
    pythonPath: process.env.PYTHON_PATH || 'python',
    gigaamModel: process.env.GIGAAM_MODEL || 'v3_e2e_rnnt',
    gigaamDevice: process.env.GIGAAM_DEVICE || 'auto',
    gigaamDownloadRoot: process.env.GIGAAM_DOWNLOAD_ROOT || defaultGigaAmDownloadRoot(),
    transcriptionChunkSeconds: numberFromEnv('TRANSCRIPTION_CHUNK_SECONDS', 20),
    transcriptionLiveSeconds: numberFromEnv('TRANSCRIPTION_LIVE_SECONDS', 18),
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
      archiveMaxSeconds: config.transcriptionArchiveMaxSeconds
    },
    openAi: {
      hasApiKey: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || 'gpt-5.6-terra'
    },
    reports: publicEmailConfig(),
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
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists openai_actions (
      id text primary key,
      name text not null,
      group_ids jsonb not null,
      question text not null,
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
  const transcripts = params.get('transcripts') === '1'
    ? await listTranscriptBlocks(params)
    : [];
  return json(res, 200, {
    ok: true,
    database: publicDatabaseConfig(),
    settings: await readAppSetting('ui_settings'),
    selectedChannel: await readAppSetting('selected_channel'),
    channelLabels: await readChannelLabels(),
    groups: await readOpenAiGroups(),
    actions: await readOpenAiActions(),
    scheduler: await readPublicActionSchedulerState(),
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
    select id, name, channels, from_value, to_value, created_at, updated_at
    from openai_groups
    order by created_at, name
  `);
  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    channels: Array.isArray(row.channels) ? row.channels : [],
    from: row.from_value,
    to: row.to_value,
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
        `insert into openai_groups (id, name, channels, from_value, to_value, created_at, updated_at)
         values ($1, $2, $3::jsonb, $4, $5, coalesce($6::timestamptz, now()), now())
         on conflict (id) do update
         set name = excluded.name,
             channels = excluded.channels,
             from_value = excluded.from_value,
             to_value = excluded.to_value,
             updated_at = now()`,
        [group.id, group.name, JSON.stringify(group.channels), group.from, group.to, nullableTimestamp(group.createdAt)]
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
    createdAt: group.createdAt || ''
  };
}

async function readOpenAiActions() {
  const result = await dbQuery(`
    select id, name, group_ids, question, period_mode, day_preset, custom_date,
           report_daily, report_weekly, run_on_weekends, last_run, created_at, updated_at
    from openai_actions
    order by created_at, name
  `);
  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    groupIds: Array.isArray(row.group_ids) ? row.group_ids : [],
    question: row.question,
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
  await dbTransaction(async client => {
    const ids = normalized.map(action => action.id);
    if (ids.length) {
      await client.query('delete from openai_actions where not (id = any($1::text[]))', [ids]);
    } else {
      await client.query('delete from openai_actions');
    }

    for (const action of normalized) {
      await client.query(
        `insert into openai_actions (id, name, group_ids, question, period_mode, day_preset, custom_date,
                                     report_daily, report_weekly, run_on_weekends, last_run, created_at, updated_at)
         values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, coalesce($12::timestamptz, now()), now())
         on conflict (id) do update
         set name = excluded.name,
             group_ids = excluded.group_ids,
             question = excluded.question,
             period_mode = excluded.period_mode,
             day_preset = excluded.day_preset,
             custom_date = excluded.custom_date,
             report_daily = excluded.report_daily,
             report_weekly = excluded.report_weekly,
             run_on_weekends = excluded.run_on_weekends,
             last_run = excluded.last_run,
             updated_at = now()`,
        [
          action.id,
          action.name,
          JSON.stringify(action.groupIds),
          action.question,
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
  if (!action.id || !groupIds.length || !question) return null;
  const periodMode = ['daily', 'weekly', 'once'].includes(action.periodMode) ? action.periodMode : 'daily';
  return {
    id: String(action.id),
    name: String(action.name || question).trim() || 'Действие',
    groupIds,
    question,
    periodMode,
    dayPreset: String(action.dayPreset || 'today'),
    customDate: String(action.customDate || ''),
    reportDaily: Boolean(action.reportDaily) && periodMode !== 'once',
    reportWeekly: Boolean(action.reportWeekly) && periodMode !== 'once',
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
    const isDueNow = scheduledActionCandidates(
      candidate.action,
      new Map(candidate.groups.map(group => [group.id, group])),
      new Date()
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
    runActionSchedulerTick().catch(error => {
      console.warn(`OpenAI action scheduler failed: ${publicError(error)}`);
    });
  };
  const firstRunTimer = setTimeout(tick, 2000);
  firstRunTimer.unref?.();

  actionSchedulerTimer = setInterval(tick, ACTION_SCHEDULER_INTERVAL_MS);
  actionSchedulerTimer.unref?.();
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
        ...scheduledRetryCandidates(action, groupMap, actionState, now),
        ...scheduledActionCandidates(action, groupMap, now)
      ]);
      for (const candidate of candidates) {
        if (actionLastRunMatchesCandidate(action.lastRun, candidate)) continue;
        const liveSchedulerState = await readActionSchedulerState();
        const modeState = liveSchedulerState.actions?.[action.id]?.[candidate.periodMode];
        const candidateState = scheduledCandidateState(modeState, candidate.runKey, candidate);
        if (!shouldRunScheduledCandidate(candidateState, candidate, now)) continue;

        const activeKey = `${action.id}:${candidate.runKey}`;
        if (activeScheduledActions.has(activeKey)) continue;
        if (manualActionClaim(activeKey)) continue;

        activeScheduledActions.add(activeKey);
        let lastRun;
        try {
          lastRun = await runScheduledOpenAiAction(candidate, {
            settings,
            labels
          });
        } catch (error) {
          lastRun = await persistScheduledActionFailure(candidate, error);
        } finally {
          activeScheduledActions.delete(activeKey);
        }

        await mutateActionSchedulerState(state => {
          markActionSchedulerState(state, candidate, lastRun);
        });
      }
    }
  } finally {
    actionSchedulerRunning = false;
  }
}

async function triggerScheduledOpenAiAction(payload) {
  const actionId = String(payload?.actionId || '').trim();
  if (!actionId) throw httpError(400, 'Action id is required.');

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

  const [actions, groups, schedulerState] = await Promise.all([
    readOpenAiActions(),
    readOpenAiGroups(),
    readActionSchedulerState()
  ]);
  const action = actions.find(item => item.id === actionId);
  if (!action) throw httpError(404, 'Действие не найдено.');
  if (action.periodMode === 'once') {
    throw httpError(409, 'Одноразовые действия запускаются в открытой странице.');
  }

  const groupMap = new Map(groups.map(group => [group.id, group]));
  const actionState = schedulerState.actions?.[action.id];
  const now = new Date();
  const candidates = uniqueScheduledCandidates([
    ...scheduledRetryCandidates(action, groupMap, actionState, now, { ignoreMaxAge: true }),
    ...scheduledActionCandidates(action, groupMap, now)
  ]);
  const preferredRunKey = String(action.lastRun?.runKey || '');
  const runnableCandidates = candidates.filter(item => {
      if (actionLastRunMatchesCandidate(action.lastRun, item)) return false;
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

  await mutateActionSchedulerState(state => {
    forceScheduledCandidateRetry(state, candidate, now);
  });
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
  if (!modeState || typeof modeState !== 'object') return;
  const retryAt = now.toISOString();
  const pending = scheduledPendingStates(modeState).map(item => item.runKey === candidate.runKey
    ? { ...item, attempts: 0, firstAttemptAt: retryAt, nextRetryAt: retryAt }
    : item);
  const nextModeState = modeState.runKey === candidate.runKey
    ? { ...modeState, attempts: 0, firstAttemptAt: retryAt, nextRetryAt: retryAt, pending }
    : { ...modeState, pending };
  state.actions = state.actions && typeof state.actions === 'object' ? state.actions : {};
  state.actions[candidate.action.id] = {
    ...(actionState || {}),
    [candidate.periodMode]: nextModeState
  };
}

async function readPublicActionSchedulerState() {
  const state = await readActionSchedulerState().catch(() => ({ actions: {} }));
  return {
    enabled: ACTION_SCHEDULER_ENABLED && databaseConfig().enabled,
    running: actionSchedulerRunning,
    intervalSeconds: Math.round(ACTION_SCHEDULER_INTERVAL_MS / 1000),
    actions: state.actions || {}
  };
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
  const terminal = status === 'success' || status === 'delivery_uncertain';
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

function actionLastRunMatchesCandidate(lastRun, candidate) {
  if (!lastRun || (lastRun.status !== 'success' && lastRun.status !== 'delivery_uncertain')) return false;
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
    (modeState.status === 'success' || modeState.status === 'delivery_uncertain')
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
  if (actionState.status === 'success' || actionState.status === 'delivery_uncertain') return false;

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
      const snapshot = restoreScheduledCandidateSnapshot(action, groups, state, periodMode, matchingConfigHash);
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
        configHash: matchingConfigHash
      };
    }).filter(Boolean);
  });
}

function restoreScheduledCandidateSnapshot(action, groups, state, periodMode, configHash) {
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
  const selections = resolveScheduledActionSelections(retryAction, groups, new Date(), periodMode);
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

function scheduledActionCandidates(action, groupMap, now = new Date()) {
  if (!action || action.periodMode === 'once') return [];

  const periodModes = [];
  if (action.periodMode === 'daily' || action.reportDaily) periodModes.push('daily');
  if (action.periodMode === 'weekly' || action.reportWeekly) periodModes.push('weekly');

  return periodModes
    .map(periodMode => scheduledActionCandidate(action, groupMap, now, periodMode))
    .filter(Boolean);
}

function scheduledActionCandidate(action, groupMap, now, periodMode = action?.periodMode) {
  if (!action || (periodMode !== 'daily' && periodMode !== 'weekly')) return null;

  const groups = (action.groupIds || []).map(groupId => groupMap.get(groupId)).filter(Boolean);
  if (!groups.length) return null;

  const selections = resolveScheduledActionSelections(action, groups, now, periodMode);
  if (!selections.length) return null;

  const from = earliestLocalDateTime(selections.map(selection => selection.from));
  const to = latestLocalDateTime(selections.map(selection => selection.to));
  if (!from || !to) return null;

  let dueAtMs = localDateTimeMs(to);
  if (!Number.isFinite(dueAtMs)) return null;

  if (periodMode === 'weekly') {
    const weekStart = resolveScheduledWeeklyDates(action, now)[0];
    const friday = offsetDatePart(weekStart, 4);
    const fridayEveningMs = localDateTimeMs(`${friday}T18:00`);
    const saturdayEndMs = localDateTimeMs(`${offsetDatePart(friday, 1)}T23:59:59`);
    dueAtMs = Math.max(dueAtMs, fridayEveningMs);
    if (now.getTime() < dueAtMs || now.getTime() > saturdayEndMs) return null;
  } else if (now.getTime() < dueAtMs) {
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
    configHash
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
      to: group.to
    }))
  };
  if (!options.legacy && periodMode === 'daily') config.runOnWeekends = Boolean(action.runOnWeekends);
  return crypto.createHash('sha1')
    .update(JSON.stringify(config))
    .digest('hex');
}

function resolveScheduledActionSelections(action, groups, now = new Date(), periodMode = action?.periodMode) {
  const selections = [];

  for (const group of groups) {
    const ranges = resolveScheduledGroupRanges(action, group, now, periodMode);
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

function resolveScheduledGroupRanges(action, group, now = new Date(), periodMode = action?.periodMode) {
  const dates = periodMode === 'weekly'
    ? resolveScheduledWeeklyDates(action, now)
    : [resolveScheduledDailyDate(action, now)];

  return dates.filter(date => periodMode !== 'daily' || action.runOnWeekends || !isWeekendDatePart(date)).map(date => {
    const from = combineDateAndTime(date, timeOnly(group.from));
    let to = combineDateAndTime(date, timeOnly(group.to));
    if (secondsBetween(from, to) <= 0) {
      to = combineDateAndTime(offsetDatePart(date, 1), timeOnly(group.to));
    }
    return secondsBetween(from, to) > 0 ? { from, to } : null;
  }).filter(Boolean);
}

function resolveScheduledDailyDate(action, now = new Date()) {
  if (action.dayPreset === 'custom' && action.customDate) return action.customDate;
  const offset = {
    yesterday: -1,
    today: 0,
    tomorrow: 1
  }[action.dayPreset] ?? 0;
  let date = offsetDatePart(toDateInputLocal(now), offset);
  if (action.dayPreset === 'yesterday' && !action.runOnWeekends) {
    while (isWeekendDatePart(date)) date = offsetDatePart(date, -1);
  }
  return date;
}

function resolveScheduledWeeklyDates(action, now = new Date()) {
  const start = startOfWeekDatePart(resolveScheduledDailyDate(action, now));
  return Array.from({ length: 5 }, (_, index) => offsetDatePart(start, index));
}

function isWeekendDatePart(datePart) {
  const [year, month, day] = String(datePart || '').split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
  const weekday = new Date(year, month - 1, day).getDay();
  return weekday === 0 || weekday === 6;
}

async function runScheduledOpenAiAction(candidate, context) {
  const startedAt = new Date();
  const reportTypes = scheduledReportTypes(candidate);
  let answerData = null;
  let reportData = null;
  let transcriptResult = null;
  let stage = 'search';

  console.log(`OpenAI action scheduler: starting "${candidate.action.name}" for ${candidate.from} - ${candidate.to}`);
  await updateOpenAiActionLastRun(candidate.action.id, {
    status: 'running',
    scheduled: true,
    at: startedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    from: candidate.from,
    to: candidate.to,
    dueAt: candidate.dueAt,
    runKey: candidate.runKey,
    stage: 'search'
  }).catch(error => {
    console.warn(`OpenAI action scheduler could not save running status: ${publicError(error)}`);
  });

  try {
    transcriptResult = await buildScheduledActionTranscript(candidate, context);
    stage = 'ask';
    answerData = await localJsonApi('/api/openai/ask', {
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
          to: group.to
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
      stage = 'report';
      reportData = await localJsonApi('/api/reports/send', {
        method: 'POST',
        body: {
          reportTypes,
          deliveryKey: `${candidate.action.id}:${candidate.runKey}`,
          generatedAt: new Date().toISOString(),
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
            to: group.to
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

    const lastRun = {
      status: 'success',
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
      reports: reportData?.sent || [],
      runKey: candidate.runKey
    };
    try {
      await persistScheduledActionRun(candidate, lastRun, {
        reportTypes,
        warnings: transcriptResult.warnings
      });
    } catch (error) {
      lastRun.persistenceError = publicError(error);
      console.warn(`OpenAI action scheduler completed but could not save success: ${lastRun.persistenceError}`);
    }
    console.log(`OpenAI action scheduler: finished "${candidate.action.name}"`);
    return lastRun;
  } catch (error) {
    return persistScheduledActionFailure(candidate, error, {
      startedAt,
      stage,
      answerData,
      transcriptResult,
      reportData
    });
  }
}

async function persistScheduledActionFailure(candidate, error, context = {}) {
  const deliveryUncertain = Boolean(error?.deliveryUncertain || error?.details?.deliveryUncertain);
  const lastRun = {
    status: deliveryUncertain ? 'delivery_uncertain' : 'error',
    scheduled: true,
    at: new Date().toISOString(),
    startedAt: context.startedAt?.toISOString?.() || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    from: candidate.from,
    to: candidate.to,
    dueAt: candidate.dueAt,
    error: publicError(error),
    stage: context.stage || 'scheduler',
    model: context.answerData?.model || '',
    responseId: context.answerData?.responseId || '',
    answer: context.answerData?.answer || '',
    transcriptLines: context.transcriptResult?.contextLines?.length || 0,
    selections: candidate.selections?.length || 0,
    recordings: context.transcriptResult?.knownRecordings || 0,
    reports: context.reportData?.sent || [],
    runKey: candidate.runKey,
    details: error.details
  };
  await persistScheduledActionRun(candidate, lastRun, {
    errorDetails: error.details
  }).catch(persistError => {
    console.warn(`OpenAI action scheduler could not save failed run: ${publicError(persistError)}`);
  });
  console.warn(`OpenAI action scheduler: "${candidate.action.name}" failed at ${lastRun.stage}: ${lastRun.error}`);
  return lastRun;
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
  const contextLines = [];
  const warnings = [];
  let knownRecordings = 0;
  let completedRecordings = 0;
  let failedSearches = 0;
  let failedRecordings = 0;

  for (const selection of candidate.selections) {
    const label = `${selection.groupName} · ${channelLabelFromRows(context.labels, selection.channel)}`;
    const query = new URLSearchParams(scheduledCameraParams(context.settings, selection.channel));
    query.set('from', selection.from);
    query.set('to', selection.to);
    query.set('_', Date.now());

    const searchPath = `/api/recordings/search?${query}`;
    let searchData;
    try {
      searchData = await localJsonApi(searchPath);
    } catch (error) {
      failedSearches += 1;
      warnings.push(`${label}: поиск записей: ${publicError(error)}`);
      continue;
    }
    if (searchData.warning) warnings.push(`${label}: ${searchData.warning}`);

    const items = (searchData.items || [])
      .map(item => ({ item, coverage: recordingCoverageForRange(item, selection.from, selection.to) }))
      .filter(entry => entry.coverage && entry.coverage.durationSeconds > 0);

    knownRecordings += items.length;
    if (!items.length) {
      warnings.push(`${label}: записи не найдены`);
      continue;
    }

    for (const entry of items) {
      try {
        await transcribeScheduledRecording({
          item: entry.item,
          coverage: entry.coverage,
          selection,
          settings: context.settings,
          labels: context.labels,
          vendor: searchData.vendor || '',
          contextLines
        });
        completedRecordings += 1;
      } catch (error) {
        failedRecordings += 1;
        const recording = entry.item.fileName || entry.item.startTime || 'архивный фрагмент';
        warnings.push(`${label}: ${recording}: ${publicError(error)}`);
      }
    }
  }

  if (!completedRecordings && !contextLines.length && (failedSearches || failedRecordings)) {
    throw httpError(
      502,
      `Не удалось получить пригодный транскрипт: ошибок поиска ${failedSearches}, ошибок записей ${failedRecordings}.`,
      {
        failedSearches,
        failedRecordings,
        warnings: warnings.slice(-100)
      }
    );
  }

  return {
    contextLines,
    warnings,
    knownRecordings,
    completedRecordings,
    failedSearches,
    failedRecordings
  };
}

async function transcribeScheduledRecording(options) {
  let offsetSeconds = options.coverage.offsetSeconds;
  const endOffsetSeconds = options.coverage.offsetSeconds + options.coverage.durationSeconds;
  const chunkSeconds = scheduledTranscriptSeconds(options.settings);

  while (offsetSeconds < endOffsetSeconds - 0.05) {
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

    const data = await localJsonApi(`/api/recordings/transcript?${query}`);
    appendScheduledOpenAiContext({
      contextLines: options.contextLines,
      labels: options.labels,
      selection: options.selection,
      item: options.item,
      segments: data.segments,
      fallbackText: data.text
    });

    const consumedSeconds = Math.max(0.5, Math.min(data.durationSeconds || durationSeconds, remainingSeconds));
    offsetSeconds += consumedSeconds;
  }
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
  return clampNumber(Number(settings?.transcriptSeconds || cameraConfig().transcriptionLiveSeconds || 18), 5, 60);
}

function scheduledReportTypes(candidate) {
  if (candidate?.periodMode === 'daily' && candidate.action?.reportDaily) return ['daily'];
  if (candidate?.periodMode === 'weekly' && candidate.action?.reportWeekly) return ['weekly'];
  return [];
}

function channelLabelFromRows(labels, channel) {
  const row = (labels || []).find(item => Number(item.channel) === Number(channel));
  return row?.label || `Канал ${channel}`;
}

function appendScheduledOpenAiContext(options) {
  const segments = normalizedTranscriptSegments(options.segments, options.fallbackText);
  for (const segment of segments) {
    options.contextLines.push([
      `[${options.selection.groupName || 'Группа'} | ${channelLabelFromRows(options.labels, options.selection.channel)} | ${formatScheduledSegmentTime(options.item, segment)}]`,
      String(segment.text || '').trim()
    ].filter(Boolean).join(' '));
  }
  return segments.length;
}

function normalizedTranscriptSegments(segments = [], fallbackText = '') {
  const normalized = Array.isArray(segments) && segments.length
    ? segments
    : fallbackText
      ? [{ text: fallbackText }]
      : [];
  return normalized.filter(segment => String(segment.text || '').trim());
}

function formatScheduledSegmentTime(item, segment) {
  const start = absoluteSegmentDate(item.startTime, segment.start);
  const end = absoluteSegmentDate(item.startTime, segment.end);
  if (start && end) {
    return `${formatReportDateTime(start.toISOString())} - ${formatReportDateTime(end.toISOString())}`;
  }
  return `${formatReportDateTime(item.startTime)} - ${formatReportDateTime(item.endTime)}`;
}

function absoluteSegmentDate(baseValue, offsetSeconds) {
  if (!Number.isFinite(Number(offsetSeconds))) return null;
  const baseMs = localDateTimeMs(baseValue);
  return Number.isFinite(baseMs) ? new Date(baseMs + (Number(offsetSeconds) * 1000)) : null;
}

function recordingCoverageForRange(item, fromValue, toValue) {
  const rangeStartMs = localDateTimeMs(fromValue);
  const rangeEndMs = localDateTimeMs(toValue);
  const itemStartMs = localDateTimeMs(item.startTime || fromValue);
  const itemEndMs = localDateTimeMs(item.endTime || toValue);

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
    headers
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

async function searchXmRecordings(config, channel, stream, from, to) {
  const login = await xmLogin(config);

  try {
    const xmChannel = Math.max(0, channel - 1);
    const query = xmRecordingSearchQuery(login, xmChannel, stream, from, to);

    const data = await cameraJsonRequest(config, '/cgi-bin/opdev.cgi', query);
    if (data.Ret === 109) {
      return xmRecordingSearchResponse({
        channel,
        xmChannel,
        stream,
        from,
        to,
        warning: 'XM OPFileQuery returned Ret=109. No files were found for this period.',
        details: xmSearchErrorDetails(data, query, channel, xmChannel, stream),
        records: []
      });
    }

    if (data.Ret === 119) {
      const fallback = await searchXmRecordingsByDay(config, login, channel, xmChannel, stream, from, to, data, query);
      if (fallback.result) {
        return fallback.result;
      }

      return xmRecordingSearchResponse({
        channel,
        xmChannel,
        stream,
        from,
        to,
        warning: 'Direct XM OPFileQuery returned Ret=119; daily archive search found no records inside the selected period.',
        details: {
          ...xmSearchErrorDetails(data, query, channel, xmChannel, stream),
          fallback: fallback.details,
          hint: xmRet119Hint()
        },
        xmRet: data.Ret,
        message: 'XM archive returned no recordings for this period.',
        records: []
      });
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
          message: 'XM archive returned no recordings for this period.',
          details: xmSearchErrorDetails(data, query, channel, xmChannel, stream),
          records: []
        });
      }

      throw httpError(502, `XM recording search failed. Ret=${data.Ret ?? 'unknown'}`, {
        ...xmSearchErrorDetails(data, query, channel, xmChannel, stream),
        hint: ''
      });
    }

    const records = xmRecordList(data.OPFileQuery);
    return xmRecordingSearchResponse({ channel, xmChannel, stream, from, to, records });
  } finally {
    await xmLogout(config, login).catch(() => {});
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

async function searchXmRecordingsByDay(config, login, channel, xmChannel, stream, from, to, originalData, originalQuery) {
  const attempts = [];
  const records = [];

  for (const range of xmSearchDayRanges(from, to)) {
    const query = xmRecordingSearchQuery(login, xmChannel, stream, range.from, range.to);
    try {
      const data = await cameraJsonRequest(config, '/cgi-bin/opdev.cgi', query);
      attempts.push(xmSearchErrorDetails(data, query, channel, xmChannel, stream));

      if (data.Ret === 100) {
        records.push(...xmRecordList(data.OPFileQuery));
      } else if (data.Ret !== 109 && data.Ret !== 119) {
        break;
      }
    } catch (error) {
      attempts.push({
        ...xmSearchErrorDetails({ Ret: error.statusCode || 'request_failed' }, query, channel, xmChannel, stream),
        error: error.message || String(error)
      });
      break;
    }
  }

  const details = {
    strategy: 'daily OPFileQuery after Ret=119',
    original: xmSearchErrorDetails(originalData, originalQuery, channel, xmChannel, stream),
    attempts
  };
  const usableFallback = attempts.some(attempt => attempt.ret === 100 || attempt.ret === 109);
  if (!usableFallback) {
    return { result: null, details };
  }

  const filteredRecords = uniqueXmRecords(records).filter(record => xmRecordOverlaps(record, from, to));
  return {
    result: xmRecordingSearchResponse({
      channel,
      xmChannel,
      stream,
      from,
      to,
      warning: filteredRecords.length
        ? 'Direct XM OPFileQuery returned Ret=119; records were found through daily archive search.'
        : 'Direct XM OPFileQuery returned Ret=119; daily archive search found no records inside the selected period.',
      details,
      records: filteredRecords
    }),
    details
  };
}

function xmRecordingSearchResponse(options) {
  const response = {
    ok: true,
    vendor: 'xm',
    channel: options.channel,
    deviceChannel: options.xmChannel,
    stream: options.stream,
    from: options.from,
    to: options.to,
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

async function transcribeAudio(req, res, config, params, mode) {
  requireCameraAuth(config);

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
  const startedAt = Date.now();
  const signal = requestAbortSignal(req, res);

  await fs.promises.mkdir(TRANSCRIPT_DIR, { recursive: true });

  if (cacheKey) {
    const cached = await readTranscriptCache(cacheKey);
    if (cached) {
      return json(res, 200, { ...cached, cached: true });
    }
  }

  const audioPath = path.join(TRANSCRIPT_DIR, `${mode}-${Date.now()}-${crypto.randomUUID()}.wav`);

  try {
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

    if (signal.aborted) return;
    await ensureAudioFileHasData(audioPath);

    const result = await transcribeWithGigaAm(config, audioPath, {
      chunkSeconds: config.transcriptionChunkSeconds,
      offsetSeconds
    });

    if (signal.aborted) return;

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
      text: result.text,
      segments: result.segments || [],
      tookMs: Date.now() - startedAt
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
  const fromEnv = normalizeEmailList(process.env.REPORT_EMAIL_TO || process.env.REPORT_RECIPIENTS || '');
  if (fromEnv.length) return fromEnv;

  try {
    const settings = await readAppSetting('ui_settings');
    return normalizeEmailList(settings?.reportEmails || '');
  } catch {
    return [];
  }
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
  const period = `${formatReportDateTime(payload.from)} - ${formatReportDateTime(payload.to)}`;
  const attachment = buildReportDocxAttachment({ ...payload, recipients }, reportType);

  const text = [
    `Отчет ${reportLabel}`,
    `Действие: ${action.name || 'без названия'}`,
    `Сформирован: ${formatReportDateTime(generatedAt)}`,
    `Период: ${period}`,
    ...(warnings.length ? [`Предупреждений при обработке: ${warnings.length}`] : []),
    '',
    `DOCX-файл прикреплен: ${attachment.fileName}`
  ].join('\n');

  const html = [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.45;color:#18212a">',
    `<h2>${escapeHtmlText(`Отчет ${reportLabel}`)}</h2>`,
    `<p><strong>Действие:</strong> ${escapeHtmlText(action.name || 'без названия')}</p>`,
    `<p><strong>Сформирован:</strong> ${escapeHtmlText(formatReportDateTime(generatedAt))}</p>`,
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
  const fromDate = reportDateKey(payload.from) || toDateInputLocal(new Date());
  const toDate = reportDateKey(payload.to) || fromDate;
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

  const blocks = [
    wParagraph('OPENAI API', 'Kicker'),
    wParagraph(`Отчет ${reportLabel}`, 'ReportTitle'),
    wParagraph(action.name || 'Архив камер', 'Subtitle'),
    wTable([
      ['Действие', action.name || 'без названия'],
      ['Сформирован', formatReportDateTime(generatedAt)],
      ['Период анализа', `${formatReportDateTime(payload.from)} - ${formatReportDateTime(payload.to)}`],
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
    ...reportDaySectionsXml(payload, channels),
    wParagraph('Группы и камеры', 'Heading1'),
    ...reportGroupBlocksXml(groups, channels),
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

function reportDaySectionsXml(payload, channels) {
  const days = reportDaysBetween(payload.from, payload.to, channels);
  if (!days.length) {
    return [wParagraph('Даты не определены.', 'MutedText')];
  }

  const result = [];
  for (const day of days) {
    const dayChannels = channels.filter(item => reportRangeOverlapsDay(item.from, item.to, day));
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
        reportTimeRange(item.from, item.to),
        `${formatReportDateTime(item.from)} - ${formatReportDateTime(item.to)}`
      ])
    ], [2160, 2160, 1440, 3600], true));
  }
  return result;
}

function reportGroupBlocksXml(groups, channels) {
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
        `${formatReportDateTime(group.from)} - ${formatReportDateTime(group.to)}`
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
        `${formatReportDateTime(item.from)} - ${formatReportDateTime(item.to)}`
      ])
    ], [2400, 2400, 4560], true));
  }

  return blocks;
}

function reportDaysBetween(fromValue, toValue, channels = []) {
  const dates = new Set();
  const start = reportDateFromKey(reportDateKey(fromValue));
  const end = reportDateFromKey(reportDateKey(toValue));

  if (start && end) {
    const cursor = new Date(start.getTime());
    while (cursor.getTime() <= end.getTime()) {
      dates.add(toDateInputLocal(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  for (const item of channels) {
    const from = reportDateKey(item.from);
    const to = reportDateKey(item.to);
    if (from) dates.add(from);
    if (to) dates.add(to);
  }

  return [...dates].sort();
}

function reportRangeOverlapsDay(fromValue, toValue, day) {
  const start = localDateTimeMs(fromValue);
  const end = localDateTimeMs(toValue);
  const dayStart = localDateTimeMs(`${day}T00:00:00`);
  const dayEnd = localDateTimeMs(`${offsetDatePart(day, 1)}T00:00:00`);
  if (![start, end, dayStart, dayEnd].every(Number.isFinite)) return reportDateKey(fromValue) === day;
  return start < dayEnd && end > dayStart;
}

function reportDateKey(value) {
  if (!value) return '';
  try {
    const parts = localDateParts(value);
    return `${parts.year}-${parts.month}-${parts.day}`;
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

function reportTimeRange(fromValue, toValue) {
  return `${formatReportTimeOnly(fromValue)} - ${formatReportTimeOnly(toValue)}`;
}

function formatReportTimeOnly(value) {
  try {
    const parts = localDateParts(value);
    return `${parts.hour}:${parts.minute}`;
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
    timeoutMs: numberFromEnv('OPENAI_TIMEOUT_MS', 120000),
    maxOutputTokens: numberFromEnv('OPENAI_MAX_OUTPUT_TOKENS', 1200)
  };
}

async function createOpenAiResponse(config, payload, signal) {
  const timeout = new AbortController();
  const abort = () => timeout.abort();
  const timer = setTimeout(abort, config.timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });

  try {
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
      signal: timeout.signal
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
    if (signal?.aborted || error.name === 'AbortError') {
      throw httpError(499, 'OpenAI request was cancelled.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
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

function formatReportDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ru-RU');
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

async function captureXmArchiveWav(config, params, channel, stream, outputPath, capture) {
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
  if (capture.durationSeconds > 0) {
    ffmpegArgs.push('-t', formatDuration(capture.durationSeconds));
  }
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
    const audioDemuxer = createXmG711Demuxer(chunk => {
      safeStreamWrite(ffmpeg.stdin, chunk, error => {
        handleStreamError(error, 'xm transcription ffmpeg stdin failed', config);
        finish(error);
      });
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

      try {
        wsHandle?.close();
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

    ffmpeg.stdin.on('error', error => handleStreamError(error, 'xm transcription ffmpeg stdin failed', config));
    ffmpeg.stderr.on('error', error => handleStreamError(error, 'xm transcription ffmpeg stderr failed', config));
    ffmpeg.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    ffmpeg.on('error', error => finish(error));
    ffmpeg.on('close', code => {
      if (code !== 0 && code !== null) {
        finish(httpError(502, `ffmpeg failed while preparing archive audio. ${redactSecrets(stderr, config)}`.trim()));
        return;
      }
      finish();
    });

    capture.signal?.addEventListener('abort', () => {
      finish(httpError(499, 'Transcription request was cancelled.'));
    }, { once: true });

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
        if (buffer.length > 0) {
          audioDemuxer.push(buffer);
        }
      },
      onClose: () => {
        audioDemuxer.flush();
        if (ffmpeg.stdin.writable) {
          ffmpeg.stdin.end();
        }
      },
      onError: error => {
        finish(error);
      }
    })
      .then(handle => {
        wsHandle = handle;
      })
      .catch(error => {
        finish(error);
      });
  });
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

  const first = await rawHttpRequest(target, {
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
    return rawHttpRequest(target, {
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
  return rawHttpRequest(target, {
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
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${options.timeoutMs} ms.`)));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function openXmWebSocket(config, wsPath, handlers) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
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

    request.on('upgrade', (response, socket, head) => {
      if (response.statusCode !== 101) {
        socket.destroy();
        reject(new Error(`WebSocket upgrade failed with HTTP ${response.statusCode}`));
        return;
      }

      const parser = createWebSocketFrameParser({
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

      resolve({
        close: () => {
          if (!socket.destroyed) {
            sendWebSocketFrame(socket, 0x8, Buffer.alloc(0));
            socket.end();
          }
        },
        pause: () => socket.pause(),
        resume: () => socket.resume()
      });
    });

    request.on('response', response => {
      response.resume();
      reject(new Error(`WebSocket upgrade failed with HTTP ${response.statusCode}`));
    });
    request.on('timeout', () => request.destroy(new Error('WebSocket upgrade timed out.')));
    request.on('error', reject);
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
  const audioHeader = Buffer.from([0x00, 0x00, 0x01, 0xfa, 0x0a, 0x02, 0x80, 0x02]);
  const payloadLength = 640;
  let buffer = Buffer.alloc(0);

  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= audioHeader.length) {
        const index = buffer.indexOf(audioHeader);
        if (index === -1) {
          buffer = buffer.subarray(Math.max(0, buffer.length - audioHeader.length + 1));
          return;
        }

        const payloadStart = index + audioHeader.length;
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
  const worker = getGigaAmWorker(config);
  return worker.request({
    audioPath,
    chunkSeconds: options.chunkSeconds || config.transcriptionChunkSeconds,
    offsetSeconds: options.offsetSeconds || 0
  }, config.transcriptionTimeoutMs);
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
    state.readyReject(error);
    rejectPendingWorkerRequests(state, error);
  });

  child.on('close', code => {
    state.closed = true;
    if (gigaAmWorkerState === state) {
      gigaAmWorkerState = null;
    }

    const message = `GigaAM worker exited with code ${code ?? 'unknown'}. ${state.stderr}`.trim();
    const error = httpError(503, message);
    state.readyReject(error);
    rejectPendingWorkerRequests(state, error);
  });

  return state;
}

function handleGigaAmWorkerMessage(state, message) {
  if (message.type === 'ready') {
    if (message.ok) {
      state.readyResolve(message);
    } else {
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
  return seconds > 0 ? seconds : 0;
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

function checkFfmpeg(command = cameraConfig().ffmpegPath) {
  return new Promise(resolve => {
    let child;

    try {
      child = spawn(command, ['-version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      resolve({
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
      resolve({
        available: false,
        command,
        error: error.message
      });
    });

    child.on('close', code => {
      resolve({
        available: code === 0,
        command,
        code,
        version: output.split(/\r?\n/)[0] || ''
      });
    });
  });
}

function checkTranscriber(command = cameraConfig().pythonPath) {
  if (transcriberCheckPromise) return transcriberCheckPromise;

  const code = [
    'import importlib.metadata',
    'import importlib.util',
    'import json',
    'spec = importlib.util.find_spec("gigaam")',
    'version = ""',
    'if spec is not None:',
    '    version = importlib.metadata.version("gigaam")',
    'print(json.dumps({"available": spec is not None, "package": "gigaam", "version": version}))'
  ].join('\n');

  transcriberCheckPromise = new Promise(resolve => {
    let child;

    try {
      child = spawn(command, ['-c', code], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      resolve({
        available: false,
        command,
        error: error.message
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        available: false,
        command,
        error: 'Python/GigaAM check timed out.'
      });
    }, 15000);

    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk.toString('utf8')).slice(-1000);
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-1000);
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({
        available: false,
        command,
        error: error.message
      });
    });
    child.on('close', codeValue => {
      clearTimeout(timer);
      const parsed = safeJsonParse(stdout);
      resolve({
        available: codeValue === 0 && Boolean(parsed?.available),
        command,
        code: codeValue,
        package: parsed?.package || 'gigaam',
        version: parsed?.version || '',
        error: codeValue === 0 ? undefined : stderr.trim()
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
  actionLastRunMatchesCandidate,
  buildReportDocxAttachment,
  isWeekendDatePart,
  markActionSchedulerState,
  normalizeStoredAction,
  reportMessageId,
  resolveScheduledDailyDate,
  resolveScheduledWeeklyDates,
  scheduledActionConfigHash,
  scheduledActionCandidates,
  scheduledReportTypes,
  scheduledRetryCandidates,
  scheduledRetryDelayMs,
  shouldRunScheduledCandidate
};
