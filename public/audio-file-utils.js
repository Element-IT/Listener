const WALL_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

// UTC arithmetic is used only as a timezone-independent calendar calculator.
// Filename timestamps are local wall-clock values, not UTC instants.
function wallTimeDate(parts) {
  const [year, month, day, hour, minute, second] = parts.map(Number);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 ||
      hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function parseWallTime(value) {
  const match = typeof value === "string" ? value.match(WALL_TIME_PATTERN) : null;
  return match ? wallTimeDate(match.slice(1)) : null;
}

function safeSeconds(value) {
  return typeof value === "number" && Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER ? Math.max(0, value) : null;
}

function formatRelative(seconds) {
  const whole = Math.floor(seconds);
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}`;
}

function textValue(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function parseAudioFileTimestamp(fileName) {
  if (typeof fileName !== "string") return null;
  const basename = fileName.split(/[\\/]/).at(-1);
  const match = basename.match(/-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:\.[^.]+)?$/);
  if (!match || !wallTimeDate(match.slice(1))) return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

export function formatAudioFileTimestamp(startTime, offsetSeconds = 0) {
  const seconds = safeSeconds(offsetSeconds) ?? 0;
  const start = parseWallTime(startTime);
  if (!start) return formatRelative(seconds);
  const date = new Date(start.getTime() + Math.floor(seconds) * 1000);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    return formatRelative(seconds);
  }
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCFullYear(), 4)} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function normalizedSegments(segments, durationSeconds) {
  const duration = safeSeconds(durationSeconds);
  return (Array.isArray(segments) ? segments : []).flatMap((segment) => {
    if (!segment || typeof segment !== "object") return [];
    let start = safeSeconds(segment.start);
    let end = safeSeconds(segment.end);
    const text = textValue(segment.text);
    if (start === null || end === null || end < start || !text) return [];
    if (duration !== null) {
      if (start > duration) return [];
      start = Math.min(start, duration);
      end = Math.min(end, duration);
    }
    return [{ start, end, text }];
  });
}

export function formatAudioFileSegments({ fileName, segments } = {}) {
  const startTime = parseAudioFileTimestamp(fileName);
  return normalizedSegments(segments).map(({ start, end, text }) =>
    `[${formatAudioFileTimestamp(startTime, start)} — ${formatAudioFileTimestamp(startTime, end)}] ${text}`
  ).join("\n");
}

export function buildAudioFileTranscript({ fileName, model, segments, durationSeconds, timeZone } = {}) {
  const startTime = parseAudioFileTimestamp(fileName);
  const duration = safeSeconds(durationSeconds);
  const lines = [
    `Файл: ${textValue(fileName) || "Без названия"}`,
    `Модель: ${textValue(model) || "Не указана"}`,
    `Часовой пояс: ${textValue(timeZone) || "Локальное время из имени файла"}`,
    startTime
      ? `Начало записи: ${formatAudioFileTimestamp(startTime, 0)} (из имени файла)`
      : "Начало записи: дата и время не найдены в имени файла; тайминги указаны относительно начала файла."
  ];
  if (duration !== null) lines.push(`Длительность: ${formatRelative(duration)}`);
  const formatted = formatAudioFileSegments({
    fileName,
    segments: normalizedSegments(segments, durationSeconds)
  });
  lines.push("", formatted || "Речь не распознана.");
  return `${lines.join("\n")}\n`;
}

export function combineAudioFileTranscripts(results) {
  if (!Array.isArray(results) || results.length === 0) return "";
  return results.map((result) => {
    const fileName = textValue(result?.fileName) || "Без названия";
    const txt = typeof result?.txt === "string" ? result.txt.trim() : "";
    const error = textValue(typeof result?.error === "string" ? result.error : result?.error?.message);
    if (txt) return error
      ? `${txt}\n\nВнимание: транскрибация файла выполнена не полностью.\nОшибка: ${error}`
      : txt;
    return `Файл: ${fileName}\nТранскрибация не выполнена.\nОшибка: ${error || "Результат обработки отсутствует."}`;
  }).join("\n\n----------------------------------------\n\n") + "\n";
}
