import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDeliveryOutbox, createMemoryDeliveryOutbox } from '../delivery-outbox.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'listener-outbox-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = new Date('2026-11-03T10:00:00Z');
  const options = { directory, now: () => now };
  return { directory, options, outbox: createDeliveryOutbox(options), setNow: value => { now = new Date(value); } };
}

function input(overrides = {}) {
  return {
    scope: 'action-1/2026-10-29', actionId: 'action-1', runKey: '2026-10-29', channel: 1,
    payload: { name: '01 Hall.txt', text: '[07:30:00] Complete transcript', complete: true },
    ...overrides
  };
}

test('outbox persists ready payload and delivery receipt across instance restarts', async t => {
  const { options, outbox } = await fixture(t);
  assert.deepEqual(await outbox.list(), []);
  assert.equal(await outbox.get('not-created', 1), null);
  const queued = await outbox.enqueue(input());
  assert.equal(queued.status, 'pending');
  assert.match(queued.id, /^[a-f0-9]{64}$/);
  const restarted = createDeliveryOutbox(options);
  assert.deepEqual(await restarted.get(queued.scope, 1), queued);
  const delivered = await restarted.markDelivered(queued.id, { id: 'drive-file', name: queued.payload.name });
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.nextAttemptAt, null);
  assert.deepEqual(delivered.payload, queued.payload);
  assert.deepEqual(await createDeliveryOutbox(options).list(), [delivered]);
});

test('enqueue is idempotent and preserves its first immutable payload and receipt', async t => {
  const { outbox } = await fixture(t);
  const original = input();
  const promise = outbox.enqueue(original);
  original.payload.text = 'caller changed the object';
  const queued = await promise;
  assert.match(queued.payload.text, /Complete transcript/);
  queued.payload.text = 'caller changed returned record';
  const retry = await outbox.enqueue(input({ payload: { text: 'replacement' } }));
  assert.match(retry.payload.text, /Complete transcript/);
  const delivered = await outbox.markDelivered(retry.id, { id: 'first-file' });
  assert.deepEqual(await outbox.enqueue(input()), delivered);
  assert.deepEqual(await outbox.markDelivered(retry.id, { id: 'second-file' }), delivered);
  assert.deepEqual(await outbox.markFailure(retry.id, 'late failure'), delivered);
  assert.deepEqual(await outbox.rememberDelivered({ ...input(), upload: { id: 'third-file' } }), delivered);
});

test('known complete remote receipts do not require a local payload and never get downgraded', async t => {
  const { outbox } = await fixture(t);
  const receipt = await outbox.rememberDelivered({ ...input(), upload: { id: 'already-present' } });
  assert.equal(receipt.payload, undefined);
  assert.equal(receipt.status, 'delivered');
  assert.deepEqual(await outbox.enqueue(input()), receipt);
});

test('rememberDelivered retains an existing pending payload', async t => {
  const { outbox } = await fixture(t);
  const queued = await outbox.enqueue(input());
  const receipt = await outbox.rememberDelivered({ ...input(), upload: { id: 'remote-existing' } });
  assert.deepEqual(receipt.payload, queued.payload);
  assert.equal(receipt.id, queued.id);
});

test('scope and normalized camera number produce stable distinct record keys', async t => {
  const { outbox } = await fixture(t);
  const first = await outbox.enqueue(input());
  assert.equal((await outbox.get(first.scope, '01')).id, first.id);
  const camera2 = await outbox.enqueue(input({ channel: 2 }));
  const otherScope = await outbox.enqueue(input({ scope: 'action-2/day', actionId: 'action-2' }));
  assert.equal(new Set([first.id, camera2.id, otherScope.id]).size, 3);
  assert.equal((await outbox.list(first.scope)).length, 2);
  assert.equal((await outbox.list()).length, 3);
  await assert.rejects(outbox.enqueue(input({ actionId: 'different-action' })), { code: 'OUTBOX_SCOPE_CONFLICT' });
  await assert.rejects(outbox.rememberDelivered({ ...input({ runKey: 'different-period' }), upload: {} }), { code: 'OUTBOX_SCOPE_CONFLICT' });
});

