import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

describe('MCP stdio diagnostic boundary', () => {
  it.each(['spawn-rejection', 'sdk-closed-after-start'])(
    'retains the real missing-executable failure through %s', mode => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-mcp-missing-'));
      const probePath = path.join(root, 'probe.cjs');
      const missing = path.join(root, 'missing-server');
      // Resolve the same public import export as McpConnection's dynamic
      // import, rather than the distinct require-condition SDK class.
      fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      fs.writeFileSync(probePath, [
        'const warnings = [];',
        `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/logger.ts'))})] = { exports: { createLogger: () => ({ info() {}, warn(message) { warnings.push(message); } }) } };`,
        `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/util/proxy-dispatcher.ts'))})] = { exports: { buildChildProxyEnvironment: async () => ({}) } };`,
        '(async () => {',
        "  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');",
        "  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');",
        '  const originalStart = StdioClientTransport.prototype.start;',
        '  const originalConnect = Client.prototype.connect;',
        '  let spawnCode, sdkRejectedCode, connectCalls = 0, sdkCloseDelivered = false;',
        '  Client.prototype.connect = async function (...args) {',
        '    connectCalls++;',
        '    try { return await Reflect.apply(originalConnect, this, args); }',
        '    catch (error) { sdkRejectedCode = error.code; throw error; }',
        '  };',
        ...(mode === 'sdk-closed-after-start' ? [
          // Reproduce the Windows ordering while retaining a real failed OS
          // spawn and the actual SDK Client/transport/close rejection path.
          // The SDK has accepted start before the later spawn error arrives.
          '  StdioClientTransport.prototype.start = function () {',
          '    const onerror = this.onerror;',
          '    this.onerror = error => { if (error.syscall?.startsWith("spawn")) spawnCode = error.code; onerror?.(error); };',
          '    void originalStart.call(this).catch(() => { sdkCloseDelivered = true; this.onclose?.(); });',
          '    return Promise.resolve();',
          '  };',
        ] : []),
        `  const { McpConnection } = require(${JSON.stringify(path.resolve('src/main/features/connectors/mcp-client.ts'))});`,
        `  const connection = new McpConnection('custom-missing', { kind: 'stdio', command: ${JSON.stringify(missing)}, args: [], env: {} });`,
        '  try {',
        '    try { await connection.connect(); throw new Error("missing executable unexpectedly connected"); }',
        '    catch (error) { process.stdout.write(JSON.stringify({ code: error.code, syscall: error.syscall, connected: connection.isConnected, spawnCode, sdkRejectedCode, connectCalls, sdkCloseDelivered, warnings })); }',
        '  } finally { await connection.close(); StdioClientTransport.prototype.start = originalStart; Client.prototype.connect = originalConnect; }',
        '})().catch(error => { process.stderr.write(error.name); process.exitCode = 1; });',
      ].join('\n'));
      try {
        const result = spawnSync(process.execPath, ['-r', require.resolve('tsx/cjs'), probePath], {
          cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_WORKSPACE_ROOT: root },
          encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
        });
        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(result.stderr).toBe('');
        const outcome = JSON.parse(result.stdout);
        expect(outcome).toMatchObject({ code: 'ENOENT', connected: false, connectCalls: 1, warnings: ['connect failed'] });
        expect(outcome.syscall).toBe(`spawn ${missing}`);
        if (mode === 'sdk-closed-after-start') {
          expect(outcome.spawnCode).toBe('ENOENT');
          expect(outcome.sdkCloseDelivered).toBe(true);
          expect(outcome.sdkRejectedCode).toBe(-32000);
        }
        // Retain the captured production warning for the default log review,
        // without emitting the temporary executable path from syscall.
        console.warn('MCP missing-executable diagnostic retained', {
          mode, code: outcome.code, sdkRejectedCode: outcome.sdkRejectedCode,
          warnings: outcome.warnings,
        });
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }, 15_000,
  );

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')
    .each(['graceful', 'ignores-eof', 'failed-initialize', 'reconnect'])(
    'closes native stdio before shutdown or reconnect: %s', async mode => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-mcp-native-close-'));
      const serverPath = path.join(root, 'server.cjs');
      const probePath = path.join(root, 'probe.cjs');
      const pidsPath = path.join(root, 'pids.jsonl');
      const receiptsPath = path.join(root, 'eof.jsonl');
      fs.writeFileSync(serverPath, [
        `const { Server } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))});`,
        `const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});`,
        `require('node:fs').appendFileSync(${JSON.stringify(pidsPath)}, JSON.stringify(process.pid) + '\\n');`,
        'process.stdin.on("end", () => {',
        ...(mode === 'ignores-eof' ? [] : [
          `  require('node:fs').appendFileSync(${JSON.stringify(receiptsPath)}, JSON.stringify(process.pid) + '\\n');`,
          '  process.exit(0);',
        ]),
        '});',
        'setTimeout(() => process.exit(1), 15000).unref();',
        ...(mode === 'failed-initialize' ? ['process.stdin.resume();'] : [
          "void new Server({ name: 'native-close', version: '1' }, { capabilities: {} }).connect(new StdioServerTransport());",
        ]),
        ...(mode === 'ignores-eof' ? ['setInterval(() => {}, 1000);'] : []),
      ].join('\n'));
      fs.writeFileSync(probePath, [
        'const warnings = [];',
        `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/logger.ts'))})] = { exports: { createLogger: () => ({ info() {}, warn(message) { warnings.push(message); } }) } };`,
        `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/util/proxy-dispatcher.ts'))})] = { exports: { buildChildProxyEnvironment: async () => ({}) } };`,
        `const { McpConnection } = require(${JSON.stringify(path.resolve('src/main/features/connectors/mcp-client.ts'))});`,
        `const connection = new McpConnection('custom-native-close', { kind: 'stdio', command: ${JSON.stringify(process.env.ORKAS_TEST_NODE)}, args: [${JSON.stringify(serverPath)}], env: {} });`,
        'const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };',
        ...(mode === 'failed-initialize' ? [
          'const originalSetTimeout = global.setTimeout;',
          'global.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, ms === 30000 ? 1000 : ms, ...args);',
        ] : []),
        '(async () => {',
        '  try {',
        '    let connectFailed = false; try { await connection.connect(); } catch { connectFailed = true; }',
        '    const closing = connection.close();',
        '    const duplicate = connection.close();',
        ...(mode === 'reconnect' ? ['    const reconnecting = connection.connect();'] : []),
        '    await Promise.all([closing, duplicate]);',
        ...(mode === 'reconnect' ? ['    await reconnecting; await connection.close();'] : []),
        `    const pids = require('node:fs').readFileSync(${JSON.stringify(pidsPath)}, 'utf8').trim().split('\\n').map(JSON.parse);`,
        `    const receipts = require('node:fs').existsSync(${JSON.stringify(receiptsPath)}) ? require('node:fs').readFileSync(${JSON.stringify(receiptsPath)}, 'utf8').trim().split('\\n').map(JSON.parse) : [];`,
        '    process.stdout.write(JSON.stringify({ connectFailed, connected: connection.isConnected, sharedClose: connectFailed || closing === duplicate, count: pids.length, alive: pids.some(alive), graceful: pids.every(pid => receipts.includes(pid)), warnings }));',
        '  } finally { await connection.close(); }',
        '})().catch(error => { process.stderr.write(error.name); process.exitCode = 1; });',
      ].join('\n'));
      try {
        const result = spawnSync(process.execPath, ['-r', require.resolve('tsx/cjs'), probePath], {
          cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_WORKSPACE_ROOT: root },
          encoding: 'utf8', timeout: 12000, maxBuffer: 1024 * 1024,
        });
        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual({
          connectFailed: mode === 'failed-initialize', connected: false, sharedClose: true,
          count: mode === 'reconnect' ? 2 : 1, alive: false, graceful: mode !== 'ignores-eof',
          warnings: mode === 'failed-initialize' ? ['connect failed'] : [],
        });
      } finally {
        if (fs.existsSync(pidsPath)) for (const pid of fs.readFileSync(pidsPath, 'utf8').trim().split('\n').map(JSON.parse)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already closed */ }
        }
        await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }, 15000,
  );

  it.runIf(process.platform === 'win32').each(['direct', 'cmd', 'failed-initialize', 'app-shutdown', 'app-late-connection', 'shared-runtime'])(
    'releases a Windows MCP descendant file lock before disconnect completes: %s', async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas MCP 更新 '));
    const serverPath = path.join(root, 'server.cjs');
    const probePath = path.join(root, 'probe.cjs');
    const lockPath = path.join(root, 'runtime.exe');
    const replacementPath = path.join(root, 'replacement.exe');
    const pidPath = path.join(root, 'lock.pid');
    const readyPath = path.join(root, 'lock.ready');
    const foreignReadyPath = path.join(root, 'foreign.ready');
    const shimPath = path.join(root, 'server.cmd');
    fs.copyFileSync(process.env.ORKAS_TEST_NODE!, lockPath);
    const unrelated = spawn(mode === 'shared-runtime' ? lockPath : process.env.ORKAS_TEST_NODE!, ['-e',
      `require('node:fs').writeFileSync(${JSON.stringify(foreignReadyPath)}, 'ready'); setTimeout(() => {}, 30000);`,
    ], {
      windowsHide: true, stdio: 'ignore',
    });
    const unrelatedClosed = new Promise(resolve => unrelated.once('close', resolve));
    fs.writeFileSync(replacementPath, 'new runtime');
    const lockScript = `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'locked'); setTimeout(() => {}, 30000);`;
    fs.writeFileSync(serverPath, [
      `const { Server } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))});`,
      `const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});`,
      `const child = require('node:child_process').spawn(${JSON.stringify(lockPath)}, ['-e', ${JSON.stringify(lockScript)}],`,
      `  { windowsHide: true, detached: true, stdio: 'ignore' });`,
      `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
      'const timer = setInterval(() => {',
      `  if (!require('node:fs').existsSync(${JSON.stringify(readyPath)})) return; clearInterval(timer);`,
      "  const server = new Server({ name: 'tree', version: '1' }, { capabilities: {} });",
      // The wrapper exits on EOF; Windows must still reap its non-cooperating child.
      '  process.stdin.once("end", () => process.exit(0));',
      mode === 'failed-initialize' ? '  process.stdin.resume();' : '  void server.connect(new StdioServerTransport());',
      '}, 20);',
    ].join('\n'));
    fs.writeFileSync(shimPath, `@echo off\r\n"${process.env.ORKAS_TEST_NODE}" "%~dp0server.cjs"\r\n`);
    fs.writeFileSync(probePath, [
      'const warnings = [];',
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/logger.ts'))})] = { exports: { createLogger: () => ({ info() {}, warn(message) { warnings.push(message); } }) } };`,
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/util/proxy-dispatcher.ts'))})] = { exports: { buildChildProxyEnvironment: async () => ({}) } };`,
      `const { McpConnection } = require(${JSON.stringify(path.resolve('src/main/features/connectors/mcp-client.ts'))});`,
      'const childProcess = require("node:child_process"); const originalSpawn = childProcess.spawn; let processHelpers = 0;',
      'childProcess.spawn = (...args) => { if (require("node:path").basename(args[0]).toLowerCase() === "powershell.exe") processHelpers++; return originalSpawn(...args); };',
      `const connection = new McpConnection('custom-tree', { kind: 'stdio', command: ${JSON.stringify(mode === 'cmd' ? shimPath : process.env.ORKAS_TEST_NODE)}, args: ${JSON.stringify(mode === 'cmd' ? [] : [serverPath])}, env: {} });`,
      ...(mode === 'failed-initialize' ? [
        'const realSetTimeout = global.setTimeout;',
        'global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 30000 ? 1500 : ms, ...args);',
      ] : []),
      '(async () => {',
      '  let processSnapshot;',
      '  try {',
      ...(mode === 'app-late-connection' ? [
        `  processSnapshot = await require(${JSON.stringify(path.resolve('src/main/util/windows-shutdown-processes.ts'))}).captureWindowsShutdownProcesses();`,
      ] : []),
      '  const connecting = connection.connect().then(() => false, () => true);',
      `  const deadline = Date.now() + 3000; while (!require('node:fs').existsSync(${JSON.stringify(readyPath)})) { if (Date.now() > deadline) throw new Error('fixture not ready'); await new Promise(resolve => setTimeout(resolve, 20)); }`,
      '  let wasLocked = false;',
      `  try { require('node:fs').renameSync(${JSON.stringify(replacementPath)}, ${JSON.stringify(lockPath)}); } catch (error) { wasLocked = error.code === 'EPERM'; }`,
      '  const connectFailed = await connecting;',
      '  let sharedClose = false;',
      '  const close = async () => { const first = connection.close(); const second = connection.close(); sharedClose = connectFailed || first === second; await Promise.all([first, second]); };',
      ...(mode.startsWith('app-') || mode === 'shared-runtime' ? [
        `  const { captureWindowsShutdownProcesses } = require(${JSON.stringify(path.resolve('src/main/util/windows-shutdown-processes.ts'))});`,
        `  const { createShutdownCoordinator } = require(${JSON.stringify(path.resolve('src/main/util/shutdown.ts'))});`,
        '  const shutdown = createShutdownCoordinator({ captureProcesses: () => processSnapshot || captureWindowsShutdownProcesses(), localTasks: [{ name: "connectors", run: close }], sync: async () => {}, onFailure: name => { throw new Error(name); } });',
        '  await shutdown.prepare();',
      ] : ['  await close();']),
      `  const pid = Number(require('node:fs').readFileSync(${JSON.stringify(pidPath)}, 'utf8'));`,
      '  let alive = false; try { process.kill(pid, 0); alive = true; } catch {}',
      // The outer test represents another host. In shared-runtime mode it
      // executes the exact locked binary and must survive app cleanup.
      `  let unrelatedAlive = false; try { process.kill(${unrelated.pid}, 0); unrelatedAlive = true; } catch {}`,
      '  let replaced = false;',
      `  try { require('node:fs').renameSync(${JSON.stringify(replacementPath)}, ${JSON.stringify(lockPath)}); replaced = true; } catch {}`,
      '  process.stdout.write(JSON.stringify({ wasLocked, alive, replaced, unrelatedAlive, connectFailed, sharedClose, warnings, processHelpers }));',
      '  } finally { await connection.close(); processSnapshot?.dispose(); }',
      '})().catch(error => { process.stderr.write(error.name); process.exitCode = 1; });',
    ].join('\n'));
    try {
      await vi.waitFor(() => expect(fs.existsSync(foreignReadyPath)).toBe(true), { timeout: 3000, interval: 20 });
      const result = spawnSync(process.execPath, ['-r', require.resolve('tsx/cjs'), probePath], {
        cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_WORKSPACE_ROOT: root },
        encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      const { processHelpers, ...outcome } = JSON.parse(result.stdout);
      expect(outcome).toEqual({
        wasLocked: true, alive: false, replaced: mode !== 'shared-runtime', unrelatedAlive: true,
        connectFailed: mode === 'failed-initialize', sharedClose: true,
        warnings: mode === 'failed-initialize' ? ['connect failed'] : [],
      });
      expect(processHelpers, 'only a connection created after the app snapshot needs another snapshot')
        .toBeLessThanOrEqual(mode === 'app-late-connection' ? 2 : 1);
      if (mode === 'shared-runtime') {
        // Only the external host can release its remaining lock. Orkas must
        // neither kill that host nor report the shared binary as replaceable.
        unrelated.kill();
        await unrelatedClosed;
        fs.renameSync(replacementPath, lockPath);
      }
      expect(fs.readFileSync(lockPath, 'utf8')).toBe('new runtime');
    } finally {
      if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill();
      await unrelatedClosed;
      if (fs.existsSync(pidPath)) {
        const pid = Number(fs.readFileSync(pidPath, 'utf8'));
        try { process.kill(pid, 'SIGKILL'); } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20000);

  it.each(['complete', 'cycle', 'failure', 'cancel', 'deadline'])('collects paged tools atomically through the real SDK: %s', mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-mcp-pages-'));
    const childPath = path.join(root, 'server.cjs');
    const probePath = path.join(root, 'probe.cjs');
    const eventsPath = path.join(root, 'pages.jsonl');
    fs.writeFileSync(childPath, [
      `const { Server } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))});`,
      `const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});`,
      `const { ListToolsRequestSchema } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/types.js'))});`,
      "const server = new Server({ name: 'paged', version: '1' }, { capabilities: { tools: {} } });",
      'server.setRequestHandler(ListToolsRequestSchema, async request => {',
      '  const cursor = request.params?.cursor;',
      `  require('node:fs').appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(cursor ?? null) + '\\n');`,
      ...(mode === 'failure' ? ["  if (cursor) throw new Error('fixture page failed');"] : []),
      ...(mode === 'deadline' ? ['  await new Promise(resolve => setTimeout(resolve, 180));'] : []),
      ...(mode === 'cancel' ? ['  if (cursor) await new Promise(resolve => setTimeout(resolve, 2000));'] : []),
      "  const index = cursor === undefined ? 0 : cursor === 'page-2' ? 1 : 2;",
      "  return { tools: [{ name: 'read_' + index, inputSchema: { type: 'object' } }],",
      mode === 'cycle' ? "    nextCursor: 'page-2' };" : "    ...(index < 2 ? { nextCursor: 'page-' + (index + 2) } : {}) };",
      '});',
      'process.stdin.once("end", () => { void server.close(); });',
      'void server.connect(new StdioServerTransport());',
    ].join('\n'));
    fs.writeFileSync(probePath, [
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/logger.ts'))})] = { exports: { createLogger: () => ({ info() {}, warn() {} }) } };`,
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/util/proxy-dispatcher.ts'))})] = { exports: { buildChildProxyEnvironment: async () => ({}) } };`,
      `const { McpConnection } = require(${JSON.stringify(path.resolve('src/main/features/connectors/mcp-client.ts'))});`,
      `const connection = new McpConnection('fixture', { kind: 'stdio', command: process.execPath, args: [${JSON.stringify(childPath)}], env: { ELECTRON_RUN_AS_NODE: '1' } });`,
      '(async () => {',
      '  try {',
      '    await connection.connect();',
      '    const controller = new AbortController(); let timer;',
      ...(mode === 'cancel' ? ['    timer = setTimeout(() => controller.abort(), 100);'] : []),
      '    try {',
      `      const tools = await connection.listTools({ signal: controller.signal, timeoutMs: ${mode === 'deadline' ? 300 : 3000} });`,
      '      process.stdout.write(JSON.stringify({ tools }));',
      '    } catch (error) { process.stdout.write(JSON.stringify({ failed: true, message: error.message })); }',
      '    finally { clearTimeout(timer); }',
      '  } finally { await connection.close(); }',
      '})().catch(() => { process.exitCode = 1; });',
    ].join('\n'));
    try {
      const result = spawnSync(process.execPath, ['-r', require.resolve('tsx/cjs'), probePath], {
        cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_WORKSPACE_ROOT: root },
        encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0); expect(result.stderr).toBe('');
      const outcome = JSON.parse(result.stdout);
      const pages = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      if (mode === 'complete') {
        expect(outcome.tools.map((tool: any) => tool.name)).toEqual(['read_0', 'read_1', 'read_2']);
        expect(pages).toEqual([null, 'page-2', 'page-3']);
      } else {
        expect(outcome.failed).toBe(true); expect(outcome).not.toHaveProperty('tools');
        if (mode === 'deadline') {
          // The 300ms operation budget covers two 180ms page delays. A busy
          // host can expire on the first page; it must never complete all three
          // or publish the partial catalog. Receipt of page two is not promised.
          expect(pages.length).toBeGreaterThanOrEqual(1);
          expect(pages.length).toBeLessThanOrEqual(2);
          expect(pages).toEqual([null, 'page-2'].slice(0, pages.length));
        } else expect(pages).toEqual([null, 'page-2']);
        if (mode === 'cycle') expect(outcome.message).toContain('repeated a pagination cursor');
        if (mode === 'failure') expect(outcome.message).toContain('fixture page failed');
        if (mode === 'deadline') expect(outcome.message).toMatch(/timed out/i);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['stdio', 'streamable-http'])('closes a %s channel that never completes initialization within 30s', (kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-mcp-connect-'));
    const childPath = path.join(root, 'silent.cjs');
    const probePath = path.join(root, 'probe.cjs');
    const pidPath = path.join(root, 'child.pid');
    fs.writeFileSync(childPath, `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.stdin.resume();`);
    fs.writeFileSync(probePath, [
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/logger.ts'))})] = { exports: { createLogger: () => ({ info() {}, warn() {} }) } };`,
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/util/proxy-dispatcher.ts'))})] = { exports: { buildChildProxyEnvironment: async () => ({}) } };`,
      `const { McpConnection } = require(${JSON.stringify(path.resolve('src/main/features/connectors/mcp-client.ts'))});`,
      'const realSetTimeout = global.setTimeout; const deadlines = [];',
      // Assert configured defaults independently of a one-millisecond setup
      // tick. Timers and the native peer stay real; only connect's clock is
      // pinned and it is restored before operations and cleanup.
      'const realNow = Date.now; const connectEpoch = realNow();',
      // Scale only the production 30s budget. An incorrect 180s/60s default fails the probe deadline.
      'global.setTimeout = (fn, ms, ...args) => { deadlines.push(ms); return realSetTimeout(fn, ms === 30000 ? 500 : ms, ...args); };',
      '(async () => {',
      "  const server = require('node:http').createServer(() => {});",
      "  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));",
      `  const transport = ${JSON.stringify(kind)} === 'stdio'`,
      `    ? { kind: 'stdio', command: process.execPath, args: [${JSON.stringify(childPath)}], env: { ELECTRON_RUN_AS_NODE: '1' } }`,
      "    : { kind: 'streamable-http', url: 'http://127.0.0.1:' + server.address().port + '/mcp' };",
      "  const connection = new McpConnection('fixture', transport);",
      '  try {',
      '    Date.now = () => connectEpoch;',
      '    await connection.connect();',
      '    throw new Error("Unexpected connection success");',
      '  } catch (error) {',
      '    process.stdout.write(JSON.stringify({ message: error.message, connected: connection.isConnected, deadlines }));',
      '  } finally { Date.now = realNow; await connection.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }',
      '})().catch(() => { process.exitCode = 1; });',
    ].join('\n'));
    try {
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_WORKSPACE_ROOT: root };
      for (const key of ['ORKAS_MCP_CONNECT_TIMEOUT_MS', 'ORKAS_MCP_STDIO_CONNECT_TIMEOUT_MS', 'ORKAS_MCP_HTTP_CONNECT_TIMEOUT_MS']) delete env[key];
      const result = spawnSync(process.execPath, ['-r', require.resolve('tsx/cjs'), probePath], {
        cwd: root, env, encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const outcome = JSON.parse(result.stdout);
      expect(outcome.connected).toBe(false);
      expect(outcome.message).toContain('MCP connect timed out (>30s)');
      expect(outcome.deadlines.slice(0, 2)).toEqual([30_000, 30_000]);
      if (kind === 'stdio') {
        expect(fs.existsSync(pidPath)).toBe(true);
        expect(() => process.kill(Number(fs.readFileSync(pidPath, 'utf8')), 0)).toThrow();
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['quiet', 'progress', 'endless', 'late-progress'])('bounds a %s operation and never replays it after timeout', (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-mcp-deadline-'));
    const childPath = path.join(root, 'server.cjs');
    const probePath = path.join(root, 'probe.cjs');
    const eventsPath = path.join(root, 'events.jsonl');
    fs.writeFileSync(childPath, [
      `const { Server } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))});`,
      `const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});`,
      `const { CallToolRequestSchema } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/types.js'))});`,
      `const record = event => require('node:fs').appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');`,
      "const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });",
      'server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {',
      "  record('start');",
      '  let count = 0, timer, pulse;',
      '  try {',
      '    await new Promise(resolve => {',
      "      extra.signal.addEventListener('abort', () => { record('cancel'); resolve(); }, { once: true });",
      ...(mode !== 'quiet' ? [
        "      pulse = setInterval(() => { void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: request.params._meta.progressToken, progress: ++count } }).catch(() => {}); }, 80);",
      ] : []),
      ...(mode !== 'endless' ? ["      timer = setTimeout(() => { record('complete'); resolve(); }, 800);"] : []),
      '    });',
      "    return { content: [{ type: 'text', text: 'complete' }] };",
      '  } finally { clearTimeout(timer); clearInterval(pulse); }',
      '});',
      'process.stdin.once("end", () => { void server.close(); });',
      'void server.connect(new StdioServerTransport());',
    ].join('\n'));
    fs.writeFileSync(probePath, [
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/logger.ts'))})] = { exports: { createLogger: () => ({ info() {}, warn() {} }) } };`,
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/util/proxy-dispatcher.ts'))})] = { exports: { buildChildProxyEnvironment: async () => ({}) } };`,
      `const { McpConnection } = require(${JSON.stringify(path.resolve('src/main/features/connectors/mcp-client.ts'))});`,
      `const connection = new McpConnection('fixture', { kind: 'stdio', command: process.execPath, args: [${JSON.stringify(childPath)}], env: { ELECTRON_RUN_AS_NODE: '1' } });`,
      'const realSetTimeout = global.setTimeout; const deadlines = [];',
      'const realNow = Date.now; const connectEpoch = realNow();',
      'global.setTimeout = (fn, ms, ...args) => { deadlines.push(ms); return realSetTimeout(fn, ms === 600000 ? 1200 : ms === 60000 ? 300 : ms, ...args); };',
      '(async () => {',
      '  try {',
      '    Date.now = () => connectEpoch;',
      '    await connection.connect();',
      '    Date.now = realNow;',
      '    try {',
      `      const result = await connection.callTool('execute_write', {}${mode === 'late-progress' ? ', { timeoutMs: 300 }' : ''});`,
      "      process.stdout.write(JSON.stringify({ outcome: result.content[0].text, deadlines }));",
      '    } catch (error) { process.stdout.write(JSON.stringify({ code: error.code, deadlines })); }',
      '    await new Promise(resolve => setTimeout(resolve, 150));',
      '  } finally { Date.now = realNow; await connection.close(); }',
      '})().catch(() => { process.exitCode = 1; });',
    ].join('\n'));
    try {
      const result = spawnSync(process.execPath, ['-r', require.resolve('tsx/cjs'), probePath], {
        cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_WORKSPACE_ROOT: root },
        encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const { deadlines, ...outcome } = JSON.parse(result.stdout);
      expect(outcome).toEqual(['quiet', 'progress'].includes(mode) ? { outcome: 'complete' } : { code: -32001 });
      // Both the startup guard and SDK initialize request use the same default.
      expect(deadlines.slice(0, 2)).toEqual([30_000, 30_000]);
      expect(deadlines).toContain(mode === 'late-progress' ? 300 : 600_000);
      expect(fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
        .toEqual(['start', ['quiet', 'progress'].includes(mode) ? 'complete' : 'cancel']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['custom-fixture', 'notion'])('drains private child diagnostics without inheriting them into the parent: %s', (id) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-mcp-diagnostics-'));
    const childPath = path.join(root, 'server.cjs');
    const probePath = path.join(root, 'probe.cjs');
    const marker = 'synthetic-private-connector-diagnostic';
    fs.writeFileSync(childPath, [
      `const { Server } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))});`,
      `const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});`,
      `const { ListToolsRequestSchema } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/types.js'))});`,
      "const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });",
      "server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'read_fixture', inputSchema: { type: 'object' } }] }));",
      // More than a typical pipe buffer: the privacy boundary must drain the stream too.
      `process.stderr.write(${JSON.stringify(marker)}.repeat(4096));`,
      'process.stdin.once("end", () => { void server.close(); });',
      'void server.connect(new StdioServerTransport());',
    ].join('\n'));
    fs.writeFileSync(probePath, [
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/logger.ts'))})] = { exports: { createLogger: () => ({ info() {}, warn() {} }) } };`,
      `require.cache[require.resolve(${JSON.stringify(path.resolve('src/main/util/proxy-dispatcher.ts'))})] = { exports: { buildChildProxyEnvironment: async () => ({}) } };`,
      `const { McpConnection } = require(${JSON.stringify(path.resolve('src/main/features/connectors/mcp-client.ts'))});`,
      `const connection = new McpConnection(${JSON.stringify(id)}, { kind: 'stdio', command: process.execPath, args: [${JSON.stringify(childPath)}], env: { ELECTRON_RUN_AS_NODE: '1' } });`,
      '(async () => {',
      '  try {',
      '    await connection.connect();',
      '    process.stdout.write(JSON.stringify(await connection.listTools()));',
      '  } finally { await connection.close(); }',
      '})().catch(() => { process.exitCode = 1; });',
    ].join('\n'));
    try {
      const result = spawnSync(process.execPath, ['-r', require.resolve('tsx/cjs'), probePath], {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_WORKSPACE_ROOT: root },
        encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        { name: 'read_fixture', description: '', input_schema: { type: 'object' } },
      ]);
      expect(result.stderr.includes(marker)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
