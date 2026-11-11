import test from 'node:test';
import assert from 'node:assert/strict';
import { assessIntervalCoverage, isTranscriptCachePayloadComplete } from '../transcript-coverage.mjs';

const base = Date.parse('2026-10-13T02:30:00.000Z');
const at = seconds => new Date(base + seconds * 1000).toISOString();
const interval = (from, to) => ({ from: at(from), to: at(to) });

test('an empty recording search does not cover a requested ten-hour day', () => {
  const result = assessIntervalCoverage({ ...interval(0, 36000), intervals: [] });
  assert.deepEqual(result, {
    complete: false, requestedSeconds: 36000, coveredSeconds: 0, missingSeconds: 36000,
    gaps: [{ ...interval(0, 36000), durationSeconds: 36000 }]
  });
});

test('coverage clips, sorts and unions overlapping intervals across explicit time zones', () => {
  const result = assessIntervalCoverage({
    from: '2026-10-13T07:30:00+05:00', to: at(100),
    intervals: [interval(60, 120), interval(10, 70), interval(-10, 30), interval(1000, 1100)]
  });
  assert.deepEqual(result, {
    complete: true, requestedSeconds: 100, coveredSeconds: 100, missingSeconds: 0, gaps: []
  });
});

test('leading, middle and trailing gaps remain explicit without counting overlaps twice', () => {
  const result = assessIntervalCoverage({
    ...interval(0, 100), intervals: [interval(50, 60), interval(10, 30), interval(20, 40)]
  });
  assert.equal(result.complete, false);
  assert.equal(result.coveredSeconds, 40);
  assert.equal(result.missingSeconds, 60);
  assert.deepEqual(result.gaps, [
    { ...interval(0, 10), durationSeconds: 10 },
    { ...interval(40, 50), durationSeconds: 10 },
    { ...interval(60, 100), durationSeconds: 40 }
  ]);
});

test('processed silence counts as covered without requiring speech segments', () => {
  const result = assessIntervalCoverage({
    ...interval(0, 60), intervals: [{ ...interval(0, 60), text: '', segments: [] }]
  });
  assert.equal(result.complete, true);
  assert.equal(result.coveredSeconds, 60);
});

test('a tolerable tail is still reported exactly, and zero tolerance is supported', () => {
  const options = { ...interval(0, 18), intervals: [interval(0, 17.25)] };
  const result = assessIntervalCoverage(options);
  assert.equal(result.complete, true);
  assert.equal(result.missingSeconds, 0.75);
  assert.deepEqual(result.gaps, [{ ...interval(17.25, 18), durationSeconds: 0.75 }]);
  assert.equal(assessIntervalCoverage({ ...options, toleranceSeconds: 0 }).complete, false);
});

test('small individual gaps cannot consume the tolerance repeatedly', () => {
  const result = assessIntervalCoverage({
    ...interval(0, 60), intervals: [interval(0, 19.25), interval(20, 39.25), interval(40, 60)]
  });
  assert.equal(result.complete, false);
  assert.equal(result.missingSeconds, 1.5);
  assert.equal(result.gaps.length, 2);
  assert.equal(assessIntervalCoverage({
    ...interval(0, 0.5), intervals: [interval(0, 0.32)]
  }).complete, false);
});

test('invalid and ambiguous times and invalid durations are rejected', () => {
  for (const invalid of ['2026-10-13T02:30:00', '2026-02-30T02:30:00Z', '2026-10-13T24:00:00Z', '2026-10-13T02:30:00+25:00', '', null]) {
    assert.throws(() => assessIntervalCoverage({ from: invalid, to: at(60), intervals: [] }));
    assert.throws(() => assessIntervalCoverage({ ...interval(0, 60), intervals: [{ from: invalid, to: at(60) }] }));
  }
  for (const badInterval of [interval(10, 10), interval(20, 10)]) {
    assert.throws(() => assessIntervalCoverage({ ...interval(0, 60), intervals: [badInterval] }), RangeError);
  }
  assert.throws(() => assessIntervalCoverage({ ...interval(0, 0), intervals: [] }), RangeError);
  assert.throws(() => assessIntervalCoverage({ ...interval(0, 60), intervals: null }), TypeError);
  assert.throws(() => assessIntervalCoverage({ ...interval(0, 60), intervals: [], toleranceSeconds: -1 }), RangeError);
});

test('cache completion uses decoded duration, accepting silence and only a bounded short tail', () => {
  assert.equal(isTranscriptCachePayloadComplete({ ok: true, durationSeconds: 18, text: '', segments: [] }, 18), true);
  assert.equal(isTranscriptCachePayloadComplete({ durationSeconds: 17.2 }, 18), true);
  assert.equal(isTranscriptCachePayloadComplete({ durationSeconds: 17.2 }, 18, { toleranceSeconds: 0 }), false);
  assert.equal(isTranscriptCachePayloadComplete({ durationSeconds: 0.32, text: 'partial words' }, 18), false);
  assert.equal(isTranscriptCachePayloadComplete({ durationSeconds: 0.32 }, 0.5), false);
  assert.equal(isTranscriptCachePayloadComplete({ durationSeconds: 20 }, 18), false);
});

test('cache completion rejects missing duration, invalid values and explicit incomplete markers', () => {
  for (const payload of [null, {}, { durationSeconds: 0 }, { durationSeconds: NaN }, { durationSeconds: Infinity }, { durationSeconds: '18' }]) {
    assert.equal(isTranscriptCachePayloadComplete(payload, 18), false);
  }
  for (const flag of [{ ok: false }, { error: 'download failed' }, { partial: true }, { complete: false }, { coverage: { complete: false } }, { status: 'incomplete' }]) {
    assert.equal(isTranscriptCachePayloadComplete({ durationSeconds: 18, ...flag }, 18), false);
  }
  assert.equal(isTranscriptCachePayloadComplete({ durationSeconds: 18 }, 0), false);
  assert.equal(isTranscriptCachePayloadComplete({ durationSeconds: 18 }, 18, { toleranceSeconds: Infinity }), false);
});