test('delivery failures persist bounded exponential backoff without modifying the payload', async t => {
  const { outbox, setNow, options } = await fixture(t);
  const queued = await outbox.enqueue(input());
  let last;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const at = new Date(Date.UTC(2026, 10, 3, 10, attempt));
    setNow(at);
    last = await outbox.markFailure(queued.id, 'Google DNS temporarily unavailable');
    assert.equal(last.attempts, attempt);
    assert.equal(Date.parse(last.nextAttemptAt) - at.getTime(), Math.min(3_600_000, 60_000 * 2 ** (attempt - 1)));
    assert.deepEqual(last.payload, queued.payload);
  }
  assert.deepEqual(await createDeliveryOutbox(options).get(queued.scope, 1), last);
  const delivered = await outbox.markDelivered(queued.id, { id: 'drive-file' });
  assert.equal(delivered.attempts, 10);
  assert.equal(delivered.lastError, null);
  assert.equal(delivered.nextAttemptAt, null);
});

test('explicit delivery retry makes a pending record due without losing failure history or payload', async t => {
  const { outbox, options, setNow } = await fixture(t);
  const queued = await outbox.enqueue(input());
  const failed = await outbox.markFailure(queued.id, 'ENOTFOUND');
  setNow('2026-11-03T10:00:15Z');
  const retry = await outbox.retryNow(queued.id);
  assert.equal(retry.nextAttemptAt, '2026-11-03T10:00:15.000Z');
  assert.equal(retry.updatedAt, retry.nextAttemptAt);
  assert.equal(retry.status, 'pending');
  assert.equal(retry.attempts, failed.attempts);
  assert.equal(retry.lastError, failed.lastError);
  assert.deepEqual(retry.payload, failed.payload);
  assert.deepEqual(await createDeliveryOutbox(options).get(retry.scope, retry.channel), retry);
  const delivered = await outbox.markDelivered(queued.id, { id: 'remote-file' });
  setNow('2026-11-03T10:01:00Z');
  assert.deepEqual(await outbox.retryNow(queued.id), delivered);
  await assert.rejects(outbox.retryNow('0'.repeat(64)), { code: 'OUTBOX_NOT_FOUND' });
});

test('concurrent failures and enqueues are serialized across store instances in this process', async t => {
  const { outbox, options } = await fixture(t);
  const second = createDeliveryOutbox(options);
  const records = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    (index % 2 ? outbox : second).enqueue(input({ payload: { complete: true, text: `payload-${index}` } }))));
  assert.equal(new Set(records.map(record => record.id)).size, 1);
  assert.equal(new Set(records.map(record => record.payload.text)).size, 1);
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    (index % 2 ? outbox : second).markFailure(records[0].id, `failure-${index}`)));
  assert.equal((await outbox.get(records[0].scope, 1)).attempts, 20);
  await Promise.all([
    outbox.markDelivered(records[0].id, { id: 'finished' }),
    second.markFailure(records[0].id, 'late failure'),
    outbox.enqueue(input())
  ]);
  assert.equal((await second.get(records[0].scope, 1)).status, 'delivered');
});

test('failed atomic replacement retains the old record and cleans only its own temporary file', async t => {
  const { outbox, directory } = await fixture(t);
  const queued = await outbox.enqueue(input());
  const before = await fs.readFile(path.join(directory, `${queued.id}.json`), 'utf8');
  const rename = t.mock.method(fs, 'rename', async () => {
    const error = new Error('simulated disk I/O failure');
    error.code = 'EIO';
    throw error;
  });
  await assert.rejects(outbox.markDelivered(queued.id, { id: 'remote-upload' }), { code: 'EIO' });
  rename.mock.restore();
  assert.equal(await fs.readFile(path.join(directory, `${queued.id}.json`), 'utf8'), before);
  assert.deepEqual(await fs.readdir(directory), [`${queued.id}.json`]);
  // A failed write must not poison the process-local serialization queue.
  assert.equal((await outbox.markDelivered(queued.id, { id: 'remote-upload' })).status, 'delivered');
});

