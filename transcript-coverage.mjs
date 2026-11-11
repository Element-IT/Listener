function instantMs(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be an ISO timestamp with an explicit time zone.`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
  if (!match) throw new RangeError(`${name} must be an ISO timestamp with an explicit time zone.`);
  const [, year, month, day, hour, minute, second = '0', fraction = '', zone, sign, offsetHour = '0', offsetMinute = '0'] = match;
  const wall = new Date(0);
  wall.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  wall.setUTCHours(Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, '0')));
  if (Number(year) < 1 || wall.getUTCFullYear() !== Number(year)
    || wall.getUTCMonth() !== Number(month) - 1 || wall.getUTCDate() !== Number(day)
    || wall.getUTCHours() !== Number(hour) || wall.getUTCMinutes() !== Number(minute)
    || wall.getUTCSeconds() !== Number(second)
    || Number(offsetHour) > 23 || Number(offsetMinute) > 59) {
    throw new RangeError(`${name} is not a valid ISO timestamp.`);
  }
  const offsetMs = zone.toUpperCase() === 'Z' ? 0
    : (Number(offsetHour) * 60 + Number(offsetMinute)) * 60000 * (sign === '+' ? 1 : -1);
  return wall.getTime() - offsetMs;
}

function toleranceFor(requestedSeconds, toleranceSeconds) {
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new RangeError('toleranceSeconds must be a finite nonnegative number.');
  }
  // A one-second allowance cannot make a mostly missing short clip complete.
  return Math.min(toleranceSeconds, requestedSeconds * 0.1);
}

/**
 * Measure actual processed-audio coverage, independently of recognized speech.
 * Input intervals must use explicit-zone timestamps. Invalid intervals throw
 * instead of being silently discarded and making coverage appear complete.
 * The allowance applies to the sum of all gaps; exact gaps remain in the result.
 */
export function assessIntervalCoverage({ from, to, intervals, toleranceSeconds = 1 } = {}) {
  const rangeStart = instantMs(from, 'from');
  const rangeEnd = instantMs(to, 'to');
  if (rangeEnd <= rangeStart) throw new RangeError('The requested interval must have positive duration.');
  if (!Array.isArray(intervals)) throw new TypeError('intervals must be an array.');
  const requestedSeconds = (rangeEnd - rangeStart) / 1000;
  const tolerance = toleranceFor(requestedSeconds, toleranceSeconds);
  const clipped = [];
  for (const interval of intervals) {
    const start = instantMs(interval?.from, 'interval.from');
    const end = instantMs(interval?.to, 'interval.to');
    if (end <= start) throw new RangeError('A coverage interval must have positive duration.');
    const clippedStart = Math.max(rangeStart, start);
    const clippedEnd = Math.min(rangeEnd, end);
    if (clippedEnd > clippedStart) clipped.push([clippedStart, clippedEnd]);
  }
  clipped.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const gaps = [];
  let cursor = rangeStart;
  const addGap = (start, end) => gaps.push({
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    durationSeconds: (end - start) / 1000
  });
  for (const [start, end] of clipped) {
    if (start > cursor) addGap(cursor, start);
    cursor = Math.max(cursor, end);
  }
  if (cursor < rangeEnd) addGap(cursor, rangeEnd);
  const missingSeconds = gaps.reduce((sum, gap) => sum + gap.durationSeconds, 0);
  return {
    complete: missingSeconds <= tolerance + 1e-9,
    requestedSeconds,
    coveredSeconds: requestedSeconds - missingSeconds,
    missingSeconds,
    gaps
  };
}

/**
 * Check whether one cache payload covers its requested block. Text can be empty
 * after valid silence; a missing/short duration or explicit partial marker is not
 * proof of completion. This does not establish source or model provenance.
 */
export function isTranscriptCachePayloadComplete(payload, requestedSeconds, { toleranceSeconds = 1 } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.ok === false || payload.error || payload.partial === true
    || payload.complete === false || payload.coverage?.complete === false
    || ['partial', 'incomplete', 'error'].includes(payload.status)) return false;
  const duration = payload.durationSeconds;
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0
    || !Number.isFinite(duration) || duration <= 0
    || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) return false;
  if (duration > requestedSeconds + 1e-9) return false;
  return requestedSeconds - duration <= toleranceFor(requestedSeconds, toleranceSeconds) + 1e-9;
}
