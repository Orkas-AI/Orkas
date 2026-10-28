import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  LOCAL_AGENT_TYPES,
  createLocalAgentLogCollector,
  ingestLocalAgentLogEvent,
  classifyLiveFailure,
  ensureRequestedAgents,
  installerPlan,
  managedBinaryCandidates,
  parseLiveArgs,
  summarizeLiveFailure,
  validateLiveProtocolTrace,
  createLiveDeliveryTrace, observeLiveDeliveryEvent, scoreLiveDelivery, liveRuntimeOverrides,
  createLiveBridgeTrace, observeLiveBridgeCall,
  waitForLiveCliExit,
} from '../../../../scripts/local-agent-live-support.mjs';

describe('local-agent live test support', () => {
  it('waits for only the dispatched CLI processes before removing their homes, and fails bounded cleanup', async () => {
    vi.useFakeTimers();
    const started = Date.now(); const seen = new Set<number>();
    const exited = (pid: number) => {
      seen.add(pid);
      if (pid === 101 || Date.now() - started >= 100) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    };
    try {
      const pending = waitForLiveCliExit(new Set([101, 102]), { timeoutMs: 200, probe: exited });
      let completed = false; pending.then(() => { completed = true; });
      await vi.advanceTimersByTimeAsync(50); expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(100); await pending;
      expect(completed).toBe(true); expect([...seen].sort()).toEqual([101, 102]);
      const stuck = waitForLiveCliExit(new Set([103]), { timeoutMs: 100, probe: () => {} });
      const rejected = expect(stuck).rejects.toThrow('cleanup did not settle');
      await vi.advanceTimersByTimeAsync(100); await rejected;
    } finally { vi.useRealTimers(); }
  });
  it('retains bounded host execution evidence without tool arguments or results', () => {
    const trace = createLiveBridgeTrace();
    const first = observeLiveBridgeCall(trace, { method: 'chat_history', ok: false, params: { secret: 'PRIVATE_ARGUMENT' }, error: 'PRIVATE_ERROR' });
    const second = observeLiveBridgeCall(trace, { method: 'chat_history', ok: true, params: { action: 'read', before_msg_index: 20 } });
    expect(first).toMatchObject({ type: 'tool-event', phase: 'use', tool: 'chat_history', isError: true });
    expect(second.callId).not.toBe(first.callId);
    expect(trace).toMatchObject({ calls: 2, failures: 1, methods: { chat_history: { ok: 1, failed: 1 } }, overflow: false });
    expect(observeLiveBridgeCall(trace, { method: 'commander.handoff', ok: true, params: {} }).tool).toBe('orkas_handoff_to_commander');
    observeLiveBridgeCall(trace, { method: 'PRIVATE_METHOD', ok: true, params: {} });
    expect(JSON.stringify(trace)).not.toMatch(/PRIVATE|before_msg_index/);
    for (let i = 0; i < 520; i++) observeLiveBridgeCall(trace, { method: `private-${i}`, ok: false, params: {} });
    expect(trace.calls).toBe(512);
    expect(trace.overflow).toBe(true);
    expect(Object.keys(trace.methods)).toHaveLength(3);
  });

  it('defaults to all agents and automatic installation', () => {
    expect(parseLiveArgs([])).toEqual({
      agents: LOCAL_AGENT_TYPES,
      installMissing: true,
      installOnly: false,
      benchmark: false,
      lifecycle: false,
      k: 2,
      noSave: false,
      help: false,
    });
  });

  it('parses a de-duplicated subset and install-only mode', () => {
    expect(parseLiveArgs(['--agents', 'codex,claude,codex', '--install-only'])).toMatchObject({
      agents: ['codex', 'claude'],
      installMissing: true,
      installOnly: true,
    });
    expect(() => parseLiveArgs(['--agents=unknown'])).toThrow(/unknown local agent type/);
  });

  it('requires an explicit no-install lifecycle run and rejects mixed modes', () => {
    expect(parseLiveArgs(['--lifecycle', '--no-install', '--agents=codex'])).toMatchObject({
      lifecycle: true, installMissing: false, agents: ['codex'],
    });
    expect(() => parseLiveArgs(['--lifecycle'])).toThrow(/--no-install/);
    for (const mode of ['--benchmark', '--install-only']) {
      expect(() => parseLiveArgs(['--lifecycle', '--no-install', mode])).toThrow(/cannot be used together/);
    }
    expect(parseLiveArgs(['--lifecycle', '--no-install', '--lifecycle-fault', 'wall'])).toMatchObject({ lifecycleFault: 'wall' });
    expect(() => parseLiveArgs(['--lifecycle-fault', 'wall'])).toThrow(/requires --lifecycle/);
    for (const mode of ['idle', '', 'unknown']) {
      expect(() => parseLiveArgs(['--lifecycle', '--no-install', '--lifecycle-fault', mode])).toThrow(/requires cancel or wall/);
    }
  });

  it('uses a shell-free, test-prefix npm install for npm-backed agents', () => {
    const [step] = installerPlan('codex', {
      platform: 'darwin', installRoot: '/managed', downloadDir: '/download',
    });
    expect(step.command).toBe('npm');
    expect(step.args).toContain('@openai/codex@latest');
    expect(step.args).toEqual(expect.arrayContaining(['--prefix', path.join('/managed', 'npm', 'codex')]));
    expect(step.args.join(' ')).not.toContain('curl');
  });

  it('downloads Hermes before executing the official installer non-interactively', () => {
    const steps = installerPlan('hermes', {
      platform: 'linux', installRoot: '/managed', downloadDir: '/download',
    });
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ command: 'curl' });
    expect(steps[1].command).toBe('bash');
    expect(steps[1].args).toEqual(expect.arrayContaining([
      '--skip-setup', '--skip-browser', '--dir', path.join('/managed', 'hermes'),
    ]));
    expect(steps[1].env).toMatchObject({
      HERMES_HOME: path.join('/managed', 'hermes-home'),
      GIT_CEILING_DIRECTORIES: '/managed',
    });
  });

  it('resolves test-managed executable locations on POSIX and Windows', () => {
    expect(managedBinaryCandidates('opencode', { platform: 'darwin', installRoot: '/m' }))
      .toContain(path.join('/m', 'npm', 'opencode', 'node_modules', '.bin', 'opencode'));
    expect(managedBinaryCandidates('opencode', { platform: 'win32', installRoot: 'C:\\m' }))
      .toContain(path.join(
        'C:\\m', 'npm', 'opencode', 'node_modules',
        'opencode-windows-x64-baseline', 'bin', 'opencode.exe',
      ));
    expect(managedBinaryCandidates('hermes', { platform: 'win32', installRoot: 'C:\\m' })[0])
      .toBe(path.join(
        'C:\\m', 'hermes-home', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe',
      ));
    expect(managedBinaryCandidates('codex', { platform: 'win32', installRoot: 'C:\\m' })[0])
      .toMatch(/codex\.cmd$/);
  });

  it('installs only an unavailable agent and re-detects it', async () => {
    let installed = false;
    const detect = vi.fn(async (type: string) => ({
      type,
      available: type === 'codex' || installed,
      version: type === 'codex' || installed ? '1.0.0' : null,
      error: type === 'claude' && !installed ? 'not_found' : undefined,
    }));
    const install = vi.fn(async () => { installed = true; });
    const result = await ensureRequestedAgents({
      agents: ['codex', 'claude'],
      installMissing: true,
      detect,
      bindCached: vi.fn(async () => false),
      install,
    });
    expect(result.map(entry => entry.type)).toEqual(['codex', 'claude']);
    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith('claude', expect.objectContaining({ error: 'not_found' }));
  });

  it('binds a cached managed CLI before installing again', async () => {
    let bound = false;
    const install = vi.fn();
    const result = await ensureRequestedAgents({
      agents: ['openclaw'],
      installMissing: true,
      detect: vi.fn(async () => ({ type: 'openclaw', available: bound, version: bound ? '2.0.0' : null })),
      bindCached: vi.fn(async () => { bound = true; return true; }),
      install,
    });
    expect(result[0]).toMatchObject({ available: true, version: '2.0.0' });
    expect(install).not.toHaveBeenCalled();
  });

  it('fails clearly when installation is disabled or did not produce a usable CLI', async () => {
    await expect(ensureRequestedAgents({
      agents: ['hermes'],
      installMissing: false,
      detect: async () => ({ available: false, errorDetail: 'not found' }),
      bindCached: async () => false,
      install: vi.fn(),
    })).rejects.toThrow(/hermes is unavailable after preparation: not found/);
  });

  it('separates authentication failures from transport/runtime failures', () => {
    expect(classifyLiveFailure({ status: 'failed', output: '401 OAuth access token expired' })).toBe('authentication');
    expect(classifyLiveFailure({ status: 'timeout', stderrTail: 'no provider available; run hermes auth' })).toBe('authentication');
    expect(classifyLiveFailure({ status: 'missing_cli', error: 'not found' })).toBe('installation');
    expect(classifyLiveFailure({ status: 'failed', error: 'socket closed' })).toBe('runtime');
    expect(summarizeLiveFailure({
      status: 'failed',
      error: 'cli exited with code 1',
      output: 'Failed to authenticate. API Error: 401 OAuth token expired.',
    })).toMatch(/^Failed to authenticate/);
  });

  it('keeps selected native models separate when several CLIs share one live run', () => {
    const env = { EVAL_MODEL: 'fallback', EVAL_CODEX_MODEL: 'native-codex', EVAL_OPENCODE_MODEL: 'opencode/free' };
    expect(liveRuntimeOverrides('codex', env)).toEqual({ modelOverride: 'native-codex', customArgs: ['-c', 'model_provider="openai"'] });
    expect(liveRuntimeOverrides('opencode', env)).toEqual({ modelOverride: 'opencode/free' });
    expect(liveRuntimeOverrides('hermes', env)).toEqual({ modelOverride: 'fallback' });
    expect(liveRuntimeOverrides('hermes', {})).toEqual({});
    expect(liveRuntimeOverrides('codex', {})).toEqual({ customArgs: ['-c', 'model_provider="openai"'] });
  });

  it.each(['codex', 'opencode', 'hermes', 'openclaw'])('requires delivered and persisted outcomes for the real %s binary', type => {
    const trace = createLiveDeliveryTrace();
    for (const event of [{ type: 'process-info' }, { type: 'text-delta', text: 'observable answer' },
      { type: 'done', status: 'completed', sessionId: 'native-session' }]) observeLiveDeliveryEvent(trace, event);
    const result = { status: 'completed', output: 'observable answer' };
    const persisted = { meta: { status: 'completed', output: result.output, sessionId: 'native-session' }, output: result.output };
    expect(scoreLiveDelivery(type, result, trace, persisted).every(check => check.pass)).toBe(true);
    for (const broken of [
      { ...persisted, meta: { ...persisted.meta, status: 'running' } },
      { ...persisted, meta: { ...persisted.meta, output: 'lost answer' } },
      { ...persisted, output: 'duplicated answer' },
      { ...persisted, meta: { ...persisted.meta, sessionId: '' } },
    ]) expect(scoreLiveDelivery(type, result, trace, broken).every(check => check.pass)).toBe(false);
    const missingDelivery = { ...trace, textDeltas: 0 };
    expect(scoreLiveDelivery(type, result, missingDelivery, persisted).every(check => check.pass)).toBe(false);
    // The archive preserves streamed commentary as well as the final reply;
    // metadata alone owns the canonical final answer. Neither may be lost.
    const phaseTrace = createLiveDeliveryTrace();
    for (const event of [{ type: 'process-info' }, { type: 'text-delta', text: 'Working...' },
      { type: 'text-delta', text: result.output }, trace.terminalEvent]) observeLiveDeliveryEvent(phaseTrace, event);
    expect(scoreLiveDelivery(type, result, phaseTrace, { ...persisted, output: 'Working...' + result.output }).every(check => check.pass)).toBe(true);
    expect(scoreLiveDelivery(type, result, phaseTrace, persisted).every(check => check.pass)).toBe(false);
    observeLiveDeliveryEvent(trace, { type: 'tool-event' });
    expect(scoreLiveDelivery(type, result, trace, persisted).every(check => check.pass)).toBe(false);
  });

  it('validates terminal protocol invariants for real CLI smoke traces', () => {
    expect(validateLiveProtocolTrace('codex', { status: 'completed' }, {
      eventTypes: ['process-info', 'status', 'text-delta', 'done'],
      terminalEvent: {
        type: 'done',
        status: 'completed',
        sessionId: 'thread-1',
      },
    })).toEqual([]);

    expect(validateLiveProtocolTrace('claude', { status: 'completed' }, {
      eventTypes: ['process-info', 'done', 'status'],
      terminalEvent: {
        type: 'done',
        status: 'failed',
      },
    })).toEqual([
      'last event=status',
      'terminal/result mismatch=failed/completed',
      'missing resumable session id',
    ]);

    expect(validateLiveProtocolTrace('opencode', { status: 'failed' }, {
      eventTypes: ['done', 'done'],
      terminalEvent: { type: 'done', status: 'failed' },
    })).toEqual([
      'process-info count=0',
      'done count=2',
    ]);
  });
});


