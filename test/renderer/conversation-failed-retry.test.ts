import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

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
  const fnSource = extractFunction('_isFailedAssistantContent');
  return vm.runInNewContext(`(${fnSource})`, {});
}

function loadFeedbackBuilder(): (details: Record<string, unknown>, max?: number) => string {
  const source = [
    extractFunction('_normalizeFeedbackFieldText'),
    extractFunction('_tailFeedbackText'),
    extractFunction('_buildFailedAssistantFeedbackContent'),
  ].join('\n');
  return vm.runInNewContext(`${source}\n_buildFailedAssistantFeedbackContent;`, {});
}

function loadFeedbackSubmitDisplayMessage(): (raw: string) => string {
  const source = [
    extractFunction('_normalizeFeedbackFieldText'),
    extractFunction('_isInternalFeedbackSubmitError'),
    extractFunction('_feedbackSubmitDisplayMessage'),
  ].join('\n');
  return vm.runInNewContext(`
    function t(key) {
      const table = {
        'chat.report_login_required': 'Please sign in before sending feedback.',
        'chat.report_login_required': 'Please sign in before sending feedback.',
        'chat.report_failed': 'Feedback failed.',
      };
      return table[key] || key;
    }
    ${source}
    _feedbackSubmitDisplayMessage;
  `, {});
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
    function _maybeShowOrkasCreditGuidance() {}
    ${source}
    ({ track: _handleModelOutputErrorForUi, calls });
  `, {});
}

describe('conversation failed assistant retry actions', () => {
  it('classifies localized model-call failure text as retryable failure content', () => {
    const isFailed = loadFailedClassifier();

    expect(isFailed('⚠️ 模型调用失败：503 系统繁忙，请稍后重试')).toBe(true);
    expect(isFailed('Model call failed: 503 service unavailable')).toBe(true);
    expect(isFailed('<span style="color:var(--danger)">⚠️ 模型调用失败：503</span>')).toBe(true);
    expect(isFailed('普通回复，没有失败状态')).toBe(false);
  });

  it('routes live placeholder failures through retry actions instead of archive actions', () => {
    const finalizeBody = extractFunction('_finalizeActorPlaceholder');

    expect(finalizeBody).toContain('const failedAssistant = _isFailedAssistantContent(text, gm);');
    expect(finalizeBody).toContain('_streamingSetFinal(ph, text, { archive: archive && !failedAssistant });');
    expect(finalizeBody).toContain('_attachFailedAssistantActions(ph, () => _messageTextForActions(ph, text));');

    const failedActionsBody = extractFunction('_attachFailedAssistantActions');
    expect(failedActionsBody).toContain("msgDiv.dataset.failed = '1';");
    expect(failedActionsBody).toContain('archive: false');
    expect(failedActionsBody).toContain('retry: true');
    expect(failedActionsBody).toContain('report: true');
  });

  it('uses only the last 300 characters of failed-reply feedback text', () => {
    const build = loadFeedbackBuilder();
    const replyText = 'All validation passed before the final confirmation step. '.repeat(20);
    const errorText = 'Send failed: Run aborted while checking the generated file.';
    const content = build({
      cid: 'gconv-test',
      actor: 'OfficeWriter',
      msgId: 'm123',
      errorText,
      replyText,
    }, 300);
    const expected = `${replyText.trim()}\n${errorText}`.slice(-300);

    expect(content).toHaveLength(300);
    expect(content).toBe(expected);
    expect(content).not.toContain('Conversation: gconv-test');
    expect(content).toContain('Run aborted');
  });

  it('hides internal feedback submit transport errors from user-facing copy', () => {
    const display = loadFeedbackSubmitDisplayMessage();

    expect(display('account:/pms/feedback/submit timed out after 60s'))
      .toBe('chat.unknown_error');
    expect(display('HTTP 502')).toBe('chat.unknown_error');
    expect(display('Please sign in before sending feedback.'))
      .toBe('Please sign in before sending feedback.');
    expect(display('Your feedback text is too long.')).toBe('Your feedback text is too long.');
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
