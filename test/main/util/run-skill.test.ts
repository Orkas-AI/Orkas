import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
const itOnNonWindows = process.platform === 'win32' ? it.skip : it;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-run-skill-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeMarketplaceSkill(dirId: string, displayName: string, scriptBase: string): void {
  const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', dirId);
  const scriptsDir = path.join(skillDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${displayName}\ndescription: test\n---\n\nbody\n`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, `${scriptBase}.sh`),
    'printf \'{"ok":true,"argv":"%s"}\\n\' "$*"\n',
  );
}

function writeAgentMarketplaceSkill(agentId: string, dirId: string, displayName: string, scriptBase: string): void {
  const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'agents', agentId, 'skills', dirId);
  const scriptsDir = path.join(skillDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${displayName}\ndescription: agent private test\n---\n\nbody\n`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, `${scriptBase}.sh`),
    'printf \'{"ok":true,"agent":"%s","argv":"%s"}\\n\' "$ORKAS_AGENT_ID" "$*"\n',
  );
}

function runSkill(skillRef: string, scriptBase: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const pcRoot = process.cwd();
  return spawnSync(process.execPath, [
    path.join(pcRoot, 'bin', 'run-skill.cjs'),
    skillRef,
    scriptBase,
    '--',
    ...args,
  ], {
    cwd: pcRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      ORKAS_WORKSPACE_ROOT: tmpDir,
      ORKAS_PC_DIR: pcRoot,
    },
  });
}

describe('run-skill.cjs', () => {
  it('checks PATH when locating Git Bash for Windows shell scripts', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'run-skill.cjs'), 'utf8');
    const body = source.match(/function findGitBash\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';

    expect(body).toContain("findOnPath(['bash.exe', 'bash'])");
    expect(body.indexOf('findOnPath')).toBeLessThan(body.indexOf('const roots'));
  });

  it('hides spawned script windows on Windows', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'run-skill.cjs'), 'utf8');
    const body = source.match(/function trySpawn\([\s\S]*?\n\}/)?.[0] ?? '';

    expect(body).toContain('windowsHide: true');
  });

  it('resolves marketplace scripts by SKILL.md display name when dir id differs', () => {
    writeMarketplaceSkill('252af214f470', 'social-fetch', 'fetch');

    const r = runSkill('social-fetch', 'fetch', ['reddit']);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true, argv: 'reddit' });
  });

  it('keeps direct internal-id lookup working', () => {
    writeMarketplaceSkill('252af214f470', 'social-fetch', 'fetch');

    const r = runSkill('252af214f470', 'fetch', ['youtube']);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true, argv: 'youtube' });
  });

  it('resolves current-agent private marketplace scripts from the installed agent directory', () => {
    writeAgentMarketplaceSkill('agent-a', 'stage-compose', 'stage-compose', 'render_composition');

    const r = runSkill('stage-compose', 'render_composition', ['--op', 'inspect'], {
      ORKAS_UID: 'u1',
      ORKAS_AGENT_ID: 'agent-a',
    });

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true, agent: 'agent-a', argv: '--op inspect' });
  });

  it('does not expose another agent private marketplace skill', () => {
    writeAgentMarketplaceSkill('agent-a', 'stage-compose', 'stage-compose', 'render_composition');

    const r = runSkill('stage-compose', 'render_composition', [], {
      ORKAS_UID: 'u1',
      ORKAS_AGENT_ID: 'agent-b',
    });

    expect(r.status).toBe(66);
    expect(r.stdout).toBe('');
    const err = JSON.parse(r.stderr.trim());
    expect(err.ok).toBe(false);
    expect(err.error).toContain('skill script not found');
    expect(JSON.stringify(err.searched)).not.toContain('agent-a');
  });

  it('requires ORKAS_UID before resolving agent private marketplace skills', () => {
    writeAgentMarketplaceSkill('agent-a', 'stage-compose', 'stage-compose', 'render_composition');

    const r = runSkill('stage-compose', 'render_composition', [], {
      ORKAS_AGENT_ID: 'agent-a',
    });

    expect(r.status).toBe(66);
    const err = JSON.parse(r.stderr.trim());
    expect(err.ok).toBe(false);
    expect(JSON.stringify(err.searched)).not.toContain('agent-a');
  });

  itOnNonWindows('prefers POSIX scripts over Windows-native scripts outside Windows', () => {
    const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'dual');
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: dual\ndescription: test\n---\n\nbody\n',
    );
    fs.writeFileSync(path.join(scriptsDir, 'run.sh'), 'printf \'{"runner":"sh"}\\n\'\n');
    fs.writeFileSync(path.join(scriptsDir, 'run.ps1'), 'Write-Output \'{"runner":"ps1"}\'\n');

    const r = runSkill('dual', 'run');

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({ runner: 'sh' });
  });

  itOnNonWindows('uses ORKAS_PYTHON for plain Python skill scripts', () => {
    const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'py-skill');
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: py-skill\ndescription: test\n---\n\nbody\n',
    );
    fs.writeFileSync(path.join(scriptsDir, 'run.py'), 'print("system python should not run this")\n');

    const fakePython = path.join(tmpDir, 'fake-python');
    fs.writeFileSync(fakePython, [
      '#!/bin/sh',
      'printf \'{"python":"bundled","script":"%s","argv":"%s"}\\n\' "$1" "$2"',
      '',
    ].join('\n'));
    fs.chmodSync(fakePython, 0o755);

    const r = runSkill('py-skill', 'run', ['arg1'], { ORKAS_PYTHON: fakePython });

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const out = JSON.parse(r.stdout.trim());
    expect(out.python).toBe('bundled');
    expect(out.script).toMatch(/run\.py$/);
    expect(out.argv).toBe('arg1');
  });
});
