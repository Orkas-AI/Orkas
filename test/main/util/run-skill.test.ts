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

  itOnNonWindows('installs declared Python requirements once before the first skill run', () => {
    const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'cold-python');
    const scriptsDir = path.join(skillDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: cold-python\ndescription: dependency bootstrap fixture\n---\n\nbody\n',
    );
    fs.writeFileSync(path.join(skillDir, 'requirements.run.txt'), 'fixture-package==1.0.0\n');
    fs.writeFileSync(path.join(scriptsDir, 'run.py'), 'print("the fake isolated python handles this")\n');
    fs.writeFileSync(path.join(scriptsDir, 'inspect.py'), 'print("this script has no dependency manifest")\n');

    const fakePython = path.join(tmpDir, 'fake-python');
    fs.writeFileSync(fakePython, [
      '#!/bin/sh',
      'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
      '  mkdir -p "$3/bin"',
      '  cp "$0" "$3/bin/python"',
      '  chmod +x "$3/bin/python"',
      '  exit 0',
      'fi',
      'if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then',
      '  if [ "$FAIL_SKILL_PIP" = "1" ]; then exit 9; fi',
      '  exit 0',
      'fi',
      'if [ "$1" = "--version" ]; then',
      '  printf \'Python 3.12.99\\n\'',
      '  exit 0',
      'fi',
      'printf \'{"python":"isolated","runner":"%s","script":"%s","argv":"%s"}\\n\' "$0" "$1" "$2"',
      '',
    ].join('\n'));
    fs.chmodSync(fakePython, 0o755);

    const env = {
      ORKAS_PYTHON: fakePython,
      ORKAS_UV: '',
      ORKAS_VENV_ROOT: path.join(tmpDir, 'venv'),
      PATH: '/usr/bin:/bin',
    };
    const unrelated = runSkill('cold-python', 'inspect', ['plain'], env);
    expect(unrelated.status).toBe(0);
    expect(unrelated.stderr).not.toContain('Installing Python dependencies');
    expect(JSON.parse(unrelated.stdout.trim())).toMatchObject({
      runner: fakePython,
      argv: 'plain',
    });

    const failed = runSkill('cold-python', 'run', ['failed'], {
      ...env,
      FAIL_SKILL_PIP: '1',
    });
    expect(failed.status).toBe(70);
    expect(failed.stderr).toContain('failed to install skill Python dependencies');

    const first = runSkill('cold-python', 'run', ['first'], env);
    expect(first.status).toBe(0);
    expect(first.stderr).toContain('Installing Python dependencies for skill cold-python');
    expect(JSON.parse(first.stdout.trim())).toMatchObject({
      python: 'isolated',
      argv: 'first',
    });
    expect(JSON.parse(first.stdout.trim()).runner).toContain(
      path.join('venv', 'python', 'skills', 'cold-python-'),
    );

    const second = runSkill('cold-python', 'run', ['second'], env);
    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain('Installing Python dependencies');
    expect(JSON.parse(second.stdout.trim())).toMatchObject({
      python: 'isolated',
      argv: 'second',
    });
  });

  it.runIf(process.platform === 'win32')(
    'installs declared Python requirements once into a Windows Scripts venv',
    () => {
      const skillDir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'cold-python-win');
      const scriptsDir = path.join(skillDir, 'scripts');
      const installLog = path.join(tmpDir, 'windows-python-install.log');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: cold-python-win\ndescription: Windows dependency bootstrap fixture\n---\n\nbody\n',
      );
      fs.writeFileSync(path.join(skillDir, 'requirements.run.txt'), 'fixture-package==1.0.0\n');
      fs.writeFileSync(
        path.join(scriptsDir, 'run.py'),
        'process.stdout.write(JSON.stringify({ python: "isolated", runner: process.execPath, argv: process.argv[2] }));\n',
      );
      fs.writeFileSync(
        path.join(skillDir, 'venv'),
        [
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          'const venv = process.argv.at(-1);',
          'const python = path.join(venv, "Scripts", "python.exe");',
          'fs.mkdirSync(path.dirname(python), { recursive: true });',
          'try { fs.linkSync(process.execPath, python); } catch { fs.copyFileSync(process.execPath, python); }',
          'fs.appendFileSync(process.env.FAKE_SKILL_PYTHON_LOG, `venv:${python}\\n`);',
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(skillDir, 'pip'),
        [
          'const fs = require("node:fs");',
          'fs.appendFileSync(process.env.FAKE_SKILL_PYTHON_LOG, `pip:${JSON.stringify(process.argv.slice(2))}\\n`);',
          'if (process.env.FAIL_SKILL_PIP === "1") process.exit(9);',
          '',
        ].join('\n'),
      );

      const env = {
        ORKAS_PYTHON: TEST_NODE,
        ORKAS_UV: TEST_NODE,
        ORKAS_VENV_ROOT: path.join(tmpDir, 'venv'),
        FAKE_SKILL_PYTHON_LOG: installLog,
      };
      const failed = runSkill('cold-python-win', 'run', ['failed'], {
        ...env,
        FAIL_SKILL_PIP: '1',
      });
      expect(failed.status).toBe(70);
      expect(failed.stderr).toContain('failed to install skill Python dependencies');

      const first = runSkill('cold-python-win', 'run', ['first'], env);
      expect(first.status).toBe(0);
      expect(first.stderr).toContain('Installing Python dependencies for skill cold-python-win');
      const firstOut = JSON.parse(first.stdout.trim());
      expect(firstOut).toMatchObject({ python: 'isolated', argv: 'first' });
      expect(firstOut.runner).toContain(path.join('venv', 'python', 'skills', 'cold-python-win-'));
      expect(firstOut.runner).toMatch(/[\\/]Scripts[\\/]python\.exe$/);

      const installEvents = fs.readFileSync(installLog, 'utf8').trim().split(/\r?\n/);
      expect(installEvents.filter((line) => line.startsWith('venv:'))).toHaveLength(2);
      expect(installEvents.filter((line) => line.startsWith('pip:'))).toHaveLength(2);
      expect(installEvents.at(-1)).toContain('Scripts\\\\python.exe');

      const second = runSkill('cold-python-win', 'run', ['second'], env);
      expect(second.status).toBe(0);
      expect(second.stderr).not.toContain('Installing Python dependencies');
      expect(JSON.parse(second.stdout.trim())).toMatchObject({
        python: 'isolated',
        runner: firstOut.runner,
        argv: 'second',
      });
      expect(fs.readFileSync(installLog, 'utf8').trim().split(/\r?\n/)).toEqual(installEvents);
    },
  );
});
