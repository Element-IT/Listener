import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  parseAudioFileTimestamp, formatAudioFileSegments, buildAudioFileTranscript
} from './public/audio-file-utils.js';

export const MAX_AUDIO_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const AUDIO_FILE_EXTENSIONS = new Set([
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.wma',
  '.aif', '.aiff', '.amr', '.3gp', '.mp4', '.webm', '.mka', '.ac3'
]);
const PCM_BYTES_PER_SECOND = 16000 * 2;

function fileError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function validateAudioUpload(params, headers = {}, maxBytes = MAX_AUDIO_FILE_BYTES) {
  const fileName = String(params.get('fileName') || '');
  if (!fileName || fileName.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(fileName)) {
    throw fileError(400, 'Укажите корректное имя аудиофайла без пути к папке.');
  }
  const extension = path.extname(fileName).toLowerCase();
  if (!AUDIO_FILE_EXTENSIONS.has(extension)) {
    throw fileError(415, 'Этот формат не поддерживается. Выберите MP3, WAV, M4A, AAC, OGG, OPUS, FLAC, WMA или другой аудиофайл из списка.');
  }
  const contentLength = headers['content-length'];
  if (contentLength !== undefined && (!/^\d+$/.test(String(contentLength)) || Number(contentLength) === 0)) {
    throw fileError(400, 'Аудиофайл пуст или его размер указан некорректно.');
  }
  if (contentLength !== undefined && Number(contentLength) > maxBytes) {
    throw fileError(413, 'Аудиофайл слишком большой. Максимальный размер — 2 ГБ на файл.');
  }
  return { fileName, extension, startTime: parseAudioFileTimestamp(fileName) };
}

// Uploaded data is written with backpressure, never buffered as one large body.
async function saveUpload(req, filePath, signal, maxBytes) {
  const file = await fs.promises.open(filePath, 'wx');
  let received = 0;
  try {
    for await (const value of req) {
      signal?.throwIfAborted();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      received += chunk.length;
      if (received > maxBytes) throw fileError(413, 'Аудиофайл превышает ограничение 2 ГБ.');
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw fileError(507, 'Не удалось сохранить загруженный аудиофайл.');
        offset += bytesWritten;
      }
    }
    signal?.throwIfAborted();
    if (!received) throw fileError(400, 'Аудиофайл пуст.');
    return received;
  } finally {
    await file.close();
  }
}

export async function* decodeAudioFile(filePath, { ffmpegPath, audioFilter = '', signal, idleTimeoutMs = 120000 } = {}) {
  signal?.throwIfAborted();
  // Restrict input to media containers: uploaded playlists must not fetch URLs
  // or read other local files. A seekable file also supports M4A with trailing moov.
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-protocol_whitelist', 'file,pipe',
    '-format_whitelist', 'wav,mp3,mov,matroska,webm,ogg,flac,aac,asf,aiff,amr,ac3',
    '-i', filePath, '-map', '0:a:0', '-vn', '-sn', '-dn'
  ];
  if (audioFilter) args.push('-af', audioFilter);
  args.push('-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-f', 's16le', 'pipe:1');
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  let failure;
  let completed = false;
  const closed = new Promise(resolve => {
    child.once('error', error => { failure = fileError(503, `Не удалось запустить FFmpeg (${error.code || 'ошибка'}).`); });
    child.once('close', code => {
      completed = true;
      if (code !== 0 && !failure) {
        // Keep uploaded metadata and local paths out of public diagnostics.
        const noAudio = /does not contain any stream|matches no streams|no audio/i.test(stderr);
        failure = fileError(422, noAudio
          ? 'В файле не найдена аудиодорожка.'
          : 'Не удалось декодировать аудиофайл: проверьте формат и целостность записи.');
      }
      resolve();
    });
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
  child.stderr.on('error', () => {});
  const abort = () => { if (!completed) child.kill(); };
  signal?.addEventListener('abort', abort, { once: true });
  const iterator = child.stdout[Symbol.asyncIterator]();
  try {
    if (signal?.aborted) abort();
    while (true) {
      signal?.throwIfAborted();
      let timer;
      const next = await Promise.race([
        iterator.next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            abort();
            reject(fileError(504, 'Превышено время ожидания декодирования аудио.'));
          }, idleTimeoutMs);
        })
      ]).finally(() => clearTimeout(timer));
      signal?.throwIfAborted();
      if (next.done) break;
      yield next.value;
    }
    await closed;
    signal?.throwIfAborted();
    if (failure) throw failure;
  } finally {
    signal?.removeEventListener('abort', abort);
    abort();
    child.stdout.destroy();
    await closed;
  }
}

