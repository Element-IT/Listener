import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runTranscriptionSetup, transcriptionPreparationPending } from '../server.mjs';

const config = { pythonPath: 'test-python', gigaamDevice: 'auto', ffmpegPath: 'ffmpeg' };
function childProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}

test('preparation stages block inference, while ready and fallback stages allow it', () => {
  for (const stage of ['checking', 'creating', 'installing_torch', 'installing_gigaam', 'verifying']) {
    assert.equal(transcriptionPreparationPending({ stage }), true);
  }
  for (const stage of ['not_started', 'ready', 'fallback']) {
    assert.equal(transcriptionPreparationPending({ stage }), false);
  }
});

test('setup bridge parses split JSON messages and returns the verified interpreter', async () => {
  const child = childProcess();
  const stages = [];
  const promise = runTranscriptionSetup(config, message => stages.push(message.stage), { spawnProcess: () => child });
  child.stdout.write('{"stage":"installing_');
  child.stdout.write('torch","variant":"cu128"}\n');
  child.stdout.write(JSON.stringify({ stage: 'done', pythonPath: 'managed-python', runtime: { available: true } }) + '\n');
  child.emit('close', 0);
  const result = await promise;
  assert.equal(result.pythonPath, 'managed-python');
  assert.deepEqual(stages, ['installing_torch']);
});

test('setup rejects a broken or missing installer result', async () => {
  const child = childProcess();
  const promise = runTranscriptionSetup(config, () => {}, { spawnProcess: () => child });
  child.stdout.write('{"stage":"failed","error":"Network unavailable"}\n');
  child.emit('close', 1);
  await assert.rejects(promise, /Network unavailable/);
});

test('setup timeout is bounded and stops the setup process', async () => {
  const child = childProcess();
  const promise = runTranscriptionSetup(config, () => {}, { spawnProcess: () => child, timeoutMs: 10 });
  await assert.rejects(promise, /timed out/);
  assert.equal(child.killed, true);
});
