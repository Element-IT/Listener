import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'Asia/Yekaterinburg';
process.env.TRANSCRIPTION_CAPTURE_CHUNK_SECONDS = '60';

const {
  buildDriveTranscriptFiles,
  isLoopbackAddress,
  normalizeRecordingSearchTimeRange,
  normalizeStoredAction,
  publicGoogleDriveConfig,
  runScheduledOpenAiAction,
  xmArchiveEndShortfallIsTolerable,
  xmArchivePartialTailIsUsable
} = await import('../server.mjs');

test('XM archive accepts only small recording-end shortfalls', () => {
  assert.equal(xmArchiveEndShortfallIsTolerable(18, 17.725), true);
  assert.equal(xmArchiveEndShortfallIsTolerable(18, 17.25), true);
  assert.equal(xmArchiveEndShortfallIsTolerable(18, 14.375), false);
  assert.equal(xmArchiveEndShortfallIsTolerable(3600, 3599.25), true);
  assert.equal(xmArchiveEndShortfallIsTolerable(3600, 3598), false);
});

test('XM partial-tail classification only describes usable PCM, not complete source coverage', () => {
  assert.equal(xmArchivePartialTailIsUsable(18, 10.2875), true);
  assert.equal(xmArchivePartialTailIsUsable(18, 0.25), true);
  assert.equal(xmArchivePartialTailIsUsable(18, 0.1), false);
  assert.equal(xmArchivePartialTailIsUsable(18, 18), false);
  assert.equal(xmArchivePartialTailIsUsable(0, 1), false);
});

test('Drive actions allow an empty OpenAI question and disable email report flags', () => {
  const action = normalizeStoredAction({
    id: 'drive-action',
    name: 'Полная транскрибация',
    groupIds: ['group-1'],
    question: '',
    destination: 'drive',
    periodMode: 'daily',
    reportDaily: true,
    reportWeekly: true,
    runOnWeekends: true
  });
  assert.equal(action.destination, 'drive');
  assert.equal(action.question, '');
  assert.equal(action.reportDaily, false);
  assert.equal(action.reportWeekly, false);
});

test('Drive status requires credentials for the explicitly selected auth type', () => {
  const keys = [
    'GOOGLE_DRIVE_ROOT_FOLDER_ID', 'GOOGLE_DRIVE_AUTH_TYPE',
    'GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_SECRET', 'GOOGLE_DRIVE_REFRESH_TOKEN',
    'GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY'
  ];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = 'root-folder';
    process.env.GOOGLE_DRIVE_AUTH_TYPE = 'oauth';
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL = 'listener@example.invalid';
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY = 'service-account-key';
    assert.equal(publicGoogleDriveConfig().configured, false);

    process.env.GOOGLE_DRIVE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'client-secret';
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = 'refresh-token';
    assert.equal(publicGoogleDriveConfig().configured, true);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('manual Drive uploads accept loopback clients and reject LAN addresses', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('192.168.40.25'), false);
  assert.equal(isLoopbackAddress(''), false);
});

test('archive search defaults cameras to Moscow when only the Yekaterinburg display zone is stored', () => {
  const result = normalizeRecordingSearchTimeRange(new URLSearchParams({
    from: '2026-09-21T13:00',
    to: '2026-09-21T14:00',
    timeZone: 'Asia/Yekaterinburg'
  }));
  assert.equal(result.params.get('from'), '2026-09-21T11:00');
  assert.equal(result.params.get('to'), '2026-09-21T12:00');
  assert.equal(result.publicRange.displayTimeZone, 'Asia/Yekaterinburg');
  assert.equal(result.publicRange.cameraTimeZone, 'Europe/Moscow');
});

