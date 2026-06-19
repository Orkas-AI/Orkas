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

function runSkill(skillRef: string, scriptBase: string, args: string[] = []) {
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
      ORKAS_WORKSPACE_ROOT: tmpDir,
      ORKAS_PC_DIR: pcRoot,
    },
  });
}

describe('run-skill.cjs', () => {
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
});
