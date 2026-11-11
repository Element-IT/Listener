import { initAudioFilesTab } from './audio-files.js';

const CHANNEL_COUNT = 16;
const DEFAULT_TRANSCRIPT_SECONDS = 18;
const DEFAULT_CAMERA_TIME_ZONE = 'Europe/Moscow';
const DEFAULT_DISPLAY_TIME_ZONE = 'Asia/Yekaterinburg';
const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 4;
const OPENAI_STAGE_ORDER = ['search', 'transcribe', 'ask', 'report'];
const OPENAI_STAGE_LABELS = {
  idle: 'Ожидает',
  search: 'Поиск записей',
  transcribe: 'Транскрибация',
  transcript: 'Подготовка аудио и транскрибация',
  queued: 'В очереди',
  stopping: 'Останавливается',
  ask: 'Запрос OpenAI',
  report: 'Отправка отчёта',
  drive: 'Загрузка на Google Диск',
  localstorage: 'Сохранение готового результата на компьютере',
  delivery_pending: 'Ожидает отправки на Google Диск',
  done: 'Готово',
  error: 'Ошибка'
};
const STORAGE_KEYS = {
  selectedChannel: 'cameraAudio.selectedChannel.v1',
  channelLabels: 'cameraAudio.channelLabels.v1',
  settings: 'cameraAudio.settings.v1',
  openAiChannels: 'cameraAudio.openAiChannels.v1',
  openAiGroups: 'cameraAudio.openAiGroups.v1',
  openAiActions: 'cameraAudio.openAiActions.v1'
};

const elements = {
  configStatus: document.querySelector('#configStatus'),
  settingsSummary: document.querySelector('#settingsSummary'),
  transcriptionDevice: document.querySelector('#transcriptionDevice'),
  transcriptionHardware: document.querySelector('#transcriptionHardware'),
  transcriptionHardwareNote: document.querySelector('#transcriptionHardwareNote'),
  transcriptionModelPicker: document.querySelector('#transcriptionModelPicker'),
  transcriptionModelCurrent: document.querySelector('#transcriptionModelCurrent'),
  transcriptionModelOptions: document.querySelector('#transcriptionModelOptions'),
  transcriptionModelMetrics: document.querySelector('#transcriptionModelMetrics'),
  transcriptionModelSource: document.querySelector('#transcriptionModelSource'),
  transcriptionModelStatus: document.querySelector('#transcriptionModelStatus'),
  channelGrid: document.querySelector('#channelGrid'),
  channelNameFields: document.querySelector('#channelNameFields'),
  activeChannelNumber: document.querySelector('#activeChannelNumber'),
  activeChannelTitle: document.querySelector('#activeChannelTitle'),
  activeChannelSubtitle: document.querySelector('#activeChannelSubtitle'),
  settingsButton: document.querySelector('#settingsButton'),
  settingsCloseButton: document.querySelector('#settingsCloseButton'),
  settingsBackdrop: document.querySelector('#settingsBackdrop'),
  settingsDrawer: document.querySelector('#settingsDrawer'),
  audioTabButton: document.querySelector('#audioTabButton'),
  openAiTabButton: document.querySelector('#openAiTabButton'),
  audioFilesTabButton: document.querySelector('#audioFilesTabButton'),
  audioTab: document.querySelector('#audioTab'),
  openAiTab: document.querySelector('#openAiTab'),
  vendor: document.querySelector('#vendor'),
  stream: document.querySelector('#stream'),
  audioFilter: document.querySelector('#audioFilter'),
  transcriptSeconds: document.querySelector('#transcriptSeconds'),
  reportEmails: document.querySelector('#reportEmails'),
  cameraTimeZone: document.querySelector('#cameraTimeZone'),
  displayTimeZone: document.querySelector('#displayTimeZone'),
  probeButton: document.querySelector('#probeButton'),
  startLiveButton: document.querySelector('#startLiveButton'),
  stopLiveButton: document.querySelector('#stopLiveButton'),
  liveAudio: document.querySelector('#liveAudio'),
  liveTranscript: document.querySelector('#liveTranscript'),
  liveTranscriptStatus: document.querySelector('#liveTranscriptStatus'),
  from: document.querySelector('#from'),
  to: document.querySelector('#to'),
  searchButton: document.querySelector('#searchButton'),
  archiveSearchStatus: document.querySelector('#archiveSearchStatus'),
  archiveAudio: document.querySelector('#archiveAudio'),
  selectedRecording: document.querySelector('#selectedRecording'),
  archiveTranscript: document.querySelector('#archiveTranscript'),
  archiveTranscriptStatus: document.querySelector('#archiveTranscriptStatus'),
  recordingsBody: document.querySelector('#recordingsBody'),
  openAiStatus: document.querySelector('#openAiStatus'),
  openAiGroupStatus: document.querySelector('#openAiGroupStatus'),
  openAiGroupName: document.querySelector('#openAiGroupName'),
  openAiGroupFrom: document.querySelector('#openAiGroupFrom'),
  openAiGroupTo: document.querySelector('#openAiGroupTo'),
  openAiGroupChannelGrid: document.querySelector('#openAiGroupChannelGrid'),
  openAiGroupSelectAllButton: document.querySelector('#openAiGroupSelectAllButton'),
  openAiGroupClearButton: document.querySelector('#openAiGroupClearButton'),
  openAiSaveGroupButton: document.querySelector('#openAiSaveGroupButton'),
  openAiResetGroupButton: document.querySelector('#openAiResetGroupButton'),
  openAiGroupList: document.querySelector('#openAiGroupList'),
  createActionButton: document.querySelector('#createActionButton'),
  openAiActionList: document.querySelector('#openAiActionList'),
  actionDialog: document.querySelector('#actionDialog'),
  actionDialogTitle: document.querySelector('#actionDialogTitle'),
  actionDialogCloseButton: document.querySelector('#actionDialogCloseButton'),
  cancelActionButton: document.querySelector('#cancelActionButton'),
  actionName: document.querySelector('#actionName'),
  actionGroupList: document.querySelector('#actionGroupList'),
  actionQuestion: document.querySelector('#actionQuestion'),
  actionQuestionField: document.querySelector('#actionQuestionField'),
  actionDestination: document.querySelector('#actionDestination'),
  actionDestinationHint: document.querySelector('#actionDestinationHint'),
  actionPeriodMode: document.querySelector('#actionPeriodMode'),
  actionDayPreset: document.querySelector('#actionDayPreset'),
  actionDayPresetLabel: document.querySelector('#actionDayPresetLabel'),
  actionCustomDate: document.querySelector('#actionCustomDate'),
  actionCustomDateLabel: document.querySelector('#actionCustomDateLabel'),
  actionScheduleOptions: document.querySelector('#actionScheduleOptions'),
  actionRunOnWeekends: document.querySelector('#actionRunOnWeekends'),
  actionReportOptions: document.querySelector('#actionReportOptions'),
  actionReportDaily: document.querySelector('#actionReportDaily'),
  actionReportWeekly: document.querySelector('#actionReportWeekly'),
  saveActionButton: document.querySelector('#saveActionButton'),
  openAiCancelButton: document.querySelector('#openAiCancelButton'),
  openAiProgressStage: document.querySelector('#openAiProgressStage'),
  openAiProgressSummary: document.querySelector('#openAiProgressSummary'),
  openAiProgressBar: document.querySelector('#openAiProgressBar'),
  openAiStageProgress: document.querySelector('#openAiStageProgress'),
  openAiCameraProgress: document.querySelector('#openAiCameraProgress'),
  openAiRecordingProgress: document.querySelector('#openAiRecordingProgress'),
  openAiTranscriptProgress: document.querySelector('#openAiTranscriptProgress'),
  openAiError: document.querySelector('#openAiError'),
  openAiRunLog: document.querySelector('#openAiRunLog'),
  openAiTranscript: document.querySelector('#openAiTranscript'),
  openAiTranscriptStatus: document.querySelector('#openAiTranscriptStatus'),
  openAiAnswerTitle: document.querySelector('#openAiAnswerTitle'),
  openAiAnswer: document.querySelector('#openAiAnswer'),
  openAiAnswerStatus: document.querySelector('#openAiAnswerStatus'),
  log: document.querySelector('#log')
};

let selectedChannel = loadSelectedChannel();
let channelLabels = loadChannelLabels();
let uiSettings = loadUiSettings();
let openAiGroups = loadOpenAiGroups();
let openAiActions = loadOpenAiActions();
let editingGroupId = null;
let editingActionId = null;
let activeOpenAiActionId = null;
let activeOpenAiActionStartedAt = null;
let lastRecordings = [];
let lastArchiveItem = null;
let liveTranscriptController = null;
let archiveTranscriptController = null;
let openAiController = null;
let liveTranscriptRunId = 0;
let archiveTranscriptRunId = 0;
let openAiRunId = 0;
let liveTranscriptOffsetSeconds = 0;
let storageHydrated = false;
let storageAvailable = false;
let transcriptionStatusTimer = null;
let transcriptionStatusLoading = false;
let transcriptionModelSaving = false;
let transcriptionModelState = {};
let transcriptionModelMessage = '';
let transcriptionModelMessageIsError = false;
let transcriptionModelRevision = 0;
const actionRunNotices = new Map();
const pendingActionCommands = new Map();
let schedulerState = null;
let schedulerClockOffset = 0;
let actionStateRefreshing = false;
const audioFilesTab = initAudioFilesTab({
  getSettings: () => ({ audioFilter: elements.audioFilter.value || 'voice', timeZone: displayTimeZone() }),
  getModel: () => transcriptionModelState
});

applySettingsToControls();
renderChannelButtons();
renderChannelNameFields();
setSelectedRecording(null);
setDefaultRange();
resetGroupForm();
renderGroupChannelPicker();
renderOpenAiGroups();
renderOpenAiActions();
renderActionGroupPicker();
setOpenAiBusy(false);
resetOpenAiProgressView();
selectChannel(selectedChannel, { quiet: true });
loadPersistedState().finally(() => {
  loadHealth();
  window.setInterval(refreshPersistedActionState, 3000);
  window.setInterval(updateActionCountdowns, 1000);
});

elements.channelGrid.addEventListener('click', event => {
  const button = event.target.closest('button[data-channel]');
  if (!button) return;
  selectChannel(Number(button.dataset.channel));
});

elements.channelNameFields.addEventListener('input', event => {
  const input = event.target.closest('input[data-channel]');
  if (!input) return;

  const channel = Number(input.dataset.channel);
  channelLabels[channel - 1] = input.value.trim() || `Канал ${channel}`;
  saveChannelLabels();
  updateActiveChannelUi();
  renderChannelButtons();
  renderGroupChannelPicker();
  renderOpenAiGroups();
  renderOpenAiActions();
  renderActionGroupPicker(selectedActionDialogGroupIds());
});

elements.audioTabButton.addEventListener('click', () => switchTab('audio'));
elements.openAiTabButton.addEventListener('click', () => switchTab('openai'));
elements.audioFilesTabButton.addEventListener('click', () => switchTab('audio-files'));
elements.settingsButton.addEventListener('click', openSettings);
elements.settingsCloseButton.addEventListener('click', closeSettings);
elements.settingsBackdrop.addEventListener('click', closeSettings);
elements.transcriptionModelOptions.addEventListener('change', event => {
  if (event.target.matches('input[name="transcriptionModel"]')) saveTranscriptionModel(event.target.value);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeSettings();
});

elements.probeButton.addEventListener('click', async () => {
  await runAction('Проверяю API камеры', async () => {
    const data = await api('/api/probe');
    if (data.detectedVendor && [...elements.vendor.options].some(option => option.value === data.detectedVendor)) {
      elements.vendor.value = data.detectedVendor;
      saveUiSettings();
    }
    log(data);
  });
});

elements.vendor.addEventListener('change', () => handlePlaybackSettingChanged('vendor'));
elements.stream.addEventListener('change', () => handlePlaybackSettingChanged('stream'));
elements.audioFilter.addEventListener('change', () => handlePlaybackSettingChanged('audioFilter'));
elements.transcriptSeconds.addEventListener('change', () => {
  elements.transcriptSeconds.value = String(getTranscriptSeconds());
  saveUiSettings();
  log({ ok: true, transcriptSeconds: getTranscriptSeconds(), applied: 'next transcript block' });
});

elements.reportEmails.addEventListener('change', () => {
  saveUiSettings();
  log({ ok: true, reportEmails: reportEmailList().length });
});

elements.cameraTimeZone.addEventListener('change', handleTimeZoneChanged);
elements.displayTimeZone.addEventListener('change', handleTimeZoneChanged);

elements.archiveAudio.addEventListener('error', () => {
  log({
    ok: false,
    error: 'Не удалось проиграть аудио из этой записи. Для XM/Xiongmai скачайте файл записи и проверьте его в VLC/ffmpeg.',
    source: elements.archiveAudio.currentSrc
  });
});

elements.startLiveButton.addEventListener('click', async () => {
  await runAction('Запускаю live', async () => {
    await startLiveAudio();
    startLiveTranscription({ reset: true });
  });
});

elements.stopLiveButton.addEventListener('click', () => {
  stopLiveAudio();
  log({ ok: true, live: 'stopped', channel: selectedChannel });
});

elements.searchButton.addEventListener('click', async () => {
  await searchRecordings();
});

elements.recordingsBody.addEventListener('click', event => {
  const button = event.target.closest('button[data-index]');
  if (!button) return;

  const item = lastRecordings[Number(button.dataset.index)];
  if (!item) return;

  if (button.dataset.action === 'download') {
    startRecordingDownload(item, recordingQuery(item));
    return;
  }

  playArchiveRecording(item);
});

elements.openAiGroupSelectAllButton.addEventListener('click', () => {
  for (const input of elements.openAiGroupChannelGrid.querySelectorAll('input[data-channel]')) {
    input.checked = true;
  }
});

elements.openAiGroupClearButton.addEventListener('click', () => {
  for (const input of elements.openAiGroupChannelGrid.querySelectorAll('input[data-channel]')) {
    input.checked = false;
  }
});

elements.openAiSaveGroupButton.addEventListener('click', saveGroupFromForm);
elements.openAiResetGroupButton.addEventListener('click', resetGroupForm);
elements.openAiGroupList.addEventListener('click', handleGroupListClick);
elements.createActionButton.addEventListener('click', () => openActionDialog());
elements.openAiActionList.addEventListener('click', handleActionListClick);
elements.actionDialogCloseButton.addEventListener('click', closeActionDialog);
elements.cancelActionButton.addEventListener('click', closeActionDialog);
elements.saveActionButton.addEventListener('click', saveActionFromDialog);
elements.actionPeriodMode.addEventListener('change', updateActionPeriodModeUi);
elements.actionDayPreset.addEventListener('change', updateActionPeriodModeUi);
elements.actionDestination.addEventListener('change', updateActionPeriodModeUi);
elements.openAiCancelButton.addEventListener('click', stopOpenAiWorkflow);

function selectChannel(channel, options = {}) {
  selectedChannel = clamp(channel, 1, CHANNEL_COUNT);
  saveSelectedChannel(selectedChannel);
  updateActiveChannelUi();
  renderChannelButtons();

  stopLiveAudio({ quiet: true });
  clearArchivePlayer();
  lastRecordings = [];
  lastArchiveItem = null;
  setSelectedRecording(null);
  setTranscript(elements.liveTranscript, elements.liveTranscriptStatus, 'Нет текста', 'Остановлено');
  setTranscript(elements.archiveTranscript, elements.archiveTranscriptStatus, 'Нет текста', 'Нет записи');
  renderRecordings(elements.vendor.value, lastRecordings);

  if (!options.quiet) {
    log({ ok: true, channel: selectedChannel, label: channelLabel(selectedChannel) });
  }
}

function updateActiveChannelUi() {
  elements.activeChannelNumber.textContent = String(selectedChannel);
  elements.activeChannelTitle.textContent = channelLabel(selectedChannel);
  elements.activeChannelSubtitle.textContent = `Канал ${selectedChannel} · ${elements.stream.value === 'sub' ? 'Sub' : 'Main'} · ${audioFilterLabel(elements.audioFilter.value)}`;
}

function renderChannelButtons() {
  elements.channelGrid.innerHTML = Array.from({ length: CHANNEL_COUNT }, (_, index) => {
    const channel = index + 1;
    const active = channel === selectedChannel ? ' active' : '';
    return `
      <button class="channel-button${active}" type="button" data-channel="${channel}" aria-pressed="${channel === selectedChannel}">
        <span class="channel-index">${String(channel).padStart(2, '0')}</span>
        <span class="channel-name">${escapeHtml(channelLabel(channel))}</span>
      </button>
    `;
  }).join('');
}

function renderChannelNameFields() {
  elements.channelNameFields.innerHTML = Array.from({ length: CHANNEL_COUNT }, (_, index) => {
    const channel = index + 1;
    return `
      <label class="channel-name-field">
        <span>${String(channel).padStart(2, '0')}</span>
        <input data-channel="${channel}" type="text" maxlength="32" value="${escapeHtml(channelLabel(channel))}">
      </label>
    `;
  }).join('');
}

