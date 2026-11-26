import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  attachProcessLogAnalysis,
  attachProcessTermination,
  createModelEvalLogCollector,
  mergeModelEvalLogAnalyses,
} from "../../scripts/model-eval-log-policy.mjs";
const headlessMacWarnings = [
  'Trying to load the allocator multiple times. This is *not* supported.',
  '[123:456:1114/081903.300239:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670',
  '[1114/084849.695655:ERROR:sandbox/mac/system_services.cc:31] SetApplicationIsDaemon: Error Domain=NSOSStatusErrorDomain Code=-50 "paramErr: error in user parameter list" (-50)',
  '[1114/175633.522910:ERROR:ui/display/mac/cv_display_link_mac.mm:192] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670',
];

it.each(['CATEGORY', 'SUPPRESSION'])('retains Chromium process/thread framing for the existing %s task-policy advisory', policy => {
  const row = `[56505:35699299:1114/103244.616502:ERROR:base/process/process_mac.cc:53] task_policy_set TASK_${policy}_POLICY: (os/kern) invalid argument (4)`;
  const logs = createModelEvalLogCollector('owned', { producer: 'chromium-headless-browser' });
  logs.ingest('stderr', row + '\n');
  expect(logs.finish()).toMatchObject({ passed: true, requiresReview: true, levelCounts: { warn: 1, error: 0 },
    findings: [expect.objectContaining({ code: 'electron-macos-task-policy-warning' })] });
});

it.each([
  '[56505:35699299:1114/103244.616502:ERROR:base/process/process_mac.cc:53] task_policy_set TASK_CATEGORY_POLICY: (os/kern) invalid argument (5)',
  '[56505:35699299:1114/103244.616502:ERROR:other/process_mac.cc:53] task_policy_set TASK_CATEGORY_POLICY: (os/kern) invalid argument (4)',
  '[56505:thread:1114/103244.616502:ERROR:base/process/process_mac.cc:53] task_policy_set TASK_CATEGORY_POLICY: (os/kern) invalid argument (4)',
])('keeps different task-policy diagnostics or malformed thread framing fatal: %s', row => {
  const logs = createModelEvalLogCollector('owned', { producer: 'chromium-headless-browser' });
  logs.ingest('stderr', row + '\n');
  expect(logs.finish()).toMatchObject({ passed: false, levelCounts: { error: 1 } });
});

it('parses pytest-subtests progress only for the Python checkpoint framing option', () => {
  const row = 'uu[12:34:56.789][ERROR][rid=-] injected failure\n';
  const owned = createModelEvalLogCollector('python', { pytestProgress: true });
  owned.ingest('stdout', row.slice(0, 9));
  owned.ingest('stdout', row.slice(9));
  expect(owned.finish()).toMatchObject({ passed: false, capturedBytes: Buffer.byteLength(row), capturedLineCount: 1,
    levelCounts: { error: 1 }, findings: [expect.objectContaining({ code: 'runtime-error', source: 'python-server' })] });
  const ordinary = createModelEvalLogCollector('ordinary');
  ordinary.ingest('stdout', row);
  expect(ordinary.finish()).toMatchObject({ levelCounts: { error: 0 }, classificationCounts: { other: 1 } });
  const lookalike = createModelEvalLogCollector('python', { pytestProgress: true });
  lookalike.ingest('stderr', row.replace('uu[', 'unknown['));
  expect(lookalike.finish()).toMatchObject({ passed: false, findings: [expect.objectContaining({ code: 'unclassified-stderr' })] });
});

const firefoxCleanupWarning = 'JavaScript error: chrome://juggler/content/Helper.js, line 82: NS_ERROR_FAILURE: Component returned failure code: 0x80004005 (NS_ERROR_FAILURE) [nsIWebProgress.removeProgressListener]';
const macHypervisorQueryWarning = 'sysctlbyname for kern.hv_vmm_present failed with status -1';
it.each([macHypervisorQueryWarning, macHypervisorQueryWarning + firefoxCleanupWarning])(
  'retains an owned macOS VM-query warning, including a missing newline, for review: %s', line => {
    const owned = createModelEvalLogCollector('firefox', { producer: 'firefox-native-browser' });
    owned.ingest('stderr', line + '\n');
    expect(owned.finish()).toMatchObject({ passed: true, requiresReview: true, coveragePassed: true,
      capturedLineCount: 1, analyzedLineCount: 1, levelCounts: { warn: 1, error: 0 } });
    for (const producer of [undefined, 'chromium-headless-browser', 'webkit-native-browser']) {
      const other = createModelEvalLogCollector('other', { producer });
      other.ingest('stderr', line + '\n');
      expect(other.finish().passed).toBe(false);
    }
  });
it.each([
  macHypervisorQueryWarning.replace('status -1', 'status -2'),
  macHypervisorQueryWarning.replace('kern.hv_vmm_present', 'kern.other'),
  macHypervisorQueryWarning + ' unrelated native failure',
  macHypervisorQueryWarning + firefoxCleanupWarning.replace('line 82', 'line 83'),
  macHypervisorQueryWarning + 'JavaScript error: resource://application/Module.sys.mjs, line 7: broken invariant',
])('keeps a different query failure or an appended unknown/error diagnostic fatal: %s', line => {
  const owned = createModelEvalLogCollector('firefox', { producer: 'firefox-native-browser' });
  owned.ingest('stderr', line + '\n');
  expect(owned.finish()).toMatchObject({ passed: false, coveragePassed: true, levelCounts: { error: 1 } });
});
it('retains the exact owned Firefox automation cleanup diagnostic for review', () => {
  const owned = createModelEvalLogCollector('firefox', { producer: 'firefox-native-browser' });
  owned.ingest('stderr', firefoxCleanupWarning + '\n');
  expect(owned.finish()).toMatchObject({ passed: true, requiresReview: true, capturedLineCount: 1,
    levelCounts: { warn: 1, error: 0 }, findings: [expect.objectContaining({ code: 'firefox-juggler-cleanup-warning' })] });
  const ordinary = createModelEvalLogCollector('ordinary');
  ordinary.ingest('stderr', firefoxCleanupWarning + '\n');
  expect(ordinary.finish().passed).toBe(false);
});

it.each([
  firefoxCleanupWarning.replace('line 82', 'line 83'),
  firefoxCleanupWarning.replace('removeProgressListener', 'addProgressListener'),
  firefoxCleanupWarning.replace('chrome://juggler', 'resource://application'),
  firefoxCleanupWarning + '\nunknown native failure',
  'JavaScript error: resource://gre/actors/AudioPlaybackChild.sys.mjs, line 140: InvalidStateError: JSWindowActorChild.sendAsyncMessage: JSWindowActorChild cannot send at the moment',
])('keeps other Firefox failures fatal: %s', line => {
  const owned = createModelEvalLogCollector('firefox', { producer: 'firefox-native-browser' });
  owned.ingest('stderr', line + '\n');
  expect(owned.finish()).toMatchObject({ passed: false, levelCounts: { error: 1 } });
});

it.each(headlessMacWarnings)('retains an exact owned headless macOS diagnostic as a reviewable warning: %s', line => {
  const owned = createModelEvalLogCollector('owned', { producer: 'chromium-headless-browser' });
  owned.ingest('stderr', line + '\n');
  expect(owned.finish()).toMatchObject({ passed: true, requiresReview: true, levelCounts: { warn: 1, error: 0 } });
  const unowned = createModelEvalLogCollector('unowned');
  unowned.ingest('stderr', line + '\n');
  expect(unowned.finish()).toMatchObject({ passed: false, levelCounts: { error: 1 } });
});

