import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { createPcmSpool } from '../pcm-spool.mjs';

const testSpools = new WeakMap();

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function spoolDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'listener-pcm-spool-test-'));
  testSpools.set(t, []);
  t.after(async () => {
    for (const spool of testSpools.get(t)) await spool.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function assertRemoved(filePath) {
  await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
}

test('capture completes while recognition pauses after its first chunk; reads remain bounded and ordered', { timeout: 5000 }, async t => {
  const directory = await spoolDirectory(t);
  const input = [Buffer.alloc(256 * 1024, 1), Buffer.alloc(256 * 1024, 2), Buffer.alloc(256 * 1024, 3)];
  const source = Readable.from(input, { objectMode: false });
  const spool = await createPcmSpool(source, { directory, maxBytes: 1024 * 1024 });
  testSpools.get(t).push(spool);
  const iterator = spool.readable[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.ok(first.value.length <= 64 * 1024);

  // No further consumer pulls until the entire source is captured.
  assert.deepEqual(await spool.done, { bytesWritten: 768 * 1024 });
  assert.equal((await fs.stat(spool.filePath)).size, 768 * 1024);
  const received = [first.value];
  for await (const chunk of iterator) {
    assert.ok(chunk.length <= 64 * 1024);
    received.push(chunk);
  }
  assert.deepEqual(Buffer.concat(received), Buffer.concat(input));
  assert.equal((await fs.stat(spool.filePath)).size, 768 * 1024, 'normal EOF must retain the file until close');
  await Promise.all([spool.close(), spool.close()]);
  await assertRemoved(spool.filePath);
});

test('reader receives live PCM before capture reaches EOF', { timeout: 5000 }, async t => {
  const directory = await spoolDirectory(t);
  const continuation = deferred();
  t.after(() => continuation.resolve());
  const source = Readable.from((async function* () {
    yield Buffer.from('first audio');
    await continuation.promise;
    yield Buffer.from('second audio');
  })(), { objectMode: false });
  const spool = await createPcmSpool(source, { directory, maxBytes: 100 });
  testSpools.get(t).push(spool);
  let captureFinished = false;
  spool.done.then(() => { captureFinished = true; }, () => {});
  const iterator = spool.readable[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.toString(), 'first audio');
  assert.equal(captureFinished, false);
  continuation.resolve();
  const remaining = [];
  for await (const chunk of iterator) remaining.push(chunk);
  assert.equal(Buffer.concat(remaining).toString(), 'second audio');
  assert.deepEqual(await spool.done, { bytesWritten: 23 });
});

test('capture errors propagate to producer and reader and automatically remove the spool', { timeout: 5000 }, async t => {
  const directory = await spoolDirectory(t);
  const continuation = deferred();
  t.after(() => continuation.resolve());
  const failure = Object.assign(new Error('Test capture connection failed.'), { code: 'ECONNRESET' });
  const source = Readable.from((async function* () {
    yield Buffer.from('prefix');
    await continuation.promise;
    throw failure;
  })(), { objectMode: false });
  const spool = await createPcmSpool(source, { directory, maxBytes: 100 });
  testSpools.get(t).push(spool);
  const iterator = spool.readable[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.toString(), 'prefix');
  continuation.resolve();
  await assert.rejects(spool.done, error => error === failure);
  await assertRemoved(spool.filePath);
  await assert.rejects(iterator.next(), error => error === failure);
  assert.equal(source.destroyed, true);
});

test('signal abort wakes a waiting reader, stops capture, and removes its file', { timeout: 5000 }, async t => {
  const directory = await spoolDirectory(t);
  const controller = new AbortController();
  const source = new PassThrough();
  const spool = await createPcmSpool(source, { directory, maxBytes: 100, signal: controller.signal });
  testSpools.get(t).push(spool);
  const iterator = spool.readable[Symbol.asyncIterator]();
  const waitingRead = assert.rejects(iterator.next(), { name: 'AbortError' });
  controller.abort();
  await waitingRead;
  await assert.rejects(spool.done, { name: 'AbortError' });
  assert.equal(source.destroyed, true);
  await assertRemoved(spool.filePath);
});

test('spool rejects an overflowing source chunk before writing any of it', { timeout: 5000 }, async t => {
  const directory = await spoolDirectory(t);
  const continuation = deferred();
  t.after(() => continuation.resolve());
  const source = Readable.from((async function* () {
    yield Buffer.alloc(80);
    await continuation.promise;
    yield Buffer.alloc(30);
  })(), { objectMode: false });
  const spool = await createPcmSpool(source, { directory, maxBytes: 100 });
  testSpools.get(t).push(spool);
  const iterator = spool.readable[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.length, 80);
  assert.equal((await fs.stat(spool.filePath)).size, 80);
  continuation.resolve();
  await assert.rejects(spool.done, error => {
    assert.equal(error.code, 'PCM_SPOOL_LIMIT');
    assert.equal(error.bytesWritten, 80);
    assert.equal(error.maxBytes, 100);
    return true;
  });
  await assertRemoved(spool.filePath);
  await assert.rejects(iterator.next(), { code: 'PCM_SPOOL_LIMIT' });
  assert.equal(source.destroyed, true);
});

test('close can cancel an async iterator whose pending read cannot be interrupted', { timeout: 5000 }, async t => {
  const directory = await spoolDirectory(t);
  let returned = 0;
  const source = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(() => {}),
        return: async () => { returned += 1; return { done: true }; }
      };
    }
  };
  const spool = await createPcmSpool(source, { directory, maxBytes: 100 });
  testSpools.get(t).push(spool);
  await spool.close();
  await spool.close();
  assert.equal(returned, 1);
  await assert.rejects(spool.done, { name: 'AbortError' });
  await assertRemoved(spool.filePath);
});

test('invalid source initialization and an already aborted request leave no spool files', async t => {
  const directory = await spoolDirectory(t);
  await assert.rejects(createPcmSpool({
    [Symbol.asyncIterator]() { throw new Error('Invalid source iterator.'); }
  }, { directory, maxBytes: 100 }), /Invalid source iterator/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createPcmSpool(new PassThrough(), {
    directory, maxBytes: 100, signal: controller.signal
  }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(directory), []);
});
