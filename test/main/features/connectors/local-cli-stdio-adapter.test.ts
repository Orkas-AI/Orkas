import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const testNode = process.env.ORKAS_TEST_NODE || process.execPath;
const adapter = require('../../../../bin/local-cli-mcp-server.cjs') as {
  MANIFESTS: Record<string, { package: string; integrity: string; executable: string; domains: readonly string[] }>;
  TOOLS: Array<{ name: string; _meta: { orkas: { actionPolicy: { risk: string } } } }>;
  validateAction: (action: string, env: NodeJS.ProcessEnv) => unknown;
  validateCapabilityPath: (path: string, env: NodeJS.ProcessEnv) => unknown;
  assertPackageIntegrityMarker: (
    manifest: { package: string; integrity: string }, env: NodeJS.ProcessEnv,
  ) => void;
  classifyAction: (action: string, schema?: unknown) => string;
  classifyXeroAction: (action: string) => string;
  invocationRisk: (baseRisk: string, parameters: unknown, env?: NodeJS.ProcessEnv) => string;
  redact: (value: unknown) => string;
  validatedParameters: (value: unknown, env?: NodeJS.ProcessEnv, inspection?: unknown) => Record<string, unknown>;
  invocationFor: (action: string, params: unknown, risk: string, env: NodeJS.ProcessEnv) => string[];
  executeAction: (
    risk: string,
    args: { action: string; parameters?: Record<string, unknown> },
    options: { runner: ReturnType<typeof vi.fn> },
    env: NodeJS.ProcessEnv,
  ) => Promise<unknown>;
  callTool: (
    name: string,
    args: Record<string, unknown>,
    options: Record<string, unknown>,
    env: NodeJS.ProcessEnv,
  ) => Promise<unknown>;
};

function envFor(provider: 'wecom' | 'lark' | 'dingtalk' | 'xero'): NodeJS.ProcessEnv {
  const manifest = adapter.MANIFESTS[provider];
  return {
    ORKAS_LOCAL_CLI_PROVIDER: provider,
    ORKAS_LOCAL_CLI_PACKAGE: manifest.package,
    ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY: manifest.integrity,
    ORKAS_LOCAL_CLI_EXECUTABLE: manifest.executable,
    ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: JSON.stringify(manifest.domains),
    ORKAS_LOCAL_CLI_PROFILE: 'orkas-test-profile',
    ORKAS_LOCAL_CLI_BRAND: provider === 'lark' ? 'feishu' : '',
    ORKAS_LOCAL_CLI_RUNTIME_DIR: path.join(os.tmpdir(), 'orkas-local-cli-test'),
    ORKAS_LOCAL_CLI_WORK_DIR: path.join(os.tmpdir(), 'orkas-local-cli-test', 'work'),
    ORKAS_LOCAL_CLI_NPX_CLI: '/runtime/npx-cli.js',
    ORKAS_NODE: '/runtime/node',
    ORKAS_LOCAL_CLI_ALLOWED_FILE_ROOTS_JSON: JSON.stringify([process.cwd()]),
    ORKAS_LOCAL_CLI_SKIP_AUTH_CHECK: '1',
  };
}

function result(payload: unknown) {
  return { status: 0, stdout: JSON.stringify(payload), stderr: '', error: undefined };
}

