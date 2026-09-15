export const TRANSCRIPTION_MODEL_SOURCE = 'https://github.com/salute-developers/GigaAM/blob/7447938d791c4f3e643386ee22c33777004293a5/evaluation.md#russian-asr';

// Quality is relative to the best published mean WER, not an accuracy percentage.
// Speed is an architectural estimate (CTC vs autoregressive RNNT), not a benchmark.
export const TRANSCRIPTION_MODELS = Object.freeze([
  ['v3_e2e_rnnt', 'GigaAM v3 E2E RNNT', 11.2, true],
  ['v3_e2e_ctc', 'GigaAM v3 E2E CTC', 12.0, true],
  ['v3_rnnt', 'GigaAM v3 RNNT', 8.3, false],
  ['v3_ctc', 'GigaAM v3 CTC', 9.1, false],
  ['v2_rnnt', 'GigaAM v2 RNNT', 10.6, false],
  ['v2_ctc', 'GigaAM v2 CTC', 11.1, false],
  ['v1_rnnt', 'GigaAM v1 RNNT', 13.8, false],
  ['v1_ctc', 'GigaAM v1 CTC', 14.2, false]
].map(([id, name, wer, punctuation]) => Object.freeze({
  id, name, wer, punctuation,
  speed: id.endsWith('_ctc') ? 5 : 3,
  quality: Math.round(5 * 8.3 / wer * 10) / 10
})));

function modelError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function createTranscriptionModelSettings({ defaultModel, read, write, busyReason, onChange }) {
  let model = ['ctc', 'rnnt', 'e2e_ctc', 'e2e_rnnt'].includes(defaultModel) ? `v3_${defaultModel}` : defaultModel;
  let initialized = false;
  let loading = null;
  let saving = false;
  let loadError = '';

  const settings = {
    get model() { return model; },
    get saving() { return saving; },
    async initialize() {
      if (initialized) return;
      if (!loading) {
        loading = (async () => {
          const stored = await read();
          if (typeof stored === 'string' && TRANSCRIPTION_MODELS.some(item => item.id === stored)) model = stored;
          initialized = true;
          loadError = '';
        })().catch(error => {
          loadError = `Не удалось загрузить выбор модели: ${error.message}`;
          throw error;
        }).finally(() => { loading = null; });
      }
      return loading;
    },
    snapshot() {
      const reason = saving ? 'Сохранение модели...' : busyReason() || loadError || (!initialized ? 'Загрузка настроек модели...' : '');
      return {
        model, models: TRANSCRIPTION_MODELS, modelSource: TRANSCRIPTION_MODEL_SOURCE,
        modelChangeAllowed: !reason, modelChangeReason: reason
      };
    },
    async save(value) {
      if (typeof value !== 'string' || !TRANSCRIPTION_MODELS.some(item => item.id === value)) {
        throw modelError(400, 'Неизвестная модель транскрибации. Выберите модель из списка.');
      }
      await settings.initialize();
      const reason = saving ? 'Выбор модели уже сохраняется.' : busyReason();
      if (reason) throw modelError(409, reason);
      if (value === model) return settings.snapshot();
      saving = true;
      try {
        await write(value);
        model = value;
        onChange();
      } finally {
        saving = false;
      }
      return settings.snapshot();
    }
  };
  return settings;
}
