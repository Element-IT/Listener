import assert from 'node:assert/strict';
import test from 'node:test';
import {
  convertLocalDateTime,
  formatDateTimeInZone,
  localDateTimeInZone,
  normalizeTimeZone,
  offsetDatePart,
  zonedDatePart,
  zonedDateTimeToEpochMs
} from '../time-zones.mjs';

test('Moscow camera time and Yekaterinburg display time convert in both directions', () => {
  assert.equal(
    convertLocalDateTime('2026-09-21T13:00', 'Asia/Yekaterinburg', 'Europe/Moscow'),
    '2026-09-21T11:00'
  );
  assert.equal(
    convertLocalDateTime('2026-09-21T11:00:42', 'Europe/Moscow', 'Asia/Yekaterinburg'),
    '2026-09-21T13:00:42'
  );
  assert.equal(
    zonedDateTimeToEpochMs('2026-09-21T13:00', 'Asia/Yekaterinburg'),
    Date.parse('2026-09-21T08:00:00Z')
  );
});

test('conversion handles date rollovers without depending on the host timezone', () => {
  assert.equal(
    convertLocalDateTime('2026-09-21T00:30', 'Asia/Yekaterinburg', 'Europe/Moscow'),
    '2026-09-20T22:30'
  );
  assert.equal(
    convertLocalDateTime('2026-12-31T23:30', 'Europe/Moscow', 'Asia/Yekaterinburg'),
    '2027-01-01T01:30'
  );
});

test('DST gaps are rejected and repeated times deterministically use the earlier instant', () => {
  assert.throws(
    () => zonedDateTimeToEpochMs('2026-03-29T02:30', 'Europe/Berlin'),
    /does not exist/
  );
  assert.equal(
    zonedDateTimeToEpochMs('2026-10-25T02:30', 'Europe/Berlin'),
    Date.parse('2026-10-25T00:30:00Z')
  );
});

test('explicit instants are formatted in the requested zone', () => {
  const epoch = Date.parse('2026-09-21T08:00:42Z');
  assert.equal(localDateTimeInZone(epoch, 'Asia/Yekaterinburg'), '2026-09-21T13:00:42');
  assert.equal(localDateTimeInZone(new Date(epoch), 'Europe/Moscow', { seconds: false }), '2026-09-21T11:00');
  assert.equal(zonedDatePart(epoch, 'Asia/Yekaterinburg'), '2026-09-21');
  assert.match(formatDateTimeInZone(epoch, 'Asia/Yekaterinburg'), /21\.09\.2026.*13:00:42/);
});

test('timezone and calendar helpers have safe fallbacks and strict validation', () => {
  assert.equal(normalizeTimeZone(' Asia/Yekaterinburg '), 'Asia/Yekaterinburg');
  assert.equal(normalizeTimeZone('not/a-zone', 'Europe/Moscow'), 'Europe/Moscow');
  assert.equal(normalizeTimeZone(null, 'also-invalid'), 'UTC');
  assert.equal(offsetDatePart('2024-02-28', 1), '2024-02-29');
  assert.equal(offsetDatePart('2024-12-31', 1), '2025-01-01');
  assert.throws(() => zonedDateTimeToEpochMs('2026-02-30T12:00', 'Europe/Moscow'), /Invalid/);
});