function renderGroupChannelPicker(channels = selectedGroupFormChannels()) {
  const selected = new Set(channels.length ? channels : [selectedChannel]);
  elements.openAiGroupChannelGrid.innerHTML = Array.from({ length: CHANNEL_COUNT }, (_, index) => {
    const channel = index + 1;
    return `
      <label class="openai-channel-option" title="${escapeHtml(channelLabel(channel))}">
        <input data-channel="${channel}" type="checkbox" value="${channel}" ${selected.has(channel) ? 'checked' : ''}>
        <span>${String(channel).padStart(2, '0')} · ${escapeHtml(channelLabel(channel))}</span>
      </label>
    `;
  }).join('');
}

function renderOpenAiGroups() {
  if (!openAiGroups.length) {
    elements.openAiGroupList.innerHTML = '<div class="empty-card">Группы пока не созданы</div>';
    return;
  }

  elements.openAiGroupList.innerHTML = openAiGroups.map(group => {
    const displayRange = groupRangeInDisplayTimeZone(group);
    return `
    <article class="group-card">
      <div class="card-title-row">
        <div>
          <strong>${escapeHtml(group.name)}</strong>
          <span>${group.channels.length} ${pluralRu(group.channels.length, 'камера', 'камеры', 'камер')}</span>
        </div>
      </div>
      <div class="meta-line">${escapeHtml(group.channels.map(channel => `${String(channel).padStart(2, '0')} ${channelLabel(channel)}`).join(', '))}</div>
      <div class="meta-line">${escapeHtml(formatTime(displayRange.from))} - ${escapeHtml(formatTime(displayRange.to))}</div>
      <div class="card-actions">
        <button class="inline file" type="button" data-group-action="edit" data-group-id="${escapeHtml(group.id)}">Изменить</button>
        <button class="inline danger" type="button" data-group-action="delete" data-group-id="${escapeHtml(group.id)}">Удалить</button>
      </div>
    </article>
  `;
  }).join('');
}

function renderOpenAiActions() {
  if (!openAiActions.length) {
    elements.openAiActionList.innerHTML = '<div class="empty-card">Действия пока не созданы</div>';
    return;
  }

  const expandedDiagnostics = new Set(Array.from(
    elements.openAiActionList.querySelectorAll('details[data-action-diagnostics][open]'),
    element => element.dataset.actionDiagnostics
  ));
  elements.openAiActionList.innerHTML = openAiActions.map(action => {
    const schedule = schedulerState?.schedules?.[action.id];
    const run = schedule?.run || action.lastRun || {};
    const lastStartedAt = activeOpenAiActionId === action.id
      ? activeOpenAiActionStartedAt
      : run.startedAt || (run.status === 'running' ? run.at : '');
    const busy = isActionBusy(action.id);
    const stopping = pendingActionCommands.get(action.id) === 'stop' || schedule?.state === 'stopping';
    const background = busy && activeOpenAiActionId !== action.id;
    const queued = pendingActionCommands.get(action.id) === 'run' || schedule?.state === 'queued';
    const percent = queued ? 0 : clamp(Number(run.progress?.percent || 0), 0, 100);
    const stateClass = activeOpenAiActionId === action.id
      ? ' running'
      : busy
        ? ' running'
        : run.status === 'success'
        ? ' success'
        : ['error', 'delivery_uncertain', 'incomplete'].includes(run.status)
          ? ' error'
          : '';
    const groups = action.groupIds.map(groupId => groupById(groupId)?.name).filter(Boolean);
    const subtitle = actionPeriodSubtitle(action);
    const reports = actionReportLabels(action);
    const destination = action.destination === 'drive' ? 'Google Диск · TXT по камерам' : 'Почта · отчёт OpenAI';
    const weekendMode = action.runOnWeekends ? 'обрабатывать' : 'пропускать';
    const triggerNotice = actionRunNotices.get(action.id);
    const runSource = run.scheduled ? 'Авто · ' : '';
    const lastLine = background
      ? stopping ? 'Останавливается в фоне' : queued ? 'В фоновой очереди' : 'Выполняется в фоне'
      : activeOpenAiActionId === action.id
      ? 'Выполняется вручную'
      : run.status && !['running', 'queued'].includes(run.status)
        ? `${runSource}${run.status === 'success' ? 'Готово' : run.status === 'running' ? 'Выполняется' : run.status === 'queued' ? 'В очереди' : run.status === 'stopped' ? 'Остановлено' : run.status === 'delivery_uncertain' ? 'Доставка не подтверждена' : run.status === 'delivery_pending' ? 'Транскрибация готова — ожидает отправки' : run.status === 'incomplete' ? 'Требует внимания' : 'Ошибка'}${run.at ? ` · ${formatTime(run.at)}` : ''}`
        : 'Ожидает запуска';
    const errorLine = !busy && ['error', 'delivery_uncertain', 'incomplete'].includes(run.status)
      ? `${OPENAI_STAGE_LABELS[run.stage] || run.stage || 'Выполнение'}: ${run.error || 'без деталей'}`
      : '';

    return `
      <article class="action-card${stateClass}" data-action-id="${escapeHtml(action.id)}" aria-busy="${busy}">
        <div class="card-title-row">
          <div>
            <strong>${escapeHtml(action.name || 'Действие')}</strong>
            <span>${escapeHtml(subtitle)}</span>
          </div>
          <span class="action-state">${escapeHtml(lastLine)}</span>
        </div>
        <div class="meta-line">Группы: ${escapeHtml(groups.length ? groups.join(', ') : 'не найдены')}</div>
        <div class="meta-line action-last-start">Последний старт: ${lastStartedAt ? `<time datetime="${escapeHtml(lastStartedAt)}">${escapeHtml(formatScheduledTime(lastStartedAt))}</time> (${escapeHtml(displayTimeZoneLabel())})` : run.status ? 'время не сохранено' : 'ещё не запускалось'}</div>
        ${run.from && run.to ? `<div class="meta-line">Период обработки: ${escapeHtml(formatScheduledTime(run.from))} — ${escapeHtml(formatScheduledTime(run.to))} (${escapeHtml(displayTimeZoneLabel())})</div>` : ''}
        <div class="meta-line">Результат: ${escapeHtml(destination)}</div>
        ${action.periodMode !== 'once' ? `<div class="meta-line">Выходные: ${weekendMode}</div>` : ''}
        ${reports.length ? `<div class="meta-line">Отчёты: ${escapeHtml(reports.join(', '))}</div>` : ''}
        <div class="action-countdown meta-line" data-action-countdown="${escapeHtml(action.id)}"></div>
        ${triggerNotice ? `<div class="meta-line${triggerNotice.error ? ' action-error-line' : ''}">${escapeHtml(triggerNotice.message)}</div>` : ''}
        ${errorLine ? `<div class="meta-line action-error-line">${run.status === 'incomplete' ? 'Причина' : 'Ошибка'}: ${escapeHtml(errorLine)}</div>` : ''}
        ${!busy && run.status === 'incomplete' ? `<div class="meta-line">Автоповторы этого периода остановлены.${action.periodMode !== 'once' ? ' Следующие периоды обрабатываются по расписанию.' : ''} Повторить этот период можно вручную кнопкой «Запустить».</div>` : ''}
        ${!busy && Number(run.missingAudioRecordings) > 0 ? `<div class="meta-line">Без аудиодорожки: ${Number(run.missingAudioRecordings)} ${pluralRu(Number(run.missingAudioRecordings), 'запись', 'записи', 'записей')}; интервалы отмечены в TXT.</div>` : ''}
        ${background ? `
          <div class="action-background-progress">
            <div class="action-progress-heading">
              <span>${escapeHtml(stopping ? (run.stage === 'report' ? 'Завершение текущей отправки письма' : 'Остановка обработки') : queued ? 'Ожидание свободной очереди' : OPENAI_STAGE_LABELS[run.stage] || 'Подготовка запуска')}</span>
              <strong>${percent.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%</strong>
            </div>
            <progress class="action-progress-bar" max="100" value="${percent}" aria-label="Выполнение действия ${escapeHtml(action.name)}">${percent}%</progress>
            ${run.progress?.label ? `<div class="meta-line">${escapeHtml(run.progress.label)}</div>` : ''}
            ${run.progress?.from ? `<div class="meta-line">${escapeHtml(formatScheduledTime(run.progress.from))} - ${escapeHtml(formatScheduledTime(run.progress.to))}</div>` : ''}
            <div class="meta-line">Частей: ${Number(run.progress?.completedChunks) || 0} · Аудио: ${formatDurationLabel(run.progress?.transcribedSeconds || 0)} · Записей: ${Number(run.progress?.completedRecordings) || 0}/${Number(run.progress?.knownRecordings) || 0}</div>
          </div>` : ''}
        ${run.errorNotification?.status === 'sent' ? '<div class="meta-line">Уведомление об ошибке отправлено на почту</div>' : ''}
        ${run.errorNotification && run.errorNotification.status !== 'sent' ? `<div class="meta-line action-error-line">Уведомление об ошибке: ${escapeHtml(run.errorNotification.error || run.errorNotification.reason || 'доставка не подтверждена')}</div>` : ''}
        ${action.destination === 'drive' && run.status ? `<div class="meta-line">Файлов сохранено на Google Диске: ${driveUploadsSummary(run.uploads)}</div>` : ''}
        ${action.destination === 'drive' ? renderDriveDeliveryStatus(run) : ''}
        ${Array.isArray(run.uploads) && run.uploads.length ? `<div class="meta-line">Google Диск: ${run.uploads.map(upload => upload.webViewLink
          ? `<a href="${escapeHtml(upload.webViewLink)}" target="_blank" rel="noopener noreferrer">${escapeHtml(driveUploadLabel(upload))}</a>`
          : escapeHtml(driveUploadLabel(upload))).join(', ')}</div>` : ''}
        ${renderActionDiagnostics(action.id, run.diagnostics, expandedDiagnostics.has(action.id))}
        ${action.destination === 'email' ? `<div class="meta-line">Вопрос: ${escapeHtml(action.question)}</div>` : ''}
        <div class="card-actions">
          ${busy ? `<button class="inline danger" type="button" data-action-command="stop" data-action-id="${escapeHtml(action.id)}" ${stopping || pendingActionCommands.get(action.id) === 'run' ? 'disabled' : ''}>${stopping ? 'Останавливается…' : 'Остановить'}</button>` : `
          <button class="inline" type="button" data-action-command="run" data-action-id="${escapeHtml(action.id)}">Запустить</button>
          <button class="inline file" type="button" data-action-command="edit" data-action-id="${escapeHtml(action.id)}">Изменить</button>
          <button class="inline danger" type="button" data-action-command="delete" data-action-id="${escapeHtml(action.id)}">Удалить</button>
          `}
        </div>
      </article>
    `;
  }).join('');
  updateActionCountdowns();
}

function driveUploadsSummary(uploads) {
  const saved = Array.isArray(uploads) ? uploads : [];
  const partial = saved.filter(upload => upload.completeness === 'partial').length;
  return `${saved.length} (полных: ${saved.length - partial}, неполных: ${partial})`;
}

function renderDriveDeliveryStatus(run = {}) {
  const count = value => Math.max(0, Math.floor(Number(value) || 0));
  const localReady = count(run.progress?.readyCameras ?? run.localReadyCameras);
  const queued = count(run.queuedCameras ?? run.progress?.queuedCameras);
  const pending = run.status === 'delivery_pending';
  if (!localReady && !queued && !pending) return '';
  const deliveryError = run.deliveryError || (pending ? run.error : '');
  return `
    <div class="meta-line">Готовых файлов на компьютере: ${localReady} · Ожидают отправки: ${queued}</div>
    ${pending ? '<div class="meta-line">Транскрибация завершена. Готовые TXT сохранены на компьютере; отправка на Google Диск повторяется отдельно, без повторной обработки камер.</div>' : ''}
    ${deliveryError ? `<div class="meta-line action-error-line">Отправка отложена: ${escapeHtml(deliveryError)}</div>` : ''}`;
}

function driveUploadLabel(upload) {
  const label = String(upload.fileName || `камера ${upload.channel}`);
  return upload.completeness === 'partial' && !label.toLocaleUpperCase('ru-RU').includes('НЕПОЛНАЯ ТРАНСКРИБАЦИЯ')
    ? `НЕПОЛНАЯ ТРАНСКРИБАЦИЯ · ${label}`
    : label;
}

function renderActionDiagnostics(actionId, diagnostics, expanded = false) {
  if (!Array.isArray(diagnostics) || !diagnostics.length) return '';
  const statusLabels = {
    skipped: 'Уже сохранено — пропущено', complete: 'Обработано',
    incomplete: 'Обработано не полностью', search: 'Поиск записей', transcript: 'Транскрибация'
  };
  const nonnegativeNumber = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const count = value => Math.floor(nonnegativeNumber(value)).toLocaleString('ru-RU');
  const elapsed = value => `${(nonnegativeNumber(value) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} с`;
  const duration = value => formatDurationLabel(nonnegativeNumber(value));
  const range = value => value?.from && value?.to
    ? `${formatScheduledTime(value.from)} — ${formatScheduledTime(value.to)}` : '';
  return `
    <details class="meta-line" data-action-diagnostics="${escapeHtml(actionId)}"${expanded ? ' open' : ''}>
      <summary>Диагностика по камерам (${diagnostics.length})</summary>
      <div class="meta-line">Время: ${escapeHtml(displayTimeZoneLabel())}. Длительность аудио указана в минутах и секундах.</div>
      ${diagnostics.map(item => {
        const diagnostic = item && typeof item === 'object' ? item : {};
        const coverage = diagnostic.archiveCoverage;
        const issues = Array.isArray(diagnostic.issues) ? diagnostic.issues : [];
        const gaps = Array.isArray(coverage?.gaps) ? coverage.gaps : [];
        return `
          <div class="group-card">
            <strong>${escapeHtml(`${String(Math.floor(nonnegativeNumber(diagnostic.channel))).padStart(2, '0')} · ${diagnostic.label || 'Камера'}`)}</strong>
            <div class="meta-line">${escapeHtml(statusLabels[diagnostic.status] || diagnostic.status || 'Нет данных')}</div>
            ${range(diagnostic) ? `<div class="meta-line">${escapeHtml(range(diagnostic))}</div>` : ''}
            ${diagnostic.status === 'skipped' ? '<div class="meta-line">Готовый результат уже сохранён локально или на Google Диске. Повторная загрузка записей и транскрибация не выполнялись.</div>' : `
              <div class="meta-line">Записей обработано: ${escapeHtml(count(diagnostic.completedRecordings))}/${escapeHtml(count(diagnostic.recordings))} · Аудио: ${escapeHtml(duration(diagnostic.processedSeconds))} · Частей из кэша: ${escapeHtml(count(diagnostic.cachedChunks))}</div>
              <div class="meta-line">Поиск: ${escapeHtml(elapsed(diagnostic.searchMs))} · Обработка: ${escapeHtml(elapsed(diagnostic.processingMs))} · Получение аудио: ${escapeHtml(elapsed(diagnostic.captureMs))} · Распознавание: ${escapeHtml(elapsed(diagnostic.asrMs))}</div>`}
            ${coverage ? `<div class="meta-line">Покрытие архива: ${escapeHtml(duration(coverage.coveredSeconds))} из ${escapeHtml(duration(coverage.requestedSeconds))} · Не покрыто: ${escapeHtml(duration(coverage.missingSeconds))}</div>` : ''}
            ${gaps.map(gap => `<div class="meta-line action-error-line">Пропуск в архиве: ${escapeHtml(range(gap))} (${escapeHtml(duration(gap?.durationSeconds))})</div>`).join('')}
            ${issues.map(issue => `<div class="meta-line action-error-line">${escapeHtml(typeof issue === 'string' ? issue : issue?.error || issue?.code || 'Ошибка без подробностей')}</div>`).join('')}
          </div>`;
      }).join('')}
    </details>`;
}

function isActionBusy(actionId) {
  return activeOpenAiActionId === actionId || pendingActionCommands.has(actionId)
    || ['queued', 'running', 'stopping'].includes(schedulerState?.schedules?.[actionId]?.state);
}

function applySchedulerState(value) {
  if (!value) return;
  schedulerState = value;
  const serverTime = Date.parse(value.serverNow);
  if (Number.isFinite(serverTime)) schedulerClockOffset = serverTime - Date.now();
}

function formatScheduledTime(value) {
  try {
    const zone = normalizeBrowserTimeZone(schedulerState?.timeZone || displayTimeZone(), DEFAULT_DISPLAY_TIME_ZONE);
    const epoch = hasExplicitTimeZone(value) ? Date.parse(value) : zonedDateTimeMs(value, zone);
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: zone, dateStyle: 'short', timeStyle: 'medium'
    }).format(new Date(epoch));
  } catch {
    return String(value || '');
  }
}

