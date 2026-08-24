import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

const pcRoot = process.env.PDF_PREVIEW_DIAGNOSTIC_PC_ROOT || path.resolve(__dirname, '../..');
const viewerSource = fs.readFileSync(
  path.resolve(pcRoot, 'src/renderer/modules/chat-file-viewer.js'),
  'utf8',
);
const mainSource = fs.readFileSync(path.resolve(pcRoot, 'src/main/index.ts'), 'utf8');

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
  let now = 1_000;
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
    '_viewerClearPdfSlowTimer',
    '_viewerBeginPdfPreview',
    '_viewerPdfIframeLoaded',
    '_viewerPdfIframeFailed',
    '_viewerFinishPdfPreview',
  ].map((name) => extractFunction(viewerSource, name)).join('\n');
  vm.runInNewContext(`
    let _viewerPdfPreviewSeq = 0;
    let _viewerPdfPreviewState = null;
    const _VIEWER_PDF_SLOW_LOAD_MS = 5000;
    const _viewerLog = globalThis.__viewerLog;
    ${functions}
    globalThis.__pdfLifecycle = {
      begin: _viewerBeginPdfPreview,
      loaded: _viewerPdfIframeLoaded,
      failed: _viewerPdfIframeFailed,
      finish: _viewerFinishPdfPreview,
    };
  `, context);
  const lifecycle = context.__pdfLifecycle as {
    begin: (cid?: string, projectId?: string) => object;
    loaded: (state: object) => void;
    failed: (state: object, errorCode?: string) => void;
    finish: (reason: string) => void;
  };
  return {
    lifecycle,
    logs,
    advance(ms: number) { now += ms; },
    runPendingTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((callback) => callback());
    },
  };
}

describe('PDF preview diagnostics', () => {
  it('records slow, loaded, and closed lifecycle states without user identifiers', () => {
    const harness = createLifecycleHarness();
    const privateCid = 'customer-private-conversation-id';
    const state = harness.lifecycle.begin(privateCid);
    harness.advance(5_100);
    harness.runPendingTimers();
    harness.lifecycle.loaded(state);
    harness.advance(400);
    harness.lifecycle.finish('closed');

    expect(harness.logs.map((record) => [record.level, record.message])).toEqual([
      ['info', 'pdf preview opened'],
      ['warn', 'pdf preview iframe load slow'],
      ['info', 'pdf preview iframe loaded'],
      ['info', 'pdf preview closed'],
    ]);
    expect(harness.logs[1].data).toMatchObject({
      preview_id: 1,
      source: 'conversation',
      threshold_ms: 5000,
      duration_ms: 5100,
    });
    expect(harness.logs[3].data).toMatchObject({
      preview_id: 1,
      source: 'conversation',
      outcome: 'loaded',
      reason: 'closed',
      duration_ms: 5500,
    });
    expect(JSON.stringify(harness.logs)).not.toContain(privateCid);
  });

  it('distinguishes iframe failure and close-before-load, then cancels pending timers', () => {
    const harness = createLifecycleHarness();
    const failed = harness.lifecycle.begin(undefined, 'private-project-id');
    harness.advance(25);
    harness.lifecycle.failed(failed);
    harness.lifecycle.finish('replaced');
    harness.lifecycle.begin();
    harness.advance(10);
    harness.lifecycle.finish('closed');
    harness.advance(10_000);
    harness.runPendingTimers();

    expect(harness.logs.map((record) => record.message)).toEqual([
      'pdf preview opened',
      'pdf preview iframe failed',
      'pdf preview closed',
      'pdf preview opened',
      'pdf preview closed',
    ]);
    expect(harness.logs[2].data).toMatchObject({ outcome: 'failed', reason: 'replaced' });
    expect(harness.logs[4].data).toMatchObject({
      source: 'workspace',
      outcome: 'closed_before_load',
      reason: 'closed',
    });
    expect(JSON.stringify(harness.logs)).not.toContain('private-project-id');
  });

  it('attaches iframe listeners before navigation and avoids HTML-string interpolation', () => {
    const renderPdf = extractFunction(viewerSource, '_renderPdfBody');
    expect(renderPdf).toContain("iframe.addEventListener('load'");
    expect(renderPdf).toContain("iframe.addEventListener('error'");
    expect(renderPdf).toContain('_viewerShowLoading()');
    expect(renderPdf).toContain('_viewerAppendLoadingResource(iframe)');
    expect(renderPdf).not.toContain('innerHTML = `<iframe');
  });

  it('keeps protocol log calls free of request URLs, paths, and raw errors', () => {
    const protocolStart = mainSource.indexOf('function registerKbFileProtocol');
    const protocolEnd = mainSource.indexOf('// Single-instance lock', protocolStart);
    expect(protocolStart).toBeGreaterThanOrEqual(0);
    expect(protocolEnd).toBeGreaterThan(protocolStart);
    const protocolSource = mainSource.slice(protocolStart, protocolEnd);
    const logCalls = protocolSource.match(/log\.(?:info|warn|error)\([\s\S]*?\);/g) || [];
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) {
      expect(call).not.toMatch(/\breqUrl\b|\babsPath\b|\babs\s*:|\berror\s*:/);
    }
    const responseLog = mainSource.slice(
      mainSource.indexOf("log.info('pdf preview response prepared'"),
      mainSource.indexOf("log.info('pdf preview response prepared'") + 900,
    );
    expect(responseLog).toContain('range_header: diagnostic.rangeHeaderKind');
    expect(responseLog).toContain('status: diagnostic.status');
    expect(responseLog).toContain('response_bytes: diagnostic.responseBytes');
    expect(responseLog).toContain('prepare_duration_ms: diagnostic.prepareDurationMs');
    expect(mainSource).toContain("log.info('pdf preview stream finished'");
    expect(mainSource).toContain('stream_duration_ms: diagnostic.durationMs');
    expect(mainSource).toContain('bytes_read: diagnostic.bytesRead');
  });
});
