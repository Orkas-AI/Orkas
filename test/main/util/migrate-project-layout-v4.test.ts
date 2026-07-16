import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-layout-v4-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrateProjectLayoutV4', () => {
  it('moves project-scoped legacy data into the project-contained layout and records structural moves', async () => {
    const p = await import('../../../src/main/paths');
    const { migrateProjectLayoutV4 } = await import('../../../src/main/util/migrate-project-layout-v4');
    const uid = 'u1';
    const pid = 'p1';
    const cid = 'c1';
    const otherCid = 'c2';
    const taskId = 'at_11111111';

    writeJson(p.projectMetaFile(uid, pid), { project_id: pid, name: 'Project One' });
    writeJson(path.join(p.userChatsDir(uid), '_index.json'), [
      {
        conversation_id: cid,
        title: 'Project chat',
        kind: 'normal',
        agent_id: 'a1',
        skill_id: '',
        session_id: `gconv-${cid}`,
        project_id: pid,
        created_at: '2026-07-01T00:00:00',
        updated_at: '2026-07-01T00:01:00',
      },
      {
        conversation_id: otherCid,
        title: 'Global chat',
        kind: 'normal',
        agent_id: '',
        skill_id: '',
        session_id: `gconv-${otherCid}`,
        created_at: '2026-07-01T00:00:00',
        updated_at: '2026-07-01T00:02:00',
      },
    ]);
    writeText(path.join(p.userChatsDir(uid), `${cid}.jsonl`), '{"from":"user","text":"hi"}\n');
    writeText(path.join(p.userChatsDir(uid), `${otherCid}.jsonl`), '{"from":"user","text":"global"}\n');
    writeJson(path.join(p.userChatsDir(uid), cid, 'meta.json'), { conversation_id: cid, title: 'Project chat', project_id: pid });
    writeJson(path.join(p.userChatsDir(uid), cid, 'members.json'), { version: 1, actors: [] });
    writeJson(path.join(p.userChatsDir(uid), cid, 'state.json'), { version: 1, status: 'idle', last_active_at: '2026-07-01T00:01:00', in_flight: [] });

    writeText(p.userSessionFile(uid, `gconv-${cid}`), '{"role":"user","content":"hi"}\n');
    writeJson(`${p.userSessionFile(uid, `gconv-${cid}`)}.context.json`, { compacted: false });
    writeText(p.userSessionFile(uid, `gmember-${cid}-a1`), '{"role":"assistant","content":"ok"}\n');
    writeText(path.join(p.sessionCloudToolResultsDir(uid, `gmember-${cid}-a1`), 'out.txt'), 'tool output');

    writeText(path.join(p.chatAttachmentDir(uid, cid), 'note.txt'), 'attachment');
    writeText(path.join(p.chatArtifactCidDir(uid, cid), 'art1', 'index.html'), '<html></html>');

    writeJson(p.autoTaskConfigFile(uid, taskId), {
      id: taskId,
      enabled: true,
      content: 'daily project task',
      project_id: pid,
      schedule: { type: 'daily', hour: 9, minute: 0 },
      created_at: '2026-07-01T00:00:00',
      updated_at: '2026-07-01T00:00:00',
    });
    writeText(path.join(p.autoTaskAttachmentsDir(uid, taskId), 'brief.md'), '# brief');

    writeText(path.join(p.projectLegacyFilesDir(uid, pid), 'notes', 'spec.md'), '# spec');

    const staleLock = path.join(p.userLocalRoot(uid), 'migrations', 'project-layout-v4.lock');
    writeJson(staleLock, { pid: 999_999_999, started_at_ms: Date.now() - 60_000 });

    const stats = migrateProjectLayoutV4(uid);

    expect(stats.moved_conversations).toBe(1);
    expect(fs.existsSync(p.projectChatJsonlFile(uid, pid, cid))).toBe(true);
    expect(fs.existsSync(path.join(p.userChatsDir(uid), `${cid}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(p.userChatsDir(uid), `${otherCid}.jsonl`))).toBe(true);

    const globalIndex = JSON.parse(fs.readFileSync(path.join(p.userChatsDir(uid), '_index.json'), 'utf8'));
    expect(globalIndex.map((row: any) => row.conversation_id)).toEqual([otherCid]);
    const projectIndex = JSON.parse(fs.readFileSync(p.projectChatIndexFile(uid, pid), 'utf8'));
    expect(projectIndex.map((row: any) => row.conversation_id)).toEqual([cid]);

    expect(fs.existsSync(p.projectSessionFile(uid, pid, `gconv-${cid}`))).toBe(true);
    expect(fs.existsSync(`${p.projectSessionFile(uid, pid, `gconv-${cid}`)}.context.json`)).toBe(true);
    expect(fs.existsSync(p.projectSessionFile(uid, pid, `gmember-${cid}-a1`))).toBe(true);
    expect(fs.existsSync(path.join(p.projectSessionCloudToolResultsDir(uid, pid, `gmember-${cid}-a1`), 'out.txt'))).toBe(true);

    expect(fs.existsSync(path.join(p.projectChatAttachmentDir(uid, pid, cid), 'note.txt'))).toBe(true);
    expect(fs.existsSync(path.join(p.projectChatArtifactCidDir(uid, pid, cid), 'art1', 'index.html'))).toBe(true);
    expect(fs.existsSync(p.projectAutoTaskConfigFile(uid, pid, taskId))).toBe(true);
    expect(fs.existsSync(path.join(p.projectAutoTaskAttachmentsDir(uid, pid, taskId), 'brief.md'))).toBe(true);
    expect(fs.existsSync(path.join(p.projectFilesDir(uid, pid), 'notes', 'spec.md'))).toBe(true);
    expect(fs.existsSync(path.join(p.projectLegacyFilesDir(uid, pid), 'notes', 'spec.md'))).toBe(false);

    const moves = JSON.parse(fs.readFileSync(p.userSyncProjectLayoutMovesFile(uid), 'utf8'));
    const froms = new Set(moves.moves.map((row: any) => row.from));
    expect(froms.has(`cloud/chats/${cid}.jsonl`)).toBe(true);
    expect(froms.has(`cloud/projects/${pid}/files/notes/spec.md`)).toBe(true);
    expect(moves.moves.some((row: any) => row.to === `cloud/projects/${pid}/contexts/notes/spec.md`)).toBe(true);

    const marker = path.join(p.userLocalRoot(uid), 'migrations', 'project-layout-v4.json');
    expect(fs.existsSync(marker)).toBe(true);

    const stats2 = migrateProjectLayoutV4(uid);
    expect(stats2.moved_conversations).toBe(0);

    // Normal activation trusts the completed marker. Late legacy paths are
    // handled only by the explicit forced repair used after a sync pull.
    const lateCid = 'c3';
    writeJson(path.join(p.userChatsDir(uid), '_index.json'), [
      ...globalIndex,
      {
        conversation_id: lateCid,
        title: 'Late synced project chat',
        project_id: pid,
        created_at: '2026-07-02T00:00:00',
        updated_at: '2026-07-02T00:01:00',
      },
    ]);
    writeText(path.join(p.userChatsDir(uid), `${lateCid}.jsonl`), '{"from":"user","text":"late"}\n');

    const skipped = migrateProjectLayoutV4(uid);
    expect(skipped.moved_conversations).toBe(0);
    expect(fs.existsSync(path.join(p.userChatsDir(uid), `${lateCid}.jsonl`))).toBe(true);

    const forced = migrateProjectLayoutV4(uid, { force: true });
    expect(forced.moved_conversations).toBe(1);
    expect(fs.existsSync(p.projectChatJsonlFile(uid, pid, lateCid))).toBe(true);
  });

  it('replays a durable journal left by an interrupted move', async () => {
    const p = await import('../../../src/main/paths');
    const { migrateProjectLayoutV4 } = await import('../../../src/main/util/migrate-project-layout-v4');
    const uid = 'u2';
    const pid = 'p2';
    const cid = 'c2';
    const body = '{"from":"user","text":"recovered"}\n';
    const target = p.projectChatJsonlFile(uid, pid, cid);
    writeJson(p.projectMetaFile(uid, pid), { project_id: pid, name: 'Project Two' });
    writeText(target, body);

    const journal = path.join(p.userLocalRoot(uid), 'migrations', 'project-layout-v4.journal.jsonl');
    writeJson(path.join(p.userLocalRoot(uid), 'migrations', 'project-layout-v4.json'), {
      version: 4,
      migrated_at: '2026-07-01T00:00:00.000Z',
    });
    const row = {
      from: `cloud/chats/${cid}.jsonl`,
      to: `cloud/projects/${pid}/chats/${cid}.jsonl`,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      size: Buffer.byteLength(body),
    };
    writeText(journal, `${JSON.stringify(row)}\n`);

    const stats = migrateProjectLayoutV4(uid);
    const moves = JSON.parse(fs.readFileSync(p.userSyncProjectLayoutMovesFile(uid), 'utf8'));
    expect(stats.move_log_entries).toBe(1);
    expect(moves.moves).toContainEqual(row);
    expect(fs.existsSync(journal)).toBe(false);
  });

  it('preserves divergent legacy bytes under migration_conflicts', async () => {
    const p = await import('../../../src/main/paths');
    const { migrateProjectLayoutV4 } = await import('../../../src/main/util/migrate-project-layout-v4');
    const uid = 'u3';
    const pid = 'p3';
    const cid = 'c3';
    const legacyBody = '{"from":"user","text":"legacy edit"}\n';
    const currentBody = '{"from":"user","text":"current edit"}\n';
    writeJson(p.projectMetaFile(uid, pid), { project_id: pid, name: 'Project Three' });
    writeJson(path.join(p.userChatsDir(uid), '_index.json'), [{
      conversation_id: cid,
      project_id: pid,
      created_at: '2026-07-01T00:00:00',
      updated_at: '2026-07-01T00:01:00',
    }]);
    writeText(path.join(p.userChatsDir(uid), `${cid}.jsonl`), legacyBody);
    writeText(p.projectChatJsonlFile(uid, pid, cid), currentBody);

    const stats = migrateProjectLayoutV4(uid);
    const digest = crypto.createHash('sha256').update(legacyBody).digest('hex').slice(0, 8);
    const preserved = path.join(
      p.projectDir(uid, pid),
      'migration_conflicts',
      'chats',
      `${cid}.legacy-v4-${digest}.jsonl`,
    );
    expect(stats.warnings.some((warning) => warning.includes('preserved legacy file'))).toBe(true);
    expect(fs.readFileSync(p.projectChatJsonlFile(uid, pid, cid), 'utf8')).toBe(currentBody);
    expect(fs.readFileSync(preserved, 'utf8')).toBe(legacyBody);
    expect(fs.existsSync(path.join(p.userChatsDir(uid), `${cid}.jsonl`))).toBe(false);
  });
});
