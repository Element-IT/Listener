import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDeliveryOutbox, createMemoryDeliveryOutbox } from '../delivery-outbox.mjs';
import { createDriveDeliveryWorker } from '../drive-delivery.mjs';

function harness() {
  let at = Date.parse('2026-11-03T10:00:00Z');
  const now = () => at;
  return { outbox: createMemoryDeliveryOutbox({ now }), now, advance: ms => { at += ms; } };
}

function queued(channel = 1, overrides = {}) {
  return { scope: 'root/action/period', actionId: 'action', runKey: 'period', channel,
    payload: { text: `Complete transcript for camera ${channel}`, complete: true }, ...overrides };
}

function receipt(item, overrides = {}) {
  return { uploads: [{ channel: item.channel, fileId: `drive-${item.channel}`, completeness: 'complete', ...overrides }] };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('worker delivers ready complete records and does not reupload delivered receipts', async () => {
  const { outbox, now } = harness();
  const item = await outbox.enqueue(queued());
  let calls = 0;
  let callbacks = 0;
  const worker = createDriveDeliveryWorker({ outbox, now,
    deliver: async value => { calls += 1; return receipt(value); },
    onDelivered: async (value, upload) => {
      callbacks += 1;
      assert.equal(value.id, item.id);
      assert.equal(upload.fileId, 'drive-1');
    } });
  await worker.flush();
  await worker.flush();
  assert.equal(calls, 1);
  assert.equal(callbacks, 1);
  assert.equal((await outbox.get(item.scope, 1)).status, 'delivered');
});

test('DNS failure retains payload, honors backoff, and does not block another camera', async () => {
  const { outbox, now, advance } = harness();
  const first = await outbox.enqueue(queued(1));
  await outbox.enqueue(queued(2));
  const calls = [];
  let offline = true;
  const worker = createDriveDeliveryWorker({ outbox, now, deliver: async item => {
    calls.push(item.channel);
    if (item.channel === 1 && offline) throw Object.assign(new Error('private URL and token'), { code: 'ENOTFOUND' });
    return receipt(item);
  } });
  await worker.flush();
  assert.deepEqual(calls.sort(), [1, 2]);
  const pending = await outbox.get(first.scope, 1);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.lastError, 'ENOTFOUND');
  assert.deepEqual(pending.payload, first.payload);
  assert.equal((await outbox.get(first.scope, 2)).status, 'delivered');
  await worker.flush();
  assert.equal(calls.length, 2);
  offline = false;
  advance(60_000);
  await worker.flush();
  assert.equal(calls.length, 3);
  assert.equal((await outbox.get(first.scope, 1)).status, 'delivered');
});

test('durable failed delivery resumes after worker and outbox recreation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'listener-delivery-worker-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let at = Date.parse('2026-11-03T10:00:00Z');
  const now = () => at;
  const original = createDeliveryOutbox({ directory, now });
  const item = await original.enqueue(queued());
  await createDriveDeliveryWorker({ outbox: original, now,
    deliver: async () => { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); } }).flush();
  const restarted = createDeliveryOutbox({ directory, now });
  let calls = 0;
  const worker = createDriveDeliveryWorker({ outbox: restarted, now,
    deliver: async value => { calls += 1; assert.deepEqual(value.payload, item.payload); return receipt(value); } });
  await worker.flush();
  assert.equal(calls, 0);
  at += 60_000;
  await worker.flush();
  assert.equal(calls, 1);
  assert.equal((await restarted.get(item.scope, 1)).status, 'delivered');
});

test('concurrent flush callers share one flight and rescan a camera queued during upload', async () => {
  const { outbox, now } = harness();
  await outbox.enqueue(queued(1));
  const started = deferred();
  const release = deferred();
  const calls = [];
  const worker = createDriveDeliveryWorker({ outbox, now, deliver: async item => {
    calls.push(item.channel);
    if (item.channel === 1) { started.resolve(); await release.promise; }
    return receipt(item);
  } });
  const first = worker.flush();
  await started.promise;
  await outbox.enqueue(queued(2));
  const concurrent = worker.flush();
  assert.equal(concurrent, first);
  release.resolve();
  await first;
  assert.deepEqual(calls, [1, 2]);
  assert.ok((await outbox.list()).every(item => item.status === 'delivered'));
});

