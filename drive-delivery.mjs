// Delivery runs independently of archive acquisition. The outbox is the source
// of truth: a network failure must never erase a completed local transcript.
export function createDriveDeliveryWorker({ outbox, deliver, onDelivered, canDeliver,
  now = () => Date.now(), timeoutMs = 30000 }) {
  if (!outbox || typeof outbox.list !== 'function' || typeof deliver !== 'function') {
    throw new TypeError('A delivery outbox and deliver function are required');
  }
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new TypeError('Delivery timeout must be a positive finite number');
  }
  let running;
  const drain = async () => {
    // Cameras can finish while a previous camera is uploading. Rescan after
    // each batch so a coalesced flush also delivers those newly queued files.
    // Never retry one item twice in this flush, even with a moving test clock.
    const attempted = new Set();
    for (;;) {
      const at = new Date(now()).getTime();
      if (!Number.isFinite(at)) throw new TypeError('Delivery clock returned an invalid date');
      const records = (await outbox.list()).filter(item => item.status === 'pending'
        && !attempted.has(item.id) && Date.parse(item.nextAttemptAt || '') <= at);
      if (!records.length) return;
      for (const item of records) {
        attempted.add(item.id);
        const controller = new AbortController();
        let timer;
        try {
          const result = await Promise.race([
            Promise.resolve().then(async () => {
              const allowed = !canDeliver || await canDeliver(item);
              controller.signal.throwIfAborted();
              if (!allowed) return { skipped: true };
              return { uploaded: await deliver(item, controller.signal) };
            }),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                const error = Object.assign(new Error('Google Drive delivery timed out'), { code: 'DELIVERY_TIMEOUT' });
                reject(error);
                controller.abort(error);
              }, timeoutMs);
            })
          ]);
          if (result.skipped) continue;
          const upload = result.uploaded?.uploads?.find(value => Number(value.channel) === Number(item.channel));
          if (!upload?.fileId || upload.completeness === 'partial' || upload.partial === true || upload.complete === false) {
            throw Object.assign(new Error('Google Drive did not confirm a complete camera file'), { code: 'DELIVERY_INVALID_RECEIPT' });
          }
          await outbox.markDelivered(item.id, { ...upload, completeness: 'complete' });
          await onDelivered?.(item, upload);
        } catch (error) {
          // Store only a safe transport classification, never tokens or HTTP bodies.
          const code = String(error?.code || error?.details?.reason || error?.cause?.code || 'DELIVERY_FAILED');
          await outbox.markFailure(item.id, /^[A-Z0-9_]+$/.test(code) ? code : 'DELIVERY_FAILED');
        } finally {
          clearTimeout(timer);
        }
      }
    }
  };
  return {
    flush() {
      if (!running) running = drain().finally(() => { running = null; });
      return running;
    }
  };
}