test('first-write failure does not pretend a payload was queued', async t => {
  const { outbox, directory } = await fixture(t);
  const open = t.mock.method(fs, 'open', async () => {
    const error = new Error('simulated full filesystem');
    error.code = 'ENOSPC';
    throw error;
  });
  await assert.rejects(outbox.enqueue(input()), { code: 'ENOSPC' });
  open.mock.restore();
  assert.deepEqual(await outbox.list(), []);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('corrupt JSON fails explicitly and is never overwritten by retry or omitted from listing', async t => {
  const { outbox, directory } = await fixture(t);
  const queued = await outbox.enqueue(input());
  const filename = path.join(directory, `${queued.id}.json`);
  await fs.writeFile(filename, '{broken json', 'utf8');
  await assert.rejects(outbox.get(queued.scope, 1), { code: 'OUTBOX_CORRUPT' });
  await assert.rejects(outbox.list(), { code: 'OUTBOX_CORRUPT' });
  await assert.rejects(outbox.enqueue(input()), { code: 'OUTBOX_CORRUPT' });
  await assert.rejects(outbox.markDelivered(queued.id, { id: 'file' }), { code: 'OUTBOX_CORRUPT' });
  assert.equal(await fs.readFile(filename, 'utf8'), '{broken json');
});

test('valid JSON with inconsistent identity or missing ready payload is corrupt', async t => {
  const { outbox, directory } = await fixture(t);
  const queued = await outbox.enqueue(input());
  const filename = path.join(directory, `${queued.id}.json`);
  await fs.writeFile(filename, JSON.stringify({ ...queued, channel: 2 }));
  await assert.rejects(outbox.list(), { code: 'OUTBOX_CORRUPT' });
  const withoutPayload = { ...queued };
  delete withoutPayload.payload;
  await fs.writeFile(filename, JSON.stringify(withoutPayload));
  await assert.rejects(outbox.get(queued.scope, 1), { code: 'OUTBOX_CORRUPT' });
});

test('orphan atomic-write temporary files are not mistaken for queued records', async t => {
  const { outbox, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, '.interrupted-write.tmp'), '{incomplete');
  assert.deepEqual(await outbox.list(), []);
  assert.equal(await fs.readFile(path.join(directory, '.interrupted-write.tmp'), 'utf8'), '{incomplete');
});

test('unexpected JSON entries are reported instead of silently ignored', async t => {
  const { outbox, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'unexpected.json'), '{}');
  await assert.rejects(outbox.list(), { code: 'OUTBOX_CORRUPT' });
});

test('invalid API inputs and unknown ids fail without creating records', async t => {
  const { outbox } = await fixture(t);
  await assert.rejects(outbox.enqueue(input({ channel: '../outside' })), TypeError);
  await assert.rejects(outbox.enqueue(input({ payload: undefined })), TypeError);
  await assert.rejects(outbox.get('', 1), TypeError);
  await assert.rejects(outbox.markDelivered('../outside', {}), TypeError);
  await assert.rejects(outbox.markDelivered('0'.repeat(64), {}), { code: 'OUTBOX_NOT_FOUND' });
  const queued = await outbox.enqueue(input());
  await assert.rejects(outbox.markFailure(queued.id, new Error('potentially private stack')), TypeError);
  const long = await outbox.markFailure(queued.id, 'x'.repeat(2500));
  assert.equal(long.lastError.length, 2000);
});

test('memory adapter has the same transitions, isolated stores and no filesystem activity', async t => {
  const open = t.mock.method(fs, 'open', async () => { throw new Error('memory adapter must not open files'); });
  const readFile = t.mock.method(fs, 'readFile', async () => { throw new Error('memory adapter must not read files'); });
  const mkdir = t.mock.method(fs, 'mkdir', async () => { throw new Error('memory adapter must not create directories'); });
  const readdir = t.mock.method(fs, 'readdir', async () => { throw new Error('memory adapter must not list directories'); });
  const outbox = createMemoryDeliveryOutbox({ now: () => '2026-11-03T10:00:00Z' });
  const other = createMemoryDeliveryOutbox();
  const queued = await outbox.enqueue(input());
  queued.payload.text = 'mutation outside store';
  assert.match((await outbox.get(queued.scope, 1)).payload.text, /Complete transcript/);
  const listed = await outbox.list();
  listed[0].payload.text = 'mutation through list';
  assert.match((await outbox.get(queued.scope, 1)).payload.text, /Complete transcript/);
  const failed = await outbox.markFailure(queued.id, 'offline');
  assert.equal(failed.nextAttemptAt, '2026-11-03T10:01:00.000Z');
  const retry = await outbox.retryNow(queued.id);
  assert.equal(retry.nextAttemptAt, '2026-11-03T10:00:00.000Z');
  assert.equal(retry.attempts, 1);
  assert.equal(retry.lastError, 'offline');
  assert.deepEqual(retry.payload, failed.payload);
  const delivered = await outbox.markDelivered(queued.id, { id: 'file' });
  assert.equal(delivered.status, 'delivered');
  assert.deepEqual(await outbox.retryNow(queued.id), delivered);
  assert.deepEqual(await outbox.enqueue(input()), delivered);
  assert.deepEqual(await other.list(), []);
  for (const mock of [open, readFile, mkdir, readdir]) assert.equal(mock.mock.callCount(), 0);
});