test('background Drive action transcribes the full selection and skips OpenAI and SMTP', async () => {
  const candidate = {
    action: {
      id: 'drive-action', name: 'Архив бухгалтерии', question: '', destination: 'drive',
      groupIds: ['group-1'], periodMode: 'daily', reportDaily: false, reportWeekly: false
    },
    groups: [{ id: 'group-1', name: 'Рабочее время', channels: [2] }],
    selections: [{
      groupId: 'group-1', groupName: 'Рабочее время', channel: 2,
      from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T08:01:00.000Z', rangeSeconds: 60
    }],
    periodMode: 'daily',
    from: '2026-09-21T08:00:00.000Z',
    to: '2026-09-21T08:01:00.000Z',
    dueAt: '2026-09-21T08:01:00.000Z',
    runKey: 'daily:test',
    configHash: 'test'
  };
  const calls = [];
  let uploaded;
  const result = await runScheduledOpenAiAction(candidate, {
    settings: {
      transcriptSeconds: 60,
      displayTimeZone: 'Asia/Yekaterinburg',
      cameraTimeZone: 'Europe/Moscow'
    },
    labels: [{ channel: 2, label: 'Бухгалтерия' }],
    services: {
      updateLastRun: async () => {},
      persistRun: async () => {},
      requestApi: async pathname => {
        calls.push(pathname);
        if (pathname.startsWith('/api/recordings/search')) {
          return { items: [{ startTime: '2026-09-21T11:00:00', endTime: '2026-09-21T11:01:00' }] };
        }
        if (pathname.startsWith('/api/recordings/transcript')) {
          return { durationSeconds: 60, segments: [{ start: 0, end: 4, text: 'Доброе утро' }] };
        }
        assert.fail(`Drive action must not call ${pathname}`);
      },
      uploadDriveTranscripts: async (item, transcript) => {
        uploaded = { item, transcript };
        return { uploads: [{ channel: 2, fileId: 'file-2' }] };
      }
    }
  });

  assert.equal(result.status, 'success');
  assert.equal(result.progress.stage, 'done');
  assert.equal(result.uploads[0].fileId, 'file-2');
  assert.equal(uploaded.transcript.transcriptEntries.length, 1);
  assert.equal(uploaded.transcript.transcriptEntries[0].start, '2026-09-21T08:00:00.000Z');
  assert.equal(calls.some(pathname => pathname === '/api/openai/ask' || pathname === '/api/reports/send'), false);
});

for (const scenario of [
  { name: 'rejects a zero-byte EOF mixed with a zero-byte timeout', failures: ['ended', 'timeout'] },
  { name: 'rejects a lone zero-byte EOF without claiming that the archive contains no audio', failures: ['ended'] },
  { name: 'uploads fully decoded silent PCM even when the ASR text is empty', failures: [null] }
]) {
  test(`background Drive action ${scenario.name}`, async () => {
    const index = scenario.failures.length;
    const from = '2026-09-21T08:00:00.000Z';
    const to = new Date(Date.parse(from) + scenario.failures.length * 60000).toISOString();
    const candidate = {
      action: {
        id: `drive-no-audio-${index}`, name: 'Архив переговорной', question: '', destination: 'drive',
        groupIds: ['group-1'], periodMode: 'daily', reportDaily: false, reportWeekly: false
      },
      groups: [{ id: 'group-1', name: 'Рабочее время', channels: [14] }],
      selections: [{
        groupId: 'group-1', groupName: 'Рабочее время', channel: 14,
        from, to, rangeSeconds: scenario.failures.length * 60
      }],
      periodMode: 'daily',
      from, to, dueAt: to,
      runKey: `daily:no-audio-${index}`,
      configHash: `no-audio-${index}`
    };
    let uploaded;
    const result = await runScheduledOpenAiAction(candidate, {
      settings: {
        transcriptSeconds: 60,
        displayTimeZone: 'Asia/Yekaterinburg',
        cameraTimeZone: 'Europe/Moscow'
      },
      labels: [{ channel: 14, label: 'Переговорка' }],
      services: {
        updateLastRun: async () => {},
        persistRun: async () => {},
        requestApi: async pathname => {
          if (pathname.startsWith('/api/recordings/search')) {
            return {
              vendor: 'xm',
              items: scenario.failures.map((failure, recordingIndex) => ({
                startTime: `2026-09-21T11:${String(recordingIndex).padStart(2, '0')}:00`,
                endTime: `2026-09-21T11:${String(recordingIndex + 1).padStart(2, '0')}:00`,
                fileName: `/archive/channel-14-${recordingIndex}.h264`
              }))
            };
          }
          if (pathname.startsWith('/api/recordings/transcript')) {
            const fileName = new URL(pathname, 'http://listener.local').searchParams.get('fileName');
            const recordingIndex = Number(/-(\d+)\.h264$/.exec(fileName)[1]);
            const failure = scenario.failures[recordingIndex];
            if (!failure) return { durationSeconds: 60, text: '', segments: [] };
            const message = failure === 'ended'
              ? 'XM archive audio ended before the requested range was received.'
              : 'Timed out while waiting for XM archive audio.';
            const error = new Error(message);
            error.statusCode = message.startsWith('Timed out') ? 504 : 502;
            error.details = {
              pipeline: 'xm-continuous-pcm-v1',
              receivedAudioBytes: 0
            };
            throw error;
          }
          assert.fail(pathname);
        },
        uploadDriveTranscripts: async (item, transcript) => {
          uploaded = transcript;
          return { uploads: [{ channel: 14, fileId: `file-14-${index}` }] };
        }
      }
    });

    assert.equal(result.missingAudioRecordings, 0);
    if (scenario.failures.some(Boolean)) {
      assert.equal(result.status, 'error');
      assert.equal(result.stage, 'transcript');
      assert.equal(result.details.failedRecordings, scenario.failures.length);
      assert.equal(result.progress.completedRecordings, 0);
      assert.equal(result.details.issues.length, scenario.failures.length);
      assert.equal(uploaded, undefined);
      assert.deepEqual(result.uploads, []);
    } else {
      assert.equal(result.status, 'success', result.error);
      assert.equal(uploaded.completedRecordings, 1);
      assert.equal(uploaded.failedRecordings, 0);
      assert.equal(uploaded.missingAudioRecordings, 0);
      assert.deepEqual(uploaded.transcriptEntries, []);
      assert.equal(result.uploads.length, 1);
    }
  });
}

