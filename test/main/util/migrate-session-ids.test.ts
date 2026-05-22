import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Migration utility strips ANY prefix segments before the kind keyword from session jsonl
// filenames (brand prefix `aiteam-` / `orkas-`, uid prefix in either 8-digit numeric or
// UUID-with-dashes form, even doubled prefixes), normalising every shape to `<kind>-<tail>.jsonl`
// (CLAUDE.md §5 — uid no longer in session_id; user scoping comes from path root). Stamps
// `<uid>/local/.migrations` so subsequent boots no-op. See src/main/util/migrate-session-ids.ts.

let tmpDir: string;
let prevWs: string | undefined;

const TEST_UID = 'u1';

function cloudSessionsDir(uid: string): string {
  return path.join(tmpDir, uid, 'cloud', 'sessions');
}
function localSessionsDir(uid: string): string {
  return path.join(tmpDir, uid, 'local', 'sessions');
}
function chatsIndexFile(uid: string): string {
  return path.join(tmpDir, uid, 'cloud', 'chats', '_index.json');
}
function agentChatMetaFile(uid: string, agentId: string): string {
  return path.join(tmpDir, uid, 'cloud', 'chats', 'agent', agentId, 'chat.json');
}
function skillChatMetaFile(uid: string, skillId: string): string {
  return path.join(tmpDir, uid, 'cloud', 'chats', 'skill', skillId, 'chat.json');
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
  it('strips brand prefix (aiteam- / orkas-) AND uid prefix to land at `<kind>-<tail>.jsonl`', async () => {
    const dir = cloudSessionsDir(TEST_UID);
    touch(path.join(dir, 'aiteam-99999999-agent-a1.jsonl'), 'old1');
    touch(path.join(dir, 'orkas-99999999-gconv-c1.jsonl'),  'old2');
    touch(path.join(dir, 'gconv-c2.jsonl'),                  'new');

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    const stats = migrateLegacySessionIds(TEST_UID);

    expect(stats).toEqual({ scanned: 3, renamed: 2, alreadyMigrated: 1, conflicts: 0, fieldsRewritten: 0 });
    expect(fs.existsSync(path.join(dir, 'agent-a1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'gconv-c1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'gconv-c2.jsonl'))).toBe(true);
    // Old files gone
    expect(fs.existsSync(path.join(dir, 'aiteam-99999999-agent-a1.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'orkas-99999999-gconv-c1.jsonl'))).toBe(false);
    // Content preserved (rename, not copy+truncate)
    expect(fs.readFileSync(path.join(dir, 'agent-a1.jsonl'), 'utf8')).toBe('old1');
  });

  it('strips a UUID-shaped uid prefix (the bug we hit on real OAuth-issued user_ids)', async () => {
    const dir = cloudSessionsDir(TEST_UID);
    const UUID = 'D69594E0-CF31-424C-9318-30231197E3A9';
    touch(path.join(dir, `${UUID}-gconv-ac5559863d42.jsonl`), 'real-archive-sample');
    touch(path.join(dir, `${UUID}-gmember-cv1-agt-1.jsonl`),  'agent-worker');

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    const stats = migrateLegacySessionIds(TEST_UID);

    expect(stats.renamed).toBe(2);
    expect(fs.existsSync(path.join(dir, 'gconv-ac5559863d42.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'gmember-cv1-agt-1.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'gconv-ac5559863d42.jsonl'), 'utf8')).toBe('real-archive-sample');
  });

  it('handles dashed kind keywords (extract-img / memory-extract) without splitting them', async () => {
    const dir = cloudSessionsDir(TEST_UID);
    touch(path.join(dir, '99999999-extract-img-deadbeef.jsonl'),  'a');
    touch(path.join(dir, '99999999-memory-extract-1234.jsonl'),    'b');

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    migrateLegacySessionIds(TEST_UID);

    expect(fs.existsSync(path.join(dir, 'extract-img-deadbeef.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'memory-extract-1234.jsonl'))).toBe(true);
  });

  it('preserves legacy kinds (organizer / sub / conv) — strips prefix, keeps body shape', async () => {
    const dir = cloudSessionsDir(TEST_UID);
    touch(path.join(dir, 'aiteam-99999999-conv-old.jsonl'),     'c');
    touch(path.join(dir, 'orkas-99999999-organizer-x.jsonl'),   'o');
    touch(path.join(dir, '99999999-sub-y.jsonl'),                's');

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    migrateLegacySessionIds(TEST_UID);

    expect(fs.existsSync(path.join(dir, 'conv-old.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'organizer-x.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sub-y.jsonl'))).toBe(true);
  });

  it('also scans local/sessions/ — ephemeral kinds (extract-img / reflect / anon) live there post-routing', async () => {
    const cloudDir = cloudSessionsDir(TEST_UID);
    const localDir = localSessionsDir(TEST_UID);
    touch(path.join(cloudDir, 'D69594E0-CF31-424C-9318-30231197E3A9-gconv-cv1.jsonl'), 'cloud');
    touch(path.join(localDir, 'D69594E0-CF31-424C-9318-30231197E3A9-anon-x.jsonl'),    'local');

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    const stats = migrateLegacySessionIds(TEST_UID);

    expect(stats.renamed).toBe(2);
    expect(fs.existsSync(path.join(cloudDir, 'gconv-cv1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(localDir, 'anon-x.jsonl'))).toBe(true);
  });

  it('stamps .migrations and is a no-op on second invocation', async () => {
    const dir = cloudSessionsDir(TEST_UID);
    touch(path.join(dir, '99999999-agent-a1.jsonl'), 'first');

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    const first = migrateLegacySessionIds(TEST_UID);
    expect(first.renamed).toBe(1);
    expect(fs.existsSync(migrationsFile(TEST_UID))).toBe(true);

    // Second invocation: drop a fresh legacy file but it should be skipped (tag stamped).
    touch(path.join(dir, '99999999-skill-s2.jsonl'), 'should-not-rename');
    const second = migrateLegacySessionIds(TEST_UID);
    expect(second).toEqual({ scanned: 0, renamed: 0, alreadyMigrated: 0, conflicts: 0, fieldsRewritten: 0 });
    expect(fs.existsSync(path.join(dir, '99999999-skill-s2.jsonl'))).toBe(true);
  });

  it('preserves the source file on conflict (target name already taken) — manual triage path', async () => {
    const dir = cloudSessionsDir(TEST_UID);
    touch(path.join(dir, '99999999-agent-a1.jsonl'), 'legacy');
    touch(path.join(dir, 'agent-a1.jsonl'),           'kept');

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    const stats = migrateLegacySessionIds(TEST_UID);

    expect(stats.conflicts).toBe(1);
    expect(stats.renamed).toBe(0);
    // Both files survive; new-format content not overwritten by legacy
    expect(fs.existsSync(path.join(dir, '99999999-agent-a1.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'agent-a1.jsonl'), 'utf8')).toBe('kept');
  });

  it('handles missing sessions dir (fresh uid, never had sessions) by stamping & returning zeros', async () => {
    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    const stats = migrateLegacySessionIds(TEST_UID);
    expect(stats).toEqual({ scanned: 0, renamed: 0, alreadyMigrated: 0, conflicts: 0, fieldsRewritten: 0 });
    // Still stamped so we don't re-scan on every boot
    expect(fs.existsSync(migrationsFile(TEST_UID))).toBe(true);
  });

  it('handles doubled prefix (aiteam-<uid>-<kind>-…) — single pass strips both', async () => {
    const dir = cloudSessionsDir(TEST_UID);
    touch(path.join(dir, 'aiteam-99999999-gconv-cv1.jsonl'), 'doubled');

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    migrateLegacySessionIds(TEST_UID);

    expect(fs.existsSync(path.join(dir, 'gconv-cv1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'aiteam-99999999-gconv-cv1.jsonl'))).toBe(false);
  });

  // Why this matters (regression from real user data, 2026-05-15): renaming the jsonl files
  // alone wasn't enough — `cloud/chats/_index.json` persists each conversation's session_id,
  // and reads come through there. Without this rewrite, opening any pre-migration chat hands
  // the old dashed session_id back to session-store, which creates a fresh dashed jsonl in
  // the directory the migration just cleaned. The "renamed=6" log fires, then within minutes
  // 6 dashed files reappear because the index pulled them back.
  it('rewrites session_id field inside cloud/chats/_index.json', async () => {
    touch(chatsIndexFile(TEST_UID), JSON.stringify([
      { conversation_id: 'cv1', session_id: '99999999-gconv-cv1', title: 'a' },
      { conversation_id: 'cv2', session_id: 'D69594E0-CF31-424C-9318-30231197E3A9-gconv-cv2', title: 'b' },
      { conversation_id: 'cv3', session_id: 'gconv-cv3', title: 'already migrated' },
    ]));

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    const stats = migrateLegacySessionIds(TEST_UID);

    expect(stats.fieldsRewritten).toBe(2);
    const after = JSON.parse(fs.readFileSync(chatsIndexFile(TEST_UID), 'utf8'));
    expect(after[0].session_id).toBe('gconv-cv1');
    expect(after[1].session_id).toBe('gconv-cv2');
    expect(after[2].session_id).toBe('gconv-cv3');
    // Other fields preserved.
    expect(after[0].title).toBe('a');
    expect(after[1].title).toBe('b');
  });

  it('rewrites session_id inside agent / skill chat.json edit-meta files', async () => {
    touch(agentChatMetaFile(TEST_UID, 'a1'), JSON.stringify({
      session_id: 'D69594E0-CF31-424C-9318-30231197E3A9-agent-a1',
      otherField: 'kept',
    }));
    touch(skillChatMetaFile(TEST_UID, 's1'), JSON.stringify({
      session_id: 'aiteam-99999999-skill-s1',
    }));

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    const stats = migrateLegacySessionIds(TEST_UID);

    expect(stats.fieldsRewritten).toBe(2);
    const a = JSON.parse(fs.readFileSync(agentChatMetaFile(TEST_UID, 'a1'), 'utf8'));
    expect(a.session_id).toBe('agent-a1');
    expect(a.otherField).toBe('kept');
    const s = JSON.parse(fs.readFileSync(skillChatMetaFile(TEST_UID, 's1'), 'utf8'));
    expect(s.session_id).toBe('skill-s1');
  });

  it('skips chat.json files whose session_id is already in new format', async () => {
    touch(agentChatMetaFile(TEST_UID, 'a1'), JSON.stringify({ session_id: 'agent-a1' }));

    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    const stats = migrateLegacySessionIds(TEST_UID);

    expect(stats.fieldsRewritten).toBe(0);
  });

  it('tolerates missing chats/ directory (fresh user with no conversations)', async () => {
    const { migrateLegacySessionIds } = await import('../../../src/main/util/migrate-session-ids');
    expect(() => migrateLegacySessionIds(TEST_UID)).not.toThrow();
  });
});
