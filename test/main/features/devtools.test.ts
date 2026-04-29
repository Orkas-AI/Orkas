/**
 * Devtools feature — archive storage semantics.
 *
 * Scope:
 *   - `archiveLlmCall` respects the dev gate (no-op in prod), writes an
 *     atomic JSON file under `workspace/test/`, and keeps at most 10 files
 *     (newest-by-filename) after repeated calls.
 *   - `listArchives` / `readArchive` round-trip the record and skip
 *     corrupted files silently.
 *   - `clearArchives` deletes everything under the dir.
 *   - `newArchiveId` produces sortable, unique ids.
 *
 * Out of scope: the stream wrapper in `model/core-agent/client.ts` — that
 * requires a real core-agent instance and network; covered at runtime.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
let prevDevtools: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-devtools-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevDevtools = process.env.ORKAS_DEVTOOLS;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // Force dev mode on — `isDevEnv()` looks at `app.isPackaged` (will throw in
  // non-Electron test runner, caught inside) and then falls back to this env.
  process.env.ORKAS_DEVTOOLS = '1';
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevDevtools === undefined) delete process.env.ORKAS_DEVTOOLS;
  else process.env.ORKAS_DEVTOOLS = prevDevtools;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function buildRecord(d: { id: string; message?: string; text?: string }) {
  return {
    id: d.id,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 123,
    userId: 'u1',
    sessionId: 'u1-anon-xyz',
    input: { message: d.message || 'hi', model: 'claude-sonnet-4-7', provider: 'anthropic' },
    events: [{ t: 0, type: 'text', data: { text: 'ok' } }],
    output: { text: d.text || 'hello', aborted: false, error: null },
  };
}

describe('devtools › archiveLlmCall + listArchives', () => {
  it('writes an archive and reads it back via listArchives + readArchive', async () => {
    const mod = await import('../../../src/main/features/devtools');
    const rec = buildRecord({ id: mod.newArchiveId(), message: '你好', text: '响应' });
    mod.archiveLlmCall(rec);

    const { archives } = mod.listArchives();
    expect(archives).toHaveLength(1);
    expect(archives[0].id).toBe(rec.id);
    expect(archives[0].model).toBe('claude-sonnet-4-7');
    expect(archives[0].inputPreview).toBe('你好');
    expect(archives[0].outputPreview).toBe('响应');

    const { archive } = mod.readArchive(rec.id);
    expect(archive).not.toBeNull();
    expect(archive!.input.message).toBe('你好');
    expect(archive!.events).toHaveLength(1);
  });

  it('keeps only the newest 10 archives', async () => {
    const mod = await import('../../../src/main/features/devtools');
    for (let i = 0; i < 15; i++) {
      const id = `2026-04-20T00-00-00-${String(i).padStart(3, '0')}-aaa`;
      mod.archiveLlmCall(buildRecord({ id, text: `out-${i}` }));
    }
    const { archives } = mod.listArchives();
    expect(archives).toHaveLength(10);
    // Newest-first (listFilesDesc sorts descending by filename).
    expect(archives[0].id.endsWith('-014-aaa')).toBe(true);
    expect(archives[9].id.endsWith('-005-aaa')).toBe(true);
  });

  it('clearArchives removes every file and the list goes empty', async () => {
    const mod = await import('../../../src/main/features/devtools');
    mod.archiveLlmCall(buildRecord({ id: mod.newArchiveId() }));
    mod.archiveLlmCall(buildRecord({ id: mod.newArchiveId() }));

    expect(mod.listArchives().archives).toHaveLength(2);
    const { cleared } = mod.clearArchives();
    expect(cleared).toBe(2);
    expect(mod.listArchives().archives).toHaveLength(0);
  });

  it('readArchive returns null for unknown / unsafe ids', async () => {
    const mod = await import('../../../src/main/features/devtools');
    expect(mod.readArchive('nope').archive).toBeNull();
    expect(mod.readArchive('../../../etc/passwd').archive).toBeNull();
    expect(mod.readArchive('').archive).toBeNull();
  });

  it('listArchives skips corrupt files instead of throwing', async () => {
    const mod = await import('../../../src/main/features/devtools');
    mod.archiveLlmCall(buildRecord({ id: mod.newArchiveId() }));
    const testDir = path.join(tmpDir, TEST_UID, 'local', 'test');
    // Drop a garbage JSON file next to the real one.
    fs.writeFileSync(path.join(testDir, 'corrupt.json'), 'not json');
    const { archives } = mod.listArchives();
    expect(archives).toHaveLength(1);
  });
});

describe('devtools › dev gate', () => {
  it('is a no-op when ORKAS_DEVTOOLS is unset and app would be packaged', async () => {
    delete process.env.ORKAS_DEVTOOLS;
    // We can't set app.isPackaged inside vitest; isDevEnv() catches the
    // `app` access error and falls back to env check. So here env is
    // cleared → isDevEnv returns false → write is skipped.
    vi.resetModules();
    const users = await import('../../../src/main/features/users');
    users.activateUser(TEST_UID);
    const mod = await import('../../../src/main/features/devtools');
    mod.archiveLlmCall(buildRecord({ id: mod.newArchiveId() }));
    expect(mod.listArchives().archives).toHaveLength(0);
  });
});

describe('devtools › newArchiveId', () => {
  it('is sortable by time and unique within the same millisecond', async () => {
    const mod = await import('../../../src/main/features/devtools');
    const now = new Date('2026-04-20T10:30:15.123Z');
    const a = mod.newArchiveId(now);
    const b = mod.newArchiveId(now);
    // Both start with the same time prefix; the random tail differs.
    const prefixA = a.slice(0, 23);
    const prefixB = b.slice(0, 23);
    expect(prefixA).toBe(prefixB);
    expect(a).not.toBe(b);
  });
});

describe('devtools › startRecording stream accumulator', () => {
  it('records events with elapsed ms and persists on finish', async () => {
    const mod = await import('../../../src/main/features/devtools');
    const rec = mod.startRecording({
      userId: 'u1',
      sessionId: 'u1-anon-s',
      input: { message: 'hi', model: 'claude-opus-4-7', provider: 'anthropic' },
    });
    rec.record({ type: 'text', text: 'hello' });
    rec.record({ type: 'tool_call', name: 'read' });
    rec.finish({ text: 'hello world', aborted: false, error: null });

    const { archives } = mod.listArchives();
    expect(archives).toHaveLength(1);
    const { archive } = mod.readArchive(archives[0].id);
    expect(archive!.events).toHaveLength(2);
    expect(archive!.events[0].type).toBe('text');
    expect(archive!.events[1].type).toBe('tool_call');
    expect(archive!.output.text).toBe('hello world');
  });

  it('returns no-op recorder in prod — nothing gets archived', async () => {
    delete process.env.ORKAS_DEVTOOLS;
    vi.resetModules();
    const users = await import('../../../src/main/features/users');
    users.activateUser(TEST_UID);
    const mod = await import('../../../src/main/features/devtools');
    const rec = mod.startRecording({
      userId: 'u1', sessionId: 's', input: { message: 'hi' },
    });
    rec.record({ type: 'text', text: 'x' });
    rec.finish({ text: 'y', aborted: false, error: null });
    expect(mod.listArchives().archives).toHaveLength(0);
  });
});
