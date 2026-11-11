import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAudioFileTimestamp,
  formatAudioFileTimestamp,
  formatAudioFileSegments,
  buildAudioFileTranscript,
  combineAudioFileTranscripts
} from "../public/audio-file-utils.js";

test("audio filenames expose the final date and time without a timezone shift", () => {
  for (const suffix of ["", ".mp3", ".WAV", ".m4a", ".ogg"]) {
    assert.equal(parseAudioFileTimestamp(`1-recording-20261009-142239${suffix}`), "2026-10-09T14:22:39");
  }
  assert.equal(parseAudioFileTimestamp("C:\\recordings\\2-20240229-235959.flac"), "2024-02-29T23:59:59");
  assert.equal(parseAudioFileTimestamp("prefix-20000229-000000.wav"), "2000-02-29T00:00:00");
});

test("audio filename timestamps reject invalid dates, times and nonfinal matches", () => {
  for (const fileName of [
    "recording.mp3", "20261009-142239.wav", "1-20260229-142239.wav",
    "1-19000229-142239.wav", "1-20261301-142239.wav", "1-20260431-142239.wav",
    "1-20260001-142239.wav", "1-20261000-142239.wav", "1-00001009-142239.wav",
    "1-20261009-242239.wav", "1-20261009-146039.wav", "1-20261009-142260.wav",
    "1-20261009-142239-copy.wav", "1-20261009-142239.wav.bak", "1-20261009-142239.", "", null
  ]) assert.equal(parseAudioFileTimestamp(fileName), null, String(fileName));
});

test("absolute segment times carry across midnight, leap days and years", () => {
  assert.equal(formatAudioFileTimestamp("2026-10-09T23:59:50", 20), "10.10.2026 00:00:10");
  assert.equal(formatAudioFileTimestamp("2024-02-28T23:59:59", 86402), "01.03.2024 00:00:01");
  assert.equal(formatAudioFileTimestamp("2026-12-31T23:59:59", 1), "01.01.2027 00:00:00");
  assert.equal(formatAudioFileTimestamp("2026-10-09T14:22:39", 1.99), "09.10.2026 14:22:40");
});

test("unknown timestamps use relative hours including durations longer than a day", () => {
  assert.equal(formatAudioFileTimestamp(null, 90061), "25:01:01");
  assert.equal(formatAudioFileTimestamp("2026-02-30T01:00:00", 30), "00:00:30");
  assert.equal(formatAudioFileTimestamp(null, -20), "00:00:00");
  assert.equal(formatAudioFileTimestamp(null, Infinity), "00:00:00");
  assert.equal(formatAudioFileTimestamp(null, NaN), "00:00:00");
});

test("streamed lines preserve each segment offset and normalize invalid values", () => {
  const text = formatAudioFileSegments({ fileName: "1-recording-20261009-142239.mp3", segments: [
    { start: 60, end: 80, text: "  Первый\nфрагмент  " },
    { start: 120, end: 121, text: "Второй" },
    { start: -5, end: 2, text: "Начало" },
    { start: NaN, end: 10, text: "Не использовать" },
    { start: 0, end: Infinity, text: "Не использовать" },
    { start: 10, end: 2, text: "Не использовать" },
    { start: null, end: 2, text: "Не использовать" },
    { start: 0, end: 2, text: "  " }, null
  ] });
  assert.equal(text, [
    "[09.10.2026 14:23:39 — 09.10.2026 14:23:59] Первый фрагмент",
    "[09.10.2026 14:24:39 — 09.10.2026 14:24:40] Второй",
    "[09.10.2026 14:22:39 — 09.10.2026 14:22:41] Начало"
  ].join("\n"));
});

test("TXT includes provenance, respects clip duration and reports silence", () => {
  const txt = buildAudioFileTranscript({ fileName: "1-recording-20261009-142239.wav", model: "gigaam-v3", timeZone: "Asia/Yekaterinburg", durationSeconds: 20, segments: [
    { start: 0, end: 40, text: "Текст" },
    { start: 30, end: 40, text: "За пределами записи" }
  ] });
  assert.match(txt, /Файл: 1-recording-20261009-142239.wav/);
  assert.match(txt, /Модель: gigaam-v3/);
  assert.match(txt, /Часовой пояс: Asia\/Yekaterinburg/);
  assert.match(txt, /Начало записи: 09\.10\.2026 14:22:39/);
  assert.match(txt, /\[09\.10\.2026 14:22:39 — 09\.10\.2026 14:22:59\] Текст/);
  assert.doesNotMatch(txt, /За пределами/);
  const relative = buildAudioFileTranscript({ fileName: "voice.ogg", segments: [{ start: 5, end: 10, text: "Привет" }] });
  assert.match(relative, /относительно начала файла/);
  assert.match(relative, /\[00:00:05 — 00:00:10\] Привет/);
  assert.match(buildAudioFileTranscript({ fileName: "silence.mp3", segments: [] }), /Речь не распознана/);
});

test("combined TXT keeps file order and explicit partial or failed results", () => {
  const first = buildAudioFileTranscript({ fileName: "one-20261009-235950.mp3", segments: [{ start: 15, end: 20, text: "Один" }] });
  const second = buildAudioFileTranscript({ fileName: "two-20261010-080000.mp3", segments: [{ start: 5, end: 10, text: "Два" }] });
  const txt = combineAudioFileTranscripts([
    { fileName: "one-20261009-235950.mp3", txt: first },
    { fileName: "broken.wav", error: "Формат не поддерживается" },
    { fileName: "two-20261010-080000.mp3", txt: second, error: new Error("Прервано") }
  ]);
  assert.ok(txt.indexOf("one-") < txt.indexOf("broken.wav"));
  assert.ok(txt.indexOf("broken.wav") < txt.indexOf("two-"));
  assert.match(txt, /10\.10\.2026 00:00:05/);
  assert.match(txt, /10\.10\.2026 08:00:05/);
  assert.match(txt, /Файл: broken.wav\nТранскрибация не выполнена\.\nОшибка: Формат не поддерживается/);
  assert.match(txt, /выполнена не полностью\.\nОшибка: Прервано/);
  assert.equal(combineAudioFileTranscripts([]), "");
});
