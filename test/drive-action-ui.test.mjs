import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `${name} must exist`);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/\n(?:async )?function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test('every Drive Run button uses the background pipeline, including one-time actions', () => {
  for (const [destination, periodMode, expected] of [
    ['drive', 'once', 'background'], ['drive', 'daily', 'background'],
    ['email', 'once', 'browser'], ['email', 'daily', 'background']
  ]) {
    const calls = [];
    const action = { id: 'action', destination, periodMode };
    const context = vm.createContext({
      actionById: () => action,
      isActionBusy: () => false,
      triggerScheduledOpenAiAction: async item => { calls.push(['background', item.id]); },
      runOpenAiWorkflow: async item => { calls.push(['browser', item.id]); }
    });
    vm.runInContext(functionSource('handleActionListClick'), context);
    context.handleActionListClick({ target: { closest: () => ({
      dataset: { actionCommand: 'run', actionId: action.id }, disabled: false
    }) } });
    assert.deepEqual(calls, [[expected, action.id]], `${destination}/${periodMode}`);
  }
});

test('a direct legacy browser workflow invocation cannot bypass the Drive background pipeline', async () => {
  const action = { id: 'once-drive', destination: 'drive', periodMode: 'once' };
  const calls = [];
  const context = vm.createContext({
    triggerScheduledOpenAiAction: async item => { calls.push(item.id); return 'queued'; },
    stopOpenAiWorkflow: () => assert.fail('must redirect before starting browser work')
  });
  vm.runInContext(functionSource('runOpenAiWorkflow'), context);
  assert.equal(await context.runOpenAiWorkflow(action), 'queued');
  assert.deepEqual(calls, [action.id]);
});

test('delivery status distinguishes locally completed TXT files from remote uploads', () => {
  const context = vm.createContext({
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  });
  vm.runInContext(functionSource('renderDriveDeliveryStatus'), context);
  const html = context.renderDriveDeliveryStatus({
    status: 'delivery_pending', progress: { readyCameras: 12 }, queuedCameras: 3,
    error: 'Google <network> failed'
  });
  assert.match(html, /Готовых файлов на компьютере: 12 · Ожидают отправки: 3/);
  assert.match(html, /без повторной обработки камер/);
  assert.match(html, /Google &lt;network&gt; failed/);
  assert.doesNotMatch(html, /<network>/);
  assert.equal(context.renderDriveDeliveryStatus({ status: 'success' }), '');
  assert.match(context.renderDriveDeliveryStatus({
    status: 'running', progress: { readyCameras: 2, queuedCameras: 1 }
  }), /Готовых файлов на компьютере: 2 · Ожидают отправки: 1/);
});