function updateActionCountdowns() {
  for (const element of elements.openAiActionList.querySelectorAll('[data-action-countdown]')) {
    const action = actionById(element.dataset.actionCountdown);
    if (!action) continue;
    const schedule = schedulerState?.schedules?.[action.id];
    element.hidden = isActionBusy(action.id);
    if (element.hidden) continue;
    const nextAt = Date.parse(schedule?.nextRunAt || '');
    if (action.periodMode === 'once') element.textContent = 'Только ручной запуск';
    else if (!schedulerState) element.textContent = 'Расписание загружается…';
    else if (!schedulerState.enabled) element.textContent = 'Фоновый планировщик выключен';
    else if (!Number.isFinite(nextAt)) element.textContent = 'Нет следующего фонового запуска';
    else {
      const seconds = Math.max(0, Math.ceil((nextAt - Date.now() - schedulerClockOffset) / 1000));
      const days = Math.floor(seconds / 86400);
      const clock = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
        .map(number => String(number).padStart(2, '0')).join(':');
      element.textContent = seconds ? `До запуска в фоне: ${days ? `${days} д. ` : ''}${clock}` : 'Ожидает запуска в фоновой очереди';
      element.title = `Следующий запуск: ${formatScheduledTime(schedule.nextRunAt)} (${schedulerState.timeZone || displayTimeZone()})`;
    }
  }
}

function renderActionGroupPicker(selectedGroupIds = []) {
  if (!openAiGroups.length) {
    elements.actionGroupList.innerHTML = '<div class="empty-card">Сначала сохраните хотя бы одну группу</div>';
    return;
  }

  const selected = new Set(selectedGroupIds);
  elements.actionGroupList.innerHTML = openAiGroups.map(group => {
    const displayRange = groupRangeInDisplayTimeZone(group);
    return `
    <label class="action-group-option">
      <input data-group-id="${escapeHtml(group.id)}" type="checkbox" ${selected.has(group.id) ? 'checked' : ''}>
      <span>${escapeHtml(group.name)}</span>
      <small>${group.channels.length} ${pluralRu(group.channels.length, 'камера', 'камеры', 'камер')} · ${escapeHtml(timeOnly(displayRange.from))}-${escapeHtml(timeOnly(displayRange.to))}</small>
    </label>
  `;
  }).join('');
}

function switchTab(tabName) {
  for (const panel of document.querySelectorAll('[data-tab-panel]')) {
    const active = panel.dataset.tabPanel === tabName;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  }
  for (const button of document.querySelectorAll('.tab-button[data-tab]')) {
    const active = button.dataset.tab === tabName;
    button.classList.toggle('active', active);
    button.classList.toggle('secondary', !active);
    button.setAttribute('aria-selected', String(active));
  }
  if (tabName === 'audio-files') audioFilesTab.refreshSettings();
}

async function startLiveAudio(reason = 'started') {
  const query = new URLSearchParams(currentCameraParams());
  query.set('_', Date.now());
  elements.liveAudio.src = `/api/live/audio?${query}`;
  await elements.liveAudio.play();
  log({
    ok: true,
    live: reason,
    channel: selectedChannel,
    label: channelLabel(selectedChannel),
    vendor: elements.vendor.value,
    audioFilter: elements.audioFilter.value
  });
}

function stopLiveAudio() {
  elements.liveAudio.pause();
  elements.liveAudio.removeAttribute('src');
  elements.liveAudio.load();
  stopLiveTranscription();
}

async function playArchiveRecording(item, reason = 'started') {
  lastArchiveItem = item;
  setSelectedRecording(item);
  markSelectedRecording(item);

  const query = recordingQuery(item);
  query.set('_', Date.now());
  elements.archiveAudio.src = `/api/recordings/audio?${query}`;
  try {
    await elements.archiveAudio.play();
    log({
      ok: true,
      archiveAudio: reason,
      channel: selectedChannel,
      fileName: item.fileName || item.filePath,
      audioFilter: elements.audioFilter.value
    });
    startArchiveTranscription(item);
  } catch (error) {
    log({
      ok: false,
      error: `Не удалось запустить аудио: ${error.message || error}`,
      hint: 'Попробуйте кнопку Скачать для этой записи.'
    });
  }
}

function clearArchivePlayer() {
  elements.archiveAudio.pause();
  elements.archiveAudio.removeAttribute('src');
  elements.archiveAudio.load();
  stopArchiveTranscription();
}

function startLiveTranscription({ reset = true } = {}) {
  stopLiveTranscription();

  const runId = liveTranscriptRunId + 1;
  liveTranscriptRunId = runId;
  liveTranscriptController = new AbortController();

  if (reset) {
    liveTranscriptOffsetSeconds = 0;
    setTranscript(elements.liveTranscript, elements.liveTranscriptStatus, 'Нет текста', 'Запущено');
  } else {
    elements.liveTranscriptStatus.textContent = 'Обновляю';
  }

  runLiveTranscriptionLoop(runId, liveTranscriptController.signal);
}

function stopLiveTranscription() {
  if (liveTranscriptController) {
    liveTranscriptController.abort();
    liveTranscriptController = null;
  }
  liveTranscriptRunId += 1;
  elements.liveTranscriptStatus.textContent = 'Остановлено';
}

async function runLiveTranscriptionLoop(runId, signal) {
  while (runId === liveTranscriptRunId && !signal.aborted && elements.liveAudio.currentSrc && !elements.liveAudio.paused) {
    try {
      const durationSeconds = getTranscriptSeconds();
      const query = new URLSearchParams(currentCameraParams());
      query.set('duration', String(durationSeconds));
      query.set('offsetSeconds', String(liveTranscriptOffsetSeconds));
      query.set('_', Date.now());

      const fromLabel = formatDurationLabel(liveTranscriptOffsetSeconds);
      const toLabel = formatDurationLabel(liveTranscriptOffsetSeconds + durationSeconds);
      elements.liveTranscriptStatus.textContent = `Распознаю ${fromLabel}-${toLabel}`;
      const data = await api(`/api/live/transcript?${query}`, { signal });

      if (runId !== liveTranscriptRunId || signal.aborted) return;

      const hadText = appendTranscript(elements.liveTranscript, data.segments, data.text);
      liveTranscriptOffsetSeconds += data.durationSeconds || durationSeconds;
      elements.liveTranscriptStatus.textContent = hadText ? `Обновлено ${formatDurationLabel(liveTranscriptOffsetSeconds)}` : 'Речи не найдено';
      await delay(300, signal);
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError') return;
      elements.liveTranscriptStatus.textContent = 'Ошибка';
      appendTranscript(elements.liveTranscript, [], `Ошибка транскрибации: ${error.message || error}`);
      return;
    }
  }
}

function startArchiveTranscription(item) {
  stopArchiveTranscription();

  const runId = archiveTranscriptRunId + 1;
  archiveTranscriptRunId = runId;
  archiveTranscriptController = new AbortController();
  setTranscript(elements.archiveTranscript, elements.archiveTranscriptStatus, 'Нет текста', 'Запущено');

  runArchiveTranscriptionLoop(item, runId, archiveTranscriptController.signal);
}

async function runArchiveTranscriptionLoop(item, runId, signal) {
  const totalSeconds = recordingDurationSeconds(item);
  let offsetSeconds = 0;
  let chunksWithText = 0;

  while (runId === archiveTranscriptRunId && !signal.aborted) {
    if (totalSeconds > 0 && offsetSeconds >= totalSeconds) {
      elements.archiveTranscriptStatus.textContent = chunksWithText > 0 ? 'Готово' : 'Речь не найдена';
      if (chunksWithText === 0) {
        renderTranscript(elements.archiveTranscript, [], '');
      }
      return;
    }

    const requestedSeconds = getTranscriptSeconds();
    const durationSeconds = totalSeconds > 0
      ? Math.min(requestedSeconds, Math.max(1, totalSeconds - offsetSeconds))
      : requestedSeconds;
    const query = recordingQuery(item);
    query.set('duration', String(durationSeconds));
    query.set('offsetSeconds', String(offsetSeconds));
    query.set('_', Date.now());

    const fromLabel = formatDurationLabel(offsetSeconds);
    const toLabel = formatDurationLabel(offsetSeconds + durationSeconds);
    elements.archiveTranscriptStatus.textContent = `Распознаю ${fromLabel}-${toLabel}`;

    try {
      const data = await api(`/api/recordings/transcript?${query}`, { signal });
      if (runId !== archiveTranscriptRunId || signal.aborted) return;

      const hadText = appendTranscript(elements.archiveTranscript, data.segments, data.text);
      if (hadText) chunksWithText += 1;
      offsetSeconds += data.durationSeconds || durationSeconds;
      elements.archiveTranscriptStatus.textContent = data.cached
        ? `Из кеша ${formatDurationLabel(offsetSeconds)}`
        : `Обновлено ${formatDurationLabel(offsetSeconds)}`;
      log({
        ok: true,
        transcript: 'archive',
        channel: selectedChannel,
        cached: Boolean(data.cached),
        offsetSeconds: data.offsetSeconds,
        durationSeconds: data.durationSeconds,
        tookMs: data.tookMs,
        model: data.model
      });
      await delay(150, signal);
    } catch (error) {
      if (error.name === 'AbortError' || signal.aborted) return;
      if (runId !== archiveTranscriptRunId) return;
      setTranscript(elements.archiveTranscript, elements.archiveTranscriptStatus, `Ошибка транскрибации: ${error.message || error}`, 'Ошибка');
      return;
    }
  }
}

function stopArchiveTranscription() {
  if (archiveTranscriptController) {
    archiveTranscriptController.abort();
    archiveTranscriptController = null;
  }
  archiveTranscriptRunId += 1;
}

function saveGroupFromForm() {
  const name = elements.openAiGroupName.value.trim();
  const channels = selectedGroupFormChannels();
  const from = elements.openAiGroupFrom.value;
  const to = elements.openAiGroupTo.value;

  if (!name) {
    setGroupStatus('Введите название', 'warn');
    elements.openAiGroupName.focus();
    return;
  }
  if (!channels.length) {
    setGroupStatus('Выберите камеры', 'warn');
    return;
  }
  if (!from || !to || secondsBetween(from, to) <= 0) {
    setGroupStatus('Проверьте период', 'warn');
    return;
  }

  const group = {
    id: editingGroupId || createId('group'),
    name,
    channels,
    from,
    to,
    timeZone: displayTimeZone(),
    updatedAt: new Date().toISOString()
  };

  if (editingGroupId) {
    openAiGroups = openAiGroups.map(item => item.id === editingGroupId ? group : item);
  } else {
    openAiGroups = [...openAiGroups, { ...group, createdAt: group.updatedAt }];
  }

  saveOpenAiGroups();
  setGroupStatus('Группа сохранена', 'good');
  resetGroupForm({ keepStatus: true });
  renderOpenAiGroups();
  renderOpenAiActions();
  renderActionGroupPicker(selectedActionDialogGroupIds());
}

function resetGroupForm(options = {}) {
  editingGroupId = null;
  elements.openAiGroupName.value = '';
  elements.openAiGroupFrom.value = elements.from?.value || toDatetimeLocal(new Date(Date.now() - 60 * 60 * 1000));
  elements.openAiGroupTo.value = elements.to?.value || toDatetimeLocal(new Date());
  renderGroupChannelPicker([selectedChannel]);
  if (!options.keepStatus) setGroupStatus('Новая группа', 'neutral');
  elements.openAiSaveGroupButton.textContent = 'Сохранить группу';
}

function setGroupStatus(message, tone = 'neutral') {
  elements.openAiGroupStatus.textContent = message;
  elements.openAiGroupStatus.className = `section-status ${tone}`;
}

function handleGroupListClick(event) {
  const button = event.target.closest('button[data-group-action]');
  if (!button) return;

  const group = groupById(button.dataset.groupId);
  if (!group) return;

  if (button.dataset.groupAction === 'edit') {
    loadGroupIntoForm(group);
    return;
  }

  if (button.dataset.groupAction === 'delete') {
    deleteGroup(group.id);
  }
}

function loadGroupIntoForm(group) {
  editingGroupId = group.id;
  elements.openAiGroupName.value = group.name;
  const displayRange = groupRangeInDisplayTimeZone(group);
  elements.openAiGroupFrom.value = displayRange.from.slice(0, 16);
  elements.openAiGroupTo.value = displayRange.to.slice(0, 16);
  renderGroupChannelPicker(group.channels);
  elements.openAiSaveGroupButton.textContent = 'Обновить группу';
  setGroupStatus('Редактирование', 'busy');
}

function deleteGroup(groupId) {
  openAiGroups = openAiGroups.filter(group => group.id !== groupId);
  openAiActions = openAiActions
    .map(action => ({ ...action, groupIds: action.groupIds.filter(id => id !== groupId) }))
    .filter(action => action.groupIds.length);
  if (editingGroupId === groupId) resetGroupForm();
  saveOpenAiGroups();
  saveOpenAiActions();
  renderOpenAiGroups();
  renderOpenAiActions();
  renderActionGroupPicker(selectedActionDialogGroupIds());
  setGroupStatus('Группа удалена', 'warn');
}

function openActionDialog(action = null) {
  if (action && isActionBusy(action.id)) return;
  elements.saveActionButton.disabled = false;
  editingActionId = action?.id || null;
  elements.actionDialogTitle.textContent = action ? 'Изменить действие' : 'Создать действие';
  elements.actionName.value = action?.name || '';
  elements.actionQuestion.value = action?.question || '';
  elements.actionDestination.value = action?.destination || 'email';
  elements.actionPeriodMode.value = action?.periodMode || 'daily';
  elements.actionDayPreset.value = action?.dayPreset || 'today';
  elements.actionCustomDate.value = action?.customDate || toDateInputLocal(new Date());
  elements.actionRunOnWeekends.checked = action ? Boolean(action.runOnWeekends) : false;
  elements.actionReportDaily.checked = Boolean(action?.reportDaily);
  elements.actionReportWeekly.checked = Boolean(action?.reportWeekly);
  renderActionGroupPicker(action?.groupIds || []);
  updateActionPeriodModeUi();
  elements.saveActionButton.textContent = action ? 'Обновить действие' : 'Сохранить действие';
  elements.actionDialog.showModal();
}

function closeActionDialog() {
  editingActionId = null;
  elements.actionDialog.close();
}

function saveActionFromDialog() {
  const groupIds = selectedActionDialogGroupIds();
  const question = elements.actionQuestion.value.trim();
  const destination = elements.actionDestination.value === 'drive' ? 'drive' : 'email';
  const periodMode = normalizePeriodMode(elements.actionPeriodMode.value);
  const dayPreset = elements.actionDayPreset.value || 'today';
  const customDate = elements.actionCustomDate.value || toDateInputLocal(new Date());
  const name = elements.actionName.value.trim() || firstMeaningfulLine(question) || `Действие ${openAiActions.length + 1}`;
  const canSchedule = periodMode === 'daily' || periodMode === 'weekly';
  const canSendReports = destination === 'email' && canSchedule;

  if (!groupIds.length) {
    setOpenAiStatus('Выберите группы для действия');
    return;
  }
  if (destination === 'email' && !question) {
    setOpenAiStatus('Введите вопрос для действия');
    elements.actionQuestion.focus();
    return;
  }
  if (canSchedule && dayPreset === 'custom' && !customDate) {
    setOpenAiStatus('Укажите дату запуска');
    elements.actionCustomDate.focus();
    return;
  }

  const previous = editingActionId ? openAiActions.find(action => action.id === editingActionId) : null;
  if (editingActionId && isActionBusy(editingActionId)) {
    setOpenAiStatus('Сначала остановите фоновое действие');
    return;
  }
  const action = {
    id: editingActionId || createId('action'),
    name,
    groupIds,
    question,
    destination,
    periodMode,
    dayPreset,
    customDate,
    reportDaily: canSendReports && elements.actionReportDaily.checked,
    reportWeekly: canSendReports && elements.actionReportWeekly.checked,
    runOnWeekends: canSchedule && elements.actionRunOnWeekends.checked,
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRun: previous?.lastRun || null
  };

  openAiActions = previous
    ? openAiActions.map(item => item.id === action.id ? action : item)
    : [...openAiActions, action];
  saveOpenAiActions();
  renderOpenAiActions();
  closeActionDialog();
  setOpenAiStatus('Действие сохранено');
}

function handleActionListClick(event) {
  const button = event.target.closest('button[data-action-command]');
  if (!button) return;

  const action = actionById(button.dataset.actionId);
  if (!action) return;
  if (button.disabled) return;
  if (button.dataset.actionCommand === 'stop') {
    if (activeOpenAiActionId === action.id) stopOpenAiWorkflow();
    else void stopScheduledAction(action).catch(error => {
      actionRunNotices.set(action.id, { message: `Ошибка остановки: ${error.message}`, error: true });
      renderOpenAiActions();
    });
    return;
  }
  if (isActionBusy(action.id)) return;

  if (button.dataset.actionCommand === 'run') {
    if (action.destination === 'drive' || action.periodMode !== 'once') {
      void triggerScheduledOpenAiAction(action).catch(error => {
        const message = `Ошибка запуска: ${error.message || error}`;
        actionRunNotices.set(action.id, { message, error: true });
        renderOpenAiActions();
        setOpenAiStatus(message);
        setTranscript(elements.openAiAnswer, elements.openAiAnswerStatus, message, 'Не запущено');
        logError(error);
      });
    } else {
      void runOpenAiWorkflow(action).catch(error => {
        setOpenAiStatus(`Ошибка запуска: ${error.message || error}`);
        logError(error);
      });
    }
    return;
  }
  if (button.dataset.actionCommand === 'edit') {
    openActionDialog(action);
    return;
  }
  if (button.dataset.actionCommand === 'delete') {
    deleteAction(action.id);
  }
}