export async function handleAudioFileTranscription(req, res, params, services) {
  const { config, signal, tempRoot, transcribe, chunkFixedPcm, writePcm16Wav } = services;
  const maxBytes = services.maxBytes || MAX_AUDIO_FILE_BYTES;
  const metadata = validateAudioUpload(params, req.headers, maxBytes);
  const model = config.gigaamModel;
  if (params.get('model') && params.get('model') !== model) {
    throw fileError(409, 'Модель в настройках изменилась. Запустите транскрибацию файлов заново.');
  }
  const timeZone = services.timeZone;
  const chunkSeconds = Math.max(5, Math.min(60, Number(config.transcriptionChunkSeconds) || 20));
  await fs.promises.mkdir(tempRoot, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(tempRoot, 'uploaded-audio-'));
  const inputPath = path.join(directory, `input${metadata.extension}`);
  const wavPath = path.join(directory, 'chunk.wav');
  const segments = [];
  let processedSeconds = 0;
  let heartbeat;
  let decoded;
  const emit = async event => {
    signal?.throwIfAborted();
    if (res.destroyed || res.writableEnded) throw fileError(499, 'Загрузка результата отменена.');
    if (!res.write(`${JSON.stringify(event)}\n`)) await once(res, 'drain', { signal });
  };
  try {
    await saveUpload(req, inputPath, signal, maxBytes);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    await emit({ type: 'start', ...metadata, model, timeZone });
    // Keep a long queued/model-loading request alive without buffering heartbeats.
    heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write('{"type":"heartbeat"}\n');
    }, 15000);
    heartbeat.unref?.();
    await emit({ type: 'progress', stage: 'converting', processedSeconds: 0 });
    decoded = (services.decode || decodeAudioFile)(inputPath, {
      ffmpegPath: config.ffmpegPath, audioFilter: services.audioFilter || '', signal
    });
    for await (const pcm of chunkFixedPcm(decoded, chunkSeconds * PCM_BYTES_PER_SECOND)) {
      signal?.throwIfAborted();
      const durationSeconds = pcm.length / PCM_BYTES_PER_SECOND;
      if (pcm.length % 2) throw fileError(422, 'Декодированная аудиодорожка повреждена.');
      await writePcm16Wav(wavPath, pcm, 16000, 1);
      await emit({ type: 'progress', stage: 'transcribing', processedSeconds });
      const result = await transcribe(config, wavPath, { chunkSeconds, offsetSeconds: processedSeconds, signal });
      signal?.throwIfAborted();
      const endSeconds = processedSeconds + durationSeconds;
      const blockSegments = (Array.isArray(result.segments) ? result.segments : [])
        .filter(segment => segment && String(segment.text || '').trim())
        .map(segment => ({
          start: Math.max(processedSeconds, Math.min(endSeconds, Number(segment.start) || processedSeconds)),
          end: Math.max(processedSeconds, Math.min(endSeconds, Number(segment.end) || endSeconds)),
          text: String(segment.text).trim()
        }))
        .filter(segment => segment.end > segment.start);
      if (!blockSegments.length && String(result.text || '').trim()) {
        blockSegments.push({ start: processedSeconds, end: endSeconds, text: String(result.text).trim() });
      }
      segments.push(...blockSegments);
      processedSeconds = endSeconds;
      await emit({ type: 'block', segments: blockSegments, processedSeconds, txt: formatAudioFileSegments({ fileName: metadata.fileName, segments: blockSegments }) });
    }
    if (!processedSeconds) throw fileError(422, 'В файле нет пригодной для распознавания аудиодорожки.');
    await emit({ type: 'done', ...metadata, model, timeZone, durationSeconds: processedSeconds,
      txt: buildAudioFileTranscript({ fileName: metadata.fileName, model, timeZone, segments, durationSeconds: processedSeconds }) });
    res.end();
  } catch (error) {
    if (!res.headersSent) throw error;
    if (!signal?.aborted && !res.destroyed && !res.writableEnded) {
      await emit({ type: 'error', error: services.publicError ? services.publicError(error) : error.message });
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
    await decoded?.return?.().catch(() => {});
    // Only this request's unique temp directory is ever removed.
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
