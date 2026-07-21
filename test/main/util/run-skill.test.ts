import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

let tmpDir: string;
const tmpDirs: string[] = [];
const itOnNonWindows = process.platform === 'win32' ? it.skip : it;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-run-skill-'));
  tmpDirs.push(tmpDir);
});

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
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
    path.join(scriptsDir, `${scriptBase}.js`),
    'module.exports = async ({ args }) => ({ ok: true, argv: args.join(" ") });\n',
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
    path.join(scriptsDir, `${scriptBase}.js`),
    'module.exports = async ({ args }) => ({ ok: true, agent: process.env.ORKAS_AGENT_ID, argv: args.join(" ") });\n',
  );
}

function runSkill(skillRef: string, scriptBase: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const pcRoot = process.cwd();
  return spawnSync(TEST_NODE, [
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

function skillMarkdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...skillMarkdownFiles(target));
    else if (entry.isFile() && entry.name === 'SKILL.md') out.push(target);
  }
  return out;
}

describe('run-skill.cjs', () => {
  it('keeps protected skill script commands on the standard runner', () => {
    const pcRoot = process.cwd();
    const roots = [
      path.join(pcRoot, 'resources', 'builtin', 'marketplace'),
      path.join(pcRoot, 'resources', 'builtin', 'system', 'skills'),
      path.resolve(pcRoot, '..', 'Resource', 'skills'),
    ];
    const directScriptCommands: string[] = [];
    const commandPattern = /(?:\$ORKAS_NODE|\bnode\b|\bpython3?\b|\bbash\b|\bsh\b|\bruby\b|\bpwsh\b|\bpowershell\b|&\s+\$\w+)[^\n]*(?:scripts[\\/]|[\\/]scripts[\\/])/i;

    for (const file of roots.flatMap(skillMarkdownFiles)) {
      const relative = path.relative(path.resolve(pcRoot, '..'), file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        let command = lines[index].trim();
        while (/[\\`^]$/.test(command) && index + 1 < lines.length) {
          command = `${command.slice(0, -1)} ${lines[++index].trim()}`;
        }
        if (!commandPattern.test(command) || command.includes('run-skill.cjs')) continue;
        directScriptCommands.push(`${relative}:${index + 1}: ${command}`);
      }
    }

    expect(directScriptCommands).toEqual([]);
  });

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
    writeAgentMarketplaceSkill('agent-a', 'stage-compose', 'stage-compose', 'compose_preview');

    const r = runSkill('stage-compose', 'compose_preview', ['--op', 'inspect'], {
      ORKAS_UID: 'u1',
      ORKAS_AGENT_ID: 'agent-a',
    });

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true, agent: 'agent-a', argv: '--op inspect' });
  });

  it('does not expose another agent private marketplace skill', () => {
    writeAgentMarketplaceSkill('agent-a', 'stage-compose', 'stage-compose', 'compose_preview');

    const r = runSkill('stage-compose', 'compose_preview', [], {
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
    writeAgentMarketplaceSkill('agent-a', 'stage-compose', 'stage-compose', 'compose_preview');

    const r = runSkill('stage-compose', 'compose_preview', [], {
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

  it.runIf(process.platform === 'win32')('prefers Windows-native scripts over shell scripts on Windows', () => {
    const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'dual-win');
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: dual-win\ndescription: test\n---\n\nbody\n',
    );
    fs.writeFileSync(path.join(scriptsDir, 'run.ps1'), 'Write-Output \'{"runner":"ps1"}\'\n');
    fs.writeFileSync(path.join(scriptsDir, 'run.sh'), 'printf \'{"runner":"sh"}\\n\'\n');

    const r = runSkill('dual-win', 'run');

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toEqual({ runner: 'ps1' });
  });

  it('uses ORKAS_PYTHON for plain Python skill scripts', () => {
    const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'py-skill');
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: py-skill\ndescription: test\n---\n\nbody\n',
    );
    fs.writeFileSync(
      path.join(scriptsDir, 'run.py'),
      process.platform === 'win32'
        ? 'process.stdout.write(JSON.stringify({ python: "bundled", script: process.argv[1], argv: process.argv[2] }));\n'
        : 'print("system python should not run this")\n',
    );

    const fakePython = process.platform === 'win32' ? TEST_NODE : path.join(tmpDir, 'fake-python');
    if (process.platform === 'win32') {
      expect(fs.existsSync(fakePython)).toBe(true);
    } else {
      fs.writeFileSync(fakePython, [
        '#!/bin/sh',
        'printf \'{"python":"bundled","script":"%s","argv":"%s"}\\n\' "$1" "$2"',
        '',
      ].join('\n'));
      fs.chmodSync(fakePython, 0o755);
    }

    const r = runSkill('py-skill', 'run', ['arg1'], { ORKAS_PYTHON: fakePython });

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const out = JSON.parse(r.stdout.trim());
    expect(out.python).toBe('bundled');
    expect(out.script).toMatch(/run\.py$/);
    expect(out.argv).toBe('arg1');
  });
});