async function triggerScheduledOpenAiAction(action) {
  pendingActionCommands.set(action.id, 'run');
  try {
    actionRunNotices.set(action.id, { message: 'Ставлю действие в фоновую очередь…', error: false });
    renderOpenAiActions();
    const data = await api('/api/storage/action-trigger', { method: 'POST', body: { actionId: action.id } });
    const status = ['running', 'stopping'].includes(data.status) ? data.status : 'queued';
    schedulerState ||= { schedules: {} };
    schedulerState.schedules ||= {};
    schedulerState.schedules[action.id] = { state: status, run: null };
    const message = data.message || 'Действие поставлено в фоновую очередь.';
    actionRunNotices.set(action.id, { message, error: false });
    setOpenAiStatus(message);
    setTranscript(elements.openAiAnswer, elements.openAiAnswerStatus, message, OPENAI_STAGE_LABELS[status] || 'Выполняется');
  } finally {
    pendingActionCommands.delete(action.id);
    await refreshPersistedActionState();
    renderOpenAiActions();
  }
}

async function stopScheduledAction(action) {
  pendingActionCommands.set(action.id, 'stop');
  renderOpenAiActions();
  try {
    const result = await api('/api/storage/action-stop', { method: 'POST', body: { actionId: action.id } });
    const schedule = schedulerState?.schedules?.[action.id];
    if (schedule) schedule.state = result.status;
    actionRunNotices.delete(action.id);
  } finally {
    pendingActionCommands.delete(action.id);
    await refreshPersistedActionState();
    renderOpenAiActions();
  }
}

function deleteAction(actionId) {
  if (isActionBusy(actionId)) return;
  openAiActions = openAiActions.filter(action => action.id !== actionId);
  if (activeOpenAiActionId === actionId) {
    stopOpenAiWorkflow();
    activeOpenAiActionId = null;
  }
  saveOpenAiActions();
  renderOpenAiActions();
  setOpenAiStatus('Действие удалено');
}

function updateActionPeriodModeUi() {
  const scheduled = elements.actionPeriodMode.value !== 'once';
  const email = elements.actionDestination.value !== 'drive';
  elements.actionDayPresetLabel.hidden = !scheduled;
  elements.actionCustomDateLabel.hidden = !scheduled || elements.actionDayPreset.value !== 'custom';
  elements.actionScheduleOptions.hidden = !scheduled;
  elements.actionReportOptions.hidden = !scheduled || !email;
  elements.actionQuestionField.hidden = !email;
  elements.actionDestinationHint.textContent = email
    ? 'OpenAI подготовит отчёт и отправит его на указанные почты.'
    : 'Для каждой полностью обработанной камеры TXT сначала сохраняется на компьютере, затем отправляется на Google Диск отдельной очередью. При ошибке неполный TXT не выгружается. OpenAI и почта не используются.';
  if (!scheduled) {
    elements.actionRunOnWeekends.checked = false;
  }
  if (!scheduled || !email) {
    elements.actionReportDaily.checked = false;
    elements.actionReportWeekly.checked = false;
  }
}

function selectedGroupFormChannels() {
  return [...elements.openAiGroupChannelGrid.querySelectorAll('input[data-channel]:checked')]
    .map(input => clamp(Number(input.dataset.channel), 1, CHANNEL_COUNT));
}

function selectedActionDialogGroupIds() {
  return [...elements.actionGroupList.querySelectorAll('input[data-group-id]:checked')]
    .map(input => input.dataset.groupId)
    .filter(Boolean);
}

function selectedActionGroups(action) {
  return (action?.groupIds || [])
    .map(groupById)
    .filter(Boolean);
}

function resolveActionSelections(action) {
  const groups = selectedActionGroups(action);
  const result = [];

  for (const group of groups) {
    const ranges = resolveGroupRangesForAction(group, action);

    for (const range of ranges) {
      for (const channel of group.channels) {
        result.push({
          groupId: group.id,
          groupName: group.name,
          channel,
          from: range.from,
          to: range.to,
          rangeSeconds: secondsBetween(range.from, range.to)
        });
      }
    }
  }

  return result.filter(selection => selection.rangeSeconds > 0);
}

function resolveGroupRangesForAction(group, action) {
  if (action.periodMode === 'once') {
    const from = localValueToIso(group.from, group.timeZone || DEFAULT_CAMERA_TIME_ZONE);
    const to = localValueToIso(group.to, group.timeZone || DEFAULT_CAMERA_TIME_ZONE);
    return secondsBetween(from, to) > 0 ? [{ from, to }] : [];
  }

  const dates = action.periodMode === 'weekly'
    ? resolveWeeklyActionDates(action)
    : [resolveDailyActionDate(action)];

  return dates.filter(date => action.periodMode !== 'daily' || action.runOnWeekends || !isWeekendDatePart(date)).map(date => {
    const displayRange = groupRangeInDisplayTimeZone(group);
    const fromLocal = combineDateAndTime(date, timeOnly(displayRange.from));
    let toLocal = combineDateAndTime(date, timeOnly(displayRange.to));

    if (displayRange.to.slice(0, 10) !== displayRange.from.slice(0, 10)
      || localWallClockSeconds(toLocal) <= localWallClockSeconds(fromLocal)) {
      toLocal = combineDateAndTime(offsetDatePart(date, 1), timeOnly(displayRange.to));
    }
    const from = localValueToIso(fromLocal, displayTimeZone());
    const to = localValueToIso(toLocal, displayTimeZone());
    return secondsBetween(from, to) > 0 ? { from, to } : null;
  }).filter(Boolean);
}

function resolveDailyActionDate(action) {
  if (action.dayPreset === 'custom' && action.customDate) return action.customDate;
  const offset = {
    yesterday: -1,
    today: 0,
    tomorrow: 1
  }[action.dayPreset] ?? 0;
  let date = offsetDatePart(zonedDatePart(new Date(), displayTimeZone()), offset);
  if (action.dayPreset === 'yesterday' && !action.runOnWeekends) {
    while (isWeekendDatePart(date)) date = offsetDatePart(date, -1);
  }
  return date;
}

function resolveWeeklyActionDates(action) {
  const start = startOfWeekDatePart(resolveDailyActionDate(action));
  return Array.from({ length: 5 }, (_, index) => offsetDatePart(start, index));
}

function updateActionLastRun(actionId, lastRun) {
  const action = actionById(actionId);
  openAiActions = openAiActions.map(action => action.id === actionId ? { ...action, lastRun } : action);
  saveOpenAiActions();
  const persistence = persistActionRun(action, lastRun);
  renderOpenAiActions();
  return persistence;
}

function persistActionRun(action, lastRun) {
  if (!action || !lastRun?.status) return;
  const timestamp = lastRun.at || new Date().toISOString();
  return syncStorage('/api/storage/action-run', {
    ...lastRun,
    actionId: action.id,
    actionName: action.name,
    startedAt: lastRun.startedAt || timestamp,
    finishedAt: lastRun.finishedAt || timestamp,
    details: {
      ...lastRun,
      action: {
        id: action.id,
        name: action.name,
        groupIds: action.groupIds,
        periodMode: action.periodMode,
        dayPreset: action.dayPreset,
        customDate: action.customDate,
        destination: action.destination,
        reportDaily: action.reportDaily,
        reportWeekly: action.reportWeekly,
        runOnWeekends: action.runOnWeekends
      }
    }
  });
}

async function runOpenAiWorkflow(action) {
  // Drive work always uses the server pipeline: completeness checks, durable
  // local results and delivery retries must not depend on an open browser tab.
  if (action?.destination === 'drive') return triggerScheduledOpenAiAction(action);
  stopOpenAiWorkflow({ quiet: true });

  const selections = resolveActionSelections(action);
  const question = String(action?.question || '').trim();
  const destination = action?.destination === 'drive' ? 'drive' : 'email';

  if (!action) {
    setOpenAiStatus('Выберите действие');
    return;
  }
  if (!selections.length) {
    const requestedDate = action.periodMode === 'daily' ? resolveDailyActionDate(action) : '';
    const message = requestedDate && !action.runOnWeekends && isWeekendDatePart(requestedDate)
      ? 'Период попадает на выходной. Включите обработку выходных или выберите другую дату.'
      : 'В действии нет доступных групп или периодов.';
    setOpenAiStatus(message);
    setTranscript(elements.openAiAnswer, elements.openAiAnswerStatus, message, 'Не запущено');
    await updateActionLastRun(action.id, {
      status: 'error',
      at: new Date().toISOString(),
      error: message,
      stage: 'search',
      scheduled: false
    });
    return;
  }
  if (destination === 'email' && !question) {
    setOpenAiStatus('В действии нет вопроса');
    return;
  }

  const runId = openAiRunId + 1;
  openAiRunId = runId;
  openAiController = new AbortController();
  activeOpenAiActionId = action.id;
  const startedAt = new Date().toISOString();
  activeOpenAiActionStartedAt = startedAt;
  const signal = openAiController.signal;
  const contextLines = [];
  const transcriptEntries = [];
  const progress = createOpenAiProgressState(action, selections);
  let answerData = null;
  let reportData = null;
  let driveData = null;
  let manualClaim = null;

  renderOpenAiActions();
  setOpenAiBusy(true);
  startOpenAiRunProgress(progress);
  setTranscript(elements.openAiTranscript, elements.openAiTranscriptStatus, 'Нет текста', 'Готовлю');
  setTranscript(elements.openAiAnswer, elements.openAiAnswerStatus, 'Нет ответа', 'Ожидает');
  elements.openAiAnswer.classList.add('is-empty');

  try {
    manualClaim = await api('/api/storage/action-run/start', {
      method: 'POST',
      body: {
        actionId: action.id,
        periodMode: action.periodMode,
        from: progress.from,
        to: progress.to,
        startedAt
      },
      signal
    });

    for (const [selectionIndex, selection] of selections.entries()) {
      ensureOpenAiRun(runId, signal);
      const selectionLabel = `${selection.groupName} · ${channelLabel(selection.channel)}`;
      setOpenAiStage(progress, 'search', `Ищу записи: ${selectionLabel}`);
      progress.currentChannel = selection.channel;
      progress.currentGroupName = selection.groupName;
      progress.currentFrom = selection.from;
      progress.currentTo = selection.to;
      const channelProgressStart = progress.completedSeconds;

      const query = new URLSearchParams(cameraParamsForChannel(selection.channel));
      query.set('from', selection.from);
      query.set('to', selection.to);
      query.set('timeZone', displayTimeZone());
      query.set('cameraTimeZone', cameraTimeZone());
      query.set('_', Date.now());

      const searchPath = `/api/recordings/search?${query}`;
      let searchData;
      try {
        searchData = await api(searchPath, { signal });
      } catch (error) {
        throw enrichOpenAiError(error, progress, {
          stage: 'search',
          groupName: selection.groupName,
          channel: selection.channel,
          endpoint: searchPath,
          from: selection.from,
          to: selection.to
        });
      }
      if (searchData.vendor && elements.vendor.value === 'auto' && [...elements.vendor.options].some(option => option.value === searchData.vendor)) {
        elements.vendor.value = searchData.vendor;
        saveUiSettings();
      }
      if (searchData.warning) {
        appendOpenAiRunLog(`${selectionLabel}: ${searchData.warning}`);
        appendOpenAiNotice(`${selectionLabel}: ${searchData.warning}`);
      }

      const cameraFrom = searchData.cameraFrom || localValueInZone(selection.from, cameraTimeZone());
      const cameraTo = searchData.cameraTo || localValueInZone(selection.to, cameraTimeZone());
      const items = (searchData.items || [])
        .map(item => ({ item, coverage: recordingCoverage(item, cameraFrom, cameraTo) }))
        .filter(entry => entry.coverage && entry.coverage.durationSeconds > 0);

      progress.knownRecordings += items.length;
      appendOpenAiRunLog(`Найдено записей: ${selectionLabel} - ${items.length}`);
      updateOpenAiProgressView(progress, Math.max(progress.percent, ((selectionIndex + 1) / selections.length) * 18));

      if (!items.length) {
        appendOpenAiNotice(`${selectionLabel}: записи не найдены`);
        progress.completedSeconds += selection.rangeSeconds;
        progress.completedChannels += 1;
        updateOpenAiProgressView(progress, transcriptionProgressPercent(progress));
        continue;
      }

      setOpenAiStage(progress, 'transcribe', `Распознаю ${selectionLabel}`);
      for (const entry of items) {
        await transcribeOpenAiRecording({
          groupName: selection.groupName,
          channel: selection.channel,
          item: entry.item,
          coverage: entry.coverage,
          contextLines,
          transcriptEntries,
          progress,
          runId,
          signal
        });
      }

      progress.completedSeconds = Math.max(progress.completedSeconds, channelProgressStart + selection.rangeSeconds);
      progress.completedChannels += 1;
      updateOpenAiProgressView(progress, transcriptionProgressPercent(progress));
    }

    ensureOpenAiRun(runId, signal);
    elements.openAiTranscriptStatus.textContent = contextLines.length ? 'Транскрибация готова' : 'Текст не найден';
    if (destination === 'drive') {
      setOpenAiStage(progress, 'drive', 'Загружаю TXT-файлы на Google Диск');
      updateOpenAiProgressView(progress, 96);
      elements.openAiAnswerStatus.textContent = 'Google Диск';
      try {
        driveData = await api('/api/drive/transcripts', {
          method: 'POST',
          body: {
            action: { id: action.id, name: action.name, periodMode: action.periodMode, destination },
            runKey: manualClaim?.runKey || `manual:${startedAt}`,
            from: progress.from,
            to: progress.to,
            timeZone: displayTimeZone(),
            selections: selections.map(selection => ({
              channel: selection.channel,
              label: channelLabel(selection.channel),
              groupName: selection.groupName,
              from: selection.from,
              to: selection.to
            })),
            entries: transcriptEntries
          },
          signal
        });
      } catch (error) {
        throw enrichOpenAiError(error, progress, {
          stage: 'drive',
          endpoint: '/api/drive/transcripts',
          transcriptLines: contextLines.length
        });
      }
      answerData = { answer: `На Google Диск загружено файлов: ${driveUploadsSummary(driveData.uploads)}`, model: '', responseId: '' };
      elements.openAiAnswer.textContent = answerData.answer;
      elements.openAiAnswer.classList.remove('is-empty');
      elements.openAiAnswerStatus.textContent = 'Загружено';
      appendOpenAiRunLog(answerData.answer);
    } else {
      setOpenAiStage(progress, 'ask', 'Отправляю вопрос в OpenAI');
      updateOpenAiProgressView(progress, 92);
      elements.openAiAnswerStatus.textContent = 'Запрос';

      try {
        answerData = await api('/api/openai/ask', {
        method: 'POST',
        body: {
          question,
          transcript: contextLines.join('\n'),
          from: progress.from,
          to: progress.to,
          action: {
            id: action.id,
            name: action.name,
            periodMode: action.periodMode
          },
          groups: selectedActionGroups(action).map(group => ({
            id: group.id,
            name: group.name,
            channels: group.channels,
            from: group.from,
            to: group.to,
            timeZone: group.timeZone
          })),
          channels: selections.map(selection => ({
            channel: selection.channel,
            label: channelLabel(selection.channel),
            group: selection.groupName,
            from: selection.from,
            to: selection.to
          }))
        },
        signal
        });
      } catch (error) {
        throw enrichOpenAiError(error, progress, {
          stage: 'ask',
          endpoint: '/api/openai/ask',
          transcriptLines: contextLines.length
        });
      }

    ensureOpenAiRun(runId, signal);
    elements.openAiAnswer.textContent = answerData.answer || 'Нет ответа';
    elements.openAiAnswer.classList.toggle('is-empty', !answerData.answer);
    elements.openAiAnswerStatus.textContent = answerData.model || 'Готово';

      const reportTypes = actionReportTypes(action);
      if (reportTypes.length) {
      setOpenAiStage(progress, 'report', 'Отправляю отчёт на почту');
      updateOpenAiProgressView(progress, 96);
      try {
        reportData = await sendActionReports({
          action,
          selections,
          progress,
          question,
          answerData,
          transcript: contextLines.join('\n'),
          reportTypes,
          deliveryKey: manualClaim?.deliveryKey || '',
          signal
        });
        appendOpenAiRunLog(`Отчёт отправлен: ${reportTypes.map(reportTypeLabel).join(', ')}`);
      } catch (error) {
        throw enrichOpenAiError(error, progress, {
          stage: 'report',
          endpoint: '/api/reports/send',
          transcriptLines: contextLines.length
        });
      }
      }
    }

    setOpenAiStage(progress, 'done', 'Готово');
    updateOpenAiProgressView(progress, 100);
    await updateActionLastRun(action.id, {
      status: 'success',
      startedAt,
      at: new Date().toISOString(),
      from: progress.from,
      to: progress.to,
      periodMode: action.periodMode,
      scheduled: false,
      runKey: manualClaim?.runKey || '',
      deliveryKey: manualClaim?.deliveryKey || '',
      model: answerData.model || '',
      responseId: answerData.responseId || '',
      answer: answerData.answer || '',
      transcriptLines: contextLines.length,
      selections: selections.length,
      reports: reportData?.sent || [],
      uploads: driveData?.uploads || []
    });
    log({
      ok: true,
      openAi: 'answer',
      action: action.name,
      model: answerData.model,
      responseId: answerData.responseId,
      tookMs: answerData.tookMs,
      transcriptLines: contextLines.length
    });
  } catch (error) {
    if (error.name === 'AbortError' || signal.aborted || error.statusCode === 499) {
      setOpenAiStatus('Остановлено');
      elements.openAiAnswerStatus.textContent = 'Остановлено';
      appendOpenAiRunLog('Остановлено пользователем');
      await updateActionLastRun(action.id, {
        status: 'stopped',
        startedAt,
        at: new Date().toISOString(),
        from: progress.from,
        to: progress.to,
        periodMode: action.periodMode,
        scheduled: false,
        runKey: manualClaim?.runKey || '',
        deliveryKey: manualClaim?.deliveryKey || '',
        error: 'Остановлено пользователем'
      });
      return;
    }

    setOpenAiStage(progress, 'error', 'Ошибка');
    renderOpenAiWorkflowError(error, progress);
    elements.openAiTranscriptStatus.textContent = elements.openAiTranscript.textContent.trim() ? elements.openAiTranscriptStatus.textContent : 'Ошибка';
    if (error.openAiContext?.stage === 'ask') {
      setTranscript(elements.openAiAnswer, elements.openAiAnswerStatus, `Ошибка OpenAI: ${error.message || error}`, 'Ошибка');
    } else if (error.openAiContext?.stage === 'report') {
      setTranscript(
        elements.openAiAnswer,
        elements.openAiAnswerStatus,
        `${answerData?.answer || 'Ответ получен.'}\n\nОшибка отправки отчёта: ${error.message || error}`,
        'Ошибка отчёта'
      );
    } else {
      setTranscript(
        elements.openAiAnswer,
        elements.openAiAnswerStatus,
        `Запрос в OpenAI не выполнялся: ошибка на этапе "${error.openAiContext?.stageLabel || 'выполнение'}".`,
        'Не отправлялось'
      );
    }
    const deliveryUncertain = Boolean(error?.details?.deliveryUncertain);
    await updateActionLastRun(action.id, {
      status: deliveryUncertain ? 'delivery_uncertain' : 'error',
      startedAt,
      at: new Date().toISOString(),
      from: progress.from,
      to: progress.to,
      periodMode: action.periodMode,
      scheduled: false,
      runKey: manualClaim?.runKey || '',
      deliveryKey: manualClaim?.deliveryKey || '',
      error: error.message || String(error),
      stage: error.openAiContext?.stage || progress.stage,
      answer: answerData?.answer || '',
      model: answerData?.model || '',
      responseId: answerData?.responseId || '',
      details: error?.details
    });
    logError(error);
  } finally {
    if (manualClaim?.runKey) {
      await syncStorage('/api/storage/action-run/release', {
        actionId: action.id,
        runKey: manualClaim.runKey
      }, { force: true });
    }
    if (runId === openAiRunId) {
      openAiController = null;
      activeOpenAiActionId = null;
      activeOpenAiActionStartedAt = null;
      setOpenAiBusy(false);
      renderOpenAiActions();
    }
  }
}

