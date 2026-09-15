import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranscriptionModelSettings, TRANSCRIPTION_MODELS } from '../transcription-models.mjs';
import { transcriptCacheKey } from '../server.mjs';

function fixture(options = {}) {
  const writes = [];
  let changes = 0;
  const settings = createTranscriptionModelSettings({
    defaultModel: 'v3_e2e_rnnt', read: async () => null,
    write: async value => { writes.push(value); },
    busyReason: () => '', onChange: () => { changes += 1; }, ...options
  });
  return { settings, writes, changes: () => changes };
}

test('catalog contains only versioned Russian ASR models with bounded, reproducible ratings', () => {
  assert.equal(TRANSCRIPTION_MODELS.length, 8);
  assert.equal(new Set(TRANSCRIPTION_MODELS.map(model => model.id)).size, 8);
  for (const model of TRANSCRIPTION_MODELS) {
    assert.match(model.id, /^v[123]_(e2e_)?(ctc|rnnt)$/);
    assert.equal(model.quality, Math.round(5 * 8.3 / model.wer * 10) / 10);
    assert.equal(model.speed, model.id.endsWith('_ctc') ? 5 : 3);
    assert.ok(model.quality > 0 && model.quality <= 5);
  }
});

test('stored server setting overrides env default and survives a new settings instance', async () => {
  let stored;
  const options = { read: async () => stored, write: async value => { stored = value; } };
  const first = fixture(options);
  await first.settings.initialize();
  assert.equal(first.settings.model, 'v3_e2e_rnnt');
  await first.settings.save('v3_ctc');
  assert.equal(first.settings.model, 'v3_ctc');
  assert.equal(first.changes(), 1);
  const restarted = fixture(options);
  await restarted.settings.initialize();
  assert.equal(restarted.settings.model, 'v3_ctc');
});

test('unknown persisted settings are ignored, configured aliases normalize, custom defaults remain intact', async () => {
  const aliases = fixture({ defaultModel: 'ctc', read: async () => 'emo' }).settings;
  await aliases.initialize();
  assert.equal(aliases.model, 'v3_ctc');
  const custom = fixture({ defaultModel: '/models/custom.ckpt' }).settings;
  await custom.initialize();
  assert.equal(custom.model, '/models/custom.ckpt');
});

test('invalid models and paths never reach storage or restart the worker', async () => {
  const { settings, writes, changes } = fixture();
  for (const value of ['ssl', 'emo', '../model.ckpt', '--device cpu', 'v9_ctc', null, {}]) {
    await assert.rejects(settings.save(value), { statusCode: 400 });
  }
  assert.deepEqual(writes, []);
  assert.equal(changes(), 0);
});

test('capture, worker loading and background activity block changes without stopping the worker', async () => {
  let reason = 'Transcription is active';
  const { settings, writes, changes } = fixture({ busyReason: () => reason });
  await settings.initialize();
  assert.equal(settings.snapshot().modelChangeAllowed, false);
  await assert.rejects(settings.save('v3_ctc'), { statusCode: 409, message: reason });
  assert.deepEqual(writes, []);
  assert.equal(changes(), 0);
  reason = '';
  assert.equal(settings.snapshot().modelChangeAllowed, true);
  await settings.save('v3_ctc');
  assert.equal(changes(), 1);
});

test('failed persistence keeps the previous model and running worker', async () => {
  const { settings, changes } = fixture({ write: async () => { throw new Error('DB unavailable'); } });
  await assert.rejects(settings.save('v3_ctc'), /DB unavailable/);
  assert.equal(settings.model, 'v3_e2e_rnnt');
  assert.equal(settings.saving, false);
  assert.equal(changes(), 0);
});

test('concurrent saves cannot race and model changes only after durable persistence', async () => {
  let finishWrite;
  let startedWrite;
  const started = new Promise(resolve => { startedWrite = resolve; });
  const { settings, changes } = fixture({ write: () => {
    startedWrite();
    return new Promise(resolve => { finishWrite = resolve; });
  } });
  const first = settings.save('v3_ctc');
  await started;
  assert.equal(settings.saving, true);
  assert.equal(settings.model, 'v3_e2e_rnnt');
  assert.equal(settings.snapshot().modelChangeAllowed, false);
  await assert.rejects(settings.save('v2_ctc'), { statusCode: 409 });
  finishWrite();
  await first;
  assert.equal(settings.model, 'v3_ctc');
  assert.equal(settings.saving, false);
  assert.equal(changes(), 1);
});

test('no-op selection does not write or reload a model', async () => {
  const { settings, writes, changes } = fixture();
  await settings.save('v3_e2e_rnnt');
  assert.equal(writes.length, 0);
  assert.equal(changes(), 0);
});

test('storage initialization coalesces reads and can recover from failure', async () => {
  let reads = 0;
  let unavailable = true;
  const { settings } = fixture({ read: async () => {
    reads += 1;
    if (unavailable) throw new Error('offline');
    return 'v2_rnnt';
  } });
  const attempts = await Promise.allSettled([settings.initialize(), settings.initialize()]);
  assert.ok(attempts.every(result => result.status === 'rejected'));
  assert.equal(reads, 1);
  assert.equal(settings.snapshot().modelChangeAllowed, false);
  unavailable = false;
  await settings.initialize();
  assert.equal(settings.model, 'v2_rnnt');
  assert.equal(settings.snapshot().modelChangeAllowed, true);
  await settings.initialize();
  assert.equal(reads, 2);
});

test('recording cache separates transcripts made by different models', () => {
  const params = new URLSearchParams({ from: '2026-09-14T09:00', to: '2026-09-14T09:01' });
  const config = { host: 'camera', gigaamModel: 'v3_ctc' };
  const first = transcriptCacheKey(config, params, { channel: 2 });
  const second = transcriptCacheKey({ ...config, gigaamModel: 'v3_rnnt' }, params, { channel: 2 });
  assert.notEqual(first, second);
});
