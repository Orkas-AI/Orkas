import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Migration utility strips legacy `aiteam-` / `orkas-` prefixes from session
// jsonl filenames and stamps `<uid>/local/.migrations` so subsequent boots
// no-op. See src/main/util/migrate-session-ids.ts and CLAUDE.md §5.

let tmpDir: string;
let prevWs: string | undefined;

const TEST_UID = 'u1';

function sessionsDir(uid: string): string {
  return path.join(tmpDir, uid, 'cloud', 'sessions');
}
function migrationsFile(uid: string): string {
  return path.join(tmpDir, uid, 'local', '.migrations');
}
function touch(file: string, content = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-migrate-sid-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrate-session-ids', () => {
  it('strips aiteam- / orkas- prefixes and leaves bare-format files alone', async () => {
    const dir = sessionsDir(TEST_UID);
    touch(path.join(dir, `aiteam-${TEST_UID}-agent-a1.jsonl`), 'old1');
    touch(path.join(dir, `orkas-${TEST_UID}-gconv-c1.jsonl`),  'old2');
    touch(path.join(dir, `${TEST_UID}-skill-s1.jsonl`),         'new');

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    const stats = migrateLegacySessionIds(TEST_UID);

    expect(stats).toEqual({ scanned: 3, renamed: 2, alreadyMigrated: 1, conflicts: 0 });
    expect(fs.existsSync(path.join(dir, `${TEST_UID}-agent-a1.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${TEST_UID}-gconv-c1.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${TEST_UID}-skill-s1.jsonl`))).toBe(true);
    // 老文件不应残留
    expect(fs.existsSync(path.join(dir, `aiteam-${TEST_UID}-agent-a1.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `orkas-${TEST_UID}-gconv-c1.jsonl`))).toBe(false);
    // 内容保留(rename 而非 copy+truncate)
    expect(fs.readFileSync(path.join(dir, `${TEST_UID}-agent-a1.jsonl`), 'utf8')).toBe('old1');
  });

  it('preserves legacy kinds (organizer / sub / conv) — strips prefix, keeps body', async () => {
    const dir = sessionsDir(TEST_UID);
    touch(path.join(dir, `aiteam-${TEST_UID}-conv-old.jsonl`),     'c');
    touch(path.join(dir, `aiteam-${TEST_UID}-organizer-x.jsonl`),  'o');
    touch(path.join(dir, `aiteam-${TEST_UID}-sub-y.jsonl`),        's');

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    migrateLegacySessionIds(TEST_UID);

    expect(fs.existsSync(path.join(dir, `${TEST_UID}-conv-old.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${TEST_UID}-organizer-x.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${TEST_UID}-sub-y.jsonl`))).toBe(true);
  });

  it('stamps .migrations and is a no-op on second invocation', async () => {
    const dir = sessionsDir(TEST_UID);
    touch(path.join(dir, `aiteam-${TEST_UID}-agent-a1.jsonl`), 'first');

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    const first = migrateLegacySessionIds(TEST_UID);
    expect(first.renamed).toBe(1);
    expect(fs.existsSync(migrationsFile(TEST_UID))).toBe(true);

    // 第二次:加一个新的 aiteam- 文件,但因为已盖章应当被跳过
    touch(path.join(dir, `aiteam-${TEST_UID}-skill-s2.jsonl`), 'should-not-rename');
    const second = migrateLegacySessionIds(TEST_UID);
    expect(second).toEqual({ scanned: 0, renamed: 0, alreadyMigrated: 0, conflicts: 0 });
    expect(fs.existsSync(path.join(dir, `aiteam-${TEST_UID}-skill-s2.jsonl`))).toBe(true);
  });

  it('skips on conflict (target name already taken) without overwriting', async () => {
    const dir = sessionsDir(TEST_UID);
    touch(path.join(dir, `aiteam-${TEST_UID}-agent-a1.jsonl`), 'legacy');
    touch(path.join(dir, `${TEST_UID}-agent-a1.jsonl`),         'kept');

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    const stats = migrateLegacySessionIds(TEST_UID);

    expect(stats.conflicts).toBe(1);
    expect(stats.renamed).toBe(0);
    // 双方文件都在;新文件内容未被覆盖
    expect(fs.existsSync(path.join(dir, `aiteam-${TEST_UID}-agent-a1.jsonl`))).toBe(true);
    expect(fs.readFileSync(path.join(dir, `${TEST_UID}-agent-a1.jsonl`), 'utf8')).toBe('kept');
  });

  it('handles missing sessions dir (fresh uid, never had sessions) by stamping & returning zeros', async () => {
    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    const stats = migrateLegacySessionIds(TEST_UID);
    expect(stats).toEqual({ scanned: 0, renamed: 0, alreadyMigrated: 0, conflicts: 0 });
    // 仍然盖章,避免下次启动重扫
    expect(fs.existsSync(migrationsFile(TEST_UID))).toBe(true);
  });
});