async function sendActionReports(options) {
  const recipients = reportEmailList();
  if (!recipients.length) {
    throw new Error('Укажите почты для отчётов в настройках.');
  }

  return api('/api/reports/send', {
    method: 'POST',
    body: {
      reportTypes: options.reportTypes,
      deliveryKey: options.deliveryKey || '',
      recipients,
      generatedAt: new Date().toISOString(),
      timeZone: displayTimeZone(),
      from: options.progress.from,
      to: options.progress.to,
      question: options.question,
      answer: options.answerData.answer || '',
      transcript: options.transcript || '',
      model: options.answerData.model || '',
      responseId: options.answerData.responseId || '',
      action: {
        id: options.action.id,
        name: options.action.name,
        periodMode: options.action.periodMode,
        reportDaily: options.action.reportDaily,
        reportWeekly: options.action.reportWeekly,
        runOnWeekends: options.action.runOnWeekends
      },
      groups: selectedActionGroups(options.action).map(group => ({
        id: group.id,
        name: group.name,
        channels: group.channels,
        from: group.from,
        to: group.to,
        timeZone: group.timeZone
      })),
      channels: options.selections.map(selection => ({
        channel: selection.channel,
        label: channelLabel(selection.channel),
        group: selection.groupName,
        from: selection.from,
        to: selection.to
      }))
    },
    signal: options.signal
  });
}

function actionReportTypes(action) {
  if (action.periodMode === 'daily' && action.reportDaily) return ['daily'];
  if (action.periodMode === 'weekly' && action.reportWeekly) return ['weekly'];
  return [];
}

function reportTypeLabel(reportType) {
  return reportType === 'weekly' ? 'за неделю' : 'за день';
}

async function transcribeOpenAiRecording(options) {
  let offsetSeconds = options.coverage.offsetSeconds;
  const endOffsetSeconds = options.coverage.offsetSeconds + options.coverage.durationSeconds;
  let chunksWithText = 0;

  while (offsetSeconds < endOffsetSeconds - 0.05) {
    ensureOpenAiRun(options.runId, options.signal);

    const remainingSeconds = Math.max(0, endOffsetSeconds - offsetSeconds);
    const durationSeconds = Math.min(getTranscriptSeconds(), remainingSeconds);
    const query = recordingQueryForChannel(options.item, options.channel, options.coverage);
    query.set('duration', String(durationSeconds));
    query.set('offsetSeconds', String(offsetSeconds));
    query.set('_', Date.now());

    const fromLabel = formatDurationLabel(offsetSeconds);
    const toLabel = formatDurationLabel(offsetSeconds + durationSeconds);
    setOpenAiStatus(`Распознаю ${channelLabel(options.channel)} ${fromLabel}-${toLabel}`);
    elements.openAiTranscriptStatus.textContent = `${channelLabel(options.channel)} ${fromLabel}-${toLabel}`;

    const transcriptPath = `/api/recordings/transcript?${query}`;
    let data;
    try {
      data = await api(transcriptPath, { signal: options.signal });
    } catch (error) {
      throw enrichOpenAiError(error, options.progress, {
        stage: 'transcribe',
        groupName: options.groupName,
        channel: options.channel,
        endpoint: transcriptPath,
        recording: recordingLabel(options.item),
        offsetSeconds,
        durationSeconds
      });
    }
    ensureOpenAiRun(options.runId, options.signal);

    const hadText = appendOpenAiTranscript(options.groupName, options.channel, options.item, data.segments, data.text);
    if (hadText) {
      chunksWithText += 1;
      options.progress.transcriptChunks += appendOpenAiContext(options.contextLines, options.groupName, options.channel, options.item, data.segments, data.text);
      appendDriveTranscriptEntries(
        options.transcriptEntries,
        options.groupName,
        options.channel,
        options.item,
        data.segments,
        data.text,
        {
          offsetSeconds: data.offsetSeconds !== undefined && data.offsetSeconds !== null && Number.isFinite(Number(data.offsetSeconds))
            ? Number(data.offsetSeconds)
            : offsetSeconds,
          durationSeconds: Number.isFinite(Number(data.durationSeconds)) && Number(data.durationSeconds) > 0
            ? Number(data.durationSeconds)
            : durationSeconds
        }
      );
    }

    const consumedSeconds = Math.max(0.5, Math.min(data.durationSeconds || durationSeconds, remainingSeconds));
    offsetSeconds += consumedSeconds;
    options.progress.completedSeconds += consumedSeconds;
    updateOpenAiProgressView(options.progress, transcriptionProgressPercent(options.progress));

    log({
      ok: true,
      transcript: 'openai',
      channel: options.channel,
      cached: Boolean(data.cached),
      offsetSeconds: data.offsetSeconds,
      durationSeconds: data.durationSeconds,
      tookMs: data.tookMs,
      model: data.model
    });

    await delay(150, options.signal);
  }

  if (chunksWithText === 0) {
    appendOpenAiNotice(`${options.groupName} · ${channelLabel(options.channel)}: речь не найдена в записи ${formatCameraTime(options.item.startTime)} - ${formatCameraTime(options.item.endTime)}`);
  }

  options.progress.completedRecordings += 1;
  updateOpenAiProgressView(options.progress, transcriptionProgressPercent(options.progress));
}

function stopOpenAiWorkflow(options = {}) {
  if (openAiController) {
    openAiController.abort();
    openAiController = null;
  }
  openAiRunId += 1;
  setOpenAiBusy(false);
  if (!options.quiet) {
    setOpenAiStatus('Остановлено');
    elements.openAiAnswerStatus.textContent = 'Остановлено';
  }
}

function ensureOpenAiRun(runId, signal) {
  if (signal.aborted || runId !== openAiRunId) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function setOpenAiBusy(isBusy) {
  elements.openAiCancelButton.disabled = !isBusy;
  elements.createActionButton.disabled = isBusy;
  elements.openAiSaveGroupButton.disabled = isBusy;
  elements.openAiResetGroupButton.disabled = isBusy;
  elements.openAiGroupSelectAllButton.disabled = isBusy;
  elements.openAiGroupClearButton.disabled = isBusy;
  elements.openAiGroupName.disabled = isBusy;
  elements.openAiGroupFrom.disabled = isBusy;
  elements.openAiGroupTo.disabled = isBusy;

  for (const input of elements.openAiGroupChannelGrid.querySelectorAll('input[data-channel]')) input.disabled = isBusy;
  for (const button of elements.openAiActionList.querySelectorAll('button')) button.disabled = isBusy;
  for (const button of elements.openAiGroupList.querySelectorAll('button')) button.disabled = isBusy;
}

function setOpenAiStatus(status) {
  elements.openAiStatus.textContent = status;
}

function setOpenAiProgress(percent) {
  const safePercent = clamp(percent, 0, 100);
  elements.openAiProgressBar.style.width = `${safePercent}%`;
  elements.openAiProgressSummary.textContent = `${Math.round(safePercent)}%`;
}

function createOpenAiProgressState(action, selections) {
  const from = earliestLocalDateTime(selections.map(selection => selection.from));
  const to = latestLocalDateTime(selections.map(selection => selection.to));

  return {
    stage: 'idle',
    errorStage: '',
    percent: 0,
    actionName: action?.name || '',
    destination: action?.destination === 'drive' ? 'drive' : 'email',
    from,
    to,
    totalChannels: selections.length,
    completedChannels: 0,
    currentChannel: null,
    currentGroupName: '',
    currentFrom: '',
    currentTo: '',
    knownRecordings: 0,
    completedRecordings: 0,
    completedSeconds: 0,
    estimatedSeconds: Math.max(1, selections.reduce((total, selection) => total + selection.rangeSeconds, 0)),
    transcriptChunks: 0
  };
}

function earliestLocalDateTime(values) {
  return sortedLocalDateTimes(values)[0] || '';
}

function latestLocalDateTime(values) {
  const sorted = sortedLocalDateTimes(values);
  return sorted[sorted.length - 1] || '';
}

function sortedLocalDateTimes(values) {
  return values
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .sort((left, right) => localDateTimeMs(left) - localDateTimeMs(right));
}

function localDateTimeMs(value) {
  try {
    return zonedDateTimeMs(value, displayTimeZone());
  } catch {
    return 0;
  }
}

function startOpenAiRunProgress(state) {
  elements.openAiError.hidden = true;
  elements.openAiError.textContent = '';
  elements.openAiRunLog.textContent = '';
  appendOpenAiRunLog(`Старт действия: ${state.actionName || 'без названия'}`);
  appendOpenAiRunLog(`Период: ${formatTime(state.from)} - ${formatTime(state.to)}, задач: ${state.totalChannels}`);
  setOpenAiStage(state, 'search', 'Поиск записей');
  const askStep = document.querySelector('[data-openai-stage="ask"]');
  const reportStep = document.querySelector('[data-openai-stage="report"]');
  elements.openAiAnswerTitle.textContent = state.destination === 'drive' ? 'Результат Google Диска' : 'Ответ ChatGPT';
  if (askStep) askStep.textContent = state.destination === 'drive' ? 'OpenAI не требуется' : 'Запрос OpenAI';
  if (reportStep) reportStep.textContent = state.destination === 'drive' ? 'Загрузка на Диск' : 'Отправка отчёта';
  updateOpenAiProgressView(state, 0);
}

function resetOpenAiProgressView() {
  const askStep = document.querySelector('[data-openai-stage="ask"]');
  const reportStep = document.querySelector('[data-openai-stage="report"]');
  elements.openAiAnswerTitle.textContent = 'Ответ ChatGPT';
  if (askStep) askStep.textContent = 'Запрос OpenAI';
  if (reportStep) reportStep.textContent = 'Отправка отчёта';
  setOpenAiProgress(0);
  elements.openAiProgressStage.textContent = OPENAI_STAGE_LABELS.idle;
  elements.openAiStageProgress.textContent = `0/${OPENAI_STAGE_ORDER.length}`;
  elements.openAiCameraProgress.textContent = '0/0';
  elements.openAiRecordingProgress.textContent = '0/0';
  elements.openAiTranscriptProgress.textContent = '0 фрагментов';
  elements.openAiError.hidden = true;
  elements.openAiError.textContent = '';
  elements.openAiRunLog.textContent = 'Журнал пуст';
  updateOpenAiStageTrack({ stage: 'idle' });
}

function setOpenAiStage(state, stage, status) {
  state.stage = stage;
  if (stage === 'error') state.errorStage = state.errorStage || state.openAiContext?.stage || '';
  const label = OPENAI_STAGE_LABELS[stage] || stage;
  setOpenAiStatus(status || label);
  elements.openAiProgressStage.textContent = status || label;
  if (stage !== 'error') {
    appendOpenAiRunLog(status || label);
  }
  updateOpenAiProgressView(state);
}

function updateOpenAiProgressView(state, percent = state.percent) {
  state.percent = clamp(percent, 0, 100);
  setOpenAiProgress(state.percent);
  elements.openAiStageProgress.textContent = `${completedOpenAiStageCount(state)}/${OPENAI_STAGE_ORDER.length}`;
  elements.openAiCameraProgress.textContent = `${state.completedChannels}/${state.totalChannels}`;
  elements.openAiRecordingProgress.textContent = `${state.completedRecordings}/${state.knownRecordings}`;
  elements.openAiTranscriptProgress.textContent = `${formatDurationLabel(state.completedSeconds)} · ${state.transcriptChunks} фрагментов`;
  updateOpenAiStageTrack(state);
}

function updateOpenAiStageTrack(state) {
  const activeStage = openAiStageTrackKey(state.errorStage || state.stage);
  const activeIndex = OPENAI_STAGE_ORDER.indexOf(activeStage);
  const doneCount = completedOpenAiStageCount(state);

  for (const item of document.querySelectorAll('[data-openai-stage]')) {
    const index = OPENAI_STAGE_ORDER.indexOf(item.dataset.openaiStage);
    item.classList.toggle('done', index >= 0 && index < doneCount);
    item.classList.toggle('active', item.dataset.openaiStage === openAiStageTrackKey(state.stage) && state.stage !== 'error');
    item.classList.toggle('error', state.stage === 'error' && index === activeIndex);
  }
}

function completedOpenAiStageCount(state) {
  if (state.stage === 'done') return OPENAI_STAGE_ORDER.length;
  const stage = openAiStageTrackKey(state.stage === 'error' ? state.errorStage : state.stage);
  const index = OPENAI_STAGE_ORDER.indexOf(stage);
  return index > 0 ? index : 0;
}

function openAiStageTrackKey(stage) {
  return stage === 'drive' ? 'report' : stage;
}

function transcriptionProgressPercent(state) {
  return Math.min(90, 18 + ((state.completedSeconds / state.estimatedSeconds) * 72));
}

function appendOpenAiRunLog(message) {
  const current = elements.openAiRunLog.textContent === 'Журнал пуст' ? '' : elements.openAiRunLog.textContent;
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: displayTimeZone(),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date());
  const lines = `${current}${current ? '\n' : ''}[${time}] ${message}`.split('\n').slice(-80);
  elements.openAiRunLog.textContent = lines.join('\n');
  elements.openAiRunLog.scrollTop = elements.openAiRunLog.scrollHeight;
}

function enrichOpenAiError(error, state, context = {}) {
  const result = error instanceof Error ? error : new Error(String(error));
  const stage = context.stage || state.stage;
  result.openAiContext = {
    stage,
    stageLabel: OPENAI_STAGE_LABELS[stage] || stage,
    groupName: context.groupName || state.currentGroupName,
    channel: context.channel || state.currentChannel,
    endpoint: context.endpoint || result.path || '',
    from: context.from || state.currentFrom || state.from,
    to: context.to || state.currentTo || state.to,
    recording: context.recording || '',
    offsetSeconds: context.offsetSeconds,
    durationSeconds: context.durationSeconds,
    transcriptLines: context.transcriptLines
  };
  state.errorStage = stage;
  return result;
}