it.each([
  headlessMacWarnings[0] + ' crash',
  headlessMacWarnings[1].replace('-6670', '-6671'),
  headlessMacWarnings[1].replace('cv_display_link_mac.mm', 'other.mm'),
  headlessMacWarnings[3].replace('-6670', '-6671'),
  '[1114/175633.522910:ERROR:components/viz/service/display_embedder/skia_output_device_buffer_queue.cc:264] Invalid mailbox.',
  headlessMacWarnings[2].replace('Code=-50', 'Code=-49'),
  '[123:456:1114/081903.300239:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:386] SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox.',
  // Historical E2E failures must stay fatal after changing the test browser.
  '[123:456:1114/081903.300239:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:253] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.',
  '[123:456:1114/081903.300239:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:376] SharedImageManager::ProduceOverlay: Trying to Produce a Overlay representation from a non-existent mailbox.',
  '[123:456:1114/081903.300239:ERROR:components/viz/service/display_embedder/skia_output_device_buffer_queue.cc:264] Invalid mailbox.',
  '[123:456:1114/081903.300239:ERROR:components/page_load_metrics/browser/page_load_metrics_update_dispatcher.cc:179] Invalid first_paint 0.113 s for first_image_paint 0.109 s',
  '[123:456:1114/081903.300239:ERROR:components/page_load_metrics/browser/page_load_metrics_update_dispatcher.cc:187] Invalid first_paint 0.087 s for first_contentful_paint 0.081 s',
  headlessMacWarnings[1] + '\n  unrelated native failure',
])('keeps unknown or different native errors fatal in the owned browser: %s', line => {
  const owned = createModelEvalLogCollector('owned', { producer: 'chromium-headless-browser' });
  owned.ingest('stderr', line + '\n');
  expect(owned.finish()).toMatchObject({ passed: false, coveragePassed: true });
});

