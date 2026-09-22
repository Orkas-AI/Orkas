import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Deterministic production bash executor and native shell journeys. The fixture
// supplies the asynchronous permission decision; output files and unchanged
// inputs establish execution, denial, cancellation and retry outcomes.
const UID = 'bash-permission-model-eval';
const captured = vi.hoisted(() => [] as Array<{ level: string; source: string; message: string; args: unknown[] }>);
vi.mock('../../../../src/main/logger', () => ({
  createLogger: (source: string) => Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [
    level, (message: string, ...args: unknown[]) => captured.push({ level, source, message, args }),
  ])),
}));

let consoleWarnings: string[];
let consoleErrors: unknown[][];
let consoleRecords = 0;
let root: string;
let workspace: string;
let sandboxEnv: Record<string, string>;
let oldRoot: string | undefined;
let bp: typeof import('../../../../src/main/model/core-agent/bash-permissions');
let bash: import('../../../../src/core-agent/src/tools/base').AgentTool;
let requests: import('../../../../src/main/model/core-agent/bash-permissions').BashPermissionInfo[];
let pendingDecision: 'allow_once' | 'allow_run' | 'deny';
let stateBeforeDecision: string[];
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;
let expectedMainWarnings: string[];

function commandFor(output: string): string {
  return process.platform === 'win32'
    ? `$target = Join-Path (Get-Location) "${output}"; foreach ($f in (Get-ChildItem -Name "input-*.txt" | Sort-Object)) { Get-Content -LiteralPath "$f" | Add-Content -LiteralPath "$target" }; Add-Content -LiteralPath "runs.txt" -Value once`
    : `target="$(pwd)/${output}"; for f in input-*.txt; do cat "$f" | cat >> "$target"; done; printf 'once\\n' >> runs.txt`;
}
function state(): string {
  return JSON.stringify(['report.txt', 'second.txt', 'runs.txt', 'input-a.txt', 'input-b.txt'].map(name => {
    const file = path.join(workspace, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }));
}
function context() {
  return { workingDir: workspace, state: { sandboxEnv } } as any;
}

beforeEach(async () => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bash-model-'));
  workspace = path.join(root, 'workspace with spaces');
  fs.mkdirSync(workspace);
  oldRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  captured.length = 0;
  expectedMainWarnings = ['bash risk denied', 'bash permission requested'];
  consoleWarnings = [];
  consoleErrors = [];
  consoleRecords = 0;
  consoleSpies = ['debug', 'info', 'log', 'warn', 'error'].map(level => vi.spyOn(console, level as 'log').mockImplementation((...args: unknown[]) => {
    consoleRecords++;
    const source = typeof args[0] === 'string' && /^\[[\w-]+\]$/.test(args[0]) ? args[0].slice(1, -1) : 'console';
    if (level === 'warn') consoleWarnings.push(`${source}:${String(args[1] ?? args[0])}`);
    if (level === 'error') consoleErrors.push(args);
  }));
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  const permissions = await import('../../../../src/main/features/permissions');
  permissions.setLocalExecMode('workspace_approval');
  const ws = await import('../../../../src/main/features/user_workspace');
  expect(ws.setWorkspacePath(UID, workspace).ok).toBe(true);
  fs.writeFileSync(path.join(workspace, 'input-a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(workspace, 'input-b.txt'), 'beta\n');
  bp = await import('../../../../src/main/model/core-agent/bash-permissions');
  bp._resetForTest();
  requests = [];
  stateBeforeDecision = [];
  pendingDecision = 'allow_once';
  bp._setBroadcastForTest((_channel, payload) => {
    const info = payload as typeof requests[number];
    requests.push(info);
    stateBeforeDecision.push(state());
    // A real asynchronous renderer response; the executor must be suspended.
    queueMicrotask(() => bp.respond(info.request_id, pendingDecision));
    return true;
  });
  const { buildSkillSandboxEnv } = await import('../../../../src/main/model/core-agent/client');
  sandboxEnv = { ...buildSkillSandboxEnv(UID, 'model-eval'), ORKAS_OUTPUT_DIR: workspace };
  const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
  bash = createLocalTools({ userId: UID, cid: 'permission-journey', agentId: 'model-eval' }).find(tool => tool.name === 'bash')!;
});

afterEach(() => {
  bp?._setBroadcastForTest(null);
  bp?._resetForTest();
  consoleSpies.forEach(spy => spy.mockRestore());
  if (oldRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = oldRoot;
  fs.rmSync(root, { recursive: true, force: true });
  console.info('[bash-permission-log-analysis]', JSON.stringify({
    console_records: consoleRecords, runtime_records: captured.length,
    warnings: consoleWarnings.length + captured.filter(row => row.level === 'warn').length,
    errors: consoleErrors.length + captured.filter(row => row.level === 'error').length,
  }));
  expect(consoleErrors, 'unexpected console error').toEqual([]);
  expect(captured.filter(row => row.level === 'error'), 'unexpected runtime error').toEqual([]);
  expect(consoleWarnings.every(message => message === 'agent-runner:Tool returned error'), 'unexpected core runtime warning').toBe(true);
  expect(captured.filter(row => row.level === 'warn').every(row =>
    expectedMainWarnings.includes(row.message)
  ), 'unexpected main-process warning').toBe(true);
});

function assertOutput(name = 'report.txt') {
  expect(fs.readFileSync(path.join(workspace, name), 'utf8').replace(/\r\n/g, '\n')).toBe('alpha\nbeta\n');
  expect(fs.readFileSync(path.join(workspace, 'runs.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('once\n');
  expect(fs.readFileSync(path.join(workspace, 'input-a.txt'), 'utf8')).toBe('alpha\n');
  expect(fs.readFileSync(path.join(workspace, 'input-b.txt'), 'utf8')).toBe('beta\n');
}

describe('bash permission journey — deterministic native execution', () => {
  it.runIf(process.platform !== 'win32').each(['workspace_approval', 'all_files_approval'] as const)(
    'runs verification and empty-directory cleanup together in %s', async (mode) => {
      const permissions = await import('../../../../src/main/features/permissions');
      permissions.setLocalExecMode(mode);
      pendingDecision = 'deny';
      // A02 shape: temporary setup, verification from a subdirectory, cleanup.
      const result = await bash.execute({ command: 'set -e\nmkdir -p backend/app/frontend\ncd backend\ntest -d app/frontend\ncd ..\nrmdir backend/app/frontend\nprintf verified' }, context());
      expect(result.isError, result.content).toBeFalsy();
      expect(result.observations?.execution).toMatchObject({ status: 'succeeded', exitCode: 0 });
      expect(result.content).toContain('verified');
      expect(requests).toHaveLength(0);
      expect(fs.existsSync(path.join(workspace, 'backend/app/frontend'))).toBe(false);
      expect(fs.statSync(path.join(workspace, 'backend/app')).isDirectory()).toBe(true);
    },
  );

  it.runIf(process.platform !== 'win32').each([
    ['bash', 'workspace_approval'], ['bash', 'all_files_approval'],
    ['process_session', 'workspace_approval'], ['process_session', 'all_files_approval'],
  ] as const)('cleans ordinary entries with redirection through %s in %s', async (name, mode) => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode(mode);
    const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
    const tool = createLocalTools({ userId: UID, cid: 'permission-journey', agentId: 'model-eval' })
      .find(candidate => candidate.name === name)!;
    pendingDecision = 'deny';
    for (const command of [
      'rmdir empty 2>/dev/null || true; printf verified',
      'rmdir empty 2>cleanup.log; cat < input-a.txt > report.txt',
      'cat < /dev/null > report.txt; rmdir empty; printf verified >> report.txt',
      'rm disposable.txt 2>&1; rmdir empty < input-a.txt; printf verified',
    ]) {
      fs.mkdirSync(path.join(workspace, 'empty'));
      fs.writeFileSync(path.join(workspace, 'disposable.txt'), 'temporary');
      let result = await tool.execute({ action: 'start', command }, context());
      expect(result.isError, result.content).toBeFalsy();
      if (name === 'process_session') {
        let payload = JSON.parse(result.content);
        const sessionId = payload.session_id;
        try {
          await vi.waitFor(async () => {
            if (payload.status === 'running') {
              result = await tool.execute({ action: 'read', session_id: sessionId, cursor: payload.next_cursor }, context());
              payload = JSON.parse(result.content);
            }
            expect(payload.status).toBe('exited');
          }, { timeout: 5_000, interval: 50 });
        } finally {
          if (payload.status === 'running') await tool.execute({ action: 'stop', session_id: sessionId }, context());
        }
      }
      expect(result.observations?.execution).toMatchObject({ status: 'succeeded', exitCode: 0 });
      expect(requests).toHaveLength(0);
      expect(fs.existsSync(path.join(workspace, 'empty'))).toBe(false);
      expect(fs.readFileSync(path.join(workspace, 'input-a.txt'), 'utf8')).toBe('alpha\n');
      if (command.includes('cleanup.log')) {
        expect(fs.readFileSync(path.join(workspace, 'cleanup.log'), 'utf8')).toBe('');
        expect(fs.readFileSync(path.join(workspace, 'report.txt'), 'utf8')).toBe('alpha\n');
      }
      if (command.startsWith('cat')) expect(fs.readFileSync(path.join(workspace, 'report.txt'), 'utf8')).toBe('verified');
      if (command.startsWith('rm ')) expect(fs.existsSync(path.join(workspace, 'disposable.txt'))).toBe(false);
    }
  });

  it.runIf(process.platform !== 'win32').each(['bash', 'process_session'])(
    'checks redirection independently before any cleanup through %s', async name => {
      expectedMainWarnings.push('bash filesystem mutation scope reject', 'bash filesystem read scope reject', 'interactive_cli_start risk denied');
      const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
      const tool = createLocalTools({ userId: UID, cid: 'permission-journey', agentId: 'model-eval' })
        .find(candidate => candidate.name === name)!;
      const outside = path.join(root, 'outside.txt');
      fs.writeFileSync(outside, 'outside stays intact');
      fs.mkdirSync(path.join(workspace, 'empty'));
      fs.symlinkSync(outside, path.join(workspace, 'outside-link'));
      pendingDecision = 'deny';
      for (const [command, error] of [
        [`rmdir empty > '${outside}'`, 'E_BASH_PATH_OUT_OF_SCOPE'],
        [`rmdir empty; cat < '${outside}'`, 'E_BASH_READ_PATH_OUT_OF_SCOPE'],
        ['printf overwritten > outside-link; rmdir empty', 'E_BASH_PATH_OUT_OF_SCOPE'],
        ['rmdir empty > /dev/null-backup', 'E_BASH_PATH_OUT_OF_SCOPE'],
        ['rmdir empty > "$UNKNOWN_REDIRECT"', 'E_BASH_RISK_DENIED'],
        ['rm -r empty 2>/dev/null', 'E_BASH_RISK_DENIED'],
      ]) {
        const result = await tool.execute({ action: 'start', command }, context());
        expect(result.isError, command).toBe(true);
        expect(result.content).toContain(error);
        expect(fs.statSync(path.join(workspace, 'empty')).isDirectory()).toBe(true);
        expect(fs.readFileSync(outside, 'utf8')).toBe('outside stays intact');
      }
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ unresolved_paths: true, can_allow_run: false });
      expect(requests[1].reasons).toContain('destructive');
    },
  );

  it('never exempts raw-device writes just because ordinary cleanup is also present', async () => {
    const { bashDestructiveRiskIsOnlyProducedFileDeletion } = await import('../../../../src/main/model/core-agent/local-tools');
    // No device is opened. This guards the exemption even in all-files mode,
    // independently of the filesystem scope gate that may reject it earlier.
    for (const command of ['rmdir empty > /dev/disk99', 'printf data > /dev/sda; rmdir empty']) {
      expect(bashDestructiveRiskIsOnlyProducedFileDeletion(command, workspace, {}, () => true, 'darwin')).toBe(false);
    }
  });

  it.runIf(process.platform !== 'win32')('lets the OS reject nonempty cleanup without losing contents', async () => {
    const dir = path.join(workspace, 'nonempty');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
    pendingDecision = 'deny';
    const result = await bash.execute({ command: 'rmdir nonempty' }, context());
    expect(requests).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.observations?.execution?.status).toBe('failed');
    expect(result.observations?.execution?.exitCode).toBeGreaterThan(0);
    expect(result.content).toMatch(/not empty/i);
    expect(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it.runIf(process.platform !== 'win32')('keeps parent, recursive and unresolved cleanup behind existing gates', async () => {
    fs.mkdirSync(path.join(workspace, 'parent/empty'), { recursive: true });
    pendingDecision = 'deny';
    for (const command of ['rmdir -p parent/empty', 'rm -r parent', 'rmdir "$UNKNOWN_CLEANUP_DIR"']) {
      const result = await bash.execute({ command }, context());
      expect(result.isError, command).toBe(true);
      expect(result.content).toContain('E_BASH_RISK_DENIED');
      expect(fs.statSync(path.join(workspace, 'parent/empty')).isDirectory()).toBe(true);
    }
    expect(requests).toHaveLength(3);
  });

  it.runIf(process.platform !== 'win32')('removes explicitly named empty directories without treating names as options', async () => {
    pendingDecision = 'deny';
    fs.mkdirSync(path.join(workspace, '-p'));
    fs.mkdirSync(path.join(workspace, '目录 with spaces'));
    fs.mkdirSync(path.join(workspace, 'parent/keep'), { recursive: true });
    const result = await bash.execute({ command: "rmdir -- '-p' '目录 with spaces'" }, context());
    expect(result.observations?.execution).toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(result.observations?.execution?.stderr.bytes).toBe(0);
    expect(requests).toHaveLength(0);
    expect(fs.existsSync(path.join(workspace, '-p'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '目录 with spaces'))).toBe(false);
    expect(fs.statSync(path.join(workspace, 'parent/keep')).isDirectory()).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('waits for outside-directory approval, preserves cancellation, and executes a fresh approved retry once', async () => {
    expectedMainWarnings.push('bash out-of-workspace removal denied');
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const outside = path.join(root, 'outside-empty');
    const marker = path.join(workspace, 'cleanup-count.txt');
    fs.mkdirSync(outside);
    bp._setBroadcastForTest((channel, payload) => {
      if (channel === 'bash:permission') requests.push(payload as typeof requests[number]);
      return true;
    });
    const command = `rmdir '${outside}' && printf once >> cleanup-count.txt`;
    const cancelled = bash.execute({ command }, context());
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(fs.statSync(outside).isDirectory()).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    bp.cancelForCid('permission-journey');
    expect((await cancelled).content).toContain('E_BASH_RISK_DENIED');
    expect(fs.statSync(outside).isDirectory()).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    const approved = bash.execute({ command }, context());
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    bp.respond(requests[0].request_id, 'allow_once');
    expect(fs.statSync(outside).isDirectory()).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    bp.respond(requests[1].request_id, 'allow_once');
    const result = await approved;
    expect(result.observations?.execution).toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.readFileSync(marker, 'utf8')).toBe('once');
    expect(requests).toHaveLength(2);
  });

  it.runIf(process.platform !== 'win32')('does not use an uncertain directory or stale PWD to authorize cleanup', async () => {
    expectedMainWarnings.push('bash filesystem mutation scope reject');
    const outside = path.join(root, 'outside-empty');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(workspace, 'local/empty'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'empty'));
    fs.symlinkSync(root, path.join(workspace, 'external-link'));
    pendingDecision = 'deny';
    for (const command of [
      `cd "$UNKNOWN_DIRECTORY"; rmdir '${outside}'`,
      'set -e; cd local; rmdir "$PWD/empty"',
      'rmdir external-link/outside-empty',
    ]) {
      const result = await bash.execute({ command }, context());
      expect(result.isError, command).toBe(true);
      expect(result.content).toMatch(/E_BASH_(PATH_OUT_OF_SCOPE|RISK_DENIED)/);
      expect(fs.statSync(outside).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(workspace, 'empty')).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(workspace, 'local/empty')).isDirectory()).toBe(true);
    }
    // Only the unresolved PWD needs an approval; the known outside paths must
    // remain scope denials that approval cannot override.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ unresolved_paths: true, can_allow_run: false });
  });

  it.runIf(process.platform !== 'win32')('checks removal relative to the changed directory and retains a failed-cd alternative', async () => {
    expectedMainWarnings.push('bash out-of-workspace removal denied');
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(outside, 'empty'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'empty'));
    pendingDecision = 'deny';
    for (const command of [
      `cd '${outside}' && rmdir empty`,
      `cd '${path.join(workspace, 'missing')}' ; rmdir empty`,
      `set -e; cd '${path.join(workspace, 'missing')}' && printf skipped; rmdir empty`,
      `set -e; set +e -u; cd '${path.join(workspace, 'missing')}'; rmdir empty`,
    ]) {
      // The second cd fails; its caller is outside, so cleanup must not be
      // authorized merely because the requested directory was inside.
      const ctx = command.includes('missing') ? { ...context(), workingDir: outside } : context();
      const result = await bash.execute({ command }, ctx);
      expect(result.content).toContain('E_BASH_RISK_DENIED');
      expect(fs.statSync(path.join(outside, 'empty')).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(workspace, 'empty')).isDirectory()).toBe(true);
    }
    expect(requests).toHaveLength(4);
  });

  it('keeps Windows move removal distinct from an earlier write to the same path', async () => {
    expectedMainWarnings.push('bash out-of-workspace removal denied');
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'keep');
    const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
    const tool = createLocalTools({ userId: UID, hostPlatform: 'win32' }).find(t => t.name === 'bash')!;
    pendingDecision = 'deny';
    const result = await tool.execute({ command: `Set-Content -LiteralPath '${outside}' -Value changed; mi -LiteralPath '${outside}' -Destination moved` }, context());
    expect(result.content).toContain('E_BASH_RISK_DENIED');
    expect(requests).toHaveLength(1);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(workspace, 'moved'))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('checks move destinations and traversal before touching local sources', async () => {
    expectedMainWarnings.push('bash filesystem mutation scope reject');
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'keep.txt'), 'keep');
    fs.symlinkSync(shared, path.join(workspace, 'link'));
    pendingDecision = 'deny';
    for (const command of ['mv input-a.txt link/', 'mv link/keep.txt moved', 'mv link/ moved']) {
      const result = await bash.execute({ command }, context());
      expect(result.content).toContain('E_BASH_PATH_OUT_OF_SCOPE');
      expect(fs.readFileSync(path.join(shared, 'keep.txt'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(workspace, 'input-a.txt'), 'utf8')).toBe('alpha\n');
      expect(fs.lstatSync(path.join(workspace, 'link')).isSymbolicLink()).toBe(true);
    }
  });

  it.runIf(process.platform !== 'win32')('moves local links as entries while preserving outside targets', async () => {
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'keep.txt'), 'unchanged');
    pendingDecision = 'deny';
    for (const [name, target] of [['dir', shared], ['file', path.join(shared, 'keep.txt')], ['broken', path.join(shared, 'missing')]]) {
      fs.symlinkSync(target, path.join(workspace, name));
      const result = await bash.execute({ command: `mv ${name} moved-${name}` }, context());
      expect(result.isError, result.content).toBeFalsy();
      expect(fs.readlinkSync(path.join(workspace, `moved-${name}`))).toBe(target);
      expect(() => fs.lstatSync(path.join(workspace, name))).toThrow();
    }
    expect(requests).toHaveLength(0);
    expect(fs.readFileSync(path.join(shared, 'keep.txt'), 'utf8')).toBe('unchanged');
  });

  it.runIf(process.platform !== 'win32')('requires approval to move an outside link even when its target is inside', async () => {
    expectedMainWarnings.push('bash out-of-workspace removal denied');
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const outside = path.join(root, 'outside-link');
    fs.symlinkSync(path.join(workspace, 'input-a.txt'), outside);
    pendingDecision = 'deny';
    const result = await bash.execute({ command: `mv '${outside}' moved` }, context());
    expect(result.content).toContain('E_BASH_RISK_DENIED');
    expect(requests).toHaveLength(1);
    expect(fs.lstatSync(outside).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'moved'))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, 'input-a.txt'), 'utf8')).toBe('alpha\n');
  });

  it.runIf(process.platform !== 'win32')('does not let an earlier write hide later outside removal in a compound command', async () => {
    expectedMainWarnings.push('bash out-of-workspace removal denied');
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'keep');
    pendingDecision = 'deny';
    const result = await bash.execute({ command: `touch '${outside}'; mv '${outside}' moved` }, context());
    expect(result.content).toContain('E_BASH_RISK_DENIED');
    expect(requests).toHaveLength(1);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(workspace, 'moved'))).toBe(false);
  });

  it.each(['ri', 'rd', 'rmdir', 'del', 'erase', 'rm'])(
    'applies workspace scope to the Windows deletion alias %s before execution', async (alias) => {
      expectedMainWarnings.push('bash filesystem mutation scope reject');
      const outside = path.join(root, 'outside-dir');
      fs.mkdirSync(outside);
      const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
      const tool = createLocalTools({ userId: UID, hostPlatform: 'win32' }).find(t => t.name === 'bash')!;
      pendingDecision = 'deny';
      const result = await tool.execute({ command: `${alias} -LiteralPath '${outside}' -Force` }, context());
      expect(result.content).toContain('E_BASH_PATH_OUT_OF_SCOPE');
      expect(requests).toHaveLength(0);
      expect(fs.statSync(outside).isDirectory()).toBe(true);
    },
  );

  it.each(['mi', 'move', 'mv'])(
    'checks both sides of the Windows move alias %s', async (alias) => {
      expectedMainWarnings.push('bash filesystem mutation scope reject');
      const outside = path.join(root, 'outside.txt');
      fs.writeFileSync(outside, 'keep');
      const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
      const tool = createLocalTools({ userId: UID, hostPlatform: 'win32' }).find(t => t.name === 'bash')!;
      for (const command of [
        `${alias} -LiteralPath '${outside}' -Destination moved`,
        `${alias} -LiteralPath input-a.txt -Destination '${outside}'`,
      ]) {
        const result = await tool.execute({ command }, context());
        expect(result.content).toContain('E_BASH_PATH_OUT_OF_SCOPE');
        expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
        expect(fs.readFileSync(path.join(workspace, 'input-a.txt'), 'utf8')).toBe('alpha\n');
      }
      expect(requests).toHaveLength(0);
    },
  );

  it.each(['cpi', 'copy', 'cp'])(
    'checks the read scope of the Windows copy alias %s', async (alias) => {
      expectedMainWarnings.push('bash filesystem read scope reject');
      const outside = path.join(root, 'outside.txt');
      fs.writeFileSync(outside, 'keep');
      const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
      const tool = createLocalTools({ userId: UID, hostPlatform: 'win32' }).find(t => t.name === 'bash')!;
      const result = await tool.execute({ command: `${alias} -LiteralPath '${outside}' -Destination copied` }, context());
      expect(result.content).toContain('E_BASH_READ_PATH_OUT_OF_SCOPE');
      expect(fs.existsSync(path.join(workspace, 'copied'))).toBe(false);
      expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
    },
  );

  it.runIf(process.platform !== 'win32').each(['workspace_approval', 'all_files_approval'] as const)(
    'removes only local links in %s while preserving their shared targets', async (mode) => {
      const permissions = await import('../../../../src/main/features/permissions');
      permissions.setLocalExecMode(mode);
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.writeFileSync(path.join(shared, 'keep.txt'), 'unchanged');
      pendingDecision = 'deny';
      for (const [name, target, command] of [
        ['node_modules', shared, 'rm node_modules\ngit status --short --branch'],
        ['file-link', path.join(shared, 'keep.txt'), 'unlink file-link'],
        ['broken-link', path.join(shared, 'missing'), 'rm -f broken-link'],
      ]) {
        fs.symlinkSync(target, path.join(workspace, name));
        // Preserve the historical compound command without depending on Git
        // discovery of the temporary workspace's parent directories.
        const actual = command.replace('git status --short --branch', 'printf done');
        const result = await bash.execute({ command: actual }, context());
        expect(result.isError, result.content).toBeFalsy();
        expect(result.observations?.execution?.stderr.bytes).toBe(0);
        expect(requests).toHaveLength(0);
        expect(() => fs.lstatSync(path.join(workspace, name))).toThrow();
        expect(fs.readFileSync(path.join(shared, 'keep.txt'), 'utf8')).toBe('unchanged');
      }
    },
  );

  it.runIf(process.platform !== 'win32')('keeps removal of outside links subject to approval, including dangling links', async () => {
    expectedMainWarnings.push('bash out-of-workspace removal denied');
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    pendingDecision = 'deny';
    for (const target of ['input-a.txt', 'missing.txt']) {
      const link = path.join(root, `outside-${target}`);
      fs.symlinkSync(path.join(workspace, target), link);
      const result = await bash.execute({ command: `rm '${link}'` }, context());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('E_BASH_RISK_DENIED');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    }
    expect(requests).toHaveLength(2);
    expect(fs.readFileSync(path.join(workspace, 'input-a.txt'), 'utf8')).toBe('alpha\n');
  });

  it.runIf(process.platform !== 'win32')('keeps traversal, content writes and recursive removal guarded around a local link', async () => {
    expectedMainWarnings.push('bash filesystem mutation scope reject');
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'keep.txt'), 'unchanged');
    const link = path.join(workspace, 'node_modules');
    fs.symlinkSync(shared, link);
    pendingDecision = 'deny';
    for (const command of [
      'rm node_modules/keep.txt',
      'rm node_modules/*',
      'rm -rf node_modules',
      'rm node_modules/',
      'rm node_modules/../shared/keep.txt',
      'rm node_modules; printf changed > node_modules',
    ]) {
      const result = await bash.execute({ command }, context());
      expect(result.isError, command).toBe(true);
      expect(result.content).toMatch(/E_BASH_(PATH_OUT_OF_SCOPE|RISK_DENIED)/);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(shared, 'keep.txt'), 'utf8')).toBe('unchanged');
    }
  });

  it.each(process.platform === 'win32' ? ['file'] : ['inline', 'heredoc', 'file'])(
    'writes a test through %s and executes its isolated in-memory SQLite verification without approval', async (entry) => {
      const generated = [
        'import sqlite3',
        'from pathlib import Path',
        'db = sqlite3.connect(":memory:")',
        'db.execute("CREATE TABLE dogs (id integer)")',
        'Path("executed.txt").write_text("once")',
      ].join('\n');
      // Keep the fixture's exact-byte assertion independent of Windows newline translation.
      const writer = `from pathlib import Path\ncode = '''${generated}'''\nPath('generated_test.py').write_text(code, newline='\\n')`;
      fs.writeFileSync(path.join(workspace, 'writer.py'), writer);
      const command = entry === 'file' ? 'python writer.py'
        : entry === 'heredoc' ? `python - <<'PY'\n${writer}\nPY`
          : `python -c '${writer.replace(/'/g, `'"'"'`)}'`;
      pendingDecision = 'deny';
      const written = await bash.execute({ command }, context());
      expect(written.isError, written.content).toBeFalsy();
      expect(written.observations?.execution?.stderr.bytes).toBe(0);
      expect(requests).toHaveLength(0);
      expect(fs.readFileSync(path.join(workspace, 'generated_test.py'), 'utf8')).toBe(generated);
      expect(fs.existsSync(path.join(workspace, 'executed.txt'))).toBe(false);

      const executed = await bash.execute({ command: 'python generated_test.py' }, context());
      expect(executed.isError, executed.content).toBeFalsy();
      expect(executed.observations?.execution?.stderr.bytes).toBe(0);
      expect(requests).toHaveLength(0);
      expect(fs.readFileSync(path.join(workspace, 'executed.txt'), 'utf8')).toBe('once');
    },
  );

  it('denies an outside SQLite write, then executes it once after explicit approval', async () => {
    const permissions = await import('../../../../src/main/features/permissions');
    permissions.setLocalExecMode('all_files_approval');
    const database = path.join(root, 'outside.db');
    fs.writeFileSync(path.join(workspace, 'outside.py'), [
      'import sqlite3',
      `db = sqlite3.connect(${JSON.stringify(database)})`,
      'db.execute("CREATE TABLE dogs (id integer)")',
      'db.execute("INSERT INTO dogs VALUES (42)")',
      'db.commit()',
      'print(db.execute("SELECT id FROM dogs").fetchall())',
    ].join('\n'));
    pendingDecision = 'deny';
    const denied = await bash.execute({ command: 'python outside.py' }, context());
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('E_BASH_RISK_DENIED');
    expect(requests).toHaveLength(1);
    expect(requests[0].reasons).toEqual(['external_mutation']);
    expect(fs.existsSync(database)).toBe(false);
    pendingDecision = 'allow_once';
    const approved = await bash.execute({ command: 'python outside.py' }, context());
    expect(approved.isError, approved.content).toBeFalsy();
    expect(approved.observations?.execution?.stderr.bytes).toBe(0);
    expect(approved.content).toContain('[(42,)]');
    expect(requests).toHaveLength(2);
    expect(fs.existsSync(database)).toBe(true);
  });

  it('provides the Python and Node executables promised by the production tool', async () => {
    const result = await bash.execute({ command: 'python --version; node --version' }, context());
    expect(result.isError, result.content).toBeFalsy();
    expect(result.observations?.execution?.stderr.bytes).toBe(0);
    expect(result.content).toContain('Python ');
    expect(result.content).toMatch(/v\d+\.\d+\.\d+/);
    expect(requests).toHaveLength(0);
  });

  it.each(['missing output', 'duplicate execution', 'changed source'])(
    'rejects the plausible false-success outcome: %s', (fault) => {
      fs.writeFileSync(path.join(workspace, 'report.txt'), 'alpha\nbeta\n');
      fs.writeFileSync(path.join(workspace, 'runs.txt'), 'once\n');
      if (fault === 'missing output') fs.unlinkSync(path.join(workspace, 'report.txt'));
      if (fault === 'duplicate execution') fs.appendFileSync(path.join(workspace, 'runs.txt'), 'once\n');
      if (fault === 'changed source') fs.writeFileSync(path.join(workspace, 'input-a.txt'), 'changed');
      expect(() => assertOutput()).toThrow();
    },
  );

  it('does not widen a stale task grant: first execution succeeds, next denied execution changes nothing, then recovery works', async () => {
    const initial = state();
    pendingDecision = 'allow_run';
    const first = await bash.execute({ command: commandFor('report.txt') }, context());
    expect(first.isError).toBeFalsy();
    assertOutput();
    expect(stateBeforeDecision).toEqual([initial]);
    expect(requests[0]).toMatchObject({ unresolved_paths: true, can_allow_run: false });
    const approvedState = state();
    pendingDecision = 'deny';
    const second = await bash.execute({ command: commandFor('second.txt') }, context());
    expect(second.isError).toBe(true);
    expect(second.content).toContain('E_BASH_RISK_DENIED');
    expect(requests).toHaveLength(2);
    expect(stateBeforeDecision[1]).toBe(approvedState);
    expect(state()).toBe(approvedState);
    pendingDecision = 'allow_once';
    const recovery = await bash.execute({ command: commandFor('second.txt') }, context());
    expect(recovery.isError).toBeFalsy();
    expect(requests).toHaveLength(3);
    expect(fs.readFileSync(path.join(workspace, 'second.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('alpha\nbeta\n');
    expect(fs.readFileSync(path.join(workspace, 'runs.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('once\nonce\n');
  });

  it('cancellation invalidates the pending response and a later explicit retry needs a fresh approval', async () => {
    const initial = state();
    bp._setBroadcastForTest((channel, payload) => { if (channel === 'bash:permission') requests.push(payload as typeof requests[number]); return true; });
    const executing = bash.execute({ command: commandFor('report.txt') }, context());
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(state()).toBe(initial);
    bp.cancelForCid('permission-journey');
    const result = await executing;
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_BASH_RISK_DENIED');
    expect(bp.respond(requests[0].request_id, 'allow_once')).toBe(false);
    expect(state()).toBe(initial);
    const retried = bash.execute({ command: commandFor('report.txt') }, context());
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(state()).toBe(initial);
    bp.respond(requests[1].request_id, 'allow_once');
    expect((await retried).isError).toBeFalsy();
    assertOutput();
  });
});