test('background Drive action retries a lone zero-byte timeout because it may be a transport stall', async () => {
  const candidate = {
    action: {
      id: 'drive-timeout', name: 'Архив переговорной', question: '', destination: 'drive',
      groupIds: ['group-1'], periodMode: 'daily', reportDaily: false, reportWeekly: false
    },
    groups: [{ id: 'group-1', name: 'Рабочее время', channels: [14] }],
    selections: [{
      groupId: 'group-1', groupName: 'Рабочее время', channel: 14,
      from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T08:01:00.000Z', rangeSeconds: 60
    }],
    periodMode: 'daily', from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T08:01:00.000Z',
    dueAt: '2026-09-21T08:01:00.000Z', runKey: 'daily:timeout', configHash: 'timeout'
  };
  let uploadCalled = false;
  const result = await runScheduledOpenAiAction(candidate, {
    settings: { transcriptSeconds: 60, displayTimeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow' },
    labels: [{ channel: 14, label: 'Переговорка' }],
    services: {
      updateLastRun: async () => {}, persistRun: async () => {},
      requestApi: async pathname => {
        if (pathname.startsWith('/api/recordings/search')) {
          return { vendor: 'xm', items: [{
            startTime: '2026-09-21T11:00:00', endTime: '2026-09-21T11:01:00', fileName: '/archive/channel-14.h264'
          }] };
        }
        const error = new Error('Timed out while waiting for XM archive audio.');
        error.statusCode = 504;
        error.details = { pipeline: 'xm-continuous-pcm-v1', receivedAudioBytes: 0 };
        throw error;
      },
      uploadDriveTranscripts: async () => { uploadCalled = true; }
    }
  });

  assert.equal(result.status, 'error');
  assert.equal(result.details.failedRecordings, 1);
  assert.equal(uploadCalled, false);
});

test('background Drive action still fails on a real camera network error', async () => {
  const candidate = {
    action: {
      id: 'drive-network-error', name: 'Архив переговорной', question: '', destination: 'drive',
      groupIds: ['group-1'], periodMode: 'daily', reportDaily: false, reportWeekly: false
    },
    groups: [{ id: 'group-1', name: 'Рабочее время', channels: [14] }],
    selections: [{
      groupId: 'group-1', groupName: 'Рабочее время', channel: 14,
      from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T08:01:00.000Z', rangeSeconds: 60
    }],
    periodMode: 'daily', from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T08:01:00.000Z',
    dueAt: '2026-09-21T08:01:00.000Z', runKey: 'daily:network-error', configHash: 'network-error'
  };
  let uploadCalled = false;
  const result = await runScheduledOpenAiAction(candidate, {
    settings: { transcriptSeconds: 60, displayTimeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow' },
    labels: [{ channel: 14, label: 'Переговорка' }],
    services: {
      updateLastRun: async () => {},
      persistRun: async () => {},
      requestApi: async pathname => {
        if (pathname.startsWith('/api/recordings/search')) {
          return { vendor: 'xm', items: [{
            startTime: '2026-09-21T11:00:00', endTime: '2026-09-21T11:01:00', fileName: '/archive/channel-14.h264'
          }] };
        }
        const error = new Error('connect ECONNREFUSED 192.168.40.99:80');
        error.statusCode = 502;
        throw error;
      },
      uploadDriveTranscripts: async () => { uploadCalled = true; }
    }
  });

  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'transcript');
  assert.equal(result.details.failedRecordings, 1);
  assert.equal(uploadCalled, false);
});

test('background Drive action uploads each completed camera before later cameras finish', async () => {
  const candidate = {
    action: {
      id: 'drive-per-camera', name: 'Покамерная выгрузка', question: '', destination: 'drive',
      groupIds: ['group-1'], periodMode: 'daily', reportDaily: false, reportWeekly: false
    },
    groups: [{ id: 'group-1', name: 'Рабочее время', channels: [2, 3] }],
    selections: [2, 3].map(channel => ({
      groupId: 'group-1', groupName: 'Рабочее время', channel,
      from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T08:01:00.000Z', rangeSeconds: 60
    })),
    periodMode: 'daily',
    from: '2026-09-21T08:00:00.000Z',
    to: '2026-09-21T08:01:00.000Z',
    dueAt: '2026-09-21T08:01:00.000Z',
    runKey: 'daily:per-camera',
    configHash: 'per-camera'
  };
  let secondCameraSearchStarted = false;
  const uploadedChannels = [];
  const result = await runScheduledOpenAiAction(candidate, {
    settings: { displayTimeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow' },
    labels: [{ channel: 2, label: 'Бухгалтерия' }, { channel: 3, label: 'Склад' }],
    services: {
      updateLastRun: async () => {},
      persistRun: async () => {},
      requestApi: async pathname => {
        const url = new URL(pathname, 'http://listener.local');
        const channel = Number(url.searchParams.get('channel'));
        if (pathname.startsWith('/api/recordings/search')) {
          if (channel === 3) secondCameraSearchStarted = true;
          return channel === 2
            ? { items: [{ startTime: '2026-09-21T11:00:00', endTime: '2026-09-21T11:01:00' }] }
            : { items: [] };
        }
        if (pathname.startsWith('/api/recordings/transcript')) {
          return { durationSeconds: Number(new URL(pathname, 'http://listener.test').searchParams.get('duration')), segments: [{ start: 0, end: 4, text: 'Готовый текст' }] };
        }
        assert.fail(pathname);
      },
      uploadDriveTranscripts: async item => {
        assert.equal(secondCameraSearchStarted, false);
        const channel = item.selections[0].channel;
        uploadedChannels.push(channel);
        return { uploads: [{ channel, fileId: `file-${channel}` }] };
      }
    }
  });

  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'search');
  assert.deepEqual(uploadedChannels, [2]);
  assert.deepEqual(result.uploads.map(item => item.channel), [2]);
});

test('background Drive retry skips a camera whose complete period is already uploaded', async () => {
  const candidate = {
    action: {
      id: 'drive-resume', name: 'Продолжение', question: '', destination: 'drive',
      groupIds: ['group-1'], periodMode: 'daily', reportDaily: false, reportWeekly: false
    },
    groups: [{ id: 'group-1', name: 'Рабочее время', channels: [2, 3] }],
    selections: [2, 3].map(channel => ({
      groupId: 'group-1', groupName: 'Рабочее время', channel,
      from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T08:01:00.000Z', rangeSeconds: 60
    })),
    periodMode: 'daily', from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T08:01:00.000Z',
    dueAt: '2026-09-21T08:01:00.000Z', runKey: 'daily:resume', configHash: 'resume'
  };
  const searchedChannels = [];
  const uploadedChannels = [];
  const result = await runScheduledOpenAiAction(candidate, {
    settings: { displayTimeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow' },
    labels: [{ channel: 2, label: 'Бухгалтерия' }, { channel: 3, label: 'Склад' }],
    services: {
      updateLastRun: async () => {},
      persistRun: async () => {},
      findDriveTranscripts: async () => ({
        uploads: [{ channel: 2, fileId: 'existing-2', skipped: true }]
      }),
      requestApi: async pathname => {
        const url = new URL(pathname, 'http://listener.local');
        const channel = Number(url.searchParams.get('channel'));
        if (pathname.startsWith('/api/recordings/search')) {
          searchedChannels.push(channel);
          return { items: [{ startTime: '2026-09-21T11:00:00', endTime: '2026-09-21T11:01:00' }] };
        }
        if (pathname.startsWith('/api/recordings/transcript')) {
          return { durationSeconds: Number(new URL(pathname, 'http://listener.test').searchParams.get('duration')), segments: [{ start: 0, end: 4, text: 'Новый текст' }] };
        }
        assert.fail(pathname);
      },
      uploadDriveTranscripts: async item => {
        const channel = item.selections[0].channel;
        uploadedChannels.push(channel);
        return { uploads: [{ channel, fileId: `file-${channel}` }] };
      }
    }
  });

  assert.equal(result.status, 'success');
  assert.deepEqual(searchedChannels, [3]);
  assert.deepEqual(uploadedChannels, [3]);
  assert.deepEqual(result.uploads.map(item => item.channel), [2, 3]);
  assert.equal(result.progress.skippedCameras, 1);
});

test('background Drive action timestamps text-only transcript blocks with their chunk offsets', async () => {
  const candidate = {
    action: {
      id: 'drive-text-only', name: 'Архив бухгалтерии', question: '', destination: 'drive',
      groupIds: ['group-1'], periodMode: 'daily', reportDaily: false, reportWeekly: false
    },
    groups: [{ id: 'group-1', name: 'Рабочее время', channels: [2] }],
    selections: [{
      groupId: 'group-1', groupName: 'Рабочее время', channel: 2,
      from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T08:02:00.000Z', rangeSeconds: 120
    }],
    periodMode: 'daily',
    from: '2026-09-21T08:00:00.000Z',
    to: '2026-09-21T08:02:00.000Z',
    dueAt: '2026-09-21T08:02:00.000Z',
    runKey: 'daily:text-only',
    configHash: 'text-only'
  };
  let uploaded;
  const result = await runScheduledOpenAiAction(candidate, {
    settings: {
      transcriptSeconds: 60,
      displayTimeZone: 'Asia/Yekaterinburg',
      cameraTimeZone: 'Europe/Moscow'
    },
    labels: [{ channel: 2, label: 'Бухгалтерия' }],
    services: {
      updateLastRun: async () => {},
      persistRun: async () => {},
      requestApi: async pathname => {
        if (pathname.startsWith('/api/recordings/search')) {
          return { items: [{ startTime: '2026-09-21T11:00:00', endTime: '2026-09-21T11:02:00' }] };
        }
        if (pathname.startsWith('/api/recordings/transcript')) {
          const offset = Number(new URL(pathname, 'http://listener.local').searchParams.get('offsetSeconds') || 0);
          return { durationSeconds: 60, offsetSeconds: offset, text: `Блок ${offset}`, segments: [] };
        }
        assert.fail(`Drive action must not call ${pathname}`);
      },
      uploadDriveTranscripts: async (item, transcript) => {
        uploaded = transcript;
        return { uploads: [{ channel: 2, fileId: 'file-2' }] };
      }
    }
  });

  assert.equal(result.warnings?.length || 0, 0, JSON.stringify(result.warnings || []));
  assert.deepEqual(
    uploaded.transcriptEntries.map(entry => [entry.start, entry.end, entry.text]),
    [
      ['2026-09-21T08:00:00.000Z', '2026-09-21T08:01:00.000Z', 'Блок 0'],
      ['2026-09-21T08:01:00.000Z', '2026-09-21T08:02:00.000Z', 'Блок 60']
    ]
  );
});

test('background Drive action does not upload an empty file when no archive audio was processed', async () => {
  const candidate = {
    action: {
      id: 'drive-incomplete', name: 'Неполный архив', question: '', destination: 'drive',
      groupIds: ['group-1'], periodMode: 'daily', reportDaily: false, reportWeekly: false
    },
    groups: [{ id: 'group-1', name: 'Рабочее время', channels: [2] }],
    selections: [{
      groupId: 'group-1', groupName: 'Рабочее время', channel: 2,
      from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T09:00:00.000Z', rangeSeconds: 3600
    }],
    periodMode: 'daily', from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T09:00:00.000Z',
    dueAt: '2026-09-21T09:00:00.000Z', runKey: 'daily:incomplete', configHash: 'incomplete'
  };
  let uploadCalled = false;
  const result = await runScheduledOpenAiAction(candidate, {
    settings: { displayTimeZone: 'Asia/Yekaterinburg', cameraTimeZone: 'Europe/Moscow' },
    labels: [{ channel: 2, label: 'Бухгалтерия' }],
    services: {
      updateLastRun: async () => {},
      persistRun: async () => {},
      requestApi: async pathname => pathname.startsWith('/api/recordings/search') ? { items: [] } : assert.fail(pathname),
      uploadDriveTranscripts: async () => { uploadCalled = true; }
    }
  });

  assert.equal(result.status, 'error');
  assert.equal(result.stage, 'search');
  assert.equal(uploadCalled, false);
  assert.match(result.error, /не полностью/i);
});

test('TXT files are split by camera and show selected display-zone timestamps', () => {
  const files = buildDriveTranscriptFiles({
    action: { id: 'drive-action', name: 'Рабочий день' },
    from: '2026-09-21T08:00:00.000Z',
    to: '2026-09-21T09:00:00.000Z',
    settings: { displayTimeZone: 'Asia/Yekaterinburg' },
    selections: [
      { channel: 2, label: 'Бухгалтерия', from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T09:00:00.000Z' },
      { channel: 3, label: 'Склад', from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T09:00:00.000Z' }
    ],
    entries: [{
      channel: 2, label: 'Бухгалтерия', start: '2026-09-21T08:00:00.000Z',
      end: '2026-09-21T08:00:04.000Z', text: 'Доброе утро'
    }]
  });

  assert.equal(files.length, 2);
  assert.equal(files[0].fileName, '02 Бухгалтерия — 2026-09-21_13-00-00--2026-09-21_14-00-00 — Рабочий день.txt');
  assert.equal(files[1].fileName, '03 Склад — 2026-09-21_13-00-00--2026-09-21_14-00-00 — Рабочий день.txt');
  assert.match(files[0].content, /^\uFEFFКамера: 02 — Бухгалтерия/);
  assert.match(files[0].content, /21\.09\.2026, 13:00:00–21\.09\.2026, 13:00:04/);
  assert.match(files[0].content, /Доброе утро/);
  assert.match(files[1].content, /Речь в выбранном периоде не обнаружена/);
  assert.equal(files[0].completeness, 'complete');
  assert.equal(files[1].completeness, 'complete');
});

test('TXT generation rejects a known incomplete camera and permits a separately selected complete camera', () => {
  const from = '2026-09-21T08:00:00.000Z';
  const to = '2026-09-21T08:02:00.000Z';
  const payload = {
    action: { id: 'partial-files', name: 'Рабочий день' }, from, to,
    settings: { displayTimeZone: 'Asia/Yekaterinburg' },
    selections: [2, 3].map(channel => ({ channel, label: `Камера ${channel}`, from, to })),
    entries: [{ channel: 2, start: from, end: '2026-09-21T08:00:04.000Z', text: 'Сохранённая речь' }],
    diagnostics: [
      { channel: 2, from, to, processedSeconds: 60 },
      { channel: 3, from, to, processedSeconds: 120 }
    ],
    issues: [{
      stage: 'transcript', code: 'TRANSCRIPTION_FAILED', channel: 2,
      fileName: '/archive/channel-2.h264', error: 'Аудио второго блока получено не полностью.',
      from: '2026-09-21T08:01:00.000Z', to,
      cause: { code: 'INCOMPLETE_AUDIO', expectedDurationSeconds: 60, receivedDurationSeconds: 0.32 }
    }]
  };
  assert.throws(() => buildDriveTranscriptFiles(payload), error => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.details.issues[0].channel, 2);
    assert.match(error.message, /неполные камеры не выгружены/);
    return true;
  });
  const [complete] = buildDriveTranscriptFiles({
    ...payload,
    selections: payload.selections.filter(item => item.channel === 3),
    entries: [], issues: [],
    diagnostics: payload.diagnostics.filter(item => item.channel === 3)
  });
  assert.equal(complete.completeness, 'complete');
  assert.equal(complete.processedSeconds, 120);
  assert.doesNotMatch(complete.fileName, /НЕПОЛНАЯ ТРАНСКРИБАЦИЯ/);
  assert.doesNotMatch(complete.content, /НЕПОЛНАЯ ТРАНСКРИБАЦИЯ|TRANSCRIPTION_FAILED|второго блока/);
  assert.match(complete.content, /Речь в выбранном периоде не обнаружена/);
});

test('a partially processed silent period does not produce a Drive TXT', () => {
  const from = '2026-09-21T08:00:00.000Z';
  const to = '2026-09-21T08:02:00.000Z';
  assert.throws(() => buildDriveTranscriptFiles({
    action: { name: 'Тихий архив' }, from, to,
    settings: { displayTimeZone: 'Asia/Yekaterinburg' },
    selections: [{ channel: 14, label: 'Переговорка', from, to }],
    entries: [],
    diagnostics: [{ channel: 14, from, to, processedSeconds: 60 }],
    issues: [{
      stage: 'search', code: 'ARCHIVE_GAPS', channel: 14, from, to,
      error: 'Архив не покрывает весь период: отсутствует 60 с.',
      gaps: [{ from: '2026-09-21T08:01:00.000Z', to }]
    }]
  }), /Архив не покрывает весь период/);
});

test('an explicit missing tail stays in the error details instead of generating a partial TXT', () => {
  const from = '2026-09-21T08:00:00.000Z';
  const to = '2026-09-21T09:00:00.000Z';
  assert.throws(() => buildDriveTranscriptFiles({
    action: { name: 'Длинная запись' }, from, to,
    settings: { displayTimeZone: 'Asia/Yekaterinburg' },
    selections: [{ channel: 2, label: 'Бухгалтерия', from, to }],
    entries: [{ channel: 2, start: from, end: '2026-09-21T08:00:04.000Z', text: 'Сохранённый текст' }],
    diagnostics: [{ channel: 2, from, to, processedSeconds: 91.05 }],
    issues: [{
      stage: 'transcript', code: 'TRANSCRIPTION_FAILED', channel: 2,
      from: '2026-09-21T08:01:00.000Z', to: '2026-09-21T08:02:00.000Z',
      error: 'Получен неполный аудиофрагмент; недостающий интервал будет запрошен повторно.',
      cause: {
        code: 'INCOMPLETE_AUDIO', expectedDurationSeconds: 60, receivedDurationSeconds: 31.05,
        missingFrom: '2026-09-21T08:01:31.050Z', missingTo: to
      }
    }]
  }), error => {
    assert.equal(error.details.issues[0].cause.missingFrom, '2026-09-21T08:01:31.050Z');
    assert.equal(error.details.issues[0].cause.missingTo, to);
    return true;
  });
});

test('known incomplete markers fail closed even when the top-level issues list was lost', () => {
  const base = {
    from: '2026-09-21T08:00:00.000Z', to: '2026-09-21T08:01:00.000Z',
    selections: [{ channel: 2, label: 'Бухгалтерия' }], entries: [], issues: []
  };
  for (const marker of [
    { diagnostics: [{ channel: 2, status: 'incomplete' }] },
    { diagnostics: [{ channel: 2, status: 'transcript' }] },
    { diagnostics: [{ channel: 2, archiveCoverage: { complete: false } }] },
    { diagnostics: [{ channel: 2, issues: [{ channel: 2, code: 'INCOMPLETE_AUDIO' }] }] },
    { entries: [{ channel: 2, kind: 'audio_gap', text: 'Аудио отсутствует' }] },
    { entries: [{ channel: 2, type: 'audio_gap', text: '' }] },
    { entries: [{ channel: 2, partial: true, text: 'Неполный блок' }] },
    { failedSearches: 1 }, { failedRecordings: 1 },
    { partial: true }, { completeness: 'partial' }, { complete: false }
  ]) {
    assert.throws(() => buildDriveTranscriptFiles({ ...base, ...marker }), /не полностью/, JSON.stringify(marker));
  }
  const [silent] = buildDriveTranscriptFiles({
    ...base,
    diagnostics: [{ channel: 2, status: 'complete', processedSeconds: 60, archiveCoverage: { complete: true } }]
  });
  assert.equal(silent.completeness, 'complete');
  assert.match(silent.content, /Речь в выбранном периоде не обнаружена/);
});
