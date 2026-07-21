import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  LOCAL_AGENT_TYPES,
  classifyLiveFailure,
  ensureRequestedAgents,
  installerPlan,
  managedBinaryCandidates,
  parseLiveArgs,
  summarizeLiveFailure,
} from '../../../../scripts/local-agent-live-support.mjs';

describe('local-agent live test support', () => {
  it('defaults to all agents and automatic installation', () => {
    expect(parseLiveArgs([])).toEqual({
      agents: LOCAL_AGENT_TYPES,
      installMissing: true,
      installOnly: false,
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
  });

  it('resolves test-managed executable locations on POSIX and Windows', () => {
    expect(managedBinaryCandidates('opencode', { platform: 'darwin', installRoot: '/m' }))
      .toContain(path.join('/m', 'npm', 'opencode', 'node_modules', '.bin', 'opencode'));
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
});