function renderOpenAiWorkflowError(error, state) {
  const context = error.openAiContext || {};
  const lines = [
    `Этап: ${context.stageLabel || OPENAI_STAGE_LABELS.error}`,
    context.groupName ? `Группа: ${context.groupName}` : '',
    context.channel ? `Камера: ${String(context.channel).padStart(2, '0')} · ${channelLabel(context.channel)}` : '',
    context.recording ? `Запись: ${context.recording}` : '',
    `Период: ${formatTime(context.from || state.from)} - ${formatTime(context.to || state.to)}`,
    `Готово: ${Math.round(state.percent)}%, этапы ${completedOpenAiStageCount(state)}/${OPENAI_STAGE_ORDER.length}, камеры ${state.completedChannels}/${state.totalChannels}, записи ${state.completedRecordings}/${state.knownRecordings}`,
    `Транскрибировано: ${formatDurationLabel(state.completedSeconds)}, фрагментов текста: ${state.transcriptChunks}`,
    context.offsetSeconds !== undefined ? `Фрагмент: ${formatDurationLabel(context.offsetSeconds)}-${formatDurationLabel(Number(context.offsetSeconds) + Number(context.durationSeconds || 0))}` : '',
    error.statusCode ? `HTTP: ${error.statusCode}` : '',
    context.endpoint ? `Endpoint: ${context.endpoint}` : '',
    `Ошибка: ${error.message || error}`,
    error.details ? `Детали: ${formatErrorDetails(error.details)}` : ''
  ].filter(Boolean);

  elements.openAiError.textContent = lines.join('\n');
  elements.openAiError.hidden = false;
  appendOpenAiRunLog(`Ошибка на этапе "${context.stageLabel || 'выполнение'}": ${error.message || error}`);
  updateOpenAiProgressView(state);
}

function formatErrorDetails(details) {
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

function handlePlaybackSettingChanged(kind) {
  saveUiSettings();
  updateActiveChannelUi();
  const archiveWasPlaying = lastArchiveItem && elements.archiveAudio.currentSrc && !elements.archiveAudio.paused;
  const liveWasPlaying = elements.liveAudio.currentSrc && !elements.liveAudio.paused;

  if (archiveWasPlaying) {
    playArchiveRecording(lastArchiveItem, `${kind} changed`);
  }
  if (liveWasPlaying) {
    startLiveAudio(`${kind} changed`).then(() => startLiveTranscription({ reset: false })).catch(logError);
  }
  if (!archiveWasPlaying && !liveWasPlaying) {
    log({ ok: true, setting: kind, applied: 'next playback' });
  }
}

async function loadPersistedState() {
  try {
    const data = await api('/api/storage');
    storageAvailable = true;
    applySchedulerState(data.scheduler);
    const previousDisplayTimeZone = displayTimeZone();

    if (data.settings && typeof data.settings === 'object') {
      uiSettings = { ...uiSettings, ...data.settings };
      localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(uiSettings));
    }
    if (data.selectedChannel !== null && data.selectedChannel !== undefined) {
      selectedChannel = clamp(Number(data.selectedChannel), 1, CHANNEL_COUNT);
      localStorage.setItem(STORAGE_KEYS.selectedChannel, String(selectedChannel));
    }
    if (Array.isArray(data.channelLabels) && data.channelLabels.length) {
      channelLabels = mergeStoredChannelLabels(data.channelLabels);
      localStorage.setItem(STORAGE_KEYS.channelLabels, JSON.stringify(channelLabels));
    }
    if (Array.isArray(data.groups) && data.groups.length) {
      openAiGroups = data.groups.map(normalizeOpenAiGroup).filter(Boolean);
      localStorage.setItem(STORAGE_KEYS.openAiGroups, JSON.stringify(openAiGroups));
    }
    if (Array.isArray(data.actions) && data.actions.length) {
      openAiActions = data.actions.map(normalizeOpenAiAction).filter(Boolean);
      localStorage.setItem(STORAGE_KEYS.openAiActions, JSON.stringify(openAiActions));
    }

    applySettingsToControls();
    convertDateTimeInputsBetweenZones(previousDisplayTimeZone, displayTimeZone());
    renderChannelButtons();
    renderChannelNameFields();
    renderGroupChannelPicker();
    renderOpenAiGroups();
    renderOpenAiActions();
    renderActionGroupPicker(selectedActionDialogGroupIds());
    selectChannel(selectedChannel, { quiet: true });

    await migrateLocalStorageToPostgres(data);
    setGroupStatus('Данные загружены из PostgreSQL', 'good');
  } catch (error) {
    storageAvailable = false;
    log({ ok: false, storage: 'postgres', error: error.message || String(error) });
  } finally {
    storageHydrated = true;
  }
}

async function refreshPersistedActionState() {
  if (!storageHydrated || actionStateRefreshing) return;
  actionStateRefreshing = true;

  try {
    const data = await api('/api/storage/action-status');
    const before = JSON.stringify([openAiActions, schedulerState?.schedules]);
    applySchedulerState(data.scheduler);
    if (Array.isArray(data.actions)) {
      openAiActions = data.actions.map(action => action.id === activeOpenAiActionId ? actionById(action.id) : normalizeOpenAiAction(action)).filter(Boolean);
      localStorage.setItem(STORAGE_KEYS.openAiActions, JSON.stringify(openAiActions));
    }
    for (const [id, notice] of actionRunNotices) {
      if (!notice.error && !pendingActionCommands.has(id)) actionRunNotices.delete(id);
    }
    if (before !== JSON.stringify([openAiActions, schedulerState?.schedules])) renderOpenAiActions();
    else updateActionCountdowns();
    if (editingActionId) elements.saveActionButton.disabled = isActionBusy(editingActionId);
    storageAvailable = true;
  } catch (error) {
    storageAvailable = false;
    console.warn('Storage refresh failed:', error);
  } finally {
    actionStateRefreshing = false;
  }
}

async function migrateLocalStorageToPostgres(data) {
  await syncStorage('/api/storage/settings', {
    settings: uiSettings,
    selectedChannel
  }, { force: true });

  if (!Array.isArray(data.channelLabels) || !data.channelLabels.length) {
    await syncStorage('/api/storage/channel-labels', { labels: channelLabels }, { force: true });
  }
  if ((!Array.isArray(data.groups) || !data.groups.length) && openAiGroups.length) {
    await syncStorage('/api/storage/groups', { groups: openAiGroups }, { force: true });
  }
  if ((!Array.isArray(data.actions) || !data.actions.length) && openAiActions.length) {
    await syncStorage('/api/storage/actions', { actions: openAiActions }, { force: true });
  }
}

function mergeStoredChannelLabels(rows) {
  const labels = Array.from({ length: CHANNEL_COUNT }, (_, index) => channelLabels[index] || `Канал ${index + 1}`);
  for (const row of rows) {
    const channel = Number(row?.channel);
    if (!Number.isFinite(channel) || channel < 1 || channel > CHANNEL_COUNT) continue;
    labels[channel - 1] = String(row.label || `Канал ${channel}`);
  }
  return labels;
}

async function syncStorage(path, body, options = {}) {
  if (!storageHydrated && !options.force) return null;
  try {
    const data = await api(path, { method: 'POST', body });
    storageAvailable = true;
    return data;
  } catch (error) {
    storageAvailable = false;
    console.warn(`Storage sync failed for ${path}:`, error);
    return null;
  }
}

async function loadHealth() {
  const modelRevision = transcriptionModelRevision;
  try {
    const data = await api('/api/health');
    if (modelRevision === transcriptionModelRevision) renderTranscriptionStatus(data.transcriber);
    if (!localStorage.getItem(STORAGE_KEYS.settings)) {
      uiSettings = {
        vendor: data.config.vendor || 'auto',
        stream: 'main',
        audioFilter: data.config.audioFilter || 'voice',
        transcriptSeconds: data.config.transcription?.liveSeconds || DEFAULT_TRANSCRIPT_SECONDS
      };
      applySettingsToControls();
      saveUiSettings();
      updateActiveChannelUi();
    }

    const parts = [
      `${data.config.scheme}://${data.config.host}:${data.config.httpPort}`,
      data.config.hasPassword ? 'пароль задан' : 'нет пароля',
      data.ffmpeg.available ? 'ffmpeg ok' : 'ffmpeg нужен',
      data.transcriber?.available ? `GigaAM ${data.transcriber.version || 'ok'}` : 'GigaAM нужен',
      data.config.openAi?.hasApiKey ? `OpenAI ${data.config.openAi.model}` : 'OpenAI ключ не задан',
      data.config.reports?.smtpConfigured ? `SMTP ${reportEmailList().length ? 'ok' : 'нет получателей'}` : 'SMTP не задан',
      data.config.drive?.configured ? `Google Диск ${data.config.drive.authType || 'ok'}` : 'Google Диск не настроен',
      data.config.database?.enabled ? `PostgreSQL ${storageAvailable ? 'ok' : 'недоступен'}` : 'PostgreSQL выключен',
      data.config.scheduler?.enabled ? `планировщик ${data.config.scheduler.intervalSeconds || 30}с` : 'планировщик выключен',
      `фильтр: ${elements.audioFilter.value}`,
      `XM: ${data.config.xmAudioCodec || 'mulaw'}`
    ];

    elements.configStatus.textContent = data.ffmpeg.available && data.transcriber?.available ? 'Система готова' : 'Требуется настройка';
    elements.configStatus.className = `status-pill ${data.config.hasPassword && data.ffmpeg.available && data.transcriber?.available ? 'good' : 'warn'}`;
    elements.settingsSummary.textContent = parts.join(' | ');
    log(data);
  } catch (error) {
    renderTranscriptionStatus({ error: error.message || String(error) });
    elements.configStatus.textContent = 'Ошибка запуска';
    elements.configStatus.className = 'status-pill warn';
    elements.settingsSummary.textContent = error.message || String(error);
    logError(error);
  }
}