describe('local-agent process log evidence', () => {
  it('surfaces native warnings without retaining their private message or dropping split lines', () => {
    const collector = createLocalAgentLogCollector('cli-fixture');
    ingestLocalAgentLogEvent(collector, { type: 'stderr-line', line: JSON.stringify({
      level: 'warn', timestamp: '2030-01-01T00:00:00Z', target: 'cli::transport',
      fields: { message: 'private-customer-marker' },
    }) });
    collector.ingest('stdout', '[00:00:00.000] [info] [(local-agent)] re');
    collector.ingest('stdout', 'covered\n');
    const result = collector.finish();
    expect(result).toMatchObject({ passed: true, capturedLineCount: 2,
      analyzedLineCount: 2, levelCounts: { warn: 1, info: 1 } });
    expect(JSON.stringify(result)).not.toContain('private-customer-marker');
  });

  it.each(['plain private stderr', '[00:00:00.000] [error] [(cli)] private fault'])
    ('rejects unclassified stderr and structured errors (%#)', (line) => {
      const collector = createLocalAgentLogCollector('cli-fixture');
      collector.ingest('stderr', line);
      expect(collector.finish()).toMatchObject({ passed: false, capturedLineCount: 1, analyzedLineCount: 1 });
    });
});


describe('local-agent shared log capture boundary', () => {
  it.each([-1, 0, 1])('bounds a split native log line at 8 MiB (%s)', delta => {
    const logs = createLocalAgentLogCollector('native-cap');
    logs.ingest('stdout', 'x'.repeat(8 * 1024 * 1024 + delta));
    logs.ingest('stdout', '\n');
    const report = logs.finish();
    expect(report).toMatchObject({ passed: delta <= 0, coveragePassed: delta <= 0,
      requiresReview: delta > 0, capturedLineCount: 1, analyzedLineCount: delta <= 0 ? 1 : 0,
      droppedLineCount: delta <= 0 ? 0 : 1 });
    expect(report.findings.some(finding => finding.code === 'log-coverage-gap')).toBe(delta > 0);
  });
});
