import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
const skillsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf8');
const agentsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function loadFailedClassifier(): (raw: string, message?: Record<string, unknown> | null) => boolean {
  const fnSource = [
    extractFunction('_isRetiredNonFailureCode'),
    extractFunction('_isStructuredFailure'),
    extractFunction('_isFailedAssistantContent'),
  ].join('\n');
  return vm.runInNewContext(`${fnSource}\n_isFailedAssistantContent;`, {});
}

function loadInterruptedClassifier(): (message?: Record<string, unknown> | null) => boolean {
  const fnSource = [
    extractFunction('_groupMessageSystemKind'),
    extractFunction('_isInterruptedAssistantMessage'),
  ].join('\n');
  return vm.runInNewContext(`${fnSource}\n_isInterruptedAssistantMessage;`, {});
}

function loadFailedRetrySender() {
  const calls: Array<{ cid: string; content: string; extra?: Record<string, unknown> }> = [];
  const monitorCalls: Array<{ action: string; data?: Record<string, unknown> }> = [];
  const releases: Array<() => void> = [];
  const monitor = {
    click(action: string, data?: Record<string, unknown>) {
      monitorCalls.push({ action, data });
    },
  };
  const retrySource = extractFunction('_retryFailedAssistantMessage')
    .replace(/^function /, 'async function ');
  const retry = vm.runInNewContext(`(${retrySource})`, {
    currentCid: 'cid-1',
    t: (key: string) => key === 'chat.retry_user_message' ? 'Continue' : key,
    window: { Monitor: monitor },
    Monitor: monitor,
    sendInConversation: (cid: string, content: string, extra?: Record<string, unknown>) => {
      calls.push({ cid, content, extra });
      return new Promise<void>((resolve) => releases.push(resolve));
    },
  });
  return {
    retry,
    calls,
    monitorCalls,
    releaseAll() {
      while (releases.length) releases.shift()!();
    },
  };
}

function loadModelOutputTracker() {
  const source = [
    extractFunction('_normalizeFeedbackFieldText'),
    extractFunction('_trimTelemetryText'),
    extractFunction('_handleModelOutputErrorForUi'),
  ].join('\n');
  return vm.runInNewContext(`
    const currentCid = 'fallback-cid';
    const calls = [];
    function _convTrackError(action, data) { calls.push({ action, data }); }
    function _groupActorLabel(actorId) { return actorId === 'commander' ? 'Commander' : ''; }
    const window = {};
    ${source}
    ({ track: _handleModelOutputErrorForUi, calls });
  `, {});
}

