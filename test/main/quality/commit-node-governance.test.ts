import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { removeGitFixture } from '../../helpers/remove-git-fixture';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(removeGitFixture));

it('does not erase governed commits when the checker is deleted and reintroduced', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-governance-node-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const commit = (message: string) => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  const base = commit('before governance');
  const relative = 'PC/scripts/check-prompt-commit-metadata.cjs';
  const script = path.join(root, relative);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  const bytes = fs.readFileSync(path.resolve(process.cwd(), 'scripts/check-prompt-commit-metadata.cjs'));
  fs.writeFileSync(script, bytes);
  commit('adopt checker');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Synthetic governed change.\n');
  const unaudited = commit('missing required metadata');
  fs.unlinkSync(script);
  commit('temporarily remove checker');
  fs.writeFileSync(script, bytes);
  const reintroduced = commit('reintroduce checker');
  const run = (start: string) => spawnSync(process.env.ORKAS_TEST_NODE || process.execPath,
    [script, '--base', start], { cwd: root, encoding: 'utf8' });
  const result = run(base);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(unaudited.slice(0, 12));
  expect(result.stderr).toContain('missing complete Prompt audit metadata');
  // A genuinely later event base keeps its narrow scope.
  expect(run(reintroduced).status).toBe(0);
});
