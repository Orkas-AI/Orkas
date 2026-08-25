import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

const pcRoot = path.resolve(__dirname, '../..');
const viewerSource = fs.readFileSync(
  path.resolve(pcRoot, 'src/renderer/modules/chat-file-viewer.js'),
  'utf8',
);

function extractFunction(source: string, name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

type LogRecord = { level: 'info' | 'warn'; message: string; data: Record<string, unknown> };

function createLifecycleHarness() {
  const logs: LogRecord[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let now = 10_000;
  const context: Record<string, unknown> = {
    Date: { now: () => now },
    __viewerLog: {
      info: (message: string, data: Record<string, unknown>) => logs.push({ level: 'info', message, data }),
      warn: (message: string, data: Record<string, unknown>) => logs.push({ level: 'warn', message, data }),
    },
    setTimeout: (callback: () => void) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  const functions = [
    '_viewerDurationSince',
    '_viewerClearHtmlSlowTimer',
    '_viewerBeginHtmlPreview',
    '_viewerHtmlLayoutFinished',
    '_viewerHtmlIframeLoaded',
    '_viewerHtmlIframeFailed',
    '_viewerMaybeCompleteHtmlPreview',
    '_viewerFinishHtmlPreview',
  ].map((name) => extractFunction(viewerSource, name)).join('\n');
  vm.runInNewContext(`
    let _viewerHtmlPreviewSeq = 0;
    let _viewerHtmlPreviewState = null;
    const _VIEWER_HTML_SLOW_LOAD_MS = 5000;
    const _viewerLog = globalThis.__viewerLog;
    ${functions}
    globalThis.__htmlLifecycle = {
      begin: _viewerBeginHtmlPreview,
      layout: _viewerHtmlLayoutFinished,
      loaded: _viewerHtmlIframeLoaded,
      failed: _viewerHtmlIframeFailed,
      finish: _viewerFinishHtmlPreview,
    };
  `, context);
  return {
    lifecycle: context.__htmlLifecycle as {
      begin: (cid?: string, projectId?: string) => object;
      layout: (state: object, kind: string, errorCode?: string) => void;
      loaded: (state: object) => void;
      failed: (state: object, errorCode?: string) => void;
      finish: (reason: string) => void;
    },
    logs,
    advance(ms: number) { now += ms; },
    runPendingTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((callback) => callback());
    },
  };
}

describe('HTML preview diagnostics', () => {
  it('locates the slow phase and records completion without private identifiers', () => {
    const harness = createLifecycleHarness();
    const state = harness.lifecycle.begin('private-conversation-id');
    harness.advance(150);
    harness.lifecycle.layout(state, 'responsive');
    harness.advance(5_000);
    harness.runPendingTimers();
    harness.advance(50);
    harness.lifecycle.loaded(state);
    harness.advance(25);
    harness.lifecycle.finish('closed');

    expect(harness.logs.map((record) => record.message)).toEqual([
      'html preview opened',
      'html preview layout finished',
      'html preview load slow',
      'html preview iframe loaded',
      'html preview ready',
      'html preview closed',
    ]);
    expect(harness.logs[2].data).toMatchObject({
      source: 'conversation',
      layout_finished: true,
      iframe_loaded: false,
      threshold_ms: 5000,
    });
    expect(harness.logs[5].data).toMatchObject({ outcome: 'loaded', reason: 'closed' });
    expect(JSON.stringify(harness.logs)).not.toContain('private-conversation-id');
  });

  it('records a stable layout fallback or iframe failure without raw errors', () => {
    const harness = createLifecycleHarness();
    const state = harness.lifecycle.begin(undefined, 'private-project-id');
    harness.advance(20);
    harness.lifecycle.layout(state, 'responsive', 'layout_probe_failed');
    harness.advance(30);
    harness.lifecycle.failed(state, 'iframe_load_failed');
    harness.lifecycle.finish('replaced');

    expect(harness.logs.map((record) => [record.level, record.message])).toEqual([
      ['info', 'html preview opened'],
      ['warn', 'html preview layout finished'],
      ['warn', 'html preview iframe failed'],
      ['info', 'html preview closed'],
    ]);
    expect(harness.logs[1].data).toMatchObject({ error_code: 'layout_probe_failed' });
    expect(harness.logs[2].data).toMatchObject({ error_code: 'iframe_load_failed' });
    expect(JSON.stringify(harness.logs)).not.toContain('private-project-id');
  });
});
