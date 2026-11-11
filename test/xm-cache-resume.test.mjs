import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRecoverXmRecordingFromCache } from '../xm-block-recovery.mjs';

test('more than four missing blocks never cause a completed prefix to be downloaded again', async () => {
  const blocks = Array.from({ length: 200 }, (_, index) => index);
  assert.equal(await shouldRecoverXmRecordingFromCache(blocks, 10, false, async () => false), true);
  assert.equal(await shouldRecoverXmRecordingFromCache(blocks, 0, true, async () => false), true);
});

test('a missing first block with complete later blocks uses targeted recovery, but a fresh recording streams', async () => {
  const blocks = Array.from({ length: 200 }, (_, index) => index);
  assert.equal(await shouldRecoverXmRecordingFromCache(blocks, 0, false, async index => index === 199), true);
  assert.equal(await shouldRecoverXmRecordingFromCache(blocks, 0, false, async () => false), false);
});
