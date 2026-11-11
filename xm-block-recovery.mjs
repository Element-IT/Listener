// Bounded recovery is a new capture, not a byte-identical continuation of a
// stateful voice filter. Its cache identity must include this capture anchor.
export const XM_RECOVERY_PIPELINE = 'xm-targeted-pcm-v2';
export const XM_RECOVERY_WARMUP_SECONDS = 10;

// Once any part has been cached, never replay its source just because more
// than a few holes remain. The fresh, wholly uncached case can still stream.
export async function shouldRecoverXmRecordingFromCache(blocks, startIndex, hasIncompleteCache, readComplete) {
  if (startIndex > 0 || hasIncompleteCache) return true;
  for (let index = startIndex; index < blocks.length; index += 1) {
    if (await readComplete(blocks[index])) return true;
  }
  return false;
}
const PCM_BYTES_PER_SECOND = 32000;
const RAW_BYTES_PER_SECOND = 8000;
// The 8 -> 16 kHz conversion / voice filter can drain about 25 ms short.
// This allowance does not excuse missing G.711 source bytes.
const DECODER_DRAIN_SECONDS = 0.05;

export function xmRecoveryPlans(block, coverageAnchor) {
  const offset = Number(block.offsetSeconds);
  const duration = Number(block.durationSeconds);
  const anchor = Number(coverageAnchor);
  if (![offset, duration, anchor].every(Number.isFinite) || duration <= 0
    || duration > 60 || anchor < 0 || offset < anchor) {
    throw new RangeError('Invalid bounded XM recovery range.');
  }
  // XM's seek parameter has whole-second precision. Include that rounding in
  // the discarded PCM rather than labelling earlier samples as the requested time.
  const warmAnchor = Math.floor(Math.max(anchor, offset - XM_RECOVERY_WARMUP_SECONDS));
  return [...new Set([warmAnchor, Math.floor(offset)])].map(captureOffsetSeconds => ({
    pipeline: XM_RECOVERY_PIPELINE,
    captureOffsetSeconds,
    captureDurationSeconds: offset + duration - captureOffsetSeconds,
    discardSeconds: offset - captureOffsetSeconds,
    durationSeconds: duration
  }));
}

function incomplete(plan, stats, receivedSeconds) {
  return Object.assign(new Error('Адресный запрос вернул неполное аудио; отсутствие звука в исходной записи не подтверждено.'), {
    statusCode: 502,
    details: {
      code: 'INCOMPLETE_AUDIO', sourceGapConfirmed: false,
      expectedDurationSeconds: plan.durationSeconds,
      receivedDurationSeconds: Math.max(0, receivedSeconds),
      captureStats: stats,
      captureOffsetSeconds: plan.captureOffsetSeconds,
      discardSeconds: plan.discardSeconds
    }
  });
}

export async function readXmRecoveryPcm(plan, openSession, signal) {
  if (![plan?.captureOffsetSeconds, plan?.captureDurationSeconds, plan?.discardSeconds, plan?.durationSeconds].every(Number.isFinite)
    || plan.captureOffsetSeconds < 0 || !Number.isInteger(plan.captureOffsetSeconds)
    || plan.durationSeconds <= 0 || plan.durationSeconds > 60
    || plan.discardSeconds < 0 || plan.discardSeconds >= 11
    || plan.captureDurationSeconds > 71
    || Math.abs(plan.captureDurationSeconds - plan.discardSeconds - plan.durationSeconds) > 1e-6) {
    throw new RangeError('Invalid bounded XM recovery capture.');
  }
  signal?.throwIfAborted();
  const session = await openSession({
    offsetSeconds: plan.captureOffsetSeconds,
    durationSeconds: plan.captureDurationSeconds,
    signal
  });
  // Attach immediately and drain independently of ASR. At most 71 s / 2.28 MB.
  const maxBytes = Math.ceil((plan.captureDurationSeconds + 0.1) * PCM_BYTES_PER_SECOND);
  const pieces = [];
  let length = 0;
  try {
    for await (const chunk of session.readable) {
      signal?.throwIfAborted();
      length += chunk.length;
      if (length > maxBytes) throw Object.assign(new Error('XM recovery exceeded its requested audio range.'), { statusCode: 502 });
      pieces.push(chunk);
    }
    const stats = await session.done;
    signal?.throwIfAborted();
    const receivedSeconds = length / PCM_BYTES_PER_SECOND - plan.discardSeconds;
    const expectedRawBytes = Math.ceil(plan.captureDurationSeconds * RAW_BYTES_PER_SECOND);
    if (!Number.isFinite(stats?.rawBytes) || stats.rawBytes < expectedRawBytes
      || stats.partial === true
      || receivedSeconds + Math.min(DECODER_DRAIN_SECONDS, plan.durationSeconds * 0.1) < plan.durationSeconds) {
      throw incomplete(plan, stats, receivedSeconds);
    }
    const all = Buffer.concat(pieces, length);
    const skipBytes = Math.round(plan.discardSeconds * PCM_BYTES_PER_SECOND / 2) * 2;
    const end = Math.min(all.length, skipBytes + Math.round(plan.durationSeconds * PCM_BYTES_PER_SECOND / 2) * 2);
    const pcm = all.subarray(skipBytes, end);
    if (!pcm.length || pcm.length % 2) throw incomplete(plan, stats, receivedSeconds);
    return { pcm, stats, durationSeconds: pcm.length / PCM_BYTES_PER_SECOND };
  } finally {
    await session.close().catch(() => {});
  }
}