test('a record is attempted at most once per flush even if time advances past its retry', async () => {
  const { outbox, now, advance } = harness();
  const item = await outbox.enqueue(queued());
  let calls = 0;
  const worker = createDriveDeliveryWorker({ outbox, now: () => { advance(3_600_000); return now(); },
    deliver: async () => { calls += 1; throw Object.assign(new Error('network'), { code: 'ENOTFOUND' }); } });
  await worker.flush();
  assert.equal(calls, 1);
  assert.equal((await outbox.get(item.scope, 1)).attempts, 1);
});

test('timeout aborts the request and a late resolution cannot mark the record delivered', async () => {
  const { outbox, now } = harness();
  const item = await outbox.enqueue(queued());
  const late = deferred();
  let signal;
  const worker = createDriveDeliveryWorker({ outbox, now, timeoutMs: 15, deliver: async (_item, deliverySignal) => {
    signal = deliverySignal;
    return late.promise;
  } });
  await worker.flush();
  assert.equal(signal.aborted, true);
  assert.equal((await outbox.get(item.scope, 1)).lastError, 'DELIVERY_TIMEOUT');
  late.resolve(receipt(item));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await outbox.get(item.scope, 1)).status, 'pending');
});

test('timeout includes eligibility lookup and cannot start a late upload', async () => {
  const { outbox, now } = harness();
  const item = await outbox.enqueue(queued());
  const eligible = deferred();
  let calls = 0;
  const worker = createDriveDeliveryWorker({ outbox, now, timeoutMs: 15,
    canDeliver: async () => eligible.promise,
    deliver: async value => { calls += 1; return receipt(value); } });
  await worker.flush();
  eligible.resolve(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal((await outbox.get(item.scope, 1)).lastError, 'DELIVERY_TIMEOUT');
});

test('eligibility rejection leaves an item untouched while lookup errors back off independently', async () => {
  const { outbox, now } = harness();
  const first = await outbox.enqueue(queued(1));
  await outbox.enqueue(queued(2));
  await outbox.enqueue(queued(3));
  const calls = [];
  const worker = createDriveDeliveryWorker({ outbox, now, canDeliver: async item => {
    if (item.channel === 1) return false;
    if (item.channel === 2) throw Object.assign(new Error('private database details'), { code: 'ECONNRESET' });
    return true;
  }, deliver: async item => { calls.push(item.channel); return receipt(item); } });
  await worker.flush();
  assert.deepEqual(calls, [3]);
  assert.equal((await outbox.get(first.scope, 1)).attempts, 0);
  assert.equal((await outbox.get(first.scope, 2)).lastError, 'ECONNRESET');
  assert.equal((await outbox.get(first.scope, 3)).status, 'delivered');
});

test('missing or wrong-camera receipts never mark a complete payload delivered', async () => {
  for (const upload of [undefined, {}, { uploads: [] }, { uploads: [{ channel: 1 }] },
    { uploads: [{ channel: 2, fileId: 'wrong-camera' }] }]) {
    const { outbox, now } = harness();
    const item = await outbox.enqueue(queued());
    await createDriveDeliveryWorker({ outbox, now, deliver: async () => upload }).flush();
    const pending = await outbox.get(item.scope, 1);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.lastError, 'DELIVERY_INVALID_RECEIPT');
  }
});

test('explicitly partial or incomplete receipts are never promoted to complete', async () => {
  for (const flags of [{ completeness: 'partial' }, { partial: true }, { complete: false }]) {
    const { outbox, now } = harness();
    const item = await outbox.enqueue(queued());
    await createDriveDeliveryWorker({ outbox, now, deliver: async value => receipt(value, flags) }).flush();
    const pending = await outbox.get(item.scope, 1);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.upload, undefined);
    assert.equal(pending.lastError, 'DELIVERY_INVALID_RECEIPT');
  }
});

test('unsafe error details are reduced to a safe classification', async () => {
  const { outbox, now } = harness();
  const item = await outbox.enqueue(queued());
  await createDriveDeliveryWorker({ outbox, now, deliver: async () => {
    throw { code: 'https://private.example/?token=secret', message: 'secret body' };
  } }).flush();
  assert.equal((await outbox.get(item.scope, 1)).lastError, 'DELIVERY_FAILED');
});

test('post-delivery callback failure never downgrades a durable receipt', async () => {
  const { outbox, now } = harness();
  const item = await outbox.enqueue(queued());
  await createDriveDeliveryWorker({ outbox, now, deliver: async value => receipt(value),
    onDelivered: async () => { throw new Error('status update failed'); } }).flush();
  const delivered = await outbox.get(item.scope, 1);
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.upload.fileId, 'drive-1');
  assert.equal(delivered.lastError, null);
});
