/**
 * Tests for the `localAgents.readToolResult` IPC handler.
 *
 * Security invariants the handler MUST hold (CLAUDE.md §5 boundary):
 *   - active uid only, path must resolve under <uid>/local/tool-results/
 *   - reject ENOENT, symlink-escape, traversal (`../`), non-file targets
 *   - byte-cap reads at 256 KB; signal truncation via `{truncated:true}`
 *
 * Never throws across the IPC boundary — all failure modes return
 * `{ok:false, error}` so a UI bug can't crash the renderer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-readtoolresult-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // Each test gets a fresh module graph so users.activateUser doesn't
  // bleed across.
  const { vi } = await import('vitest');
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function callHandler(input: unknown): Promise<any> {
  const mod = await import('../../../src/main/ipc/local_agents');
  return (mod.invokeHandlers as any)['localAgents.readToolResult'](input as any);
}

function sessionDir(): string {
  // Mirror sessionToolResultsDir(uid, '<uid>-cli-claude-runX') so we
  // can drop fixtures into the same shape the runner spills into.
  const dir = path.join(
    tmpDir, TEST_UID, 'local', 'tool-results', `${TEST_UID}-cli-claude-runtest`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('ipc/local_agents.readToolResult', () => {
  it('rejects when path is missing / not a string', async () => {
    expect(await callHandler({})).toMatchObject({ ok: false });
    expect(await callHandler({ path: 42 })).toMatchObject({ ok: false });
    expect(await callHandler({ path: '' })).toMatchObject({ ok: false });
  });

  it('reads a small spill file when path is inside tool-results/', async () => {
    const dir = sessionDir();
    const filePath = path.join(dir, 'bash.abc.txt');
    fs.writeFileSync(filePath, 'hello world');
    const r = await callHandler({ path: filePath });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('hello world');
    expect(r.truncated).toBe(false);
  });

  it('rejects an absolute path outside the active uid tool-results dir', async () => {
    const outside = path.join(tmpDir, 'evil.txt');
    fs.writeFileSync(outside, 'leaked');
    const r = await callHandler({ path: outside });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/outside tool-results scope/);
  });

  it('rejects a `..` traversal that escapes via path concat', async () => {
    const dir = sessionDir();
    // Construct a path that, before realpath, includes `..` segments
    // pointing OUT of tool-results/. realpath collapses them; the
    // handler then sees the canonical out-of-scope path and rejects.
    // tmpDir on macOS may itself be a symlink (/var → /private/var),
    // so we put the file at a known sibling-of-sessionDir absolute
    // location and reach it through `..` from sessionDir.
    const outsideDir = path.join(tmpDir, 'evil-sibling');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'evil.txt');
    fs.writeFileSync(outsideFile, 'leaked');
    // sessionDir is <tmpDir>/u1/local/tool-results/<session>;
    // 4 `..` go back to tmpDir, then into the sibling.
    const escapingPath = path.join(dir, '..', '..', '..', '..', 'evil-sibling', 'evil.txt');
    const r = await callHandler({ path: escapingPath });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/outside tool-results scope/);
  });

  it('rejects ENOENT cleanly without throwing', async () => {
    const dir = sessionDir();
    const r = await callHandler({ path: path.join(dir, 'never-existed.txt') });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/no longer exists/);
  });

  it('rejects when the resolved target is a directory, not a file', async () => {
    const dir = sessionDir();
    const r = await callHandler({ path: dir });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/not a regular file/);
  });

  it('truncates files larger than the 256 KB cap and reports truncated:true', async () => {
    const dir = sessionDir();
    const filePath = path.join(dir, 'huge.txt');
    // Write 300 KB of A's.
    const huge = 'A'.repeat(300 * 1024);
    fs.writeFileSync(filePath, huge);
    const r = await callHandler({ path: filePath });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBe(256 * 1024);
    expect(r.content.startsWith('A')).toBe(true);
  });

  it('rejects when a symlink points OUT of tool-results/', async () => {
    const dir = sessionDir();
    const outside = path.join(tmpDir, 'evil-target.txt');
    fs.writeFileSync(outside, 'should not leak');
    const linkPath = path.join(dir, 'innocent-looking.txt');
    try {
      fs.symlinkSync(outside, linkPath);
    } catch (err) {
      // Some sandboxed CI envs forbid symlinks; skip this case
      // rather than fail the test on platform constraints.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    const r = await callHandler({ path: linkPath });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/outside tool-results scope/);
  });

  it('allows a symlink that resolves WITHIN tool-results/', async () => {
    const dir = sessionDir();
    const real = path.join(dir, 'real.txt');
    fs.writeFileSync(real, 'inside content');
    const linkPath = path.join(dir, 'alias.txt');
    try {
      fs.symlinkSync(real, linkPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    const r = await callHandler({ path: linkPath });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('inside content');
  });
});