// Cold-install stderr from ensure-runtime.cjs: download progress is not an
// error, and self-check completion does not override the child's exit status.
const runtimePreparationLines = [
  'runtime python: downloading {"key":"darwin-arm64","asset":"cpython-3.12.13+20260610-aarch64-apple-darwin-install_only_stripped.tar.gz"}',
  'runtime python self-check ok {"version":"Python 3.12.13"}',
  'runtime uv: downloading {"key":"darwin-arm64","asset":"uv-aarch64-apple-darwin.tar.gz"}',
  'runtime uv self-check ok {"version":"uv 0.11.21 (5aa65dd7a 2026-06-11 aarch64-apple-darwin)"}',
  'runtime node: downloading {"key":"darwin-arm64","asset":"node-v24.17.0-darwin-arm64.tar.gz"}',
  'runtime node self-check ok {"version":"v24.17.0"}',
];
describe("Model Eval process-log policy", () => {
  it('recognizes chunked Server Loguru severity without retaining request identities', () => {
    const logs = createModelEvalLogCollector('python');
    const text = '[model-eval-case-log server/case] \x1b[31m[12:34:56.789][ERROR][rid=private-request] synthetic failure\x1b[0m\r\n'
      + '[12:34:56.790][WARNING][rid=-] recoverable failure\n'
      + '[12:34:56.791][CRITICAL][rid=-] broken invariant\n'
      + '[12:34:56.792][INFO][rid=-] finished\n';
    for (let i = 0; i < text.length; i += 7) logs.ingest('stdout', text.slice(i, i + 7));
    expect(logs.finish()).toMatchObject({ passed: false, requiresReview: true, coveragePassed: true,
      classificationCounts: { runtime: 4, other: 0 }, levelCounts: { error: 2, warn: 1, info: 1 },
      sourceCounts: { 'python-server': 4 }, findings: expect.arrayContaining([
        expect.objectContaining({ code: 'runtime-error', source: 'python-server', caseKey: 'server/case' }),
        expect.objectContaining({ code: 'runtime-warning', source: 'python-server' }),
      ]) });
    expect(JSON.stringify(logs.finish())).not.toContain('private-request');
  });

  it('keeps Server warnings reviewable and rejects severity-like prose as runtime evidence', () => {
    const logs = createModelEvalLogCollector('python');
    logs.ingest('stderr', '[12:34:56.789][WARNING][rid=-] controlled warning\n');
    expect(logs.finish()).toMatchObject({ passed: true, requiresReview: true, levelCounts: { warn: 1 } });
    const prose = createModelEvalLogCollector('python');
    prose.ingest('stdout', 'example [12:34:56.789][ERROR][rid=-] text\n[12:34:56.789][ERROR] missing request frame\n');
    expect(prose.finish()).toMatchObject({ passed: true, classificationCounts: { runtime: 0, other: 2 } });
    prose.ingest('stderr', 'unclassified ERROR-like text\n');
    expect(prose.finish()).toMatchObject({ passed: false });
  });

  it('attributes native provider failures and retries without turning a failed request into a pass', () => {
    const logs = createModelEvalLogCollector('context');
    const failure = "[pi-provider] provider stream failed {\n  phase: 'before_response',\n  source: 'transport',\n  code: 'ECONNRESET',\n  elapsedMs: 5012,\n  aborted: false\n}\n";
    const retry = "[agent-runner] retrying provider request { kind: 'connection_dropped', attempt: 1, maxRetries: 1, waitMs: 1187 }\n";
    const text = failure.repeat(3) + retry + failure.repeat(3);
    for (let offset = 0; offset < text.length; offset += 19) logs.ingest('stderr', text.slice(offset, offset + 19));
    expect(logs.finish()).toMatchObject({ passed: false, coveragePassed: true,
      levelCounts: { error: 6, warn: 1 }, findings: expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'provider-request-failed', source: 'pi-provider', count: 6 }),
        expect.objectContaining({ severity: 'warning', code: 'provider-request-retry', source: 'agent-runner', count: 1 }),
      ]) });
    expect(logs.finish().findings).toHaveLength(2);
    expect(JSON.stringify(logs.finish())).not.toContain('ECONNRESET');
  });

  it('closes retry continuation state and preserves concurrent case and stream ownership', () => {
    const logs = createModelEvalLogCollector('context');
    logs.ingest('stderr', "[model-eval-case-log first] [agent-runner] retrying provider request { kind: 'timeout', attempt: 1, maxRetries: 2, waitMs: 1000 }\n");
    logs.ingest('stderr', '[model-eval-case-log first]   unrelated stderr\n');
    logs.ingest('stderr', '[model-eval-case-log second] [pi-provider] provider stream failed {\n');
    logs.ingest('stdout', '[pi-provider] provider stream failed {\n');
    expect(logs.finish()).toMatchObject({ passed: false, findings: expect.arrayContaining([
      expect.objectContaining({ code: 'provider-request-retry', caseKey: 'first' }),
      expect.objectContaining({ code: 'provider-request-failed', caseKey: 'second' }),
      expect.objectContaining({ code: 'unclassified-stderr', caseKey: 'first' }),
    ]) });
    expect(logs.finish().levelCounts).toMatchObject({ warn: 1, error: 2 });
  });

  it('accepts the multiline console retry shape and rejects incomplete or malformed metadata', () => {
    const header = '[agent-runner] retrying provider request {\n';
    const body = "  kind: 'service_unavailable',\n  attempt: 1,\n  maxRetries: 2,\n  waitMs: 10000\n}\n";
    const complete = createModelEvalLogCollector('context'); complete.ingest('stderr', header + body);
    expect(complete.finish()).toMatchObject({ passed: true, requiresReview: true, coveragePassed: true,
      findings: [expect.objectContaining({ severity: 'warning', code: 'provider-request-retry', count: 1 })] });
    const truncated = createModelEvalLogCollector('context'); truncated.ingest('stderr', header + body.slice(0, -2));
    expect(truncated.finish()).toMatchObject({ passed: false, coveragePassed: false });
    const malformed = createModelEvalLogCollector('context');
    malformed.ingest('stderr', header + body.replace('maxRetries: 2', 'maxRetries: 0'));
    expect(malformed.finish()).toMatchObject({ passed: false,
      findings: expect.arrayContaining([expect.objectContaining({ code: 'unclassified-stderr' })]) });
    const interrupted = createModelEvalLogCollector('context');
    interrupted.ingest('stderr', header + 'unknown failure\n');
    expect(interrupted.finish()).toMatchObject({ passed: false,
      findings: expect.arrayContaining([expect.objectContaining({ code: 'unclassified-stderr' })]) });
  });

  it.each([
    '[pi-provider] provider stream failed but recovered',
    "[agent-runner] retrying provider request { kind: 'unknown', attempt: 1, maxRetries: 1, waitMs: 1000 }",
    "[agent-runner] retrying provider request { kind: 'timeout', attempt: 2, maxRetries: 1, waitMs: 1000 }",
    "[agent-runner] retrying provider request { kind: 'timeout', attempt: 0, maxRetries: 1, waitMs: 1000 }",
    "[agent-runner] retrying provider request { kind: 'timeout', attempt: 1, maxRetries: 1, waitMs: -1 }",
    "[agent-runner] retrying provider request { kind: 'timeout', attempt: 1, maxRetries: 1, waitMs: 9007199254740992 }",
    "[agent-runner] retrying provider request { kind: 'timeout', attempt: 1, maxRetries: 1, waitMs: 1 } unexpected failure",
  ])('keeps diagnostic look-alikes fatal: %s', text => {
    const logs = createModelEvalLogCollector('context'); logs.ingest('stderr', text + '\n');
    expect(logs.finish()).toMatchObject({ passed: false,
      findings: [expect.objectContaining({ severity: 'error', code: 'unclassified-stderr' })] });
  });

  describe('native process capture protocols', () => {
    it('accounts for exact local inspector lifecycle records without hiding later stderr', () => {
      const logs = createModelEvalLogCollector('native-startup');
      const messages = [
        'Debugger listening on ws://127.0.0.1:9229/11111111-2222-3333-4444-555555555555',
        'DevTools listening on ws://127.0.0.1:9222/devtools/browser/11111111-2222-3333-4444-555555555555',
        'For help, see: https://nodejs.org/learn/getting-started/debugging',
        'Debugger attached.',
        'Waiting for the debugger to disconnect...',
        'Debugger ending on ws://127.0.0.1:9229/11111111-2222-3333-4444-555555555555',
      ];
      logs.ingest('stderr', messages.join('\n') + '\n');
      expect(logs.finish()).toMatchObject({ passed: true, coveragePassed: true,
        capturedLineCount: 6, analyzedLineCount: 6, classificationCounts: { control: 6 }, levelCounts: { error: 0 } });
      logs.ingest('stderr', '  unrelated native failure\n');
      expect(logs.finish()).toMatchObject({ passed: false, levelCounts: { error: 1 } });
      const interrupted = createModelEvalLogCollector('native-startup');
      interrupted.ingest('stderr', "[agent-runner] Tool returned error {\nDebugger attached.\n  tool: 'unrelated',\n");
      expect(interrupted.finish()).toMatchObject({ passed: false, levelCounts: { error: 1 } });
    });
    it.each([
      'Debugger listening on ws://outside.invalid:9229/11111111-2222-3333-4444-555555555555',
      'DevTools listening on ws://127.0.0.1:9222/private-data/11111111-2222-3333-4444-555555555555',
      'Debugger attached. Unexpected native failure',
      'DevTools listening on ws://127.0.0.1:9222/devtools/browser/not-an-endpoint',
    ])('keeps an inspector look-alike as unclassified stderr: %s', line => {
      const logs = createModelEvalLogCollector('native-startup'); logs.ingest('stderr', line + '\n');
      expect(logs.finish()).toMatchObject({ passed: false, coveragePassed: true,
        findings: [expect.objectContaining({ severity: 'error', code: 'unclassified-stderr' })] });
    });
    it('accepts successful media access only for its declared local preview producer', () => {
      const line = '127.0.0.1 - - [06/Nov/2026 00:00:00] "GET /res/video.mp4 HTTP/1.1" 206 -\n';
      const ordinary = createModelEvalLogCollector('native-process'); ordinary.ingest('stderr', line);
      expect(ordinary.finish().passed).toBe(false);
      const preview = createModelEvalLogCollector('native-process', { producer: 'python-http-preview' });
      preview.ingest('stderr', line);
      expect(preview.finish()).toMatchObject({ passed: true, coveragePassed: true, capturedLineCount: 1,
        analyzedLineCount: 1, levelCounts: { info: 1, error: 0 } });
      preview.ingest('stderr', '127.0.0.1 - - [06/Nov/2026 00:00:00] rebuilt localized preview /security/?lang=pt\n');
      expect(preview.finish()).toMatchObject({ passed: true, coveragePassed: true, levelCounts: { info: 2 } });
      preview.ingest('stderr', line.replace(' 206 -', ' 404 -'));
      expect(preview.finish()).toMatchObject({ passed: false, levelCounts: { error: 1 } });
      const failedRefresh = createModelEvalLogCollector('native-process', { producer: 'python-http-preview' });
      failedRefresh.ingest('stderr', '127.0.0.1 - - [06/Nov/2026 00:00:00] localized page refresh failed: fixture failure\n');
      expect(failedRefresh.finish()).toMatchObject({ passed: false, levelCounts: { error: 1 } });
    });
    it('retains Firefox native stdout errors and stderr warnings only for the declared browser producer', () => {
      const logs = createModelEvalLogCollector('native-firefox', { producer: 'firefox-native-browser' });
      logs.ingest('stdout', 'Juggler listening to the pipe\nconsole.error: native fixture failed\nconsole.warn: native fixture warning\nCrash Annotation GraphicsCriticalError: fixture graphics failure\n');
      logs.ingest('stderr', '*** You are running in headless mode.\nJavaScript warning: resource://fixture/module.sys.mjs, line 7: fixture warning\nJavaScript error: chrome://fixture/Helper.js, line 8: fixture error\n');
      expect(logs.finish()).toMatchObject({ passed: false, coveragePassed: true, capturedLineCount: 7,
        analyzedLineCount: 7, classificationCounts: { control: 2 }, levelCounts: { error: 3, warn: 2 },
        findings: expect.arrayContaining([expect.objectContaining({ code: 'firefox-runtime-error', severity: 'error', count: 3 }),
          expect.objectContaining({ code: 'firefox-runtime-warning', severity: 'warning', count: 2 })]) });
    });
    const rkvWarning = '[WARN  rkv::backend::impl_safe::environment] `load_ratio()` is irrelevant for this storage backend.';
    it('retains an owned RKV WARN record across chunks without hiding later Firefox errors', () => {
      const logs = createModelEvalLogCollector('native-firefox', { producer: 'firefox-native-browser' });
      const record = rkvWarning + '\r\n';
      for (let offset = 0; offset < record.length; offset += 7) logs.ingest('stderr', record.slice(offset, offset + 7));
      expect(logs.finish()).toMatchObject({ passed: true, requiresReview: true, coveragePassed: true,
        capturedBytes: Buffer.byteLength(record), capturedLineCount: 1, analyzedLineCount: 1,
        levelCounts: { warn: 1, error: 0 },
        findings: [expect.objectContaining({ severity: 'warning', code: 'firefox-runtime-warning' })] });
      expect(JSON.stringify(logs.finish())).not.toContain('load_ratio');
      logs.ingest('stdout', 'Crash Annotation GraphicsCriticalError: fixture graphics failure\n');
      logs.ingest('stderr', rkvWarning.replace('[WARN ', '[ERROR ') + '\n');
      expect(logs.finish()).toMatchObject({ passed: false, coveragePassed: true,
        levelCounts: { warn: 1, error: 2 } });
    });
    it('does not lend the RKV warning format to an unowned or different native producer', () => {
      for (const producer of [undefined, 'chromium-headless-browser', 'webkit-native-browser']) {
        const logs = createModelEvalLogCollector('native', { producer });
        logs.ingest('stderr', rkvWarning + '\n');
        expect(logs.finish()).toMatchObject({ passed: false, levelCounts: { error: 1, warn: 0 } });
      }
    });
    it.each([
      rkvWarning.replace('[WARN ', '[ERROR '),
      rkvWarning.replace('environment]', 'environment_extra]'),
      rkvWarning.replace('environment]', 'environment'),
      rkvWarning.slice(0, rkvWarning.indexOf(']') + 1) + ' ',
      'prefix ' + rkvWarning,
      rkvWarning + '\n  unrelated native failure',
    ])('keeps a different or malformed RKV diagnostic fatal: %s', record => {
      const logs = createModelEvalLogCollector('native-firefox', { producer: 'firefox-native-browser' });
      logs.ingest('stderr', record + '\n');
      expect(logs.finish()).toMatchObject({ passed: false, coveragePassed: true, levelCounts: { error: 1 } });
    });
    it('does not classify arbitrary stdout as Firefox diagnostics and keeps unknown Firefox stderr failed', () => {
      const ordinary = createModelEvalLogCollector('ordinary'); ordinary.ingest('stdout', 'console.error: arbitrary output\n');
      expect(ordinary.finish().findings).toEqual([]);
      const firefox = createModelEvalLogCollector('native-firefox', { producer: 'firefox-native-browser' });
      firefox.ingest('stderr', 'console.error: wrong stream\nunknown native failure\n');
      expect(firefox.finish()).toMatchObject({ passed: false, levelCounts: { error: 2 },
        findings: [expect.objectContaining({ code: 'unclassified-stderr', count: 2 })] });
      const interrupted = createModelEvalLogCollector('native-firefox', { producer: 'firefox-native-browser' });
      interrupted.ingest('stderr', "[agent-runner] Tool returned error {\n*** You are running in headless mode.\n  tool: 'unrelated',\n");
      expect(interrupted.finish()).toMatchObject({ passed: false, levelCounts: { error: 1 } });
    });
    it('accepts the current WebKit startSessionAdmission record only inside its owned native stderr stream', () => {
      const text = '[WebKitWin:Media:-] MediaSessionManagerInterface::startSessionAdmission(0) 8543142656536241089\r\n'
        + '[WebKitWin:Media:-] MediaSessionManagerInterface::startSessionAdmission(0) 8543142656536241089 returning true\r\n';
      const owned = createModelEvalLogCollector('native-webkit', { producer: 'webkit-native-browser' });
      owned.ingest('stderr', text.slice(0, 43)); owned.ingest('stderr', text.slice(43));
      expect(owned.finish()).toMatchObject({ passed: true, coveragePassed: true,
        capturedLineCount: 2, analyzedLineCount: 2, levelCounts: { info: 2, error: 0 } });
      for (const producer of [undefined, 'chromium-headless-browser']) {
        const unowned = createModelEvalLogCollector('unowned-current-webkit', { producer }); unowned.ingest('stderr', text);
        expect(unowned.finish()).toMatchObject({ passed: false, levelCounts: { error: 2 } });
      }
      for (const malformed of [
        '[WebKitWin:Media:ERROR] MediaSessionManagerInterface::startSessionAdmission(0) 17',
        '[WebKitWin:Other:-] MediaSessionManagerInterface::startSessionAdmission(0) 17',
        '[WebKitWin:Media:-] MediaSessionManagerInterface::startSessionAdmission(0) 123456789012345678901',
        '[WebKitWin:Media:-] MediaSessionManagerInterface::startSessionAdmission(0) 17 returning true: native failure',
        '[WebKitWin:Media:-] MediaSessionManagerInterface::startSessionAdmissionOther(0) 17',
      ]) {
        const invalid = createModelEvalLogCollector('invalid-current-webkit', { producer: 'webkit-native-browser' });
        invalid.ingest('stderr', malformed + '\n');
        expect(invalid.finish()).toMatchObject({ passed: false, levelCounts: { error: 1 } });
      }
    });
    it('accepts owned WebKit media records and bounded session dumps across chunks', () => {
      const logs = createModelEvalLogCollector('native-webkit', { producer: 'webkit-native-browser' });
      logs.ingest('stderr', '[WebKitWin:Media:-] MediaSessionManagerInterface::sessionWillBeginPlayback(0) 18446744073709551615\r\n'
        + '[WebKitWin:Media:-] MediaSessionManagerInterface::setCurrentSession(0) 17, size = 2\r\n'
        + '[WebKitWin:Media:-] MediaSessionManagerInterface::sessionWillBeginPlayback(0) 17 returning false\r\n'
        + '[WebKitWin:Media:-] MediaSessionManagerInterface::dumpSessionStates(0)  Sessions:\r\n(AC1A6358C3F639B6): VideoAudio, Pla');
      logs.ingest('stderr', 'ying, \r\n(abc): Audio, Paused\r\n(1): null\r\n\r\n');
      expect(logs.finish()).toMatchObject({ passed: true, coveragePassed: true,
        capturedLineCount: 8, analyzedLineCount: 8, blankLineCount: 1, levelCounts: { info: 7, error: 0 } });
    });
    it.each([
      '(abc): VideoAudio, Playing, \n',
      '[WebKitWin:Other:-] MediaSessionManagerInterface::dumpSessionStates(0)  Sessions:\n(abc): VideoAudio, Playing, \n',
      '[WebKitWin:Media:ERROR] MediaSessionManagerInterface::sessionWillBeginPlayback(0) 17\n',
      '[WebKitWin:Media:-] MediaSessionManagerInterface::dumpSessionStates(0)  Sessions:\n(abc): VideoAudio, Broken, \n',
      '[WebKitWin:Media:-] MediaSessionManagerInterface::dumpSessionStates(0)  Sessions:\n\n(abc): VideoAudio, Playing, \n',
      '[WebKitWin:Media:-] MediaSessionManagerInterface::dumpSessionStates(0)  Sessions:\n[00:00:00.000] [warn] [(fixture)] new record\n(abc): VideoAudio, Playing, \n',
      '[WebKitWin:Media:-] MediaSessionManagerInterface::dumpSessionStates(0)  Sessions:\n(abc): VideoAudio, Playing, \nunrelated native failure\n',
    ])('keeps malformed or unowned WebKit dump context fatal: %s', text => {
      const logs = createModelEvalLogCollector('native-webkit', { producer: 'webkit-native-browser' });
      logs.ingest('stderr', text);
      expect(logs.finish()).toMatchObject({ passed: false, coveragePassed: true,
        findings: expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'unclassified-stderr' })]) });
    });
    it('does not transfer WebKit source or continuation ownership between cases or streams', () => {
      const header = '[WebKitWin:Media:-] MediaSessionManagerInterface::dumpSessionStates(0)  Sessions:';
      const row = '(abc): VideoAudio, Playing, ';
      const ordinary = createModelEvalLogCollector('generic'); ordinary.ingest('stderr', header + '\n' + row + '\n');
      expect(ordinary.finish().passed).toBe(false);
      const scoped = createModelEvalLogCollector('native-webkit', { producer: 'webkit-native-browser' });
      scoped.ingest('stderr', `[model-eval-case-log first] ${header}\n[model-eval-case-log second] ${row}\n`);
      scoped.ingest('stdout', row + '\n');
      expect(scoped.finish()).toMatchObject({ passed: false, levelCounts: { info: 1, error: 1 } });
      const bounded = createModelEvalLogCollector('native-webkit', { producer: 'webkit-native-browser' });
      bounded.ingest('stderr', `[agent-runner] Tool fixture returned error: short\n${header}\n${row}\n  unrelated native failure\n`);
      expect(bounded.finish()).toMatchObject({ passed: false, levelCounts: { error: 1 } });
    });
    it('rejects a native budget record interrupted by WebKit media output', () => {
      const logs = createModelEvalLogCollector('native-webkit', { producer: 'webkit-native-browser' });
      logs.ingest('stderr', "[tool-definitions] tool definition description exceeds soft budget; sent untruncated {\n"
        + "  tool: 'read_files',\n"
        + '[WebKitWin:Media:-] MediaSessionManagerInterface::sessionWillBeginPlayback(0) 17\n'
        + "  field: 'tool description',\n  estimatedTokens: 87,\n  softBudgetTokens: 80\n}\n");
      expect(logs.finish()).toMatchObject({ passed: false,
        findings: expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'unclassified-stderr' })]) });
    });
    it('rejects an unknown producer instead of silently treating its output as trusted', () => {
      expect(() => createModelEvalLogCollector('native-process', { producer: 'unknown-preview' })).toThrow('producer');
    });
  });
  it('retains exact repeated failure counts, immutable callbacks and earlier summaries across continued collection', () => {
    let callbacks = 0, first: any;
    const logs = createModelEvalLogCollector('runtime', { onFinding: (finding: any) => {
      callbacks++; first ??= finding; expect(finding.count).toBe(1);
    } });
    const line = '[00:00:00.000] [error] [(fixture)] synthetic repeated failure\n';
    for (let i = 0; i < 25000; i++) logs.ingest('stderr', line);
    const earlier = logs.finish();
    expect(earlier.findings).toHaveLength(1); expect(earlier.findings[0].count).toBe(25000);
    for (let i = 0; i < 25000; i++) logs.ingest('stderr', line);
    const final = logs.finish();
    expect(final).toMatchObject({ passed: false, coveragePassed: true,
      capturedLineCount: 50000, analyzedLineCount: 50000, levelCounts: { error: 50000 },
      findings: [expect.objectContaining({ code: 'runtime-error', count: 50000 })] });
    expect(callbacks).toBe(50000); expect(first.count).toBe(1);
    expect(earlier.findings[0].count).toBe(25000);
    expect(JSON.stringify(final)).not.toContain('synthetic repeated failure');
  });
  it.each(['stdout', 'stderr'])(
    'keeps a logger-wrapped Node deprecation reviewable on %s', stream => {
      const logs = createModelEvalLogCollector('runtime');
      logs.ingest(stream, '[12:00:00.000] [error] [ (console)] (node:42) [DEP0180] DeprecationWarning: fs.Stats constructor is deprecated.\n');
      expect(logs.finish()).toMatchObject({ passed: true, requiresReview: true,
        levelCounts: { warn: 1, error: 0 }, findings: [expect.objectContaining({ code: 'node-deprecation-warning' })] });
      logs.ingest('stderr', 'unexpected native failure\n');
      expect(logs.finish().passed).toBe(false);
    },
  );

  it.each(['stdout', 'stderr'])(
    'preserves a logger-wrapped Node listener warning for review on %s', stream => {
      const logs = createModelEvalLogCollector('packaged-launch-library');
      logs.ingest(stream, '[12:00:00.000] [error] [ (console)] (node:42) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 before-quit listeners added to [EventEmitter]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit\n');
      expect(logs.finish()).toMatchObject({ passed: true, requiresReview: true,
        coveragePassed: true, capturedLineCount: 1, analyzedLineCount: 1,
        levelCounts: { warn: 1, error: 0 },
        findings: [expect.objectContaining({ code: 'node-runtime-warning', severity: 'warning', count: 1 })] });
      logs.ingest('stderr', 'unexpected native failure\n');
      expect(logs.finish().passed).toBe(false);
    },
  );

  it.each([
    '[12:00:00.000] [error] [ (library)] (node:42) MaxListenersExceededWarning: fixture',
    '[12:00:00.000] [error] [ (console)] failed after MaxListenersExceededWarning',
    '[12:00:00.000] [error] [ (console)] (node:42) Error: MaxListenersExceededWarning',
  ])('keeps listener-warning look-alikes as application errors: %s', line => {
    const logs = createModelEvalLogCollector('packaged-launch-library');
    logs.ingest('stderr', line);
    expect(logs.finish()).toMatchObject({ passed: false,
      findings: [expect.objectContaining({ code: 'runtime-error', severity: 'error' })] });
  });

  it.each([
    '[12:00:00.000] [error] [ (library)] (node:42) [DEP0180] DeprecationWarning: fixture',
    '[12:00:00.000] [error] [ (console)] failed after DeprecationWarning',
    '[12:00:00.000] [error] [ (console)] (node:42) [DEP0180] Error: native runtime failed',
  ])('never excuses an application error that resembles a deprecation: %s', line => {
    const logs = createModelEvalLogCollector('runtime');
    logs.ingest('stderr', line);
    expect(logs.finish()).toMatchObject({ passed: false,
      findings: [expect.objectContaining({ code: 'runtime-error', severity: 'error' })] });
  });

  it("classifies cold runtime preparation without retaining asset or version metadata", () => {
    const logs = createModelEvalLogCollector("environment");
    const output = runtimePreparationLines.join("\r\n");
    for (let offset = 0; offset < output.length; offset += 17) {
      logs.ingest("stderr", output.slice(offset, offset + 17));
    }
    const analysis = logs.finish();
    expect(analysis).toMatchObject({
      passed: true, requiresReview: false, coveragePassed: true,
      capturedLineCount: 6, analyzedLineCount: 6, findings: [],
      classificationCounts: { control: 6, processError: 0 },
    });
    expect(JSON.stringify(analysis)).not.toContain("cpython-");
    expect(JSON.stringify(analysis)).not.toContain("5aa65dd7a");
  });

  it.each([
    ["runtime", runtimePreparationLines[0]],
    ["preflight", runtimePreparationLines[1]],
    ["environment", 'runtime ruby self-check ok {"version":"3.4"}'],
    ["environment", 'runtime node self-check failed {"version":"v24.17.0"}'],
    ["environment", 'runtime node self-check ok {"version":"v24.17.0","error":"broken"}'],
    ["environment", 'runtime python: downloading {"key":"darwin-arm64"}'],
    ["environment", 'runtime python: downloading {"key":null,"asset":"python.tar.gz"}'],
    ["environment", 'runtime node self-check ok {"version":null}'],
    ["environment", 'runtime node self-check ok {"version":"v24.17.0"} failed'],
    ["environment", 'runtime node self-check ok {broken}'],
  ])("rejects look-alike progress outside its known phase or record shape: %s / %s", (phase, line) => {
    const logs = createModelEvalLogCollector(phase);
    logs.ingest("stderr", line);
    expect(logs.finish()).toMatchObject({ passed: false, coveragePassed: true,
      findings: [expect.objectContaining({ code: "unclassified-stderr" })] });
  });

  it("keeps warnings reviewable and closes their continuation window at a progress record", () => {
    const logs = createModelEvalLogCollector("environment");
    logs.ingest("stderr", `warning: preparation diagnostic\n${runtimePreparationLines[1]}\n`);
    expect(logs.finish()).toMatchObject({ passed: true, requiresReview: true,
      findings: [expect.objectContaining({ code: "plain-process-warning" })] });
    logs.ingest("stderr", "  unexpected failure after progress\n");
    expect(logs.finish()).toMatchObject({ passed: false, coveragePassed: true });
    expect(logs.finish().findings).toContainEqual(expect.objectContaining({ code: "unclassified-stderr" }));
  });

  it('does not assign overlapping legacy cases to the last starter or clear the remaining case', () => {
    const logs = createModelEvalLogCollector('runtime');
    logs.ingest('stdout', '[model-eval-case] start model-a/r1\n[model-eval-case] start model-b/r1\n');
    logs.ingest('stderr', 'warning: overlapping\n');
    logs.ingest('stdout', '[model-eval-case] end model-a/r1\n');
    logs.ingest('stderr', 'warning: remaining\n');
    const result = logs.finish();
    expect(result.findings).toContainEqual(expect.objectContaining({ attribution: 'ambiguous', count: 1 }));
    expect(result.findings.find(item => item.attribution === 'ambiguous')).not.toHaveProperty('caseKey');
    expect(result.findings).toContainEqual(expect.objectContaining({ caseKey: 'model-b/r1', count: 1 }));
  });

  it('keeps explicit ownership across pipe reordering and isolates multiline failure windows', () => {
    const logs = createModelEvalLogCollector('runtime');
    logs.ingest('stdout', '[model-eval-case] start a\n[model-eval-case] start b\n[model-eval-case] end a\n[model-eval-case] end b\n');
    logs.ingest('stderr', '[model-eval-case-log a] [agent-runner] Tool returned error {\n');
    logs.ingest('stderr', '[model-eval-case-log b] unexpected native failure\n');
    logs.ingest('stderr', "[model-eval-case-log a]   tool: 'tool_result',\n[model-eval-case-log a]   result: { text_hash: '123456abcdef', text_chars: 12 }\n[model-eval-case-log a] }\n");
    const result = logs.finish();
    expect(result.passed).toBe(false);
    expect(result.coveragePassed).toBe(true);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ caseKey: 'a', attribution: 'explicit', code: 'tool-execution-failed', count: 1 }),
      expect.objectContaining({ caseKey: 'b', attribution: 'explicit', code: 'unclassified-stderr', count: 1 }),
    ]));
    expect(result.findings).toHaveLength(2);
  });

  it('classifies bounded tool correlation and input diagnostics without hiding the tool failure', () => {
    const record = [
      '[agent-runner] Tool returned error {',
      "  tool: 'manage_execution_plan',",
      "  runner_ref: 'a9008ca835625aa1d0447cd5',",
      '  batch_sequence: 10,',
      "  execution_mode: 'single',",
      '  input_parse: {',
      "    stream_json: 'strict',",
      "    tolerant_parse: 'unknown',",
      '    parsed_input_matches: true',
      '  },',
      "  call_hash: '2c00439c3cb8',",
      `  input_digest: 'sha256:${'a'.repeat(64)}',`,
      "  result: { text_hash: '9cbb1fd5ea11', text_chars: 1186 },",
      "  output_storage: 'inline'",
      '}',
    ].join('\n');
    const logs = createModelEvalLogCollector('runtime');
    logs.ingest('stderr', record);
    expect(logs.finish()).toMatchObject({
      passed: true, requiresReview: true, coveragePassed: true,
      findings: [expect.objectContaining({ code: 'tool-execution-failed', severity: 'warning' })],
    });
    for (const invalid of [
      record.replace("  runner_ref: 'a9008ca835625aa1d0447cd5',", "  secret: 'unclassified',"),
      record.replace("    tolerant_parse: 'unknown',", "    error: 'unclassified',"),
      record.replace("    stream_json: 'strict',", "    stream_json: 'unclassified',"),
      `${record}\n  batch_sequence: 11,`,
    ]) {
      const rejected = createModelEvalLogCollector('runtime');
      rejected.ingest('stderr', invalid);
      expect(rejected.finish()).toMatchObject({ passed: false, coveragePassed: true });
      expect(rejected.finish().findings).toContainEqual(expect.objectContaining({ code: 'unclassified-stderr' }));
    }
  });

  it.each([
    ["warning: fixture diagnostic", "plain-process-warning", "stderr"],
    ["WARNING: fixture diagnostic", "plain-process-warning", "stderr"],
    ["(node:42) Warning: fixture diagnostic", "node-runtime-warning", "node"],
    ["(node:42) ExperimentalWarning: fixture diagnostic", "node-runtime-warning", "node"],
    ["(node:42) MaxListenersExceededWarning: fixture diagnostic", "node-runtime-warning", "node"],
  ])("keeps warning origin reviewable without accepting a later error: %s", (line, code, source) => {
    const logs = createModelEvalLogCollector("runtime");
    logs.ingest("stderr", `${line}\n`);
    const warning = logs.finish();
    expect(warning.passed).toBe(true);
    expect(warning.requiresReview).toBe(true);
    expect(warning.findings).toEqual([
      expect.objectContaining({ severity: "warning", code, source, count: 1 }),
    ]);
    expect(JSON.stringify(warning)).not.toContain("fixture diagnostic");

    logs.ingest("stderr", "unexpected failure\n");
    const failed = logs.finish();
    expect(failed.passed).toBe(false);
    expect(failed.coveragePassed).toBe(true);
    expect(failed.findings).toContainEqual(
      expect.objectContaining({ severity: "error", code: "unclassified-stderr" }),
    );
  });

  it("analyzes every line and attributes runtime warnings to the active case", () => {
    const collector = createModelEvalLogCollector("runtime");
    collector.ingest("stdout", [
      "[model-eval-case] start commander/cmd-workspace-file-read",
      "[17:49:11.122] [info]  [ (model) ] model turn ready",
      "[17:49:11.195] [warn]  [ (console) ] [tool-definitions] tool definition description exceeds soft budget",
      "  tool: 'read_file'",
      "[model-eval-case] end commander/cmd-workspace-file-read",
      "",
    ].join("\n"));

    const analysis = collector.finish();

    expect(analysis.coveragePassed).toBe(true);
    expect(analysis.analyzedLineCount).toBe(analysis.capturedLineCount);
    expect(analysis.passed).toBe(true);
    expect(analysis.requiresReview).toBe(true);
    expect(analysis.findings).toEqual([expect.objectContaining({
      severity: "warning",
      code: "tool-definition-soft-budget",
      count: 1,
      phase: "runtime",
      source: "console",
      caseKey: "commander/cmd-workspace-file-read",
    })]);
  });

  it("surfaces the native core-agent tool-description warning without losing its case or metadata lines", () => {
    const logs = createModelEvalLogCollector("runtime");
    logs.ingest("stderr", "[model-eval-case] start guide/read\n");
    logs.ingest("stderr", "[tool-definitions] tool definition description exceeds soft budget; sent untruncated {\n"
      + "  tool: 'read_files',\n  field: 'schema description at /inputSchema/properties/raw_text',\n"
      + "  estimatedTokens: 87,\n  softBudgetTokens: 80\n}\n");
    logs.ingest("stderr", "[model-eval-case] end guide/read\n");
    const report = logs.finish();
    expect(report).toMatchObject({ passed: true, requiresReview: true, coveragePassed: true,
      capturedLineCount: 8, analyzedLineCount: 8, levelCounts: { warn: 1, error: 0 } });
    expect(report.findings).toEqual([expect.objectContaining({ severity: "warning",
      code: "tool-definition-soft-budget", source: "tool-definitions", count: 1, caseKey: "guide/read" })]);
  });

  it.each([
    "[tool-definitions] tool definition description exceeds soft budget; sent untruncated ERROR\n",
    "[tool-definitions] tool definition description exceeds soft budget; sent untruncated {\n  error: 'unexpected dependency failure'\n}\n",
    "[tool-definitions] tool definition description exceeds soft budget; sent untruncated {\n  tool: 'read_files'\n}\n  unexpected inherited stderr\n",
  ])("keeps malformed or unrelated native tool-budget output fatal: %s", text => {
    const logs = createModelEvalLogCollector("runtime");
    logs.ingest("stderr", text);
    expect(logs.finish()).toMatchObject({ passed: false, coveragePassed: true });
  });

  it("rejects truncated native tool-budget metadata as incomplete log coverage", () => {
    const logs = createModelEvalLogCollector("runtime");
    logs.ingest("stderr", "[tool-definitions] tool definition description exceeds soft budget; sent untruncated {\n  tool: 'read_files',\n");
    expect(logs.finish()).toMatchObject({ passed: false, coveragePassed: false });
  });

  it("closes the prior tool-error payload before a native budget warning", () => {
    const logs = createModelEvalLogCollector("runtime");
    logs.ingest("stderr", "[agent-runner] Tool noop returned error: fixture\n"
      + "[tool-definitions] tool definition description exceeds soft budget; sent untruncated {\n"
      + "  tool: 'read_files',\n  field: 'schema description at /inputSchema/properties/raw_text',\n"
      + "  estimatedTokens: 87,\n  softBudgetTokens: 80\n}\n"
      + "unexpected inherited native failure\n");
    const report = logs.finish();
    expect(report).toMatchObject({ passed: false, coveragePassed: true });
    expect(report.findings).toContainEqual(expect.objectContaining({ severity: "error", code: "unclassified-stderr" }));
  });

  it("counts a line beyond the per-stream buffer cap as captured but never analyzed, so coverage fails", () => {
    const logs = createModelEvalLogCollector("runtime");
    const oversized = "x".repeat(8 * 1024 * 1024 + 1);
    // Delivered in transport-sized chunks, as a child printing one giant line would.
    for (let offset = 0; offset < oversized.length; offset += 1024 * 1024) {
      logs.ingest("stderr", oversized.slice(offset, offset + 1024 * 1024));
    }
    logs.ingest("stderr", "\nwarning: still analyzed after the dropped line\n");
    const analysis = logs.finish();
    expect(analysis).toMatchObject({ passed: false, coveragePassed: false, capturedLineCount: 2, analyzedLineCount: 1,
      droppedLineCount: 1, droppedBytes: oversized.length });
    expect(analysis.findings.map((finding) => finding.code).sort()).toEqual(["log-coverage-gap", "plain-process-warning"]);
    // The dropped payload is never retained in memory or in the summary.
    expect(JSON.stringify(analysis).length).toBeLessThan(10_000);
    const merged = mergeModelEvalLogAnalyses([analysis, createModelEvalLogCollector("preflight").finish()]);
    expect(merged).toMatchObject({ coveragePassed: false, passed: false, droppedLineCount: 1, droppedBytes: oversized.length });

    // An unterminated oversized line at process exit is still a captured line.
    const tail = createModelEvalLogCollector("runtime");
    tail.ingest("stdout", "y".repeat(8 * 1024 * 1024 + 1));
    expect(tail.finish()).toMatchObject({ coveragePassed: false, capturedLineCount: 1, analyzedLineCount: 0, droppedLineCount: 1 });

    // Exactly at the cap nothing is dropped.
    const exact = createModelEvalLogCollector("runtime");
    exact.ingest("stdout", `${"z".repeat(8 * 1024 * 1024)}\n`);
    expect(exact.finish()).toMatchObject({ coveragePassed: true, capturedLineCount: 1, analyzedLineCount: 1, droppedLineCount: 0, droppedBytes: 0 });
  });

  it("retains known process warnings but fails unclassified stderr", () => {
    const preflight = createModelEvalLogCollector("preflight");
    preflight.ingest(
      "stderr",
      "(node:42) [DEP0205] DeprecationWarning: module.register() is deprecated\n",
    );
    const knownWarning = preflight.finish();
    expect(knownWarning.passed).toBe(true);
    expect(knownWarning.findings.map((finding) => finding.code))
      .toEqual(["node-deprecation-warning"]);

    const runtime = createModelEvalLogCollector("runtime");
    runtime.ingest("stderr", "unexpected native crash text\n");
    const unknownError = runtime.finish();
    expect(unknownError.passed).toBe(false);
    expect(unknownError.findings).toEqual([expect.objectContaining({
      severity: "error",
      code: "unclassified-stderr",
    })]);
  });

  it("keeps a plain-text tool-error payload attached without excusing unknown stderr", () => {
    // 2026-08-11 research-resume-durable-ledger: the log gate failed the run on
    // two unclassified stderr lines that were the body of a warning the runtime
    // was asked to print. AgentRunner splices 150 characters of the failed tool
    // result into one warn record, and a tool result carries newlines, so the
    // record arrives as several lines and only the first keeps its prefix.
    const runtime = createModelEvalLogCollector("runtime");
    runtime.ingest("stderr", [
      "[13:50:12.202] [warn]  [ (console) ] [agent-runner] Tool web_fetch returned error: URL: https://eur-lex.europa.eu/eli/reg/2024/1689/oj/eng",
      "Accessed at: 2026-08-11T05:50:12.139Z",
      "",
      "JS_OR_NAV_SHELL: The site returned a JavaScript applica",
      "[13:50:12.210] [info]  [ (runner) ] native web search injected {",
    ].join("\n"));
    const analysis = runtime.finish();
    expect(analysis.classificationCounts.processError).toBe(0);
    expect(analysis.findings.map((finding) => finding.code)).toEqual(["runtime-warning"]);

    // The window belongs to that one emitter and closes at the next record, so
    // stderr nobody classified still fails — including a line that looks like
    // payload but follows an ordinary warning.
    const other = createModelEvalLogCollector("runtime");
    other.ingest("stderr", [
      "[13:50:12.202] [warn]  [ (console) ] [agent-runner] run_progress: nudged model",
      "unexpected native crash text",
    ].join("\n"));
    const otherAnalysis = other.finish();
    expect(otherAnalysis.passed).toBe(false);
    expect(otherAnalysis.findings.map((finding) => finding.code))
      .toContain("unclassified-stderr");

    // And a crash after the payload window has closed is still an error.
    const after = createModelEvalLogCollector("runtime");
    after.ingest("stderr", [
      "[13:50:12.202] [warn]  [ (console) ] [agent-runner] Tool web_fetch returned error: boom",
      "detail line",
      "[13:50:12.210] [info]  [ (runner) ] native web search injected {",
      "unexpected native crash text",
    ].join("\n"));
    const afterAnalysis = after.finish();
    expect(afterAnalysis.passed).toBe(false);
    expect(afterAnalysis.findings.map((finding) => finding.code))
      .toContain("unclassified-stderr");
  });

  it("keeps logger-truncated XML payload lines attached to a structured runtime warning", () => {
    const runtime = createModelEvalLogCollector("runtime");
    runtime.ingest("stderr", [
      "[17:49:11.195] [warn]  [ (console) ] [agent-runner] Tool bash returned error: <command-result status=\"failed\">",
      "<s",
      "",
    ].join("\n"));

    const analysis = runtime.finish();
    expect(analysis.passed).toBe(true);
    expect(analysis.classificationCounts.processError).toBe(0);
    expect(analysis.findings).toEqual([expect.objectContaining({
      severity: "warning",
      code: "runtime-warning",
      source: "console",
    })]);
  });

  it("keeps numbered tool diagnostics attached to a structured runtime warning", () => {
    const runtime = createModelEvalLogCollector("runtime");
    runtime.ingest("stderr", [
      "[11:03:02.549] [warn]  [ (console) ] [agent-runner] Tool edit_office returned error: E_OFFICE_EDIT_FAILED: [1] Removed /slide[3]/chart[@id=100022]",
      "[2] Added shape at /slide[3]/shape[@id=100054]",
      "[3] ERROR: Unknown element type 'p' for /",
      "",
    ].join("\n"));

    const analysis = runtime.finish();
    expect(analysis.passed).toBe(true);
    expect(analysis.classificationCounts.processError).toBe(0);
    expect(analysis.classificationCounts.other).toBe(2);
    expect(analysis.findings).toEqual([expect.objectContaining({
      severity: "warning",
      code: "runtime-warning",
      source: "console",
    })]);
  });

  it("classifies the known non-fatal Electron macOS task-policy diagnostic", () => {
    const runtime = createModelEvalLogCollector("runtime");
    runtime.ingest("stderr", [
      "[1143:0808/221127.020938:ERROR:base/process/process_mac.cc:53] task_policy_set TASK_CATEGORY_POLICY: (os/kern) invalid argument (4)",
      "[1143:0808/221127.020938:ERROR:base/process/process_mac.cc:98] task_policy_set TASK_SUPPRESSION_POLICY: (os/kern) invalid argument (4)",
      "",
    ].join("\n"));

    const analysis = runtime.finish();
    expect(analysis.passed).toBe(true);
    expect(analysis.requiresReview).toBe(true);
    expect(analysis.classificationCounts.processWarning).toBe(2);
    expect(analysis.levelCounts).toEqual(expect.objectContaining({ warn: 2, error: 0 }));
    expect(analysis.findings).toEqual([expect.objectContaining({
      severity: "warning",
      code: "electron-macos-task-policy-warning",
      count: 2,
      source: "electron",
    })]);
  });

  it('surfaces native macOS spellchecker timeout and recovery as reviewable warnings', () => {
    const logs = createModelEvalLogCollector('runtime');
    logs.ingest('stderr', [
      '2026-10-16 22:23:10.123 Electron[123:456] NSSpellServer dataFromCheckingString timed out, index is 0',
      '2026-10-16 22:23:10.124 Electron[123:456] NSSpellServer dataFromCheckingString succeeded, index is 0',
      '',
    ].join('\n'));
    expect(logs.finish()).toMatchObject({ passed: true, requiresReview: true, coveragePassed: true,
      capturedLineCount: 2, analyzedLineCount: 2, levelCounts: { warn: 2, error: 0 },
      findings: [expect.objectContaining({ severity: 'warning', code: 'electron-macos-spellchecker-warning', count: 2 })] });
  });

  it.each([
    '2026-10-16 22:23:10.123 Electron[123:456] NSSpellServer dataFromCheckingString failed, index is 0',
    '2026-10-16 22:23:10.123 Electron[123:456] NSSpellServer dataFromCheckingString timed out, index is 0; application failed',
    'NSSpellServer dataFromCheckingString timed out, index is 0',
  ])('keeps unrecognized macOS spellchecker look-alikes as failures: %s', line => {
    const logs = createModelEvalLogCollector('runtime');
    logs.ingest('stderr', line+'\n');
    expect(logs.finish()).toMatchObject({ passed: false, coveragePassed: true,
      findings: [expect.objectContaining({ severity: 'error', code: 'unclassified-stderr' })] });
  });

  it("merges all phases and persists bounded analysis without raw log text", () => {
    const preflight = createModelEvalLogCollector("preflight");
    preflight.ingest("stdout", "strict audit completed\n");
    const runtime = createModelEvalLogCollector("runtime");
    runtime.ingest(
      "stdout",
      "[17:49:11.122] [warn]  [ (console) ] review this private-looking value\n",
    );
    const analysis = mergeModelEvalLogAnalyses([
      preflight.finish(),
      runtime.finish(),
    ]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-eval-log-policy-"));
    const report = path.join(directory, "report.json");
    try {
      fs.writeFileSync(report, '{"kind":"fixture","results":[]}\n', "utf8");
      attachProcessLogAnalysis(report, analysis);
      const saved = JSON.parse(fs.readFileSync(report, "utf8"));

      expect(saved.processLogAnalysis.coveragePassed).toBe(true);
      expect(saved.processLogAnalysis.phases.map((item: { phase: string }) => item.phase))
        .toEqual(["preflight", "runtime"]);
      expect(saved.processLogAnalysis.findings).toEqual([expect.objectContaining({
        code: "runtime-warning",
        detail: "the production runtime emitted a warning that requires review",
      })]);
      expect(JSON.stringify(saved)).not.toContain("private-looking value");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("turns an interrupted running report into an explicit process-lifecycle failure", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-eval-termination-"));
    const report = path.join(directory, "report.json");
    try {
      fs.writeFileSync(report, JSON.stringify({
        kind: "model-eval-production-regression",
        runStatus: "running",
        completedAt: null,
        progress: { activeCase: "commander/product-runtime-cache-concurrency-repair" },
      }), "utf8");

      attachProcessTermination(report, { signal: "SIGKILL" });
      const saved = JSON.parse(fs.readFileSync(report, "utf8"));

      expect(saved).toMatchObject({
        runStatus: "failed",
        failure: {
          code: "runner-signaled",
          phase: "process-lifecycle",
          caseKey: "commander/product-runtime-cache-concurrency-repair",
        },
        processTermination: { kind: "signal", signal: "SIGKILL" },
      });
      expect(saved.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

});