describe('official local CLI MCP adapter', () => {
  it.each(['cancel', 'disconnect', 'continue'])('preserves request ownership across pending schema inspection: %s', async (abandon) => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-abort-'));
    const workDir = path.join(runtimeDir, 'work');
    fs.mkdirSync(workDir);
    const schemaStarted = path.join(runtimeDir, 'schema-started');
    const mutation = path.join(runtimeDir, 'mutation');
    const descendantMutation = path.join(runtimeDir, 'descendant-mutation');
    const descendantPid = path.join(runtimeDir, 'descendant-pid');
    const fakeCli = path.join(runtimeDir, 'npx-cli.cjs');
    fs.writeFileSync(fakeCli, [
      "const fs = require('node:fs');",
      "if (process.argv.includes('--schema')) {",
      `  require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify([
        `require('node:fs').writeFileSync(${JSON.stringify(descendantPid)}, String(process.pid));`,
        `require('node:fs').writeFileSync(${JSON.stringify(schemaStarted)}, 'started');`,
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(descendantMutation)}, 'unexpected late effect'), 450);`,
      ].join('\n'))}], { stdio: 'inherit' });`,
      `  setTimeout(() => process.stdout.write(JSON.stringify({ effect: 'write' })), 350);`,
      '} else {',
      `  fs.writeFileSync(${JSON.stringify(mutation)}, 'unexpected mutation');`,
      `  process.stdout.write(JSON.stringify({ ok: true }));`,
      '}',
    ].join('\n'));
    const marker = path.join(runtimeDir, '.orkas-cli-integrity.json');
    fs.writeFileSync(marker, JSON.stringify(adapter.MANIFESTS.wecom));
    const transport = new StdioClientTransport({
      command: testNode,
      args: [path.resolve('bin/local-cli-mcp-server.cjs')],
      env: {
        ...envFor('wecom'),
        ORKAS_NODE: testNode,
        ORKAS_LOCAL_CLI_NPX_CLI: fakeCli,
        ORKAS_LOCAL_CLI_RUNTIME_DIR: runtimeDir,
        ORKAS_LOCAL_CLI_WORK_DIR: workDir,
        ORKAS_LOCAL_CLI_INTEGRITY_MARKER: marker,
      } as Record<string, string>,
      stderr: 'pipe',
    });
    const diagnostics: Buffer[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => diagnostics.push(chunk));
    const client = new Client({ name: 'cancel-regression', version: '1.0.0' });
    const controller = new AbortController();
    try {
      await client.connect(transport);
      const pending = client.callTool({
        name: 'execute_write', arguments: { action: 'todo.task.create', parameters: { title: 'fixture' } },
      }, undefined, { signal: controller.signal }).catch((error) => error);
      // Wait for real child readiness; process startup is not the cancellation deadline.
      await vi.waitFor(() => expect(fs.existsSync(schemaStarted)).toBe(true), { timeout: 5_000 });
      if (abandon === 'cancel') controller.abort();
      else if (abandon === 'disconnect') await client.close();
      const result = await pending;
      if (abandon === 'continue') {
        expect(result).not.toBeInstanceOf(Error);
        expect(result.isError).not.toBe(true);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 550));
      }
      expect(fs.existsSync(mutation)).toBe(abandon === 'continue');
      expect(fs.existsSync(descendantMutation)).toBe(abandon === 'continue');
      await vi.waitFor(() => expect(() => process.kill(Number(fs.readFileSync(descendantPid, 'utf8')), 0)).toThrow());
    } finally {
      await client.close();
      fs.rmSync(runtimeDir, { recursive: true, force: true });
      expect(Buffer.concat(diagnostics).toString('utf8')).toBe('');
    }
  });

  it.each(['stdout', 'stderr', 'nonzero', 'timeout'])('bounds real official CLI failure without exposing output: %s', async (failure) => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-bound-'));
    const fakeCli = path.join(runtimeDir, 'npx-cli.cjs');
    const pidFile = path.join(runtimeDir, 'child.pid');
    fs.writeFileSync(fakeCli, [
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      failure === 'timeout' ? 'setInterval(() => {}, 1000);'
        : failure === 'nonzero' ? "process.stderr.write('private fixture detail'); process.exitCode = 2;"
          : `process.${failure}.write('x'.repeat(2 * 1024 * 1024));`,
    ].join('\n'));
    const env = {
      ...envFor('wecom'), ORKAS_NODE: testNode,
      ORKAS_LOCAL_CLI_NPX_CLI: fakeCli,
      ORKAS_LOCAL_CLI_RUNTIME_DIR: runtimeDir,
      ORKAS_LOCAL_CLI_WORK_DIR: path.join(runtimeDir, 'work'),
    };
    fs.mkdirSync(env.ORKAS_LOCAL_CLI_WORK_DIR);
    if (failure === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = adapter.callTool('describe_action', { action: 'todo.task.create' }, {
      skipPackageIntegrityCheck: true,
    }, env).catch((error) => error);
    try {
      if (failure === 'timeout') {
        await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true));
        await vi.advanceTimersByTimeAsync(33_000);
      }
      const result = await pending;
      expect(result).toMatchObject({ code: 'local_cli_action_failed' });
      if (!(result instanceof Error)) throw new Error('Expected the child failure to reject');
      expect(result.message).toMatch(/^official wecom-cli command failed(?: \(exit \d+\))?$/);
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      vi.useRealTimers();
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    } finally {
      vi.useRealTimers();
      if (fs.existsSync(pidFile)) {
        try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already terminated */ }
      }
      await pending;
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it.each(['complete', 'cancel'])('preserves sequential official CLI access when the next request will %s', async (next) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-serial-'));
    const work = path.join(root, 'work');
    fs.mkdirSync(work);
    const activeFile = path.join(root, 'active');
    const overlapFile = path.join(root, 'overlap');
    const startsFile = path.join(root, 'starts');
    const fakeCli = path.join(root, 'npx-cli.cjs');
    fs.writeFileSync(fakeCli, [
      "const fs = require('node:fs');",
      `if (fs.existsSync(${JSON.stringify(activeFile)})) fs.writeFileSync(${JSON.stringify(overlapFile)}, 'overlap');`,
      `fs.writeFileSync(${JSON.stringify(activeFile)}, String(process.pid));`,
      `fs.appendFileSync(${JSON.stringify(startsFile)}, String(process.pid) + String.fromCharCode(10));`,
      'setTimeout(() => {',
      `  fs.rmSync(${JSON.stringify(activeFile)}, { force: true });`,
      "  process.stdout.write(JSON.stringify({ effect: 'read' }));",
      '}, 350);',
    ].join('\n'));
    const marker = path.join(root, '.orkas-cli-integrity.json');
    fs.writeFileSync(marker, JSON.stringify(adapter.MANIFESTS.wecom));
    const transport = new StdioClientTransport({
      command: testNode, args: [path.resolve('bin/local-cli-mcp-server.cjs')], stderr: 'pipe',
      env: {
        ...envFor('wecom'), ORKAS_NODE: testNode,
        ORKAS_LOCAL_CLI_NPX_CLI: fakeCli, ORKAS_LOCAL_CLI_RUNTIME_DIR: root,
        ORKAS_LOCAL_CLI_WORK_DIR: work, ORKAS_LOCAL_CLI_INTEGRITY_MARKER: marker,
      } as Record<string, string>,
    });
    const diagnostics: Buffer[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => diagnostics.push(chunk));
    const client = new Client({ name: 'sequential-regression', version: '1.0.0' });
    const controller = new AbortController();
    try {
      await client.connect(transport);
      const request = { name: 'describe_action', arguments: { action: 'todo.task.list' } };
      const first = client.callTool(request);
      await vi.waitFor(() => expect(fs.existsSync(activeFile)).toBe(true));
      const second = client.callTool(request, undefined, { signal: controller.signal }).catch((error) => error);
      if (next === 'cancel') {
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.abort();
      }
      const results = await Promise.all([first, second]);
      expect(results[0].isError).not.toBe(true);
      if (next === 'complete') expect(results[1].isError).not.toBe(true);
      expect(fs.existsSync(overlapFile)).toBe(false);
      expect(fs.readFileSync(startsFile, 'utf8').trim().split('\n')).toHaveLength(next === 'cancel' ? 1 : 2);
    } finally {
      await client.close();
      fs.rmSync(root, { recursive: true, force: true });
      expect(Buffer.concat(diagnostics).toString('utf8')).toBe('');
    }
  });

  it('exposes only the six governed tools with separate R/W/H/D host policies', () => {
    expect(adapter.TOOLS.map((item) => item.name)).toEqual([
      'list_capabilities', 'describe_action', 'execute_read', 'execute_write',
      'execute_high_impact', 'execute_destructive',
    ]);
    expect(Object.fromEntries(adapter.TOOLS.map((item) => [
      item.name, item._meta.orkas.actionPolicy.risk,
    ]))).toEqual({
      list_capabilities: 'R',
      describe_action: 'R',
      execute_read: 'R',
      execute_write: 'W',
      execute_high_impact: 'H',
      execute_destructive: 'D',
    });
  });

  it('allows reviewed business domains and blocks raw/admin/developer command surfaces', () => {
    const env = envFor('lark');
    expect(adapter.validateAction('calendar.events.list', env)).toBeTruthy();
    expect(adapter.validateAction('im messages send', env)).toBeTruthy();
    expect(() => adapter.validateAction('api POST /open-apis/im', env)).toThrow(/not allowed|invalid action/);
    expect(() => adapter.validateAction('auth.logout', env)).toThrow(/not allowed/);
    expect(() => adapter.validateAction('config.risk-control.off', env)).toThrow(/not allowed/);
    expect(() => adapter.validateAction('devapp.publish', envFor('dingtalk'))).toThrow(/not allowed/);
    expect(() => adapter.validateAction('calendar --help', env)).toThrow(/invalid action|raw CLI flags/);
  });

  it('uses provider metadata when present and otherwise fails unknown verbs into high-impact', () => {
    expect(adapter.classifyAction('calendar.events.list', { effect: 'read' })).toBe('R');
    expect(adapter.classifyAction('todo.task.create', { effect: 'write' })).toBe('W');
    expect(adapter.classifyAction('todo.task.create', {
      effect: 'write', risk: 'high', confirmation: 'user_required',
    })).toBe('H');
    expect(adapter.classifyAction('drive.permission.delete', { effect: 'write', risk: 'high' })).toBe('D');
    expect(adapter.classifyAction('im.message.send', { effect: 'write', risk: 'medium' })).toBe('H');
    expect(adapter.classifyAction('im.message.send', {})).toBe('H');
    expect(adapter.classifyAction('im.batchSend', { effect: 'write' })).toBe('H');
    expect(adapter.classifyAction('drive.permission.delete', {})).toBe('D');
    expect(adapter.classifyAction('drive.batch_delete', { effect: 'write' })).toBe('D');
    expect(adapter.classifyAction('calendar.events.frobnicate', {})).toBe('H');
    expect(adapter.classifyXeroAction('reports.profit-and-loss')).toBe('R');
    expect(adapter.classifyXeroAction('contacts.update')).toBe('W');
    expect(adapter.classifyXeroAction('invoices.create')).toBe('H');
  });

  it('raises destructive status mutations into the destructive lane, including approved JSON input', () => {
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-xero-input-'));
    const input = path.join(inputDir, 'account.json');
    try {
      fs.writeFileSync(input, JSON.stringify({ accountID: 'a-1', status: 'ARCHIVED' }));
      const env = {
        ...envFor('xero'),
        ORKAS_LOCAL_CLI_ALLOWED_FILE_ROOTS_JSON: JSON.stringify([inputDir]),
      };
      expect(adapter.invocationRisk('W', { status: 'VOIDED' }, env)).toBe('D');
      expect(adapter.invocationRisk('W', { file: input }, env)).toBe('D');
      expect(adapter.invocationRisk('W', { status: 'ACTIVE' }, env)).toBe('W');
    } finally {
      fs.rmSync(inputDir, { recursive: true, force: true });
    }
  });

  it.each([512, 256 * 1024 + 1, 8 * 1024 * 1024])(
    'checks the complete Xero JSON file before dispatch at %i bytes', async (size) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-xero-size-'));
      const input = path.join(root, 'contact.json');
      const env = { ...envFor('xero'), ORKAS_LOCAL_CLI_ALLOWED_FILE_ROOTS_JSON: JSON.stringify([root]) };
      const dispatched: string[] = [];
      const runner = vi.fn((_command, argv: string[]) => {
        if (argv.includes('--help')) return result({});
        dispatched.push(fs.readFileSync(argv[argv.indexOf('--file') + 1], 'utf8'));
        return result({ ok: true });
      });
      const args = { action: 'contacts.update', parameters: { file: input } };
      const document = (status: string) => {
        const prefix = '{"contactID":"00000000-0000-0000-0000-000000000001",';
        const suffix = `"contactStatus":"${status}"}`;
        return prefix + ' '.repeat(size - Buffer.byteLength(prefix + suffix)) + suffix;
      };
      try {
        const active = document('ACTIVE');
        fs.writeFileSync(input, active);
        await expect(adapter.executeAction('W', args, { runner }, env)).resolves.toMatchObject({ risk: 'W' });
        expect(dispatched).toEqual([active]);
        for (const status of ['ARCHIVED', 'DELETED', 'VOIDED']) {
          const destructive = document(status);
          fs.writeFileSync(input, destructive);
          dispatched.length = 0;
          await expect(adapter.executeAction('W', args, { runner }, env))
            .rejects.toThrow(/risk mismatch.*execute_destructive/);
          expect(dispatched).toEqual([]);
          await expect(adapter.executeAction('D', args, { runner }, env)).resolves.toMatchObject({ risk: 'D' });
          expect(dispatched).toEqual([destructive]);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['oversized', 'multibyte overflow', 'malformed', 'invalid UTF-8', 'directory', 'read failure', 'inspection failure'])(
    'rejects unchecked Xero JSON without dispatch and allows a corrected retry: %s', async (failure) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-xero-invalid-'));
      const input = path.join(root, 'private-contact.json');
      const env = { ...envFor('xero'), ORKAS_LOCAL_CLI_ALLOWED_FILE_ROOTS_JSON: JSON.stringify([root]) };
      const dispatched: string[] = [];
      const runner = vi.fn((_command, argv: string[]) => {
        if (argv.includes('--help')) return result({});
        dispatched.push(argv[argv.indexOf('--file') + 1]);
        return result({ ok: true });
      });
      // Even an inline destructive status cannot bypass validation of the file.
      const args = { action: 'contacts.update', parameters: { file: input, status: 'ARCHIVED' } };
      let readFailure: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const payload = failure === 'oversized' ? '{}'.padEnd(8 * 1024 * 1024 + 1)
          : failure === 'multibyte overflow' ? JSON.stringify({ name: '界'.repeat(3 * 1024 * 1024) })
            : failure === 'malformed' ? '{"name":"private fixture detail",'
              : failure === 'invalid UTF-8' ? Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xf0, 0x9f, 0x92]), Buffer.from('"}')])
                : failure === 'inspection failure' ? '['.repeat(20000) + '{}' + ']'.repeat(20000)
                  : '{}';
        if (failure === 'directory') fs.mkdirSync(input);
        else fs.writeFileSync(input, payload);
        if (failure === 'read failure') {
          readFailure = vi.spyOn(fs, 'openSync').mockImplementation(() => {
            throw new Error('private fixture detail');
          });
        }
        const error = await adapter.executeAction('D', args, { runner }, env).catch((caught) => caught);
        expect(dispatched).toEqual([]);
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw new Error('Expected invalid input to reject');
        expect(error.message).toMatch(/Xero input file.*(?:8 MiB|read|JSON|check)/);
        expect(error.message).not.toContain(root);
        expect(error.message).not.toContain('private');
        readFailure?.mockRestore();
        readFailure = undefined;
        if (failure === 'directory') fs.rmdirSync(input);
        fs.writeFileSync(input, '{"contactID":"00000000-0000-0000-0000-000000000001","contactStatus":"ACTIVE"}');
        await expect(adapter.executeAction('W', {
          action: 'contacts.update', parameters: { file: input },
        }, { runner }, env)).resolves.toMatchObject({ risk: 'W' });
        expect(dispatched).toEqual([input]);
      } finally {
        readFailure?.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('preserves non-Xero binary input and the separate inline parameter budget', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-file-'));
    const input = path.join(root, 'document.bin');
    const env = { ...envFor('lark'), ORKAS_LOCAL_CLI_ALLOWED_FILE_ROOTS_JSON: JSON.stringify([root]) };
    try {
      fs.writeFileSync(input, Buffer.alloc(300 * 1024, 0xff));
      const runner = vi.fn((_command: string, argv: string[]) => argv[4] === 'schema'
        ? result({
            name: 'drive.file.upload',
            inputSchema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
            _meta: { risk: 'write' },
          })
        : result({ ok: true }));
      await expect(adapter.executeAction('W', {
        action: 'drive.file.upload', parameters: { file: input },
      }, { runner }, env)).resolves.toMatchObject({ risk: 'W' });
      expect(runner.mock.calls.at(-1)?.[1]).toContain('--file');
      expect(() => adapter.validatedParameters({ name: 'x'.repeat(256 * 1024) }, envFor('xero')))
        .toThrow(/parameters are too large/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['short reads', 'growth', 'interrupted'])(
    'keeps Xero file inspection complete and bounded during %s', async (state) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-xero-read-'));
      const input = path.join(root, 'contact.json');
      const env = { ...envFor('xero'), ORKAS_LOCAL_CLI_ALLOWED_FILE_ROOTS_JSON: JSON.stringify([root]) };
      fs.writeFileSync(input, '{"contactStatus":"ARCHIVED"}'.padEnd(1024));
      const stat = fs.fstatSync.bind(fs);
      const read = fs.readSync.bind(fs);
      let openedFd: number | undefined;
      let readBytes = 0;
      const statFault = vi.spyOn(fs, 'fstatSync').mockImplementation((fd) => {
        openedFd = fd;
        const before = stat(fd);
        if (state === 'growth') fs.appendFileSync(input, ' '.repeat(8 * 1024 * 1024 + 1 - before.size));
        return before;
      });
      const readFault = vi.spyOn(fs, 'readSync').mockImplementation((fd, buffer, options = {}) => {
        if (state === 'interrupted' && readBytes > 0) throw new Error('private read error');
        const length = options.length ?? buffer.byteLength - (options.offset ?? 0);
        const count = read(fd, buffer, { ...options, length: state === 'growth' ? length : Math.min(length, 31) });
        readBytes += count;
        return count;
      });
      const dispatched: string[] = [];
      const runner = vi.fn((_command, argv: string[]) => {
        if (!argv.includes('--help')) dispatched.push('mutation');
        return result({ ok: true });
      });
      try {
        const pending = adapter.executeAction('D', {
          action: 'contacts.update', parameters: { file: input },
        }, { runner }, env);
        if (state === 'short reads') {
          await expect(pending).resolves.toMatchObject({ risk: 'D' });
          expect(dispatched).toEqual(['mutation']);
          expect(readBytes).toBe(1024);
        } else {
          await expect(pending).rejects.toThrow(state === 'growth' ? /exceeds 8 MiB/ : /could not be fully checked/);
          expect(dispatched).toEqual([]);
          expect(readBytes).toBeGreaterThan(0);
        }
        expect(readBytes).toBeLessThanOrEqual(8 * 1024 * 1024 + 1);
        expect(openedFd).toBeDefined();
        expect(() => stat(openedFd!)).toThrow();
      } finally {
        statFault.mockRestore();
        readFault.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('returns Xero file failures through real MCP and recovers without an unintended write', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-xero-mcp-'));
    const work = path.join(root, 'work');
    fs.mkdirSync(work);
    const input = path.join(root, 'contact.json');
    const mutation = path.join(root, 'mutation.json');
    const cli = path.join(root, 'npx-cli.cjs');
    fs.writeFileSync(cli, [
      "const fs = require('node:fs');",
      "if (!process.argv.includes('--help')) {",
      "  const data = fs.readFileSync(process.argv[process.argv.indexOf('--file') + 1]);",
      `  fs.writeFileSync(${JSON.stringify(mutation)}, data);`,
      '}',
      'process.stdout.write(JSON.stringify({ ok: true }));',
    ].join('\n'));
    const marker = path.join(root, '.orkas-cli-integrity.json');
    fs.writeFileSync(marker, JSON.stringify(adapter.MANIFESTS.xero));
    const transport = new StdioClientTransport({
      command: testNode, args: [path.resolve('bin/local-cli-mcp-server.cjs')], stderr: 'pipe',
      env: {
        ...envFor('xero'), ORKAS_NODE: testNode, ORKAS_LOCAL_CLI_NPX_CLI: cli,
        ORKAS_LOCAL_CLI_RUNTIME_DIR: root, ORKAS_LOCAL_CLI_WORK_DIR: work,
        ORKAS_LOCAL_CLI_INTEGRITY_MARKER: marker,
        ORKAS_LOCAL_CLI_ALLOWED_FILE_ROOTS_JSON: JSON.stringify([root]),
      } as Record<string, string>,
    });
    const diagnostics: Buffer[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => diagnostics.push(chunk));
    const client = new Client({ name: 'xero-input-regression', version: '1.0.0' });
    const args = { action: 'contacts.update', parameters: { file: input } };
    try {
      await client.connect(transport);
      for (const invalid of ['{"private fixture detail":', '{}'.padEnd(8 * 1024 * 1024 + 1)]) {
        fs.writeFileSync(input, invalid);
        const response = await client.callTool({ name: 'execute_write', arguments: args });
        expect(response.isError).toBe(true);
        expect(JSON.stringify(response)).toContain('local_cli_action_failed');
        expect(JSON.stringify(response)).not.toContain(root);
        expect(JSON.stringify(response)).not.toContain('private fixture detail');
        expect(fs.existsSync(mutation)).toBe(false);
      }
      const archived = '{"contactID":"00000000-0000-0000-0000-000000000001","contactStatus":"ARCHIVED"}'
        .padEnd(300 * 1024);
      fs.writeFileSync(input, archived);
      const mismatch = await client.callTool({ name: 'execute_write', arguments: args });
      expect(mismatch.isError).toBe(true);
      expect(JSON.stringify(mismatch)).toContain('execute_destructive');
      expect(fs.existsSync(mutation)).toBe(false);
      const accepted = await client.callTool({ name: 'execute_destructive', arguments: args });
      expect(accepted.isError).not.toBe(true);
      expect(fs.readFileSync(mutation, 'utf8')).toBe(archived);
    } finally {
      await client.close();
      fs.rmSync(root, { recursive: true, force: true });
      expect(Buffer.concat(diagnostics).toString('utf8')).toBe('');
    }
  });

  it('rejects altered package integrity and domain policy before invoking a CLI', () => {
    expect(() => adapter.validateAction('calendar.events.list', {
      ...envFor('lark'), ORKAS_LOCAL_CLI_PACKAGE_INTEGRITY: 'sha512-tampered',
    })).toThrow(/integrity mismatch/);
    expect(() => adapter.validateAction('calendar.events.list', {
      ...envFor('lark'), ORKAS_LOCAL_CLI_ALLOWED_DOMAINS_JSON: JSON.stringify(['calendar']),
    })).toThrow(/domain policy mismatch/);
  });

  it('requires an authorization-time package-integrity marker from the connector-owned directory', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-adapter-integrity-'));
    const marker = path.join(runtimeDir, '.orkas-cli-integrity.json');
    const manifest = adapter.MANIFESTS.wecom;
    const env = {
      ...envFor('wecom'),
      ORKAS_LOCAL_CLI_RUNTIME_DIR: runtimeDir,
      ORKAS_LOCAL_CLI_INTEGRITY_MARKER: marker,
    };
    try {
      fs.writeFileSync(marker, JSON.stringify({ package: manifest.package, integrity: manifest.integrity }));
      expect(() => adapter.assertPackageIntegrityMarker(manifest, env)).not.toThrow();
      fs.writeFileSync(marker, JSON.stringify({ package: manifest.package, integrity: 'sha512-tampered' }));
      expect(() => adapter.assertPackageIntegrityMarker(manifest, env)).toThrow(/pin changed/);
      expect(() => adapter.assertPackageIntegrityMarker(manifest, {
        ...env, ORKAS_LOCAL_CLI_INTEGRITY_MARKER: path.join(os.tmpdir(), 'outside-marker'),
      })).toThrow(/unavailable/);
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('rejects credential/local-path plumbing and builds shell-free provider argv', () => {
    expect(() => adapter.validatedParameters({ client_secret: 'x' })).toThrow(/not allowed/);
    expect(() => adapter.validatedParameters({ payload: { authorization: 'Bearer synthetic' } }))
      .toThrow(/credential parameter is not allowed/);
    expect(() => adapter.validatedParameters({ payload: { api_key: 'synthetic' } }))
      .toThrow(/credential parameter is not allowed/);
    expect(() => adapter.validatedParameters({ output_path: '/tmp/leak' })).toThrow(/not allowed/);
    expect(() => adapter.validatedParameters({ file: '/tmp/leak' }, envFor('lark')))
      .toThrow(/outside|does not exist/);
    expect(() => adapter.validatedParameters({ source: '../credential.json' }, envFor('lark'), {
      provider: 'lark', schema: { inputSchema: { properties: { source: { type: 'string', format: 'binary' } } } },
    }))
      .toThrow(/outside|does not exist/);
    const approvedFile = path.join(process.cwd(), 'package.json');
    expect(adapter.validatedParameters({ file: approvedFile }, envFor('lark')))
      .toEqual({ file: approvedFile });
    expect(adapter.validatedParameters({ app_token: 'base-id', title: 'hello;$(safe)' }))
      .toEqual({ app_token: 'base-id', title: 'hello;$(safe)' });
    expect(adapter.redact('{"access_token":"secret","apiKey":"key","name":"safe"}'))
      .toBe('{"access_token":"[redacted]","apiKey":"[redacted]","name":"safe"}');

    expect(adapter.invocationFor(
      'todo.task.create',
      { title: 'hello;$(safe)', executor_ids: ['u1', 'u2'] },
      'W',
      envFor('dingtalk'),
    )).toEqual([
      'todo', 'task', 'create', '--title', 'hello;$(safe)', '--executor-ids', '["u1","u2"]',
      '--format', 'json', '--yes',
    ]);

    expect(adapter.invocationFor(
      'invoices.list', { page: 2 }, 'R', envFor('xero'),
    )).toEqual([
      'invoices', 'list', '--page', '2', '--profile', 'orkas-test-profile', '--json',
    ]);
  });

  it('classifies child authorization failures without exposing provider output or backing paths', async () => {
    const runner = vi.fn().mockReturnValue({
      status: 1,
      stdout: 'synthetic customer content',
      stderr: 'unauthorized private-buyer@example.test /Users/test/private.json',
      error: undefined,
    });
    let failure: Error | undefined;
    try {
      await adapter.executeAction(
        'R', { action: 'invoices.list', parameters: {} }, { runner }, envFor('xero'),
      );
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toBe('official xero account is not authorized; reconnect this connector');
    expect(failure?.message).not.toContain('private-buyer');
    expect(failure?.message).not.toContain('/Users/');
  });

  it('checks official schema before execution and refuses the wrong risk lane', async () => {
    const runner = vi.fn()
      .mockReturnValueOnce(result({ canonical_path: 'todo.task.create', effect: 'write' }))
      .mockReturnValueOnce(result({ ok: true, data: { id: 'task-1' } }));

    expect(await adapter.executeAction(
      'W',
      { action: 'todo.task.create', parameters: { title: 'Review order' } },
      { runner },
      envFor('dingtalk'),
    )).toMatchObject({ action: 'todo.task.create', risk: 'W' });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0][1]).toContain('--cli-path');
    expect(runner.mock.calls[1][1]).toContain('--yes');

    const mismatchRunner = vi.fn().mockReturnValue(result({ effect: 'destructive' }));
    await expect(adapter.executeAction(
      'R',
      { action: 'todo.task.delete', parameters: { task_id: '1' } },
      { runner: mismatchRunner },
      envFor('dingtalk'),
    )).rejects.toThrow(/risk mismatch.*execute_destructive/);
  });

  it('reports static reviewed capabilities without exposing package/admin commands', async () => {
    await expect(adapter.callTool(
      'list_capabilities', {}, { skipPackageIntegrityCheck: true }, envFor('wecom'),
    )).resolves.toMatchObject({
      provider: 'wecom',
      official_cli: 'wecom-cli',
      domains: expect.arrayContaining(['message', 'contact', 'doc', 'sheet']),
      execution_tools: ['execute_read', 'execute_write', 'execute_high_impact', 'execute_destructive'],
    });
  });

  it('progressively discovers official actions only inside a reviewed domain', async () => {
    const larkFixture = require('./fixtures/lark-cli-1.0.93.json').samples.find(
      (entry: { args: string[] }) => entry.args.join(' ') === 'schema im.chat.members',
    );
    const larkRunner = vi.fn().mockReturnValue(larkFixture);
    await expect(adapter.callTool(
      'list_capabilities',
      { path: 'im.chat.members' },
      { runner: larkRunner, skipPackageIntegrityCheck: true },
      envFor('lark'),
    )).resolves.toMatchObject({
      provider: 'lark', path: 'im.chat.members',
      schema: expect.arrayContaining([expect.objectContaining({ name: 'im chat.members get' })]),
    });
    expect(larkRunner.mock.calls[0][1]).toEqual([
      '/runtime/npx-cli.js', '--offline', '-y', '@larksuite/cli@1.0.93', 'schema', 'im.chat.members',
    ]);

    const dingtalkRunner = vi.fn().mockReturnValue(result({ kind: 'schema', tools: [] }));
    await adapter.callTool(
      'list_capabilities',
      { path: 'chat message' },
      { runner: dingtalkRunner, skipPackageIntegrityCheck: true },
      envFor('dingtalk'),
    );
    expect(dingtalkRunner.mock.calls[0][1]).toEqual([
      '/runtime/npx-cli.js', '--offline', '-y', 'dingtalk-workspace-cli@1.0.61',
      'schema', 'chat message', '--compact', '-f', 'json',
    ]);

    const wecomRunner = vi.fn().mockReturnValue(result({ resources: [] }));
    await adapter.callTool(
      'list_capabilities',
      { path: 'message' },
      { runner: wecomRunner, skipPackageIntegrityCheck: true },
      envFor('wecom'),
    );
    expect(wecomRunner.mock.calls[0][1]).toEqual([
      '/runtime/npx-cli.js', '--offline', '-y', '@wecom/cli@1.2.0', 'message', '--schema',
    ]);

    const xeroRunner = vi.fn().mockReturnValue({
      status: 0, stdout: 'USAGE: xero reports profit-and-loss', stderr: '', error: undefined,
    });
    await expect(adapter.callTool(
      'list_capabilities',
      { path: 'reports' },
      { runner: xeroRunner, skipPackageIntegrityCheck: true },
      envFor('xero'),
    )).resolves.toMatchObject({ provider: 'xero', path: 'reports' });
    expect(xeroRunner.mock.calls[0][1]).toEqual([
      '/runtime/npx-cli.js', '--offline', '-y', '@xeroapi/xero-command-line@0.0.7', 'reports', '--help',
    ]);

    const xeroExecute = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: 'List invoices', stderr: '', error: undefined })
      .mockReturnValueOnce(result([{ InvoiceID: 'invoice-1' }]));
    expect(await adapter.executeAction(
      'R', { action: 'invoices.list', parameters: { page: 1 } }, { runner: xeroExecute }, envFor('xero'),
    )).toMatchObject({ action: 'invoices.list', risk: 'R' });
    expect(xeroExecute.mock.calls[0][1]).toEqual([
      '/runtime/npx-cli.js', '--offline', '-y', '@xeroapi/xero-command-line@0.0.7', 'invoices', 'list', '--help',
    ]);
    expect(xeroExecute.mock.calls[1][1]).toEqual([
      '/runtime/npx-cli.js', '--offline', '-y', '@xeroapi/xero-command-line@0.0.7',
      'invoices', 'list', '--page', '1', '--profile', 'orkas-test-profile', '--json',
    ]);

    expect(() => adapter.validateCapabilityPath('auth.status', envFor('lark'))).toThrow(/not allowed/);
    expect(() => adapter.validateCapabilityPath('calendar --help', envFor('lark'))).toThrow(/invalid|raw CLI/);
  });
});
