import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';

let root: string;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-staged-manifest-'));
  const write = (file: string, body: string) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body); };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  write('scripts/update-builtin-manifest.cjs', fs.readFileSync(path.resolve('scripts/update-builtin-manifest.cjs'), 'utf8'));
  write('bin/builtin-resource-gate.cjs', `const fs=require('node:fs'),path=require('node:path');
    module.exports={BUILTIN_MANIFEST_NAME:'_manifest.json',createBuiltinManifest(root){
      const content=fs.readFileSync(path.join(root,'payload.txt'),'utf8');
      if(!content)throw Error('Empty staged payload');return {content};}};`);
  write('src/main/data/avatars.json', '{}');
  write('resources/builtin/payload.txt', 'staged payload');
  write('resources/builtin/_manifest.json', JSON.stringify({ content: 'staged payload' }, null, 2) + '\n');
  git('add', '.');
  return { write, git, run: () => spawnSync(process.execPath, [path.join(root, 'scripts/update-builtin-manifest.cjs'), '--check-staged'], { cwd: root, encoding: 'utf8', timeout: 10_000 }) };
}

it('validates staged resources with the staged validator while preserving concurrent working files', () => {
  const { write, git, run } = fixture();
  const concurrent = 'throw Error("The unstaged validator must never run");';
  write('bin/builtin-resource-gate.cjs', concurrent);
  write('resources/builtin/payload.txt', 'concurrent payload');
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('staged snapshot verified');
  expect(fs.readFileSync(path.join(root, 'bin/builtin-resource-gate.cjs'), 'utf8')).toBe(concurrent);
  expect(git('show', ':resources/builtin/payload.txt')).toBe('staged payload');
});

it('rejects invalid staged resources even when the working copy has repaired them', () => {
  const { write, git, run } = fixture();
  write('resources/builtin/payload.txt', ''); git('add', 'resources/builtin/payload.txt');
  write('resources/builtin/payload.txt', 'working repair');
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('staged snapshot validation failed');
  expect(git('show', ':resources/builtin/payload.txt')).toBe('');
  expect(fs.readFileSync(path.join(root, 'resources/builtin/payload.txt'), 'utf8')).toBe('working repair');
});
