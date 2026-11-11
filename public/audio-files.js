import {
  parseAudioFileTimestamp,
  formatAudioFileTimestamp,
  buildAudioFileTranscript,
  combineAudioFileTranscripts
} from './audio-file-utils.js';

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wma', 'aif', 'aiff', 'amr', '3gp', 'mp4', 'webm', 'mka', 'ac3']);
const MAX_AUDIO_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const FILE_STATUS = { pending: 'Ожидает', running: 'Обрабатывается', done: 'Готово', error: 'Ошибка', stopped: 'Остановлено', skipped: 'Не обработан' };

export function initAudioFilesTab({ getSettings, getModel }) {
  const ui = Object.fromEntries([
    'Input', 'DropZone', 'List', 'StartButton', 'StopButton', 'ClearButton', 'Download',
    'Status', 'Model', 'TimeZone', 'Error', 'ProgressPanel', 'ProgressLabel', 'ProgressCount',
    'Progress', 'Transcript', 'TranscriptStatus'
  ].map(name => [name, document.querySelector(`#audioFiles${name}`)]));
  let entries = [];
  let running = false;
  let controller = null;
  let downloadUrl = null;
  let batchSettings = null;
  let batchModel = null;
  let sequence = 0;

  function refreshSettings() {
    const settings = running ? batchSettings : getSettings();
    const state = running ? batchModel : getModel();
    const modelName = state?.models?.find(item => item.id === state.model)?.name || state?.model || 'загрузка…';
    ui.Model.textContent = `Модель ${running ? 'этого запуска' : 'из настроек'}: ${modelName}`;
    ui.TimeZone.textContent = `Время в названии файла считается местным (${settings?.timeZone || 'часовой пояс из настроек'}), без сдвига относительно камер.`;
  }

  function showError(message = '') {
    ui.Error.textContent = message;
    ui.Error.hidden = !message;
  }

  function updateControls() {
    ui.Input.disabled = running;
    ui.StartButton.disabled = running || !entries.length;
    ui.StopButton.disabled = !running;
    ui.ClearButton.disabled = running || !entries.length;
    ui.DropZone.classList.toggle('is-busy', running);
    renderList();
  }

  function renderList() {
    ui.List.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('li');
      row.className = 'audio-file-item';
      const body = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = entry.file.name;
      const meta = document.createElement('span');
      meta.className = 'muted-line';
      const start = parseAudioFileTimestamp(entry.file.name);
      meta.textContent = `${fileSize(entry.file.size)} · ${start ? formatAudioFileTimestamp(start, 0) : 'Относительные тайминги от 00:00:00'}`;
      body.append(title, meta);
      const status = document.createElement('span');
      status.className = `audio-file-status ${entry.status}`;
      status.textContent = FILE_STATUS[entry.status];
      row.append(body, status);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary audio-file-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Убрать ${entry.file.name}`);
      remove.disabled = running;
      remove.addEventListener('click', () => {
        entries = entries.filter(item => item.id !== entry.id);
        updateDownload(entries.some(item => item.status !== 'done'));
        updateControls();
        if (!entries.length) ui.Status.textContent = 'Выберите файлы';
      });
      row.append(remove);
      ui.List.append(row);
    }
  }

  function addFiles(files) {
    if (running) return;
    const rejected = [];
    for (const file of files) {
      const extension = file.name.split('.').pop().toLowerCase();
      if (!AUDIO_EXTENSIONS.has(extension)) {
        rejected.push(`${file.name}: неподдерживаемый формат`);
        continue;
      }
      if (file.size === 0) {
        rejected.push(`${file.name}: файл пуст`);
        continue;
      }
      if (file.size > MAX_AUDIO_FILE_BYTES) {
        rejected.push(`${file.name}: размер превышает 2 ГБ`);
        continue;
      }
      if (entries.some(entry => entry.file.name === file.name && entry.file.size === file.size && entry.file.lastModified === file.lastModified)) continue;
      entries.push({ id: sequence++, file, status: 'pending', result: null });
    }
    entries.sort((left, right) => {
      const a = parseAudioFileTimestamp(left.file.name);
      const b = parseAudioFileTimestamp(right.file.name);
      if (a && b) return a.localeCompare(b) || left.id - right.id;
      if (a || b) return a ? -1 : 1;
      return left.id - right.id;
    });
    showError(rejected.length ? `Не добавлены файлы: ${rejected.join('; ')}` : '');
    ui.Status.textContent = entries.length ? `Выбрано файлов: ${entries.length}` : 'Выберите файлы';
    updateControls();
    refreshSettings();
  }

  function clearDownload() {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    ui.Download.removeAttribute('href');
    ui.Download.hidden = true;
  }

  function updateDownload(partial = true) {
    const results = entries.map(entry => entry.result).filter(Boolean);
    if (!results.length) {
      clearDownload();
      return;
    }
    const text = combineAudioFileTranscripts(results);
    if (!text) return;
    clearDownload();
    downloadUrl = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' }));
    ui.Download.href = downloadUrl;
    ui.Download.download = `Транскрипция${partial ? '-неполная' : ''}.txt`;
    ui.Download.textContent = partial ? 'Скачать TXT (неполный)' : 'Скачать единый TXT';
    ui.Download.hidden = false;
  }

  function changeTranscript(update) {
    const target = ui.Transcript;
    const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight <= 4;
    update();
    if (atBottom) target.scrollTop = target.scrollHeight;
  }

  function createFilePreview(entry) {
    const section = document.createElement('section');
    section.className = 'audio-file-preview';
    const heading = document.createElement('strong');
    heading.textContent = entry.file.name;
    const text = document.createElement('pre');
    const notice = document.createElement('p');
    notice.className = 'audio-file-preview-notice';
    section.append(heading, text, notice);
    changeTranscript(() => {
      if (ui.Transcript.classList.contains('is-empty')) {
        ui.Transcript.replaceChildren();
        ui.Transcript.classList.remove('is-empty');
      }
      ui.Transcript.append(section);
    });
    return { text, notice };
  }

  async function transcribeFile(entry, index, signal) {
    entry.status = 'running';
    renderList();
    const preview = createFilePreview(entry);
    let segments = [];
    let durationSeconds = 0;
    let finished = false;
    const label = `Файл ${index + 1}/${entries.length}: ${entry.file.name}`;
    const setProgress = text => { ui.ProgressLabel.textContent = `${label} · ${text}`; };
    setProgress('Загрузка файла');
    try {
      const query = new URLSearchParams({
        fileName: entry.file.name,
        audioFilter: batchSettings.audioFilter || 'voice',
        model: batchModel.model,
        timeZone: batchSettings.timeZone
      });
      const response = await fetch(`/api/audio-files/transcript?${query}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: entry.file, signal
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `Ошибка HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('Браузер не получил поток транскрипции.');
      await readEvents(response.body, message => {
        if (message.type === 'error') throw new Error(message.error || 'Не удалось обработать файл.');
        if (message.type === 'start') {
          setProgress('Подготовка аудио');
        } else if (message.type === 'progress') {
          const time = secondsLabel(message.processedSeconds || 0);
          setProgress(message.stage === 'converting' ? 'Преобразование аудио' : `Транскрибация · ${time}`);
        } else if (message.type === 'block') {
          segments.push(...(Array.isArray(message.segments) ? message.segments : []));
          durationSeconds = Math.max(durationSeconds, Number(message.processedSeconds) || 0);
          if (message.txt) changeTranscript(() => { preview.text.append(document.createTextNode(`${message.txt.trimEnd()}\n`)); });
          setProgress(`Транскрибация · ${secondsLabel(durationSeconds)}`);
          ui.TranscriptStatus.textContent = `Получено фрагментов: ${segments.length}`;
          entry.result = {
            fileName: entry.file.name,
            txt: buildAudioFileTranscript({ fileName: entry.file.name, model: batchModel.model, segments, durationSeconds, timeZone: batchSettings.timeZone }),
            error: 'Файл обработан частично: транскрибация ещё выполняется.'
          };
          updateDownload(true);
        } else if (message.type === 'done') {
          finished = true;
          entry.status = 'done';
          entry.result = { fileName: entry.file.name, txt: message.txt || buildAudioFileTranscript({ fileName: entry.file.name, model: batchModel.model, segments, durationSeconds: message.durationSeconds, timeZone: batchSettings.timeZone }) };
          changeTranscript(() => { preview.text.textContent = entry.result.txt; });
          setProgress(`Готово · ${secondsLabel(message.durationSeconds || durationSeconds)}`);
        }
      });
      if (!finished) throw new Error('Соединение прервалось до завершения файла. Полученный текст сохранён как неполный.');
    } catch (error) {
      const cancelled = signal.aborted;
      const message = cancelled ? 'Обработка остановлена пользователем. Файл обработан не полностью.' : String(error.message || error);
      entry.status = cancelled ? 'stopped' : 'error';
      entry.result = {
        fileName: entry.file.name,
        txt: buildAudioFileTranscript({ fileName: entry.file.name, model: batchModel.model, segments, durationSeconds, timeZone: batchSettings.timeZone }),
        error: message
      };
      changeTranscript(() => { preview.notice.textContent = message; });
    }
    ui.Progress.value = index + 1;
    ui.ProgressCount.textContent = `${index + 1}/${entries.length}`;
    renderList();
    updateDownload(true);
  }

  async function start() {
    if (running || !entries.length) return;
    running = true;
    controller = new AbortController();
    batchSettings = { ...getSettings() };
    batchModel = { ...getModel() };
    entries.forEach(entry => { entry.status = 'pending'; entry.result = null; });
    clearDownload();
    showError();
    ui.Transcript.replaceChildren();
    ui.Transcript.textContent = 'Ожидание текста…';
    ui.Transcript.classList.add('is-empty');
    ui.TranscriptStatus.textContent = 'Ожидает';
    ui.ProgressPanel.hidden = false;
    ui.Progress.max = entries.length;
    ui.Progress.value = 0;
    ui.ProgressCount.textContent = `0/${entries.length}`;
    ui.ProgressLabel.textContent = 'Проверка модели распознавания';
    ui.Status.textContent = 'Выполняется';
    updateControls();
    refreshSettings();
    try {
      const response = await fetch('/api/transcription/status', { signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.transcriber?.model) throw new Error(data.error || 'Не удалось определить выбранную модель.');
      batchModel = data.transcriber;
      refreshSettings();
      for (let index = 0; index < entries.length; index += 1) {
        if (controller.signal.aborted) break;
        await transcribeFile(entries[index], index, controller.signal);
      }
    } catch (error) {
      if (!controller.signal.aborted) showError(String(error.message || error));
    } finally {
      const stopped = controller.signal.aborted;
      for (const entry of entries.filter(item => item.status === 'pending')) {
        entry.status = 'skipped';
        entry.result = { fileName: entry.file.name, txt: '', error: stopped ? 'Не обработан: запуск остановлен пользователем.' : 'Не обработан: запуск не удалось завершить.' };
      }
      const completed = entries.filter(entry => entry.status === 'done').length;
      const failures = entries.filter(entry => entry.status === 'error').length;
      const partial = completed !== entries.length;
      ui.Status.textContent = stopped ? 'Остановлено · результат неполный' : partial ? 'Завершено не полностью' : 'Готово';
      ui.TranscriptStatus.textContent = `Готово файлов: ${completed}/${entries.length}${failures ? ` · Ошибок: ${failures}` : ''}`;
      ui.ProgressLabel.textContent = stopped ? 'Обработка остановлена. Полученный текст доступен для скачивания.' : partial ? 'Полученный текст сохранён. Ошибки перечислены в TXT.' : 'Все файлы обработаны. Единый TXT готов.';
      updateDownload(partial);
      running = false;
      controller = null;
      updateControls();
      refreshSettings();
    }
  }

  ui.Input.addEventListener('change', () => {
    addFiles(ui.Input.files);
    ui.Input.value = '';
  });
  for (const name of ['dragenter', 'dragover']) ui.DropZone.addEventListener(name, event => {
    event.preventDefault();
    if (!running) ui.DropZone.classList.add('is-dragging');
  });
  for (const name of ['dragleave', 'drop']) ui.DropZone.addEventListener(name, event => {
    event.preventDefault();
    ui.DropZone.classList.remove('is-dragging');
  });
  ui.DropZone.addEventListener('drop', event => addFiles(event.dataTransfer.files));
  ui.StartButton.addEventListener('click', start);
  ui.StopButton.addEventListener('click', () => {
    controller?.abort();
    ui.StopButton.disabled = true;
    ui.Status.textContent = 'Останавливается…';
  });
  ui.ClearButton.addEventListener('click', () => {
    if (running) return;
    entries = [];
    clearDownload();
    showError();
    ui.ProgressPanel.hidden = true;
    ui.Transcript.textContent = 'Нет текста';
    ui.Transcript.classList.add('is-empty');
    ui.TranscriptStatus.textContent = 'Нет текста';
    ui.Status.textContent = 'Выберите файлы';
    updateControls();
  });
  window.addEventListener('beforeunload', event => {
    if (!running) return;
    event.preventDefault();
    event.returnValue = '';
  });
  refreshSettings();
  return { refreshSettings };
}

async function readEvents(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
      if (done) {
        if (pending.trim()) onEvent(JSON.parse(pending));
        break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function fileSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.ceil(bytes / 1024)} КБ`;
}

function secondsLabel(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
