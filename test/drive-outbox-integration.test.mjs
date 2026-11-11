import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeliveryOutbox, createMemoryDeliveryOutbox } from '../delivery-outbox.mjs';

process.env.TRANSCRIPTION_CAPTURE_CHUNK_SECONDS = '60';
const { runScheduledOpenAiAction } = await import('../server.mjs');

const from = '2026-10-29T02:30:00.000Z';
const to = '2026-10-29T02:31:00.000Z';
const candidate = {
  action: {
    id: 'outbox-integration', name: 'Локальная очередь', destination: 'drive', question: '',
    groupIds: ['g'], periodMode: 'daily', dayPreset: 'today', reportDaily: false, reportWeekly: false
  },
  groups: [{ id: 'g', name: 'Группа', channels: [5, 6] }],
  selections: [5, 6].map(channel => ({ groupId: 'g', groupName: 'Группа', channel, from, to, rangeSeconds: 60 })),
  periodMode: 'daily', from, to, dueAt: to, runKey: 'daily:outbox-integration', configHash: 'outbox-integration',
  timeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow'
};

function context(services) {
  return {
    settings: { transcriptSeconds: 60, displayTimeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow' },
    labels: [{ channel: 5, label: 'Кухня' }, { channel: 6, label: 'Инженерный отдел' }],
    services: {
      updateLastRun: async () => {}, persistRun: async () => {},
      findDriveTranscripts: async () => ({ uploads: [] }),
      ...services
    }
  };
}

function cameraApi(events, { failChannel, onSearch } = {}) {
  return async pathname => {
    const url = new URL(pathname, 'http://listener.test');
    const channel = Number(url.searchParams.get('channel'));
    if (url.pathname === '/api/recordings/search') {
      events.push(`search:${channel}`);
      onSearch?.(channel);
      return { items: [{
        startTime: '2026-10-29T05:30:00', endTime: '2026-10-29T05:31:00',
        fileName: `/archive/channel-${channel}.h264`
      }] };
    }
    if (url.pathname === '/api/recordings/transcript') {
      events.push(`asr:${channel}`);
      return {
        durationSeconds: channel === failChannel ? 0.32 : 60,
        segments: channel === failChannel ? [] : [{ start: 0, end: 5, text: `Текст камеры ${channel}` }]
      };
    }
    assert.fail(`Unexpected API request: ${url.pathname}`);
  };
}

const offline = () => Object.assign(new Error('DNS is unavailable'), { code: 'ENOTFOUND' });
const receipt = item => ({ uploads: [{
  channel: item.selections[0].channel,
  fileId: `file-${item.selections[0].channel}`, completeness: 'complete'
}] });

async function temporaryOutbox(t, clock) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'listener-drive-outbox-integration-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('listener-drive-outbox-integration-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { directory, outbox: createDeliveryOutbox({ directory, now: () => new Date(clock.value) }) };
}

test('offline Drive never prevents ASR; a durable restart sends ready cameras without touching camera/cache APIs', async t => {
  const clock = { value: Date.parse('2026-11-03T12:00:00.000Z') };
  const { directory, outbox } = await temporaryOutbox(t, clock);
  const events = [];
  const first = await runScheduledOpenAiAction(candidate, context({
    deliveryOutbox: outbox, deliveryNow: () => clock.value,
    findDriveTranscripts: async () => { events.push('lookup:offline'); throw offline(); },
    requestApi: cameraApi(events),
    uploadDriveTranscripts: async item => { events.push(`upload-failed:${item.selections[0].channel}`); throw offline(); }
  }));
  assert.equal(first.status, 'delivery_pending', first.error);
  assert.equal(first.processingComplete, true);
  assert.equal(first.queuedCameras, 2);
  assert.deepEqual(events.filter(event => event.startsWith('asr:')), ['asr:5', 'asr:6']);
  const pending = await outbox.list();
  assert.equal(pending.length, 2);
  assert.ok(pending.every(item => item.status === 'pending' && item.payload.transcript.diagnostics[0].processedSeconds === 60));
  assert.ok(pending.every(item => item.payload.transcript.issues.length === 0));

  clock.value += 61_000;
  const restarted = createDeliveryOutbox({ directory, now: () => new Date(clock.value) });
  const uploads = [];
  const resumedContext = context({
    deliveryOutbox: restarted, deliveryNow: () => clock.value,
    findDriveTranscripts: async () => assert.fail('Ready local cameras must not need a Drive lookup'),
    requestApi: async () => assert.fail('Ready local cameras must skip search, download, ASR and cache APIs'),
    uploadDriveTranscripts: async item => { uploads.push(item.selections[0].channel); return receipt(item); }
  });
  const delivered = await runScheduledOpenAiAction(candidate, resumedContext);
  assert.equal(delivered.status, 'success', delivered.error);
  assert.equal(delivered.queuedCameras, 0);
  assert.equal(delivered.progress.uploadedCameras, 2);
  assert.equal(delivered.progress.skippedCameras, 2);
  assert.deepEqual([...uploads].sort(), [5, 6]);
  assert.ok((await restarted.list()).every(item => item.status === 'delivered'));

  const alreadyDone = await runScheduledOpenAiAction(candidate, resumedContext);
  assert.equal(alreadyDone.status, 'success', alreadyDone.error);
  assert.equal(uploads.length, 2, 'durable receipts suppress duplicate uploads after restart/retry');
});