describe('conversation failed assistant retry actions', () => {
  it('offers retry from recorded failure state even without error prose, but not for successful empty deliveries', () => {
    const isFailed = loadFailedClassifier();
    for (const text of ['', 'Partial answer', '一部の回答']) {
      expect(isFailed(text, { failure_kind: 'model', failure_code: 'empty_response' })).toBe(true);
    }
    expect(isFailed('', { failure_kind: 'dependency', failure_code: 'missing_cli' })).toBe(true);
    for (const message of [{}, { produced: ['report.md'] }, { form: { fields: [] } }, { terminalDelivery: true }]) {
      expect(isFailed('', message)).toBe(false);
    }
    // Retired host heuristics must not regain authority through legacy prose.
    expect(isFailed('Model call failed', {
      failure_kind: 'operation', failure_code: 'agent_reported_failure',
    })).toBe(false);
  });

  it('renders one localized empty-failure notice without changing content or inventing failures', () => {
    for (const language of ['en', 'zh', 'ja', 'pt']) {
      const locale = JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/renderer/locales/${language}.json`), 'utf8'));
      const notices: any[] = [];
      const bubble = {
        querySelector: () => notices[0] || null,
        appendChild: (node: any) => notices.push(node),
      };
      const mount = vm.runInNewContext([
        extractFunction('_isRetiredNonFailureCode'),
        extractFunction('_isStructuredFailure'),
        extractFunction('_mountEmptyResponseNotice'),
        '_mountEmptyResponseNotice;',
      ].join('\n'), {
        t: (key: string) => locale[key],
        document: { createElement: () => ({ dataset: {}, setAttribute() {} }) },
      });
      const msgDiv = { querySelector: () => bubble };
      for (const message of [
        { text: '' },
        { text: '', produced: ['report.md'] },
        { text: '', form: { fields: [] } },
        { text: '', terminalDelivery: true },
        { text: 'Existing error notice', failure_kind: 'model', failure_code: 'empty_response' },
        { text: '', failure_kind: 'model', failure_code: 'provider_error' },
        { text: '', failure_kind: 'model', failure_code: 'empty_response_lookalike' },
      ]) mount(msgDiv, message);
      expect(notices).toHaveLength(0);
      for (const code of ['empty_response', 'empty_response_normal', 'empty_response_unknown', 'empty_response_safety']) {
        notices.length = 0;
        const message = Object.freeze({ content: '', failure_kind: 'model', failure_code: code });
        mount(msgDiv, message);
        mount(msgDiv, message);
        expect(notices).toHaveLength(1);
        expect(notices[0].textContent).toBe(locale['chat.empty_response_retry']);
        expect(notices[0].textContent.length).toBeGreaterThan(0);
        expect(notices[0].dataset.i18n).toBe('chat.empty_response_retry');
        expect(message.content).toBe('');
      }
    }
  });

  it('keeps Retry enabled and submits every click with the stable failed-message identity', async () => {
    const { retry, calls, monitorCalls, releaseAll } = loadFailedRetrySender();
    const button = { disabled: false, innerHTML: 'Retry' };

    const first = retry({ dataset: { msgId: 'failed-message-1' } }, button);
    await Promise.resolve();
    const second = retry({ dataset: { msgId: 'failed-message-1' } }, button);
    await Promise.resolve();

    expect(calls).toEqual([{
      cid: 'cid-1',
      content: 'Continue',
      extra: { retry_message_id: 'failed-message-1' },
    }, {
      cid: 'cid-1',
      content: 'Continue',
      extra: { retry_message_id: 'failed-message-1' },
    }]);
    expect(button).toEqual({ disabled: false, innerHTML: 'Retry' });
    releaseAll();
    await Promise.all([first, second]);
  });

  it('classifies localized model-call failure text as retryable failure content', () => {
    const isFailed = loadFailedClassifier();

    expect(isFailed('⚠️ 模型调用失败：503 系统繁忙，请稍后重试')).toBe(true);
    expect(isFailed('Model call failed: 503 service unavailable')).toBe(true);
    expect(isFailed('Model response failed: aborted')).toBe(true);
    expect(isFailed('<span style="color:var(--danger)">⚠️ 模型调用失败：503</span>')).toBe(true);
    expect(isFailed('普通回复，没有失败状态')).toBe(false);
  });

  it('classifies persisted stop and startup-recovery records without matching ordinary prose', () => {
    const isInterrupted = loadInterruptedClassifier();

    expect(isInterrupted({
      process: [{
        type: 'event',
        event: { stream: 'runtime', data: { phase: 'end', aborted: true } },
      }],
    })).toBe(true);
    expect(isInterrupted({ _system_kind: 'reply_interrupted' })).toBe(true);
    expect(isInterrupted({
      content: 'The user discussed an interrupted download.',
      process: [{
        type: 'event',
        event: { stream: 'runtime', data: { phase: 'end', aborted: false } },
      }],
    })).toBe(false);
  });

  it('uses the standard bubble action colors for retry', () => {
    expect(styleSource).not.toMatch(/\.bubble-retry-btn\s*\{/);
    expect(source).toContain("retryBtn.className = 'bubble-action-btn bubble-retry-btn';");
  });

  it('reveals shared message actions only on message hover or keyboard focus', () => {
    expect(styleSource).toMatch(
      /\.chat-bubble-actions\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s,
    );
    expect(styleSource).toContain('.chat-message:hover .chat-bubble-actions');
    expect(styleSource).toContain('.chat-message:focus-within .chat-bubble-actions');
    expect(styleSource).toContain('.chat-bubble-actions:has(.bubble-more-btn[aria-expanded="true"])');
    expect(styleSource).toMatch(
      /\.chat-message:hover \.chat-bubble-actions,[^{]+\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s,
    );
    expect(styleSource).toMatch(
      /@media \(hover:\s*none\)\s*\{\s*\.chat-bubble-actions\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s,
    );
    expect(styleSource).not.toMatch(/\.chat-msg-actions\s*\{[^}]*opacity:\s*0;/s);
  });

  it('routes live failed and interrupted placeholders through retry actions', () => {
    const finalizeBody = extractFunction('_finalizeActorPlaceholder');

    expect(finalizeBody).toContain('const failedAssistant = _isFailedAssistantContent(text, gm);');
    expect(finalizeBody).toContain('const interruptedAssistant = _isInterruptedAssistantMessage(gm);');
    expect(finalizeBody).toContain('archive: archive && !failedAssistant && !interruptedAssistant');
    expect(finalizeBody).toContain('_attachFailedAssistantActions(ph, () => _messageTextForActions(ph, text));');
    expect(finalizeBody).toContain('_attachInterruptedAssistantActions(ph, () => _messageTextForActions(ph, text), { archive });');
    expect(finalizeBody).toContain("failure_kind: String(gm.failure_kind || '')");

    const failedActionsBody = extractFunction('_attachFailedAssistantActions');
    expect(failedActionsBody).toContain("msgDiv.dataset.failed = '1';");
    expect(failedActionsBody).toContain('archive: false');
    expect(failedActionsBody).toContain('retry: true');
    expect(failedActionsBody).not.toContain('report: true');
    expect(source).toContain("const mode = compact\n    ? 'failure-only'\n    : includeRetry");
    expect(source).toContain('class="chat-bubble-more-wrap"');
    expect(source).toContain('_attachBubbleRetryBtn(directActions, msgDiv)');

    const interruptedActionsBody = extractFunction('_attachInterruptedAssistantActions');
    expect(interruptedActionsBody).toContain("msgDiv.dataset.interrupted = '1';");
    expect(interruptedActionsBody).toContain('retry: true');
    expect(interruptedActionsBody).toContain('report: true');
    expect(source).toContain("else if (role === 'assistant' && interruptedAssistant)");
    expect(source).toContain('} else if (interruptedAssistant) {');
    expect(extractFunction('_streamingMarkAborted')).toContain('_attachInterruptedAssistantActions(');
  });

  it('does not send model output error telemetry in the open build', () => {
    const { track, calls } = loadModelOutputTracker();
    const msgDiv = {
      dataset: {
        msgId: 'm123',
        turnId: 'turn-1',
        fromActor: 'commander',
      },
    };
    const longError = `Model call failed: ${'x'.repeat(900)}`;

    track('cid-1', msgDiv, longError, { stage: 'stream_event' });
    track('cid-1', msgDiv, longError, { stage: 'stream_event' });
    track('cid-1', msgDiv, 'aborted', { aborted: true });

    expect(calls).toHaveLength(0);
  });

});

// S6-OWN-3: main dedupes a repeated Retry of the same failed bubble while its
// retry is still queued/running and answers `{ ok: true, already_pending }`.
// The renderer keeps Retry as a repeatable queue action; the deduped click
// must reach the user as "nothing new to do", never as an error.
describe('conversation busy-path send with a deduped retry', () => {
  function loadBusySender(response: Record<string, unknown>) {
    const rendered: unknown[] = [];
    const alerts: unknown[] = [];
    const warnings: string[] = [];
    const noop = () => undefined;
    const target: Record<string, unknown> = {
      console, JSON, String, Number, Array, Object, Promise, Math, Date, encodeURIComponent,
      performance: { now: () => 0 },
      currentCid: 'cid-1',
      isConvPending: () => true,
      apiFetch: async () => ({ json: async () => response }),
      uiAlert: (text: unknown) => { alerts.push(text); },
      _convLog: { warn: (text: string) => { warnings.push(text); }, info: noop, error: noop, debug: noop },
      _renderOrClaimPersistedUserMessage: (cid: string, msg: unknown) => { rendered.push(msg); return true; },
      _chatModelTelemetryContext: () => ({}),
      _normalizeCommanderTemplateAttribution: () => ({}),
      window: { TaskBoard: { resync: noop } },
    };
    const context = new Proxy(target, {
      has: () => true,
      get(t, key) {
        if (typeof key === 'symbol') return undefined;
        if (key in t) return t[key as string];
        if (key in globalThis) return (globalThis as any)[key];
        return noop;
      },
    });
    // `sendInConversation` declares `options = {}`; brace-match from the
    // body, not from the first `{` in the parameter list.
    const start = source.indexOf('async function sendInConversation(');
    if (start < 0) throw new Error('missing sendInConversation');
    let depth = 0;
    let end = -1;
    for (let i = source.indexOf(') {', start) + 2; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end < 0) throw new Error('unterminated sendInConversation');
    const send = vm.runInNewContext(`(${source.slice(start, end)})`, context);
    return { send, rendered, alerts, warnings };
  }

  it('treats an already-pending retry as an accepted send with no error, alert, or duplicate bubble', async () => {
    const { send, rendered, alerts, warnings } = loadBusySender({ ok: true, already_pending: true });

    const result = await send('cid-1', 'Continue', { retry_message_id: 'failed-1' }, {
      source_view: 'conversation',
    });

    expect(result).toEqual({ started: true, aborted: false, errored: false, result: 'success' });
    expect(rendered).toEqual([]);
    expect(alerts).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('still reports a rejected busy-path send as a failure (negative control)', async () => {
    const { send, rendered, warnings } = loadBusySender({ ok: false, error: 'retry target is not a failed assistant reply' });

    const result = await send('cid-1', 'Continue', { retry_message_id: 'failed-1' }, {
      source_view: 'conversation',
    });

    expect(result).toEqual({ started: false, aborted: false, errored: true, result: 'failure' });
    expect(rendered).toEqual([]);
    expect(warnings).toEqual(['busy direct send failed']);
  });
});
