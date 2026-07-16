import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;

const TEST_UID = 'u-ghost';

function chatsDir(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'chats');
}

function indexFile(): string {
  return path.join(chatsDir(), '_index.json');
}

function migrationsFile(): string {
  return path.join(tmpDir, TEST_UID, 'local', '.migrations');
}

const GHOST_MIGRATION_TAG = 'chats-index-ghost-tombstones-v2';

function migrationTags(): string[] {
  if (!fs.existsSync(migrationsFile())) return [];
  return fs.readFileSync(migrationsFile(), 'utf8').split('\n').filter(Boolean);
}

function writeIndex(rows: unknown[]): void {
  fs.mkdirSync(chatsDir(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(rows, null, 2));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chat-ghost-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrate-chats-ghost-cleanup', () => {
  it('does not stamp when _index.json is absent so a later cloud pull can still be cleaned', async () => {
    const { migrateChatsGhostCleanup } = await import('../../../src/main/util/migrate-chats-ghost-cleanup');
    const stats = migrateChatsGhostCleanup(TEST_UID, Date.parse('2026-05-29T00:00:00Z'));

    expect(stats.tombstoned).toBe(0);
    // Project-root discovery may stamp its own layout migration. The ghost
    // cleanup itself must remain unstamped so a later cloud index can run it.
    expect(migrationTags()).not.toContain(GHOST_MIGRATION_TAG);
  });

  it('turns stale index rows with missing jsonl into sync tombstones', async () => {
    writeIndex([
      {
        conversation_id: 'gone123',
        title: 'ghost',
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
      {
        conversation_id: 'alive123',
        title: 'real',
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
    ]);
    fs.writeFileSync(path.join(chatsDir(), 'alive123.jsonl'), '{"id":"m1"}\n');

    const { migrateChatsGhostCleanup } = await import('../../../src/main/util/migrate-chats-ghost-cleanup');
    const stats = migrateChatsGhostCleanup(TEST_UID, Date.parse('2026-05-29T00:00:00Z'));

    expect(stats.tombstoned).toBe(1);
    const after = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    const gone = after.find((r: any) => r.conversation_id === 'gone123');
    const alive = after.find((r: any) => r.conversation_id === 'alive123');
    expect(gone.deleted_at).toBeTruthy();
    expect(gone.updated_at).toBe(gone.deleted_at);
    expect(alive.deleted_at).toBeUndefined();
    expect(migrationTags()).toContain(GHOST_MIGRATION_TAG);
  });

  it('skips recent missing rows so a partial pull does not self-delete a fresh conversation', async () => {
    writeIndex([
      {
        conversation_id: 'fresh123',
        title: 'fresh',
        created_at: '2026-05-29T00:00:00Z',
        updated_at: '2026-05-29T00:00:00Z',
      },
    ]);

    const { migrateChatsGhostCleanup } = await import('../../../src/main/util/migrate-chats-ghost-cleanup');
    const stats = migrateChatsGhostCleanup(TEST_UID, Date.parse('2026-05-29T00:02:00Z'));

    expect(stats.tombstoned).toBe(0);
    expect(stats.skippedRecent).toBe(1);
    const after = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    expect(after[0].deleted_at).toBeUndefined();
  });

  it('stamps and no-ops on the second run', async () => {
    writeIndex([
      {
        conversation_id: 'gone123',
        title: 'ghost',
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
    ]);

    const { migrateChatsGhostCleanup } = await import('../../../src/main/util/migrate-chats-ghost-cleanup');
    expect(migrateChatsGhostCleanup(TEST_UID, Date.parse('2026-05-29T00:00:00Z')).tombstoned).toBe(1);

    const second = migrateChatsGhostCleanup(TEST_UID, Date.parse('2026-05-30T00:00:00Z'));
    expect(second).toEqual({
      scanned: 0,
      tombstoned: 0,
      alreadyDeleted: 0,
      skippedRecent: 0,
      warnings: 0,
    });
  });
});