test('a complete first camera stays ready when the second fails, and incomplete cameras never enter delivery', async () => {
  const outbox = createMemoryDeliveryOutbox();
  const events = [];
  const uploadChannels = [];
  const services = {
    deliveryOutbox: outbox,
    requestApi: cameraApi(events, { failChannel: 6 }),
    uploadDriveTranscripts: async item => { uploadChannels.push(item.selections[0].channel); throw offline(); }
  };
  const first = await runScheduledOpenAiAction(candidate, context(services));
  assert.equal(first.status, 'error', first.error);
  assert.match(first.error, /неполные камеры не выгружены/);
  const records = await outbox.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].channel, 5);
  assert.equal(records[0].status, 'pending');
  assert.ok(uploadChannels.every(channel => channel === 5));

  events.length = 0;
  const second = await runScheduledOpenAiAction(candidate, context(services));
  assert.equal(second.status, 'error', second.error);
  assert.deepEqual(events, ['search:6', 'asr:6'], 'ready first camera must be skipped before its search/cache traversal');
  assert.equal((await outbox.list()).length, 1);
});

test('a stalled upload does not block processing the next camera and times out into the local queue', async () => {
  const outbox = createMemoryDeliveryOutbox();
  const events = [];
  let uploadPending = false;
  let secondSearchedWhileUploadPending = false;
  const result = await runScheduledOpenAiAction(candidate, context({
    deliveryOutbox: outbox, deliveryTimeoutMs: 30,
    requestApi: cameraApi(events, { onSearch: channel => {
      if (channel === 6) secondSearchedWhileUploadPending = uploadPending;
    } }),
    uploadDriveTranscripts: async (item, transcript, { signal }) => {
      events.push(`upload-started:${item.selections[0].channel}`);
      uploadPending = true;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          uploadPending = false;
          events.push('upload-aborted');
          reject(Object.assign(new Error('Aborted stalled upload'), { code: 'ABORT_ERR' }));
        }, { once: true });
      });
    }
  }));
  assert.equal(secondSearchedWhileUploadPending, true, events.join(', '));
  assert.equal(result.status, 'delivery_pending', result.error);
  assert.equal(result.queuedCameras, 2);
  assert.ok(events.includes('asr:6'));
  assert.ok(events.includes('upload-aborted'));
  assert.ok((await outbox.list()).every(item => item.status === 'pending'));
});

test('old partial remote files never suppress processing or become delivered receipts', async () => {
  const outbox = createMemoryDeliveryOutbox();
  const events = [];
  const uploaded = [];
  const result = await runScheduledOpenAiAction(candidate, context({
    deliveryOutbox: outbox,
    findDriveTranscripts: async () => ({ uploads: [5, 6].map(channel => ({
      channel, fileId: `old-partial-${channel}`, completeness: 'partial', processedSeconds: 15
    })) }),
    requestApi: cameraApi(events),
    uploadDriveTranscripts: async item => { uploaded.push(item.selections[0].channel); return receipt(item); }
  }));
  assert.equal(result.status, 'success', result.error);
  assert.equal(result.progress.uploadedCameras, 2);
  assert.deepEqual(events.filter(event => event.startsWith('asr:')), ['asr:5', 'asr:6']);
  assert.deepEqual([...uploaded].sort(), [5, 6]);
  assert.ok((await outbox.list()).every(item => item.status === 'delivered' && !item.upload.fileId.startsWith('old-partial')));
});