function renderTranscriptionStatus(runtime = {}) {
  renderTranscriptionModels(runtime);
  const device = runtime.actualDevice || runtime.selectedDevice || '';
  const label = device.startsWith('cuda') ? 'GPU' : device === 'cpu' ? 'CPU' : 'Нет данных';
  elements.transcriptionDevice.textContent = runtime.modelState === 'preparing' ? 'Подготовка' : runtime.available ? label : 'Недоступно';
  elements.transcriptionDevice.className = `status-pill ${runtime.available ? 'good' : 'warn'}`;
  const modelStates = { preparing: 'Подготовка окружения', not_loaded: 'Не загружена', loading: 'Загрузка модели', ready: 'Готова', transcribing: 'Распознавание', error: 'Ошибка модели' };
  const rows = [
    [runtime.actualDevice ? 'Устройство модели' : 'Выбрано для запуска', device || 'Не определено'],
    ['Состояние', modelStates[runtime.modelState] || 'Проверка не выполнена'],
    ['Модель', runtime.model || 'Не определена'],
    ['Режим', runtime.requestedDevice === 'auto' ? 'Автоматически' : runtime.requestedDevice || 'Не определён'],
    ['CUDA', runtime.cuda?.available === true ? `Доступна · ${runtime.cuda.version || ''}`.trim() : runtime.cuda?.available === false ? 'Недоступна' : 'Не проверена'],
    ['PyTorch', runtime.torchVersion || 'Не определён']
  ];
  if (runtime.setup?.source) rows.push(['Окружение', runtime.setup.source === 'managed' ? 'Автоматическое' : 'Из конфигурации']);
  const gpus = runtime.gpus || [];
  for (const [index, gpu] of gpus.entries()) {
    const memory = Number(gpu.totalMemoryBytes);
    const memoryLabel = memory > 0 ? ` · ${(memory / (1024 ** 3)).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ГБ` : '';
    rows.push([gpus.length > 1 ? `Видеокарта ${index + 1}` : 'Видеокарта', `${gpu.name}${memoryLabel}`]);
    if (gpu.driverVersion) rows.push(['Драйвер NVIDIA', gpu.driverVersion]);
  }
  if (!gpus.length) rows.push(['Видеокарта NVIDIA', 'Не обнаружена']);
  elements.transcriptionHardware.innerHTML = rows.map(([title, value]) => `<div><dt>${escapeHtml(title)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  const reasons = {
    torch_cpu_only: 'PyTorch установлен без поддержки CUDA. Транскрибация выполняется на CPU.',
    cuda_unavailable: 'CUDA недоступна для PyTorch. Для транскрибации выбран CPU.',
    cuda_check_failed: 'Проверка вычислений CUDA завершилась ошибкой.',
    cpu_requested: 'CPU выбран в конфигурации сервера.'
  };
  const setupMessages = {
    checking: 'Проверка CPU, видеокарты и установленных сборок.',
    creating: 'Создание отдельного Python-окружения.',
    installing_torch: `Установка PyTorch и TorchAudio (${runtime.setup?.variant === 'cu128' ? 'CUDA 12.8' : 'CPU'}).`,
    installing_gigaam: 'Установка GigaAM и зависимостей.',
    verifying: 'Проверка установленной сборки и вычислений CUDA.'
  };
  elements.transcriptionHardwareNote.textContent = setupMessages[runtime.setup?.stage] || [
    runtime.setup?.error ? `Подготовка сборки: ${runtime.setup.error}` : '',
    runtime.modelError || runtime.error || reasons[runtime.reason] || '',
    runtime.cuda?.error || ''
  ].filter(Boolean).join(' ');
  elements.transcriptionHardwareNote.hidden = !elements.transcriptionHardwareNote.textContent;
}

function transcriptionModelMetrics(model) {
  if (!model) return '';
  return [
    ['Скорость', model.speed, 'speed', `Ориентировочная скорость: ${model.speed} из 5. Зависит от CPU/GPU, длины и содержания аудио; не замер на этом компьютере.`],
    ['Качество', model.quality, 'quality', `Относительная оценка: ${model.quality} из 5. Средний WER ${model.wer}%. Это не процент точности на ваших записях.`]
  ].map(([label, value, kind, title]) => `<span class="transcription-model-metric ${kind}" title="${escapeHtml(title)}">
    <span>${label}</span><meter min="0" max="5" value="${value}" aria-label="${escapeHtml(`${model.name}: ${label}`)}">${value}/5</meter>
    <strong>${kind === 'speed' ? '~' : ''}${Number(value).toLocaleString('ru-RU')}/5</strong>
  </span>`).join('');
}

function renderTranscriptionModels(runtime = {}) {
  if (Array.isArray(runtime.models) && !transcriptionModelSaving) {
    if (runtime.model !== transcriptionModelState.model && !transcriptionModelMessageIsError) transcriptionModelMessage = '';
    transcriptionModelState = runtime;
  }
  const state = transcriptionModelState;
  const models = state.models || [];
  const selected = models.find(model => model.id === state.model);
  const signature = JSON.stringify(models);
  if (elements.transcriptionModelOptions.dataset.models !== signature) {
    elements.transcriptionModelOptions.dataset.models = signature;
    elements.transcriptionModelOptions.innerHTML = models.map(model => `<label class="transcription-model-option">
      <input type="radio" name="transcriptionModel" value="${escapeHtml(model.id)}" aria-label="${escapeHtml(model.name)}">
      <span class="transcription-model-option-body"><strong>${escapeHtml(model.name)}</strong>
        <small>${model.punctuation ? 'Пунктуация и числа' : 'Без пунктуации'} · WER ${Number(model.wer).toLocaleString('ru-RU')}%</small>
        <span class="transcription-model-metrics">${transcriptionModelMetrics(model)}</span>
      </span>
    </label>`).join('');
  }
  for (const input of elements.transcriptionModelOptions.querySelectorAll('input')) {
    input.checked = input.value === state.model;
    input.disabled = transcriptionModelSaving || !state.modelChangeAllowed || !Array.isArray(runtime.models);
  }
  elements.transcriptionModelCurrent.textContent = selected?.name || state.model || 'Загрузка...';
  elements.transcriptionModelMetrics.innerHTML = transcriptionModelMetrics(selected);
  if (state.modelSource?.startsWith('https://github.com/salute-developers/GigaAM/')) {
    elements.transcriptionModelSource.href = state.modelSource;
    elements.transcriptionModelSource.hidden = false;
  }
  const status = transcriptionModelSaving ? 'Сохранение модели...'
    : !Array.isArray(runtime.models) ? 'Список моделей недоступен.'
    : transcriptionModelMessageIsError ? transcriptionModelMessage : state.modelChangeReason || transcriptionModelMessage;
  elements.transcriptionModelStatus.textContent = status;
  elements.transcriptionModelStatus.hidden = !status;
  elements.transcriptionModelStatus.classList.toggle('error', transcriptionModelMessageIsError);
  audioFilesTab.refreshSettings();
}

async function saveTranscriptionModel(model) {
  if (transcriptionModelSaving || !transcriptionModelState.modelChangeAllowed) return;
  transcriptionModelSaving = true;
  transcriptionModelRevision += 1;
  transcriptionModelMessage = '';
  transcriptionModelMessageIsError = false;
  elements.transcriptionModelPicker.open = false;
  renderTranscriptionModels(transcriptionModelState);
  try {
    const data = await api('/api/transcription/model', { method: 'POST', body: { model } });
    transcriptionModelState = data.transcriber;
    transcriptionModelMessage = 'Модель сохранена.';
  } catch (error) {
    transcriptionModelMessage = `Не удалось сменить модель: ${error.message || String(error)}`;
    transcriptionModelMessageIsError = true;
  } finally {
    transcriptionModelSaving = false;
    transcriptionModelRevision += 1;
    renderTranscriptionStatus(transcriptionModelState);
    elements.transcriptionModelPicker.querySelector('summary').focus();
    refreshTranscriptionStatus();
  }
}

async function refreshTranscriptionStatus() {
  if (transcriptionStatusLoading || document.hidden) return;
  transcriptionStatusLoading = true;
  const modelRevision = transcriptionModelRevision;
  try {
    const data = await api('/api/transcription/status');
    if (modelRevision === transcriptionModelRevision) renderTranscriptionStatus(data.transcriber);
  } catch (error) {
    renderTranscriptionStatus({ error: error.message || String(error) });
  } finally {
    transcriptionStatusLoading = false;
  }
}

async function runAction(message, callback) {
  log({ status: message, channel: selectedChannel, label: channelLabel(selectedChannel) });
  try {
    await callback();
  } catch (error) {
    logError(error);
  }
}

async function searchRecordings() {
  const from = elements.from.value;
  const to = elements.to.value;

  if (!from || !to) {
    const message = 'Укажите начало и конец периода.';
    setArchiveSearchStatus(message, 'warn');
    renderRecordingsMessage(message, 'warn');
    log({ ok: false, error: message });
    return;
  }

  if (zonedDateTimeMs(to, displayTimeZone()) <= zonedDateTimeMs(from, displayTimeZone())) {
    const message = 'Конец периода должен быть позже начала.';
    setArchiveSearchStatus(message, 'warn');
    renderRecordingsMessage(message, 'warn');
    log({ ok: false, error: message });
    return;
  }

  const startedAt = Date.now();
  elements.searchButton.disabled = true;
  setArchiveSearchStatus('Ищу записи...', 'busy');
  renderRecordingsMessage('Ищу записи...', 'muted');
  log({ status: 'Ищу записи', channel: selectedChannel, label: channelLabel(selectedChannel), from, to });

  try {
    const query = new URLSearchParams({
      ...currentCameraParams(),
      from,
      to,
      timeZone: displayTimeZone(),
      cameraTimeZone: cameraTimeZone()
    });
    const data = await api(`/api/recordings/search?${query}`);

    if (data.vendor && elements.vendor.value === 'auto' && [...elements.vendor.options].some(option => option.value === data.vendor)) {
      elements.vendor.value = data.vendor;
      saveUiSettings();
    }

    lastRecordings = data.items || [];
    lastArchiveItem = null;
    clearArchivePlayer();
    setSelectedRecording(null);
    setTranscript(elements.archiveTranscript, elements.archiveTranscriptStatus, 'Нет текста', 'Нет записи');

    const count = lastRecordings.length;
    const status = count
      ? `Найдено ${count} ${pluralRu(count, 'запись', 'записи', 'записей')}`
      : data.xmRet
        ? `Камера вернула Ret=${data.xmRet}: за этот период записи не отданы`
        : 'За этот период записей нет';
    renderRecordings(data.vendor || elements.vendor.value, lastRecordings, status, data.xmRet ? 'warn' : '');
    setArchiveSearchStatus(status, count ? 'good' : 'warn');
    log({ ...data, tookMs: Date.now() - startedAt });
  } catch (error) {
    lastRecordings = [];
    lastArchiveItem = null;
    clearArchivePlayer();
    setSelectedRecording(null);
    setTranscript(elements.archiveTranscript, elements.archiveTranscriptStatus, 'Нет текста', 'Нет записи');
    renderRecordingsMessage(`Ошибка поиска: ${error.message || error}`, 'error');
    setArchiveSearchStatus(`Ошибка: ${error.message || error}`, 'error');
    logError(error);
  } finally {
    elements.searchButton.disabled = false;
  }
}

async function api(path, options = {}) {
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {})
  };
  const request = {
    method: options.method || 'GET',
    headers: {
      ...headers
    },
    signal: options.signal
  };

  if (options.body !== undefined) {
    request.headers['Content-Type'] = request.headers['Content-Type'] || 'application/json; charset=utf-8';
    request.body = JSON.stringify(options.body);
  }

  const response = await fetch(path, request);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const error = new Error(`HTTP ${response.status}: сервер вернул не JSON`);
    error.statusCode = response.status;
    error.path = path;
    error.method = request.method;
    error.details = text.slice(0, 1000);
    throw error;
  }

  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.statusCode = response.status;
    error.path = path;
    error.method = request.method;
    error.details = data.details;
    error.response = data;
    throw error;
  }

  return data;
}

function currentCameraParams() {
  return cameraParamsForChannel(selectedChannel);
}

function cameraParamsForChannel(channel) {
  return {
    vendor: elements.vendor.value,
    channel: String(channel),
    stream: elements.stream.value,
    audioFilter: elements.audioFilter.value || 'voice'
  };
}

function renderRecordings(vendor, items, emptyMessage = 'Нет результатов', emptyTone = '') {
  if (!items.length) {
    renderRecordingsMessage(emptyMessage, emptyTone);
    return;
  }

  elements.recordingsBody.innerHTML = items
    .map((item, index) => {
      const source = item.playbackUri || item.filePath || item.fileName || vendor;
      const selected = item === lastArchiveItem ? ' selected' : '';
      const canDownload = Boolean(item.fileName);
      return `
        <tr class="${selected}">
          <td>${escapeHtml(formatCameraTime(item.startTime))}</td>
          <td>${escapeHtml(formatCameraTime(item.endTime))}</td>
          <td class="source" title="${escapeHtml(source)}">${escapeHtml(source)}</td>
          <td>
            <div class="recording-actions">
              <button class="inline" type="button" data-action="listen" data-index="${index}">Слушать</button>
              <button class="inline file" type="button" data-action="download" data-index="${index}" ${canDownload ? '' : 'disabled title="Нет имени файла для скачивания"'}>Скачать</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderRecordingsMessage(message, tone = '') {
  const className = ['empty', tone].filter(Boolean).join(' ');
  elements.recordingsBody.innerHTML = `<tr><td colspan="4" class="${escapeHtml(className)}">${escapeHtml(message)}</td></tr>`;
}

function markSelectedRecording(item) {
  for (const row of elements.recordingsBody.querySelectorAll('tr')) {
    row.classList.remove('selected');
  }
  const index = lastRecordings.indexOf(item);
  const button = elements.recordingsBody.querySelector(`button[data-action="listen"][data-index="${index}"]`);
  button?.closest('tr')?.classList.add('selected');
}

function recordingQuery(item) {
  return recordingQueryForChannel(item, selectedChannel, {
    from: elements.from.value,
    to: elements.to.value
  });
}

function recordingLabel(item) {
  const source = item.filePath || item.fileName || item.playbackUri || '';
  return `${formatCameraTime(item.startTime)} - ${formatCameraTime(item.endTime)}${source ? ` · ${source}` : ''}`;
}

function recordingQueryForChannel(item, channel, fallback = {}) {
  const query = new URLSearchParams({
    ...cameraParamsForChannel(channel),
    from: item.startTime || fallback.from || elements.from.value,
    to: item.endTime || fallback.to || elements.to.value
  });

  if (item.playbackUri) {
    query.set('source', item.playbackUri);
  }
  if (item.fileName) {
    query.set('fileName', item.fileName);
  }
  if (item.localBeginTime) {
    query.set('localBeginTime', item.localBeginTime);
  }
  if (item.localEndTime) {
    query.set('localEndTime', item.localEndTime);
  }
  if (item.sizeBytes) {
    query.set('sizeBytes', item.sizeBytes);
  }

  return query;
}

function startRecordingDownload(item, query) {
  const anchor = document.createElement('a');
  anchor.href = `/api/recordings/file?${query}`;
  anchor.download = downloadName(item.fileName || item.filePath || 'recording.h264');
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  log({
    ok: true,
    download: 'started',
    channel: selectedChannel,
    fileName: item.fileName || item.filePath,
    sizeBytes: item.sizeBytes
  });
}

function setTranscript(target, statusTarget, text, status) {
  target.textContent = text;
  target.classList.toggle('is-empty', text === 'Нет текста' || text === 'Нет ответа' || text === 'Готовлю аудио');
  statusTarget.textContent = status;
}

function appendOpenAiTranscript(groupName, channel, item, segments = [], fallbackText = '') {
  const usefulSegments = normalizedTranscriptSegments(segments, fallbackText);
  if (!usefulSegments.length) return false;

  const shouldFollowTranscript = isTranscriptNearBottom(elements.openAiTranscript);
  prepareTranscriptTarget(elements.openAiTranscript);

  const source = document.createElement('div');
  source.className = 'transcript-source';
  source.textContent = `${groupName ? `${groupName} · ` : ''}${channelLabel(channel)} · ${formatCameraTime(item.startTime)} - ${formatCameraTime(item.endTime)}`;
  elements.openAiTranscript.append(source);

  for (const segment of usefulSegments) {
    const row = document.createElement('div');
    row.className = 'transcript-row';

    const time = document.createElement('span');
    time.className = 'transcript-time';
    time.textContent = formatSegmentTime(segment);

    const text = document.createElement('span');
    text.className = 'transcript-line';
    text.textContent = segment.text;

    row.append(time, text);
    elements.openAiTranscript.append(row);
  }

  scrollTranscriptToBottom(elements.openAiTranscript, shouldFollowTranscript);
  return true;
}

function appendOpenAiContext(contextLines, groupName, channel, item, segments = [], fallbackText = '') {
  const usefulSegments = normalizedTranscriptSegments(segments, fallbackText);
  for (const segment of usefulSegments) {
    contextLines.push(`[${groupName || 'Группа'} | ${channelLabel(channel)} | ${formatAbsoluteSegmentTime(item, segment)}] ${segment.text.trim()}`);
  }
  return usefulSegments.length;
}

function appendOpenAiNotice(text) {
  const shouldFollowTranscript = isTranscriptNearBottom(elements.openAiTranscript);
  prepareTranscriptTarget(elements.openAiTranscript);
  const notice = document.createElement('div');
  notice.className = 'transcript-source';
  notice.textContent = text;
  elements.openAiTranscript.append(notice);
  scrollTranscriptToBottom(elements.openAiTranscript, shouldFollowTranscript);
}

function prepareTranscriptTarget(target) {
  if (target.textContent === 'Нет текста' || target.textContent === 'Готовлю аудио' || target.textContent === 'Речь не найдена') {
    target.textContent = '';
  }
  target.classList.remove('is-empty');
}

function normalizedTranscriptSegments(segments = [], fallbackText = '') {
  const normalizedSegments = Array.isArray(segments) && segments.length
    ? segments
    : fallbackText
      ? [{ text: fallbackText }]
      : [];
  return normalizedSegments.filter(segment => String(segment.text || '').trim());
}

function setSelectedRecording(item) {
  if (!item) {
    elements.selectedRecording.textContent = 'Запись не выбрана';
    elements.selectedRecording.title = '';
    elements.selectedRecording.classList.add('is-empty');
    return;
  }

  const source = item.filePath || item.fileName || item.playbackUri || '';
  const text = `${channelLabel(selectedChannel)} · ${formatCameraTime(item.startTime)} - ${formatCameraTime(item.endTime)}${source ? ` · ${source}` : ''}`;
  elements.selectedRecording.textContent = text;
  elements.selectedRecording.title = text;
  elements.selectedRecording.classList.remove('is-empty');
}

function renderTranscript(target, segments, fallbackText) {
  target.textContent = '';
  const rendered = appendTranscript(target, segments, fallbackText);
  if (!rendered) {
    target.textContent = 'Речь не найдена';
    target.classList.add('is-empty');
  }
}

function appendTranscript(target, segments = [], fallbackText = '') {
  const normalizedSegments = Array.isArray(segments) && segments.length
    ? segments
    : fallbackText
      ? [{ text: fallbackText }]
      : [];
  const usefulSegments = normalizedSegments.filter(segment => String(segment.text || '').trim());

  if (!usefulSegments.length) return false;

  const shouldFollowTranscript = isTranscriptNearBottom(target);
  if (target.textContent === 'Нет текста' || target.textContent === 'Готовлю аудио' || target.textContent === 'Речь не найдена') {
    target.textContent = '';
  }
  target.classList.remove('is-empty');

  for (const segment of usefulSegments) {
    const row = document.createElement('div');
    row.className = 'transcript-row';

    const time = document.createElement('span');
    time.className = 'transcript-time';
    time.textContent = formatSegmentTime(segment);

    const text = document.createElement('span');
    text.className = 'transcript-line';
    text.textContent = segment.text;

    row.append(time, text);
    target.append(row);
  }

  scrollTranscriptToBottom(target, shouldFollowTranscript);
  return true;
}

function isTranscriptNearBottom(target) {
  return target.scrollHeight - target.scrollTop - target.clientHeight <= TRANSCRIPT_BOTTOM_THRESHOLD_PX;
}

function scrollTranscriptToBottom(target, shouldScroll) {
  if (shouldScroll) {
    target.scrollTop = target.scrollHeight;
  }
}

function openSettings() {
  elements.settingsBackdrop.hidden = false;
  elements.settingsDrawer.classList.add('open');
  elements.settingsDrawer.setAttribute('aria-hidden', 'false');
  refreshTranscriptionStatus();
  clearInterval(transcriptionStatusTimer);
  transcriptionStatusTimer = window.setInterval(refreshTranscriptionStatus, 5000);
}

function closeSettings() {
  elements.settingsBackdrop.hidden = true;
  elements.settingsDrawer.classList.remove('open');
  elements.settingsDrawer.setAttribute('aria-hidden', 'true');
  clearInterval(transcriptionStatusTimer);
  transcriptionStatusTimer = null;
}

function applySettingsToControls() {
  elements.vendor.value = uiSettings.vendor || 'auto';
  elements.stream.value = uiSettings.stream || 'main';
  elements.audioFilter.value = uiSettings.audioFilter || 'voice';
  elements.transcriptSeconds.value = String(uiSettings.transcriptSeconds || DEFAULT_TRANSCRIPT_SECONDS);
  elements.reportEmails.value = uiSettings.reportEmails || '';
  elements.cameraTimeZone.value = normalizeBrowserTimeZone(uiSettings.cameraTimeZone, DEFAULT_CAMERA_TIME_ZONE);
  elements.displayTimeZone.value = normalizeBrowserTimeZone(uiSettings.displayTimeZone, DEFAULT_DISPLAY_TIME_ZONE);
  audioFilesTab.refreshSettings();
}

function appendDriveTranscriptEntries(entries, groupName, channel, item, segments = [], fallbackText = '', chunk = {}) {
  if (!Array.isArray(entries)) return 0;
  const usefulSegments = normalizedTranscriptSegments(segments, fallbackText);
  for (const segment of usefulSegments) {
    const hasSegmentStart = segment.start !== undefined && segment.start !== null && segment.start !== ''
      && Number.isFinite(Number(segment.start));
    const hasSegmentEnd = segment.end !== undefined && segment.end !== null && segment.end !== ''
      && Number.isFinite(Number(segment.end));
    const startOffsetSeconds = hasSegmentStart ? Number(segment.start) : Number(chunk.offsetSeconds || 0);
    const endOffsetSeconds = hasSegmentEnd
      ? Number(segment.end)
      : startOffsetSeconds + Math.max(0, Number(chunk.durationSeconds || 0));
    const startMs = absoluteCameraSegmentMs(item.startTime, startOffsetSeconds);
    const endMs = absoluteCameraSegmentMs(item.startTime, endOffsetSeconds);
    entries.push({
      channel,
      label: channelLabel(channel),
      groupName: groupName || 'Группа',
      start: Number.isFinite(startMs) ? new Date(startMs).toISOString() : localValueToIso(item.startTime, cameraTimeZone()),
      end: Number.isFinite(endMs) ? new Date(endMs).toISOString() : localValueToIso(item.endTime, cameraTimeZone()),
      text: String(segment.text || '').trim()
    });
  }
  return usefulSegments.length;
}

function saveUiSettings() {
  uiSettings = {
    vendor: elements.vendor.value || 'auto',
    stream: elements.stream.value || 'main',
    audioFilter: elements.audioFilter.value || 'voice',
    transcriptSeconds: getTranscriptSeconds(),
    reportEmails: elements.reportEmails.value.trim(),
    cameraTimeZone: normalizeBrowserTimeZone(elements.cameraTimeZone.value, DEFAULT_CAMERA_TIME_ZONE),
    displayTimeZone: normalizeBrowserTimeZone(elements.displayTimeZone.value, DEFAULT_DISPLAY_TIME_ZONE)
  };
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(uiSettings));
  audioFilesTab.refreshSettings();
  syncStorage('/api/storage/settings', { settings: uiSettings, selectedChannel });
}

function loadUiSettings() {
  return {
    vendor: 'auto',
    stream: 'main',
    audioFilter: 'voice',
    transcriptSeconds: DEFAULT_TRANSCRIPT_SECONDS,
    reportEmails: '',
    cameraTimeZone: DEFAULT_CAMERA_TIME_ZONE,
    displayTimeZone: DEFAULT_DISPLAY_TIME_ZONE,
    ...safeJson(localStorage.getItem(STORAGE_KEYS.settings))
  };
}

function loadSelectedChannel() {
  return clamp(Number(localStorage.getItem(STORAGE_KEYS.selectedChannel) || '1'), 1, CHANNEL_COUNT);
}

function saveSelectedChannel(channel) {
  localStorage.setItem(STORAGE_KEYS.selectedChannel, String(channel));
  syncStorage('/api/storage/settings', { selectedChannel: channel });
}

function loadOpenAiGroups() {
  const saved = safeJson(localStorage.getItem(STORAGE_KEYS.openAiGroups));
  return Array.isArray(saved) ? saved.map(normalizeOpenAiGroup).filter(Boolean) : [];
}

function saveOpenAiGroups() {
  localStorage.setItem(STORAGE_KEYS.openAiGroups, JSON.stringify(openAiGroups));
  syncStorage('/api/storage/groups', { groups: openAiGroups });
}

function loadOpenAiActions() {
  const saved = safeJson(localStorage.getItem(STORAGE_KEYS.openAiActions));
  return Array.isArray(saved) ? saved.map(normalizeOpenAiAction).filter(Boolean) : [];
}

function saveOpenAiActions() {
  localStorage.setItem(STORAGE_KEYS.openAiActions, JSON.stringify(openAiActions));
  syncStorage('/api/storage/actions', { actions: openAiActions });
}

function normalizeOpenAiGroup(group, index = 0) {
  if (!group || typeof group !== 'object') return null;
  const channels = normalizeChannelList(group.channels);
  const from = String(group.from || '');
  const to = String(group.to || '');
  if (!channels.length || !from || !to) return null;
  return {
    id: String(group.id || createId(`group-${index + 1}`)),
    name: String(group.name || `Группа ${index + 1}`),
    channels,
    from,
    to,
    timeZone: normalizeBrowserTimeZone(group.timeZone, DEFAULT_CAMERA_TIME_ZONE),
    createdAt: group.createdAt || '',
    updatedAt: group.updatedAt || ''
  };
}

function normalizeOpenAiAction(action, index = 0) {
  if (!action || typeof action !== 'object') return null;
  const groupIds = Array.isArray(action.groupIds) ? action.groupIds.map(String).filter(Boolean) : [];
  const question = String(action.question || '').trim();
  const destination = action.destination === 'drive' ? 'drive' : 'email';
  if (!groupIds.length || (destination === 'email' && !question)) return null;
  const periodMode = normalizePeriodMode(action.periodMode);
  return {
    id: String(action.id || createId(`action-${index + 1}`)),
    name: String(action.name || `Действие ${index + 1}`),
    groupIds: [...new Set(groupIds)],
    question,
    destination,
    periodMode,
    dayPreset: ['today', 'yesterday', 'tomorrow', 'custom'].includes(action.dayPreset) ? action.dayPreset : 'today',
    customDate: String(action.customDate || ''),
    reportDaily: destination === 'email' && Boolean(action.reportDaily) && periodMode !== 'once',
    reportWeekly: destination === 'email' && Boolean(action.reportWeekly) && periodMode !== 'once',
    runOnWeekends: periodMode !== 'once' && (action.runOnWeekends === undefined ? true : Boolean(action.runOnWeekends)),
    createdAt: action.createdAt || '',
    updatedAt: action.updatedAt || '',
    lastRun: action.lastRun || null
  };
}

function normalizePeriodMode(value) {
  return ['daily', 'weekly', 'once'].includes(value) ? value : 'daily';
}

function normalizeChannelList(channels) {
  const values = Array.isArray(channels) ? channels : [];
  return [...new Set(values.map(channel => clamp(Number(channel), 1, CHANNEL_COUNT)))].sort((a, b) => a - b);
}

function reportEmailList() {
  return String(elements.reportEmails?.value || uiSettings.reportEmails || '')
    .split(/[,\n;]/)
    .map(value => value.trim())
    .filter(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
}

function groupById(groupId) {
  return openAiGroups.find(group => group.id === groupId) || null;
}

function actionById(actionId) {
  return openAiActions.find(action => action.id === actionId) || null;
}

function loadChannelLabels() {
  const saved = safeJson(localStorage.getItem(STORAGE_KEYS.channelLabels));
  return Array.from({ length: CHANNEL_COUNT }, (_, index) => {
    const channel = index + 1;
    return String(saved?.[index] || `Канал ${channel}`);
  });
}

function saveChannelLabels() {
  localStorage.setItem(STORAGE_KEYS.channelLabels, JSON.stringify(channelLabels));
  syncStorage('/api/storage/channel-labels', { labels: channelLabels });
}

function channelLabel(channel) {
  return channelLabels[channel - 1] || `Канал ${channel}`;
}

function audioFilterLabel(value) {
  return {
    voice: 'Речь',
    strong: 'Сильно',
    off: 'Без обработки'
  }[value] || 'Речь';
}

function getTranscriptSeconds() {
  return clamp(Number(elements.transcriptSeconds.value || DEFAULT_TRANSCRIPT_SECONDS), 5, 60);
}

function cameraTimeZone() {
  return normalizeBrowserTimeZone(elements.cameraTimeZone?.value || uiSettings.cameraTimeZone, DEFAULT_CAMERA_TIME_ZONE);
}

function displayTimeZone() {
  return normalizeBrowserTimeZone(elements.displayTimeZone?.value || uiSettings.displayTimeZone, DEFAULT_DISPLAY_TIME_ZONE);
}

function displayTimeZoneLabel() {
  return elements.displayTimeZone?.selectedOptions?.[0]?.textContent || displayTimeZone();
}

function normalizeBrowserTimeZone(value, fallback = 'UTC') {
  for (const candidate of [value, fallback, 'UTC']) {
    try {
      if (candidate) return new Intl.DateTimeFormat('en', { timeZone: String(candidate) }).resolvedOptions().timeZone;
    } catch {}
  }
  return 'UTC';
}

function hasExplicitTimeZone(value) {
  return typeof value === 'string' && /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value.trim());
}

function localDateTimeParts(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) throw new RangeError(`Некорректное время: ${value}`);
  return {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4] || 0), minute: Number(match[5] || 0), second: Number(match[6] || 0)
  };
}

