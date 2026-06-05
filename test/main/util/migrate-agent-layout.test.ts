import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Migration utility: agents/<aid>.json + meta/<aid>/* → agents/<aid>/{agent.json, meta/}
// 详见 src/main/util/migrate-agent-layout.ts + docs/plans/agent-as-directory.md。

let tmpDir: string;
let prevWs: string | undefined;

const TEST_UID = 'u1';

function agentsRoot(uid: string): string {
  return path.join(tmpDir, uid, 'cloud', 'agents');
}
function oldMetaRoot(uid: string): string {
  return path.join(tmpDir, uid, 'cloud', 'meta');
}
function migrationsFile(uid: string): string {
  return path.join(tmpDir, uid, 'local', '.migrations');
}
function ensure(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-migrate-agent-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrate-agent-layout', () => {
  it('moves <aid>.json → <aid>/agent.json', async () => {
    ensure(agentsRoot(TEST_UID));
    fs.writeFileSync(path.join(agentsRoot(TEST_UID), 'a1.json'), '{"agent_id":"a1","name":"X"}');

    const { migrateAgentLayout } = await import('../../../src/main/util/migrate-agent-layout');
    const stats = migrateAgentLayout(TEST_UID);

    expect(stats.agentsConverted).toBe(1);
    expect(fs.existsSync(path.join(agentsRoot(TEST_UID), 'a1', 'agent.json'))).toBe(true);
    expect(fs.existsSync(path.join(agentsRoot(TEST_UID), 'a1.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(agentsRoot(TEST_UID), 'a1', 'agent.json'), 'utf8'))).toEqual({
      agent_id: 'a1', name: 'X',
    });
  });

  it('moves cloud/meta/<aid>/*.md → cloud/agents/<aid>/meta/*.md', async () => {
    ensure(path.join(agentsRoot(TEST_UID), 'a1'));
    fs.writeFileSync(path.join(agentsRoot(TEST_UID), 'a1', 'agent.json'), '{}');
    ensure(path.join(oldMetaRoot(TEST_UID), 'a1'));
    fs.writeFileSync(path.join(oldMetaRoot(TEST_UID), 'a1', 'COMPETENCE.md'), 'comp body');
    fs.writeFileSync(path.join(oldMetaRoot(TEST_UID), 'a1', 'LEARNING_STRATEGIES.md'), 'strat body');

    const { migrateAgentLayout } = await import('../../../src/main/util/migrate-agent-layout');
    const stats = migrateAgentLayout(TEST_UID);

    expect(stats.metaMoved).toBe(2);
    const newMeta = path.join(agentsRoot(TEST_UID), 'a1', 'meta');
    expect(fs.readFileSync(path.join(newMeta, 'COMPETENCE.md'), 'utf8')).toBe('comp body');
    expect(fs.readFileSync(path.join(newMeta, 'LEARNING_STRATEGIES.md'), 'utf8')).toBe('strat body');
    // 旧目录清掉
    expect(fs.existsSync(oldMetaRoot(TEST_UID))).toBe(false);
  });

  it('handles flat + meta combo end-to-end', async () => {
    ensure(agentsRoot(TEST_UID));
    fs.writeFileSync(path.join(agentsRoot(TEST_UID), 'a1.json'), '{"agent_id":"a1"}');
    ensure(path.join(oldMetaRoot(TEST_UID), 'a1'));
    fs.writeFileSync(path.join(oldMetaRoot(TEST_UID), 'a1', 'COMPETENCE.md'), 'c');

    const { migrateAgentLayout } = await import('../../../src/main/util/migrate-agent-layout');
    migrateAgentLayout(TEST_UID);

    const newRoot = path.join(agentsRoot(TEST_UID), 'a1');
    expect(fs.existsSync(path.join(newRoot, 'agent.json'))).toBe(true);
    expect(fs.existsSync(path.join(newRoot, 'meta', 'COMPETENCE.md'))).toBe(true);
  });

  it('is idempotent — second run is no-op', async () => {
    ensure(agentsRoot(TEST_UID));
    fs.writeFileSync(path.join(agentsRoot(TEST_UID), 'a1.json'), '{}');

    const { migrateAgentLayout } = await import('../../../src/main/util/migrate-agent-layout');
    const first = migrateAgentLayout(TEST_UID);
    expect(first.agentsConverted).toBe(1);
    expect(fs.existsSync(migrationsFile(TEST_UID))).toBe(true);

    // 第二次:再放一个 flat agent 进来,应当因盖章而**不被处理**
    ensure(agentsRoot(TEST_UID));
    fs.writeFileSync(path.join(agentsRoot(TEST_UID), 'a2.json'), '{}');
    const second = migrateAgentLayout(TEST_UID);
    expect(second).toEqual({ agentsConverted: 0, metaMoved: 0, warnings: 0 });
    // a2.json 仍以 flat 形式留着(没被搬,盖章了)
    expect(fs.existsSync(path.join(agentsRoot(TEST_UID), 'a2.json'))).toBe(true);
  });

  it('force-scans late flat agents after the migration stamp exists', async () => {
    ensure(agentsRoot(TEST_UID));
    fs.writeFileSync(path.join(agentsRoot(TEST_UID), 'a1.json'), '{}');

    const { migrateAgentLayout } = await import('../../../src/main/util/migrate-agent-layout');
    migrateAgentLayout(TEST_UID);

    fs.writeFileSync(path.join(agentsRoot(TEST_UID), 'a2.json'), '{"agent_id":"a2"}');
    const forced = migrateAgentLayout(TEST_UID, { force: true });

    expect(forced.agentsConverted).toBe(1);
    expect(fs.existsSync(path.join(agentsRoot(TEST_UID), 'a2', 'agent.json'))).toBe(true);
    expect(fs.existsSync(path.join(agentsRoot(TEST_UID), 'a2.json'))).toBe(false);
  });

  it('drops redundant flat <aid>.json when <aid>/agent.json already exists', async () => {
    ensure(path.join(agentsRoot(TEST_UID), 'a1'));
    fs.writeFileSync(path.join(agentsRoot(TEST_UID), 'a1', 'agent.json'), '{"new":true}');
    fs.writeFileSync(path.join(agentsRoot(TEST_UID), 'a1.json'), '{"old":true}');

    const { migrateAgentLayout } = await import('../../../src/main/util/migrate-agent-layout');
    migrateAgentLayout(TEST_UID);

    expect(fs.existsSync(path.join(agentsRoot(TEST_UID), 'a1.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(agentsRoot(TEST_UID), 'a1', 'agent.json'), 'utf8'))).toEqual({ new: true });
  });

  it('handles no-op uid (no agents, no meta) — stamps and returns zeros', async () => {
    const { migrateAgentLayout } = await import('../../../src/main/util/migrate-agent-layout');
    const stats = migrateAgentLayout(TEST_UID);
    expect(stats).toEqual({ agentsConverted: 0, metaMoved: 0, warnings: 0 });
    expect(fs.existsSync(migrationsFile(TEST_UID))).toBe(true);
  });
});
