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
    ['bash risk denied', 'bash permission requested'].includes(row.message)
  ), 'unexpected main-process warning').toBe(true);
});

function assertOutput(name = 'report.txt') {
  expect(fs.readFileSync(path.join(workspace, name), 'utf8').replace(/\r\n/g, '\n')).toBe('alpha\nbeta\n');
  expect(fs.readFileSync(path.join(workspace, 'runs.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('once\n');
  expect(fs.readFileSync(path.join(workspace, 'input-a.txt'), 'utf8')).toBe('alpha\n');
  expect(fs.readFileSync(path.join(workspace, 'input-b.txt'), 'utf8')).toBe('beta\n');
}

describe('bash permission journey — deterministic native execution', () => {
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

