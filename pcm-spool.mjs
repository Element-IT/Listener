import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const READ_CHUNK_BYTES = 64 * 1024;

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error('PCM capture was cancelled.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

/**
 * Drain capture independently of recognition, retaining PCM in a bounded file.
 * The consumer owns close(); successful completion leaves the file available
 * until close, while errors and aborts release resources automatically.
 */
export async function createPcmSpool(source, { directory, maxBytes, signal } = {}) {
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('PCM source must be an async iterable.');
  }
  if (typeof directory !== 'string' || !directory) throw new TypeError('PCM spool directory is required.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('PCM spool byte limit must be a positive safe integer.');
  }
  signal?.throwIfAborted();
  await fs.mkdir(directory, { recursive: true });
  signal?.throwIfAborted();
  const filePath = path.join(directory, `pcm-spool-${randomUUID()}.pcm`);
  const file = await fs.open(filePath, 'wx+');
  let iterator;
  try {
    iterator = source[Symbol.asyncIterator]();
  } catch (error) {
    await file.close().catch(() => {});
    await fs.unlink(filePath).catch(() => {});
    throw error;
  }

  let bytesWritten = 0;
  let ended = false;
  let failure;
  let version = 0;
  let cleanupPromise;
  let sourceStopped = false;
  const waiters = new Set();
  const cancellations = new Set();
  const reads = new Set();

  function notify() {
    version += 1;
    for (const resolve of waiters) resolve();
    waiters.clear();
  }

  function waitForChange(observedVersion) {
    if (version !== observedVersion) return Promise.resolve();
    return new Promise(resolve => { waiters.add(resolve); });
  }

  function stopSource() {
    if (sourceStopped) return;
    sourceStopped = true;
    try { source.destroy?.(); } catch {}
    // A generic iterator may be awaiting an uncancellable external operation.
    // The producer races cancellation so close never waits on that operation.
    try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch {}
  }

  function cancel(reason) {
    failure ||= abortError(reason);
    for (const reject of cancellations) reject();
    notify();
    stopSource();
  }

  function nextSourceChunk() {
    if (failure) return Promise.reject(failure);
    // Remove the cancellation callback after every read. Repeatedly racing a
    // shared unresolved cancellation promise would retain a callback per chunk.
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cancellations.delete(onCancel);
        callback(value);
      };
      const onCancel = () => finish(reject, failure);
      cancellations.add(onCancel);
      try {
        Promise.resolve(iterator.next()).then(
          value => finish(resolve, value),
          error => finish(reject, error)
        );
      } catch (error) {
        finish(reject, error);
      }
      if (failure) onCancel();
    });
  }

  async function produce() {
    try {
      while (true) {
        if (failure) throw failure;
        const next = await nextSourceChunk();
        if (failure) throw failure;
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw new TypeError('PCM source must yield byte buffers.');
        const chunk = Buffer.isBuffer(next.value)
          ? next.value : Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
        if (chunk.length > maxBytes - bytesWritten) {
          const error = new Error('PCM capture exceeded its spool byte limit.');
          error.code = 'PCM_SPOOL_LIMIT';
          error.maxBytes = maxBytes;
          error.bytesWritten = bytesWritten;
          throw error;
        }
        let offset = 0;
        while (offset < chunk.length) {
          if (failure) throw failure;
          const written = await file.write(chunk, offset, chunk.length - offset, bytesWritten);
          if (!written.bytesWritten) throw new Error('PCM spool write made no progress.');
          offset += written.bytesWritten;
          bytesWritten += written.bytesWritten;
          notify();
        }
      }
      ended = true;
      notify();
      return { bytesWritten };
    } catch (error) {
      failure ||= error;
      ended = true;
      notify();
      stopSource();
      throw failure;
    }
  }

  const producer = produce();

  function releaseResources() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      signal?.removeEventListener('abort', onAbort);
      await producer.catch(() => {});
      await Promise.allSettled([...reads]);
      let cleanupError;
      try { await file.close(); } catch (error) { cleanupError = error; }
      try { await fs.unlink(filePath); } catch (error) {
        if (error.code !== 'ENOENT') cleanupError ||= error;
      }
      if (cleanupError) throw cleanupError;
    })();
    return cleanupPromise;
  }

  async function close() {
    cancel();
    await releaseResources();
  }

  function onAbort() {
    cancel(signal.reason);
    releaseResources().catch(() => {});
  }

  const done = producer.catch(async error => {
    try { await releaseResources(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  });
  // Capture can fail while the caller is still processing a previous chunk.
  done.catch(() => {});

  async function* readPcm() {
    let offset = 0;
    try {
      while (true) {
        const observedVersion = version;
        if (failure) throw failure;
        const available = bytesWritten - offset;
        if (available > 0) {
          const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, available));
          const read = file.read(buffer, 0, buffer.length, offset);
          reads.add(read);
          let result;
          try { result = await read; } finally { reads.delete(read); }
          if (failure) throw failure;
          if (!result.bytesRead) throw new Error('PCM spool ended before its committed byte count.');
          offset += result.bytesRead;
          yield buffer.subarray(0, result.bytesRead);
          continue;
        }
        if (ended) return;
        await waitForChange(observedVersion);
      }
    } catch (error) {
      cancel(error);
      try { await releaseResources(); } catch (cleanupError) { error.cleanupError = cleanupError; }
      throw error;
    }
  }

  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return { readable: readPcm(), done, close, filePath };
}
