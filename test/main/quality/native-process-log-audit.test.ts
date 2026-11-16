import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess, { type ChildProcess } from 'node:child_process';

const { beginNativeProcessAudit, expectNativeProcessTermination, acknowledgeNativeConsoleError, launchAuditedFirefox, launchAuditedWebKit, launchAuditedChromium, tagNativeProcess, acknowledgeNativePreviewNotFound } = require('../../e2e/fixtures/native-process-log-audit.cjs');
const directories: string[] = [];
const children = new Set<ChildProcess>();
const audits: any[] = [];
const digest = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-native-stdio-audit-'));
  directories.push(root); return root;
}
function begin(root: string, options?: any) {
  const audit = beginNativeProcessAudit(root, options); audits.push(audit); return audit;
}
function launch(script: string, args: string[] = []) {
  const child = childProcess.spawn(process.execPath, ['-e', script, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); child.once('close', () => children.delete(child)); return child;
}
const closed = (child: ChildProcess) => new Promise<void>(resolve => child.once('close', () => resolve()));

afterEach(async () => {
  for (const child of children) { const done = closed(child); child.kill(); await done; }
  for (const audit of audits.splice(0)) await audit.finish({ waitMs: 100 });
  for (const root of directories.splice(0)) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('orkas-native-stdio-audit-'))
      throw new Error('Refuse cleanup outside the owned temporary fixture');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('native process log capture', () => {
  it('binds headless Chromium warnings to its single owned launch and preserves original bytes', async () => {
    const root = directory(), audit = begin(root);
    const warning = 'Trying to load the allocator multiple times. This is *not* supported.';
    const actor = {}, options = { headless: true, channel: 'chrome' };
    const browserType = { name: () => 'chromium', launch: async (received: any) => {
      expect(received).toBe(options);
      const child = launch(`process.stderr.write(${JSON.stringify(warning + '\n')});`);
      await closed(child); return actor;
    } };
    expect(await launchAuditedChromium(browserType, options)).toBe(actor);
    const { report } = await audit.finish();
    expect(report).toMatchObject({ complete: true, passed: true });
    expect(report.processes[0]).toMatchObject({ producer: 'chromium-headless-browser', exitAccepted: true });
    expect(fs.readFileSync(path.join(root, report.processes[0].streams.stderr.file), 'utf8')).toBe(warning + '\n');
    expect(report.processes[0].streams.stderr.analysis).toMatchObject({ requiresReview: true, levelCounts: { warn: 1, error: 0 } });
  });

  it('refuses the headless warning protocol for a headed or different browser', async () => {
    begin(directory());
    for (const [name, options] of [['chromium', {}], ['chromium', { headless: false }], ['firefox', { headless: true }]] as const) {
      await expect(launchAuditedChromium({ name: () => name }, options)).rejects.toThrow('owning native scope');
    }
  });
  it('captures immediate first bytes and preserves the original child, arguments and consumer data', async () => {
    const root = directory(), originalSpawn = childProcess.spawn, audit = begin(root);
    const argument = 'space and café 中文';
    const child = launch('process.stdout.write(JSON.stringify(process.argv[1])); process.stderr.write("Warning: immediate fixture diagnostic\\n");', [argument]);
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout!.on('data', bytes => stdout.push(Buffer.from(bytes)));
    child.stderr!.on('data', bytes => stderr.push(Buffer.from(bytes)));
    await closed(child);
    const { report } = await audit.finish();
    expect(childProcess.spawn).toBe(originalSpawn);
    expect(report).toMatchObject({ complete: true, passed: true });
    expect(report.processes).toHaveLength(1);
    expect(report.processes[0].pid).toBe(child.pid);
    expect(JSON.parse(Buffer.concat(stdout).toString())).toBe(argument);
    for (const [stream, bytes] of [['stdout', Buffer.concat(stdout)], ['stderr', Buffer.concat(stderr)]] as const) {
      const receipt = report.processes[0].streams[stream];
      expect(fs.readFileSync(path.join(root, receipt.file))).toEqual(bytes);
      expect(receipt).toMatchObject({ available: true, owned: true, bytes: bytes.length, storedBytes: bytes.length, droppedBytes: 0, sha256: digest(bytes) });
      expect(receipt.analysis.analyzedLineCount).toBe(receipt.analysis.capturedLineCount);
    }
    expect(report.processes[0].streams.stderr.analysis).toMatchObject({ requiresReview: true, levelCounts: { warn: 1, error: 0 } });
  });

  it('fails an unknown stderr diagnostic even when the real process exits successfully', async () => {
    const root = directory(), audit = begin(root);
    const child = launch('process.stderr.write("unclassified native fixture failure\\n");');
    await closed(child);
    const { report } = await audit.finish();
    expect(report).toMatchObject({ complete: true, passed: false });
    expect(report.processes[0]).toMatchObject({ exitCode: 0, exitAccepted: true });
    expect(report.processes[0].streams.stderr.analysis).toMatchObject({ passed: false, coveragePassed: true, levelCounts: { error: 1 } });
    expect(report.processes[0].streams.stderr.analysis.findings).toContainEqual(expect.objectContaining({ code: 'unclassified-stderr', severity: 'error' }));
  });

  it('retains actual raw bytes locally while excluding arbitrary source names and report paths from metadata', async () => {
    const root = directory(), audit = begin(root);
    const child = launch('process.stdout.write("report=C:/private-context/PRIVATE_REPORT.txt\\n[00:00:00.000] [warn] [(PRIVATE_SOURCE_MARKER)] fixture warning\\n");');
    await closed(child);
    const { report } = await audit.finish();
    expect(report).toMatchObject({ complete: true, passed: true });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|private-context/);
    const stdout = report.processes[0].streams.stdout;
    expect(stdout.analysis).toMatchObject({ reportedPathCount: 1, levelCounts: { warn: 1 } });
    expect(fs.readFileSync(path.join(root, stdout.file), 'utf8')).toContain('PRIVATE_SOURCE_MARKER');
    expect(stdout.analysis.findings).toContainEqual(expect.objectContaining({ source: 'runtime-source', sourceHash: digest('PRIVATE_SOURCE_MARKER').slice(0, 16) }));
  });

  it('bounds stored output per stream and marks overflow incomplete instead of certifying it', async () => {
    const root = directory(), audit = begin(root, { maxStreamBytes: 64 });
    const child = launch('process.stdout.write("x".repeat(8192));');
    await closed(child);
    const { report } = await audit.finish();
    expect(report).toMatchObject({ complete: false, passed: false });
    const receipt = report.processes[0].streams.stdout;
    expect(receipt).toMatchObject({ bytes: 8192, storedBytes: 64, droppedBytes: 8128, sha256: digest('x'.repeat(8192)) });
    expect(fs.statSync(path.join(root, receipt.file)).size).toBe(64);
  });

  it('preserves a caller-decoded stream but cannot certify reconstructed bytes as original raw output', async () => {
    const root = directory(), audit = begin(root);
    const child = launch('process.stdout.write(Buffer.from([255]));');
    child.stdout!.setEncoding('utf8');
    let observed = ''; child.stdout!.on('data', value => { observed += value; });
    await closed(child);
    const { report } = await audit.finish();
    expect(observed).toBe('\ufffd');
    expect(report).toMatchObject({ complete: false, passed: false });
    expect(report.processes[0].streams.stdout.rawByteExact).toBe(false);
    expect(report.processes[0].issues).toHaveProperty('stdout_decoded_before_raw_capture', 1);
  });

  it('shares a bounded case budget across concurrent processes without losing their actual byte counts', async () => {
    const root = directory(), audit = begin(root, { maxCaseBytes: 80 });
    const first = launch('process.stdout.write("a".repeat(64));'), second = launch('process.stdout.write("b".repeat(64));');
    await Promise.all([closed(first), closed(second)]);
    const { report } = await audit.finish();
    expect(report).toMatchObject({ complete: false, passed: false });
    const streams = report.processes.flatMap((record: any) => Object.values(record.streams)) as any[];
    expect(streams.reduce((sum, stream) => sum + stream.bytes, 0)).toBe(128);
    expect(streams.reduce((sum, stream) => sum + stream.storedBytes, 0)).toBe(80);
    expect(streams.reduce((sum, stream) => sum + stream.droppedBytes, 0)).toBe(48);
  });

  it('preserves an existing evidence file and reports the unowned output as a capture gap', async () => {
    const root = directory(), existing = path.join(root, 'native-process-1-stdout.log');
    fs.writeFileSync(existing, 'KEEP');
    const audit = begin(root), child = launch('process.stdout.write("new diagnostic");');
    await closed(child);
    const { report, streamFiles } = await audit.finish();
    expect(fs.readFileSync(existing, 'utf8')).toBe('KEEP');
    expect(report).toMatchObject({ complete: false, passed: false });
    expect(report.processes[0].streams.stdout).toMatchObject({ owned: false, storedBytes: 0 });
    expect(streamFiles).not.toContain(existing);
  });

  it('does not turn the original unhandled spawn error into a handled error', async () => {
    const root = directory(), audit = begin(root);
    const child = childProcess.spawn(path.join(root, 'absent-native-executable.exe'), [], { windowsHide: true });
    children.add(child); child.once('close', () => children.delete(child));
    expect(child.listenerCount('error')).toBe(0);
    const error = new Promise<any>(resolve => child.once('error', resolve));
    const done = closed(child);
    expect((await error).code).toBe('ENOENT'); await done;
    const { report } = await audit.finish();
    expect(report.passed).toBe(false);
    expect(report.processes[0].issues).toHaveProperty('child_ENOENT', 1);
  });

  it('accepts only the predeclared owned fixture shutdown and rejects a retrospective acknowledgement', async () => {
    const root = directory(), audit = begin(root), child = launch('setInterval(() => {}, 1000);');
    expectNativeProcessTermination(child, 'SIGTERM');
    const done = closed(child); child.kill(); await done;
    expect(() => expectNativeProcessTermination(child, 'SIGTERM')).toThrow('live owned process');
    const { report } = await audit.finish();
    expect(report).toMatchObject({ complete: true, passed: true });
    expect(report.processes[0]).toMatchObject({ expectedTermination: true, signal: 'SIGTERM', exitAccepted: true });
  });

  it.each(['290', '290123'])('accepts one case-verified native console copy with fractional timestamp %s while retaining its original error and private-safe receipt', async precision => {
    const root = directory(), audit = begin(root);
    const sourceURL = 'http://127.0.0.1:31415/canary.js?token=PRIVATE_QUERY';
    const message = 'PRIVATE_INJECTED_FAILURE';
    const line = `[1106/172430.${precision}:INFO:CONSOLE:7] "Uncaught Error: ${message}", source: ${sourceURL} (7)`;
    const child = launch(`process.stderr.write(${JSON.stringify(line + '\n')});`);
    await closed(child);
    acknowledgeNativeConsoleError({ message, sourceURL });
    const { report } = await audit.finish();
    expect(report).toMatchObject({ complete: true, passed: true });
    expect(report.expectedConsoleErrors).toEqual([{
      messageHash: digest(message), sourceHash: digest(sourceURL), expectedCount: 1, actualCount: 1,
      matches: [{ process: 1, line: 1, sha256: digest(line) }],
    }]);
    expect(report.processes[0].streams.stderr.analysis).toMatchObject({ requiresReview: true,
      expectedConsoleErrorCount: 1, levelCounts: { warn: 1, error: 0 },
      originalAnalysis: { levelCounts: { error: 1 }, passed: false } });
    expect(fs.readFileSync(path.join(root, report.processes[0].streams.stderr.file), 'utf8')).toBe(line + '\n');
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|canary\.js/);
  });

  it.each(['2', '29', '2901', '29012', '2901234', '290123a'])(
    'rejects a malformed native console fractional timestamp %s', async precision => {
      const audit = begin(directory()), message = 'CONTROLLED_FIXTURE_FAILURE';
      const sourceURL = 'http://127.0.0.1:31415/owned.js';
      const line = `[1106/172430.${precision}:INFO:CONSOLE:7] "Uncaught Error: ${message}", source: ${sourceURL} (7)`;
      await closed(launch(`process.stderr.write(${JSON.stringify(line + '\n')});`));
      acknowledgeNativeConsoleError({ message, sourceURL });
      const { report } = await audit.finish();
      expect(report.passed).toBe(false);
      expect(report.expectedConsoleErrors[0].actualCount).toBe(0);
      expect(report.issueCounts).toHaveProperty('unmet_native_console_error', 1);
    },
  );

  it.each(['wrong-source', 'duplicate', 'additional-error', 'payload-only', 'stdout'])(
    'rejects %s instead of treating a controlled error acknowledgement as a stderr allow-list', async variant => {
      const root = directory(), audit = begin(root), message = 'CONTROLLED_FIXTURE_FAILURE';
      const sourceURL = 'http://127.0.0.1:31415/owned.js';
      const line = `[1106/172430.290:INFO:CONSOLE:7] "Uncaught Error: ${message}", source: ${sourceURL} (7)`;
      const raw = variant === 'payload-only' ? message : variant === 'duplicate' ? `${line}\n${line}`
        : variant === 'additional-error' ? `${line}\nextra unexpected native error` : line;
      const child = launch(`process.${variant === 'stdout' ? 'stdout' : 'stderr'}.write(${JSON.stringify(raw + '\n')});`);
      await closed(child);
      acknowledgeNativeConsoleError({ message, sourceURL: variant === 'wrong-source' ? sourceURL + '?other=1' : sourceURL });
      const { report } = await audit.finish();
      expect(report.passed).toBe(false);
      expect(report.expectedConsoleErrors[0].actualCount).toBe(variant === 'duplicate' ? 2 : variant === 'additional-error' ? 1 : 0);
      if (variant === 'additional-error') {
        expect(report.complete).toBe(true);
        expect(report.processes[0].streams.stderr.analysis).toMatchObject({ passed: false,
          levelCounts: { error: 1 }, originalAnalysis: { levelCounts: { error: 2 } } });
      } else expect(report.issueCounts).toHaveProperty('unmet_native_console_error', 1);
    },
  );

  it('rejects invalid or duplicate console acknowledgements and cannot acknowledge outside its owning case', async () => {
    expect(() => acknowledgeNativeConsoleError({ message: 'fixture', sourceURL: 'http://127.0.0.1:31415/a' })).toThrow('active test scope');
    const audit = begin(directory());
    expect(() => acknowledgeNativeConsoleError({ message: 'fixture', sourceURL: 'https://foreign.example/a' })).toThrow('owned loopback');
    const observed = { message: 'fixture', sourceURL: 'http://127.0.0.1:31415/a' };
    acknowledgeNativeConsoleError(observed);
    expect(() => acknowledgeNativeConsoleError(observed)).toThrow('Duplicate');
    const { report } = await audit.finish();
    expect(report.passed).toBe(false);
    expect(report.issueCounts).toHaveProperty('unmet_native_console_error', 1);
  });

  it('binds Firefox diagnostic parsing to its unchanged browser launch and returns the same actor', async () => {
    const audit = begin(directory()), actor = {}, options = { headless: true }, receiver: any[] = [];
    const browserType = { name: () => 'firefox', launch: async function (received: unknown) {
      receiver.push(this, received);
      const child = launch('process.stdout.write("console.error: native fixture failure\\n");');
      await closed(child); return actor;
    } };
    expect(await launchAuditedFirefox(browserType, options)).toBe(actor);
    expect(receiver).toEqual([browserType, options]);
    const { report } = await audit.finish();
    expect(report).toMatchObject({ complete: true, passed: false });
    expect(report.processes[0]).toMatchObject({ producer: 'firefox-native-browser', exitCode: 0 });
    expect(report.processes[0].streams.stdout.analysis).toMatchObject({ passed: false, levelCounts: { error: 1 } });
  });

  it('binds WebKit media parsing to the actual unchanged browser actor and byte-exact child', async () => {
    const root = directory(), audit = begin(root), actor = {}, options = { headless: true }, receiver: any[] = [];
    const text = '[WebKitWin:Media:-] MediaSessionManagerInterface::sessionWillBeginPlayback(0) 17\n'
      + '[WebKitWin:Media:-] MediaSessionManagerInterface::dumpSessionStates(0)  Sessions:\n(abc): VideoAudio, Playing, \n';
    const browserType = { name: () => 'webkit', launch: async function (received: unknown) {
      receiver.push(this, received); const child = launch(`process.stderr.write(${JSON.stringify(text)});`);
      await closed(child); return actor;
    } };
    expect(await launchAuditedWebKit(browserType, options)).toBe(actor);
    expect(receiver).toEqual([browserType, options]);
    const { report } = await audit.finish();
    expect(report).toMatchObject({ complete: true, passed: true });
    const record = report.processes[0];
    expect(record).toMatchObject({ producer: 'webkit-native-browser', exitCode: 0, exitAccepted: true });
    expect(fs.readFileSync(path.join(root, record.streams.stderr.file), 'utf8')).toBe(text);
    expect(record.streams.stderr).toMatchObject({ rawByteExact: true, sha256: digest(text), analysis: { levelCounts: { info: 3, error: 0 } } });
  });
  it('rejects WebKit producer spoofing and ambiguous ownership while preserving launch failures', async () => {
    const audit = begin(directory()), failure = new Error('owned launch failure'), actor = {};
    await expect(launchAuditedWebKit({ name: () => 'chromium' }, {})).rejects.toThrow('owning native scope');
    await expect(launchAuditedWebKit({ name: () => 'webkit', launch: async () => { throw failure; } }, {})).rejects.toBe(failure);
    const browserType = { name: () => 'webkit', launch: async () => {
      const first = launch(''), second = launch('');
      expect(() => tagNativeProcess(first, 'webkit-native-browser')).toThrow('Unsupported');
      await Promise.all([closed(first), closed(second)]); return actor;
    } };
    expect(await launchAuditedWebKit(browserType, {})).toBe(actor);
    const { report } = await audit.finish();
    expect(report).toMatchObject({ complete: false, passed: false, issueCounts: { webkit_process_ownership: 1 } });
    expect(report.processes.every((process: any) => process.producer === null)).toBe(true);
  });
  it('propagates Firefox launch failure and refuses ambiguous child ownership without changing the actor', async () => {
    const audit = begin(directory()), failure = new Error('owned launch failure'), actor = {};
    await expect(launchAuditedFirefox({ name: () => 'firefox', launch: async () => { throw failure; } }, {})).rejects.toBe(failure);
    const browserType = { name: () => 'firefox', launch: async () => {
      const first = launch(''), second = launch(''); await Promise.all([closed(first), closed(second)]); return actor;
    } };
    expect(await launchAuditedFirefox(browserType, {})).toBe(actor);
    const { report } = await audit.finish();
    expect(report).toMatchObject({ complete: false, passed: false, issueCounts: { firefox_process_ownership: 1 } });
    expect(report.processes.every((process: any) => process.producer === null)).toBe(true);
  });

  it('accepts only exact case-verified404 responses from the owned preview and keeps their original errors', async () => {
    const root = directory(), audit = begin(root), target = '/missing?next=PRIVATE_TARGET';
    const get = `127.0.0.1 - - [06/Nov/2026 00:00:00] "GET ${target} HTTP/1.1" 404 -`;
    const head = '127.0.0.1 - - [06/Nov/2026 00:00:00] "HEAD /missing-head HTTP/1.1" 404 -';
    const child = launch(`process.stderr.write(${JSON.stringify(get + '\n' + head + '\n')});`);
    expect(() => acknowledgeNativePreviewNotFound(child, { method: 'GET', target })).toThrow('owned Python preview');
    tagNativeProcess(child, 'python-http-preview');
    acknowledgeNativePreviewNotFound(child, { method: 'GET', target });
    acknowledgeNativePreviewNotFound(child, { method: 'HEAD', target: '/missing-head' });
    await closed(child);
    const { report } = await audit.finish();
    expect(report).toMatchObject({ complete: true, passed: true });
    expect(report.expectedPreviewNotFound.map((item: any) => [item.method, item.actualCount])).toEqual([['GET', 1], ['HEAD', 1]]);
    expect(report.processes[0].streams.stderr.analysis).toMatchObject({ expectedConsoleErrorCount: 0,
      expectedPreviewNotFoundCount: 2, levelCounts: { warn: 2, error: 0 }, originalAnalysis: { levelCounts: { error: 2 } } });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_TARGET');
    expect(fs.readFileSync(path.join(root, report.processes[0].streams.stderr.file), 'utf8')).toBe(get + '\n' + head + '\n');
  });

  it.each(['wrong-target', 'duplicate', 'additional500'])('keeps a preview %s failed despite its acknowledgement', async variant => {
    const audit = begin(directory()), target = '/missing';
    const line = `127.0.0.1 - - [06/Nov/2026 00:00:00] "GET ${target} HTTP/1.1" 404 -`;
    const raw = variant === 'duplicate' ? `${line}\n${line}` : variant === 'additional500' ? `${line}\n${line.replace(' 404 -', ' 500 -')}` : line;
    const child = launch(`process.stderr.write(${JSON.stringify(raw + '\n')});`);
    tagNativeProcess(child, 'python-http-preview');
    acknowledgeNativePreviewNotFound(child, { method: 'GET', target: variant === 'wrong-target' ? '/other' : target });
    await closed(child);
    const { report } = await audit.finish();
    expect(report.passed).toBe(false);
    if (variant === 'additional500') expect(report.processes[0].streams.stderr.analysis).toMatchObject({ passed: false,
      levelCounts: { error: 1 }, originalAnalysis: { levelCounts: { error: 2 } } });
    else expect(report.issueCounts).toHaveProperty('unmet_preview_response', 1);
  });
});
