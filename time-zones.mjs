const formatterCache = new Map();

function formatterFor(timeZone, locale = 'en-CA-u-ca-gregory-nu-latn', extra = '') {
  const key = `${locale}\u0000${timeZone}\u0000${extra}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    const options = extra === 'display'
      ? {
          timeZone,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hourCycle: 'h23'
        }
      : {
          timeZone,
          calendar: 'gregory', numberingSystem: 'latn',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hourCycle: 'h23'
        };
    formatter = new Intl.DateTimeFormat(locale, options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

function validTimeZone(value) {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return '';
  }
}

/**
 * Return a canonical IANA time-zone name. Invalid or empty values fall back
 * first to `fallback`, and finally to UTC.
 */
export function normalizeTimeZone(value, fallback = 'UTC') {
  const candidate = typeof value === 'string' ? value.trim() : '';
  const normalized = candidate && validTimeZone(candidate);
  if (normalized) return normalized;
  const fallbackCandidate = typeof fallback === 'string' ? fallback.trim() : '';
  return (fallbackCandidate && validTimeZone(fallbackCandidate)) || 'UTC';
}

function parseLocalDateTime(value) {
  if (typeof value !== 'string') throw new TypeError('Local date-time must be a string');
  const text = value.trim();
  const match = /^(\d{4,6})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(text);
  if (!match) throw new RangeError(`Invalid local date-time: ${value}`);
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] || 0),
    minute: Number(match[5] || 0),
    second: Number(match[6] || 0),
    millisecond: Number((match[7] || '').padEnd(3, '0') || 0),
    hasTime: match[4] !== undefined,
    hasSeconds: match[6] !== undefined
  };
  const epoch = utcFromParts(parts);
  const check = new Date(epoch);
  if (
    parts.year < 1 || parts.year > 9999 ||
    check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month ||
    check.getUTCDate() !== parts.day || check.getUTCHours() !== parts.hour ||
    check.getUTCMinutes() !== parts.minute || check.getUTCSeconds() !== parts.second ||
    check.getUTCMilliseconds() !== parts.millisecond
  ) {
    throw new RangeError(`Invalid local date-time: ${value}`);
  }
  return parts;
}

function utcFromParts(parts) {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond || 0);
  return date.getTime();
}

function zonedParts(epochMs, timeZone) {
  const result = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
  }
  // Some ICU builds can represent midnight as 24:00 even with h23. For the
  // calculations here it is the start of the formatted date, not the next day.
  if (result.hour === 24) result.hour = 0;
  return result;
}

function offsetAtEpochMs(epochMs, timeZone) {
  const rounded = Math.floor(epochMs / 1000) * 1000;
  return utcFromParts({ ...zonedParts(rounded, timeZone), millisecond: 0 }) - rounded;
}

function sameWallTime(epochMs, expected, timeZone) {
  const actual = zonedParts(epochMs, timeZone);
  return actual.year === expected.year && actual.month === expected.month && actual.day === expected.day &&
    actual.hour === expected.hour && actual.minute === expected.minute && actual.second === expected.second &&
    new Date(epochMs).getUTCMilliseconds() === expected.millisecond;
}

function isExplicitInstant(value) {
  return typeof value === 'string' && /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value.trim());
}

function instantEpochMs(value, timeZone) {
  if (value instanceof Date) {
    const epoch = value.getTime();
    if (!Number.isFinite(epoch)) throw new RangeError('Invalid date');
    return epoch;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('Invalid epoch');
    return value;
  }
  if (isExplicitInstant(value)) {
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch)) throw new RangeError(`Invalid date-time: ${value}`);
    return epoch;
  }
  return zonedDateTimeToEpochMs(value, timeZone);
}

/**
 * Interpret a naive date-time as wall-clock time in `timeZone` and return its
 * Unix epoch in milliseconds. Explicit ISO offsets/Z are honored directly.
 * Non-existent wall times during a DST jump are rejected. If a wall time is
 * repeated during a DST rollback, the earlier occurrence is selected.
 */
export function zonedDateTimeToEpochMs(localValue, timeZone) {
  if (localValue instanceof Date || typeof localValue === 'number' || isExplicitInstant(localValue)) {
    return instantEpochMs(localValue, timeZone);
  }
  const zone = normalizeTimeZone(timeZone);
  const parts = parseLocalDateTime(localValue);
  const wallEpoch = utcFromParts(parts);
  const sampleDistance = 36 * 60 * 60 * 1000;
  const offsets = new Set([
    offsetAtEpochMs(wallEpoch - sampleDistance, zone),
    offsetAtEpochMs(wallEpoch - 12 * 60 * 60 * 1000, zone),
    offsetAtEpochMs(wallEpoch, zone),
    offsetAtEpochMs(wallEpoch + 12 * 60 * 60 * 1000, zone),
    offsetAtEpochMs(wallEpoch + sampleDistance, zone)
  ]);
  const candidates = [];
  for (const offset of offsets) {
    const candidate = wallEpoch - offset;
    if (sameWallTime(candidate, parts, zone)) candidates.push(candidate);
  }
  if (!candidates.length) {
    throw new RangeError(`Local date-time does not exist in ${zone}: ${localValue}`);
  }
  return Math.min(...candidates);
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/** Format an instant as an HTML datetime-local compatible value. */
export function localDateTimeInZone(epochOrDate, timeZone, { seconds = true } = {}) {
  const zone = normalizeTimeZone(timeZone);
  const epoch = instantEpochMs(epochOrDate, zone);
  const parts = zonedParts(epoch, zone);
  const date = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
  const time = `${pad(parts.hour)}:${pad(parts.minute)}`;
  return seconds ? `${date}T${time}:${pad(parts.second)}` : `${date}T${time}`;
}

/** Convert a naive wall-clock value from one IANA time zone to another. */
export function convertLocalDateTime(localValue, fromZone, toZone) {
  const parsed = typeof localValue === 'string' && !isExplicitInstant(localValue)
    ? parseLocalDateTime(localValue)
    : null;
  const epoch = zonedDateTimeToEpochMs(localValue, normalizeTimeZone(fromZone));
  return localDateTimeInZone(epoch, normalizeTimeZone(toZone), { seconds: parsed?.hasSeconds ?? true });
}

/** Format an instant (or a naive value in the target zone) for display. */
export function formatDateTimeInZone(value, timeZone, locale = 'ru-RU') {
  const zone = normalizeTimeZone(timeZone);
  const epoch = instantEpochMs(value, zone);
  return formatterFor(zone, locale, 'display').format(new Date(epoch));
}

/** Return YYYY-MM-DD for an instant in the requested time zone. */
export function zonedDatePart(now, timeZone) {
  return localDateTimeInZone(now, timeZone, { seconds: false }).slice(0, 10);
}

/** Move a calendar date by an integer number of days without using host TZ. */
export function offsetDatePart(datePart, days) {
  const parsed = parseLocalDateTime(datePart);
  if (parsed.hasTime) throw new RangeError(`Expected YYYY-MM-DD, received: ${datePart}`);
  if (!Number.isInteger(days)) throw new TypeError('Day offset must be an integer');
  const date = new Date(utcFromParts(parsed) + days * 24 * 60 * 60 * 1000);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
