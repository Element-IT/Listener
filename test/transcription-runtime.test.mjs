import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkTranscriber, transcriptionRuntimeStatus } from '../server.mjs';

const runtime = { available: true, selectedDevice: 'cpu', cuda: { available: false }, reason: 'torch_cpu_only' };

test('an idle runtime reports the selected device without claiming the model is loaded', () => {
  const status = transcriptionRuntimeStatus(runtime);
  assert.equal(status.selectedDevice, 'cpu');
  assert.equal(status.actualDevice, null);
  assert.equal(status.modelState, 'not_loaded');
});

test('model loading, ready and transcribing states use actual worker device metadata', () => {
  const worker = { closed: false, pending: new Map() };
  assert.equal(transcriptionRuntimeStatus(runtime, worker).modelState, 'loading');
  worker.runtimeInfo = { actualDevice: 'cuda:1', cuda: { available: true } };
  let status = transcriptionRuntimeStatus(runtime, worker);
  assert.equal(status.modelState, 'ready');
  assert.equal(status.actualDevice, 'cuda:1');
  assert.equal(status.cuda.available, true);
  worker.pending.set('request', {});
  status = transcriptionRuntimeStatus(runtime, worker);
  assert.equal(status.modelState, 'transcribing');
});

test('a closed or failed worker cannot keep showing an active GPU', () => {
  const worker = { closed: true, runtimeInfo: { actualDevice: 'cuda:0' } };
  assert.equal(transcriptionRuntimeStatus(runtime, worker).actualDevice, null);
  const failed = transcriptionRuntimeStatus(runtime, worker, 'Model load failed');
  assert.equal(failed.available, false);
  assert.equal(failed.modelState, 'error');
  assert.equal(failed.modelError, 'Model load failed');
});

test('a missing Python executable returns a readable diagnostic instead of rejecting health', async () => {
  const status = await checkTranscriber('listener-nonexistent-python-for-test');
  assert.equal(status.available, false);
  assert.match(status.error, /ENOENT/);
});

test('Python runtime selection and worker protocol regression tests', () => {
  const result = spawnSync(process.env.PYTHON_PATH || 'python', ['-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_transcription_*.py'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', windowsHide: true, timeout: 30000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
