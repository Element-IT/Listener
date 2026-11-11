import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const recordQueues = new Map();
const ID_PATTERN = /^[a-f0-9]{64}$/;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function normalizedChannel(value) {
  const channel = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(channel) || channel < 1) {
    throw new TypeError('channel must be a positive integer.');
  }
  return channel;
}

function recordIdentity(scope, channel) {
  requiredString(scope, 'scope');
  return createHash('sha256').update(JSON.stringify([scope, normalizedChannel(channel)])).digest('hex');
}

function jsonObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object.`);
  }
  const serialized = JSON.stringify(value);
  const copy = JSON.parse(serialized);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) {
    throw new TypeError(`${name} must serialize to a JSON object.`);
  }
  return copy;
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateRecord(record, id) {
  try {
    if (!record || record.version !== 1 || record.id !== id || !ID_PATTERN.test(id)
      || recordIdentity(record.scope, record.channel) !== id
      || !['pending', 'delivered'].includes(record.status)
      || !isTimestamp(record.createdAt) || !isTimestamp(record.updatedAt)
      || !Number.isSafeInteger(record.attempts) || record.attempts < 0) {
      throw new Error('Invalid record metadata.');
    }
    requiredString(record.actionId, 'actionId');
    requiredString(record.runKey, 'runKey');
    if (record.payload !== undefined) jsonObject(record.payload, 'payload');
    if (record.status === 'pending') {
      jsonObject(record.payload, 'payload');
      if (!isTimestamp(record.nextAttemptAt)) throw new Error('Invalid retry timestamp.');
    } else {
      jsonObject(record.upload, 'upload');
      if (!isTimestamp(record.deliveredAt) || record.nextAttemptAt !== null) {
        throw new Error('Invalid delivery receipt.');
      }
    }
    if (record.lastError !== null && typeof record.lastError !== 'string') {
      throw new Error('Invalid error summary.');
    }
    return record;
  } catch (error) {
    throw failure('OUTBOX_CORRUPT', `Delivery outbox record ${id} is corrupt; it has not been discarded.`, error);
  }
}

async function withRecordLock(filename, operation) {
  const lockKey = process.platform === 'win32' ? filename.toLowerCase() : filename;
  const predecessor = recordQueues.get(lockKey);
  const current = (predecessor || Promise.resolve()).catch(() => {}).then(operation);
  recordQueues.set(lockKey, current);
  try {
    return await current;
  } finally {
    if (recordQueues.get(lockKey) === current) recordQueues.delete(lockKey);
  }
}

async function atomicWrite(filename, record) {
  const directory = path.dirname(filename);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${record.id}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let temporaryCreated = false;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    temporaryCreated = true;
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Never unlink the destination first: a failed replacement must retain the old receipt.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temporary, filename);
        temporaryCreated = false;
        break;
      } catch (error) {
        if (process.platform !== 'win32' || attempt >= 5
          || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    // Directory fsync is supported on POSIX. Windows does not expose it here.
    if (process.platform !== 'win32') {
      const directoryHandle = await fs.open(directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporaryCreated) await fs.unlink(temporary).catch(() => {});
  }
}

/**
 * Durable complete-transcript delivery queue. The caller must verify complete source/audio
 * coverage before enqueueing. This store never infers completeness from the text itself.
 * Each scope identifies one action/period; camera numbers distinguish its receipts.
 * Payloads and delivered receipts are immutable on idempotent retries.
 */
export function createDeliveryOutbox({ directory, now = () => new Date() } = {}) {
  return createOutbox({ directory, now });
}

/** Isolated equivalent for dependency-injected tests; never touches the production queue. */
export function createMemoryDeliveryOutbox({ now = () => new Date() } = {}) {
  return createOutbox({ directory: `memory-outbox-${randomUUID()}`, now, records: new Map() });
}

function createOutbox({ directory, now, records: memoryRecords }) {
  requiredString(directory, 'directory');
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  const root = path.resolve(directory);

  function timestamp() {
    const value = new Date(now());
    if (!Number.isFinite(value.getTime())) throw new TypeError('now returned an invalid date.');
    return value.toISOString();
  }

  function filename(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new TypeError('Invalid outbox record id.');
    return path.join(root, `${id}.json`);
  }

  async function read(id) {
    filename(id);
    if (memoryRecords) {
      const record = memoryRecords.get(id);
      return record ? validateRecord(structuredClone(record), id) : null;
    }
    let contents;
    try {
      contents = await fs.readFile(filename(id), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    let record;
    try { record = JSON.parse(contents); } catch (error) {
      throw failure('OUTBOX_CORRUPT', `Delivery outbox record ${id} is corrupt; it has not been discarded.`, error);
    }
    return validateRecord(record, id);
  }

  async function write(record) {
    if (memoryRecords) {
      memoryRecords.set(record.id, structuredClone(record));
      return;
    }
    await atomicWrite(filename(record.id), record);
  }

  function inputIdentity(input) {
    const scope = requiredString(input?.scope, 'scope');
    const channel = normalizedChannel(input?.channel);
    const actionId = requiredString(input?.actionId, 'actionId');
    const runKey = requiredString(input?.runKey, 'runKey');
    return { id: recordIdentity(scope, channel), scope, channel, actionId, runKey };
  }

  function checkIdentity(record, identity) {
    if (record && (record.actionId !== identity.actionId || record.runKey !== identity.runKey)) {
      throw failure('OUTBOX_SCOPE_CONFLICT', 'An outbox scope already belongs to a different action or period.');
    }
  }

  async function requireRecord(id) {
    const record = await read(id);
    if (!record) throw failure('OUTBOX_NOT_FOUND', `Delivery outbox record ${id} was not found.`);
    return record;
  }

  return {
    async list(scope) {
      if (scope !== undefined) requiredString(scope, 'scope');
      if (memoryRecords) {
        const records = [...memoryRecords.values()]
          .filter(record => scope === undefined || record.scope === scope)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        return structuredClone(records);
      }
      let entries;
      try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const records = [];
      for (const entry of entries) {
        if (!entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -5);
        if (!entry.isFile() || !ID_PATTERN.test(id)) {
          throw failure('OUTBOX_CORRUPT', 'The delivery outbox contains an unexpected JSON entry; it has not been discarded.');
        }
        const record = await read(id);
        if (!record) throw failure('OUTBOX_CORRUPT', `Delivery outbox record ${id} disappeared while listing.`);
        if (scope === undefined || record.scope === scope) records.push(record);
      }
      return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },

    async get(scope, channel) {
      return read(recordIdentity(scope, channel));
    },

    async enqueue(input) {
      const identity = inputIdentity(input);
      const payload = jsonObject(input.payload, 'payload');
      return withRecordLock(filename(identity.id), async () => {
        const existing = await read(identity.id);
        checkIdentity(existing, identity);
        if (existing) return existing;
        const at = timestamp();
        const record = {
          version: 1, ...identity, status: 'pending', payload,
          createdAt: at, updatedAt: at, attempts: 0, lastError: null, nextAttemptAt: at
        };
        await write(record);
        return structuredClone(record);
      });
    },

    async rememberDelivered(input) {
      const identity = inputIdentity(input);
      const upload = jsonObject(input.upload, 'upload');
      return withRecordLock(filename(identity.id), async () => {
        const existing = await read(identity.id);
        checkIdentity(existing, identity);
        if (existing?.status === 'delivered') return existing;
        const at = timestamp();
        const record = {
          ...(existing || { version: 1, ...identity, createdAt: at, attempts: 0 }),
          status: 'delivered', upload, updatedAt: at, deliveredAt: at,
          lastError: null, nextAttemptAt: null
        };
        await write(record);
        return structuredClone(record);
      });
    },

    async markDelivered(id, value) {
      const upload = jsonObject(value, 'upload');
      return withRecordLock(filename(id), async () => {
        const existing = await requireRecord(id);
        if (existing.status === 'delivered') return existing;
        const at = timestamp();
        const record = {
          ...existing, status: 'delivered', upload, updatedAt: at, deliveredAt: at,
          lastError: null, nextAttemptAt: null
        };
        await write(record);
        return structuredClone(record);
      });
    },

    async retryNow(id) {
      return withRecordLock(filename(id), async () => {
        const existing = await requireRecord(id);
        if (existing.status === 'delivered') return existing;
        const at = timestamp();
        const record = { ...existing, updatedAt: at, nextAttemptAt: at };
        await write(record);
        return structuredClone(record);
      });
    },

    async markFailure(id, error) {
      // Accept only a caller-sanitized summary, never persist Error objects/stacks/requests.
      if (typeof error !== 'string') throw new TypeError('error must be a sanitized string.');
      const summary = error.slice(0, 2000);
      return withRecordLock(filename(id), async () => {
        const existing = await requireRecord(id);
        if (existing.status === 'delivered') return existing;
        const at = timestamp();
        const attempts = existing.attempts + 1;
        const delayMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6));
        const record = {
          ...existing, attempts, updatedAt: at, lastError: summary,
          nextAttemptAt: new Date(Date.parse(at) + delayMs).toISOString()
        };
        await write(record);
        return structuredClone(record);
      });
    }
  };
}