function zonedParts(epochMs, timeZone) {
  const result = {};
  const formatter = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
    timeZone: normalizeBrowserTimeZone(timeZone), calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
  }
  if (result.hour === 24) result.hour = 0;
  return result;
}

function partsUtc(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
}

function zonedDateTimeMs(value, timeZone) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (hasExplicitTimeZone(value)) {
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch)) throw new RangeError(`Некорректное время: ${value}`);
    return epoch;
  }
  const expected = localDateTimeParts(value);
  const wall = partsUtc(expected);
  let epoch = wall;
  for (let index = 0; index < 4; index += 1) {
    const actual = zonedParts(epoch, timeZone);
    const adjustment = wall - partsUtc(actual);
    epoch += adjustment;
    if (!adjustment) break;
  }
  const actual = zonedParts(epoch, timeZone);
  if (['year', 'month', 'day', 'hour', 'minute', 'second'].some(key => actual[key] !== expected[key])) {
    throw new RangeError(`Время ${value} не существует в часовом поясе ${timeZone}`);
  }
  return epoch;
}

function localValueInZone(value, timeZone, withSeconds = true) {
  const epoch = value instanceof Date || typeof value === 'number' || hasExplicitTimeZone(value)
    ? (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value))
    : zonedDateTimeMs(value, timeZone);
  const parts = zonedParts(epoch, timeZone);
  const pad = number => String(number).padStart(2, '0');
  const result = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
  return withSeconds ? `${result}:${pad(parts.second)}` : result;
}

function localValueToIso(value, sourceTimeZone) {
  return new Date(zonedDateTimeMs(value, sourceTimeZone)).toISOString();
}

function zonedDatePart(value, timeZone) {
  return localValueInZone(value, timeZone, false).slice(0, 10);
}

function groupRangeInDisplayTimeZone(group) {
  const sourceTimeZone = normalizeBrowserTimeZone(group?.timeZone, DEFAULT_CAMERA_TIME_ZONE);
  try {
    return {
      from: localValueInZone(zonedDateTimeMs(group.from, sourceTimeZone), displayTimeZone(), false),
      to: localValueInZone(zonedDateTimeMs(group.to, sourceTimeZone), displayTimeZone(), false)
    };
  } catch {
    return { from: group?.from || '', to: group?.to || '' };
  }
}

function localWallClockSeconds(value) {
  const parts = localDateTimeParts(value);
  return (parts.hour * 3600) + (parts.minute * 60) + parts.second;
}

function handleTimeZoneChanged() {
  const previousDisplayTimeZone = normalizeBrowserTimeZone(uiSettings.displayTimeZone, DEFAULT_DISPLAY_TIME_ZONE);
  const nextDisplayTimeZone = displayTimeZone();
  convertDateTimeInputsBetweenZones(previousDisplayTimeZone, nextDisplayTimeZone);
  saveUiSettings();
  renderOpenAiGroups();
  renderActionGroupPicker(selectedActionDialogGroupIds());
  renderOpenAiActions();
  log({ ok: true, cameraTimeZone: cameraTimeZone(), displayTimeZone: nextDisplayTimeZone });
}

function convertDateTimeInputsBetweenZones(previousTimeZone, nextTimeZone) {
  const previous = normalizeBrowserTimeZone(previousTimeZone, DEFAULT_DISPLAY_TIME_ZONE);
  const next = normalizeBrowserTimeZone(nextTimeZone, DEFAULT_DISPLAY_TIME_ZONE);
  if (previous === next) return;
  for (const input of [elements.from, elements.to, elements.openAiGroupFrom, elements.openAiGroupTo]) {
    if (!input?.value) continue;
    try {
      input.value = localValueInZone(zonedDateTimeMs(input.value, previous), next, false);
    } catch {}
  }
}

function setDefaultRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 60 * 60 * 1000);
  elements.from.value = toDatetimeLocal(from);
  elements.to.value = toDatetimeLocal(to);
}

function toDatetimeLocal(date) {
  return localValueInZone(date, displayTimeZone()).slice(0, 16);
}

function toDateInputLocal(date) {
  return zonedDatePart(date, displayTimeZone());
}

function offsetDatePart(datePart, days) {
  const [year, month, day] = String(datePart).split('-').map(Number);
  const date = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    ? new Date(Date.UTC(year, month - 1, day))
    : new Date(Date.UTC(1970, 0, 1));
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function startOfWeekDatePart(datePart) {
  const [year, month, day] = String(datePart).split('-').map(Number);
  const date = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    ? new Date(Date.UTC(year, month - 1, day))
    : new Date(Date.UTC(1970, 0, 1));
  const weekday = date.getUTCDay();
  const offset = weekday === 0 ? -6 : 1 - weekday;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function isWeekendDatePart(datePart) {
  const [year, month, day] = String(datePart || '').split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function timeOnly(value) {
  return String(value || '').slice(11, 16) || '00:00';
}

function combineDateAndTime(datePart, timePart) {
  return `${datePart}T${timePart || '00:00'}`;
}

function dailyPresetLabel(preset, customDate) {
  if (preset === 'custom') return customDate ? formatDateOnly(customDate) : 'своя дата';
  return {
    yesterday: 'вчера',
    today: 'сегодня',
    tomorrow: 'завтра'
  }[preset] || 'сегодня';
}

function actionPeriodSubtitle(action) {
  if (action.periodMode === 'once') return 'единоразово · даты групп';
  if (action.periodMode === 'weekly') return `еженедельно · ${weeklyPresetLabel(action.dayPreset, action.customDate)}`;
  return `ежедневно · ${dailyPresetLabel(action.dayPreset, action.customDate)}`;
}

function weeklyPresetLabel(preset, customDate) {
  const anchor = preset === 'custom' && customDate ? customDate : resolveDailyActionDate({ dayPreset: preset, customDate });
  const start = startOfWeekDatePart(anchor);
  const end = offsetDatePart(start, 4);
  return `${formatDateOnly(start)} - ${formatDateOnly(end)}`;
}

function actionReportLabels(action) {
  const labels = [];
  if (action.reportDaily) labels.push('за день');
  if (action.reportWeekly) labels.push('за неделю');
  return labels;
}

function formatDateOnly(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('ru-RU', { timeZone: 'UTC' });
}

function firstMeaningfulLine(value) {
  return String(value || '').split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 64) || '';
}

function createId(prefix) {
  const random = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

function formatTime(value) {
  if (!value) return '';
  try {
    const epoch = hasExplicitTimeZone(value) ? Date.parse(value) : zonedDateTimeMs(value, displayTimeZone());
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: displayTimeZone(), dateStyle: 'short', timeStyle: 'medium'
    }).format(new Date(epoch));
  } catch {
    return String(value);
  }
}

function formatCameraTime(value) {
  if (!value) return '';
  try {
    const epoch = hasExplicitTimeZone(value) ? Date.parse(value) : zonedDateTimeMs(value, cameraTimeZone());
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: displayTimeZone(), dateStyle: 'short', timeStyle: 'medium'
    }).format(new Date(epoch));
  } catch {
    return String(value);
  }
}

function formatSegmentTime(segment) {
  if (!Number.isFinite(Number(segment.start)) || !Number.isFinite(Number(segment.end))) {
    return '';
  }
  return `${formatDurationLabel(segment.start)}-${formatDurationLabel(segment.end)}`;
}

function formatDurationLabel(seconds) {
  const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const rest = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function formatAbsoluteSegmentTime(item, segment) {
  const start = absoluteCameraSegmentMs(item.startTime, segment.start);
  const end = absoluteCameraSegmentMs(item.startTime, segment.end);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    return `${formatTime(new Date(start).toISOString())} - ${formatTime(new Date(end).toISOString())}`;
  }
  return formatSegmentTime(segment) || `${formatCameraTime(item.startTime)} - ${formatCameraTime(item.endTime)}`;
}

function absoluteCameraSegmentMs(baseValue, offsetSeconds) {
  if (!Number.isFinite(Number(offsetSeconds))) return Number.NaN;
  try {
    return (hasExplicitTimeZone(baseValue) ? Date.parse(baseValue) : zonedDateTimeMs(baseValue, cameraTimeZone()))
      + (Number(offsetSeconds) * 1000);
  } catch {
    return Number.NaN;
  }
}

function recordingDurationSeconds(item) {
  try {
    return Math.max(0, (zonedDateTimeMs(item.endTime, cameraTimeZone()) - zonedDateTimeMs(item.startTime, cameraTimeZone())) / 1000);
  } catch {
    return 0;
  }
}

function recordingCoverage(item, fromValue, toValue) {
  let rangeStartMs;
  let rangeEndMs;
  let itemStartMs;
  let itemEndMs;
  try {
    rangeStartMs = zonedDateTimeMs(fromValue, cameraTimeZone());
    rangeEndMs = zonedDateTimeMs(toValue, cameraTimeZone());
    itemStartMs = zonedDateTimeMs(item.startTime || fromValue, cameraTimeZone());
    itemEndMs = zonedDateTimeMs(item.endTime || toValue, cameraTimeZone());
  } catch {
    const fallbackSeconds = secondsBetween(item.startTime || fromValue, item.endTime || toValue);
    return fallbackSeconds > 0
      ? {
          offsetSeconds: 0,
          durationSeconds: fallbackSeconds,
          from: item.startTime || fromValue,
          to: item.endTime || toValue
        }
      : null;
  }

  const startMs = Math.max(rangeStartMs, itemStartMs);
  const endMs = Math.min(rangeEndMs, itemEndMs);
  if (endMs <= startMs) return null;

  return {
    offsetSeconds: Math.max(0, (startMs - itemStartMs) / 1000),
    durationSeconds: (endMs - startMs) / 1000,
    from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString()
  };
}

function secondsBetween(startValue, endValue) {
  try {
    const start = zonedDateTimeMs(startValue, displayTimeZone());
    const end = zonedDateTimeMs(endValue, displayTimeZone());
    return Math.max(0, (end - start) / 1000);
  } catch {
    return 0;
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function safeJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function clamp(value, min, max) {
  const number = Number.isFinite(Number(value)) ? Number(value) : min;
  return Math.min(max, Math.max(min, number));
}

function pluralRu(count, one, few, many) {
  const number = Math.abs(Number(count));
  const mod10 = number % 10;
  const mod100 = number % 100;

  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function log(value) {
  elements.log.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function logError(error) {
  log({
    ok: false,
    error: error.message || String(error),
    statusCode: error.statusCode,
    path: error.path,
    details: error.details
  });
}

function setArchiveSearchStatus(message, tone = 'neutral') {
  elements.archiveSearchStatus.textContent = message;
  elements.archiveSearchStatus.className = `section-status ${tone}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function downloadName(value) {
  const name = String(value || 'recording.h264').split(/[\\/]/).filter(Boolean).pop() || 'recording.h264';
  return /\.[a-z0-9]+$/i.test(name) ? name : `${name}.h264`;
}
