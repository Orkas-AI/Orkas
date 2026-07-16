import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const listActiveConversationIds = vi.fn();
vi.mock('../../../src/main/features/chats', () => ({ listActiveConversationIds }));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-sessions-sweep-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  listActiveConversationIds.mockReset();
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSession(dir: string, sid: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, '{}\n');
  return file;
}

describe('sessions_sweep', () => {
  it('loads active conversations once for global and project session roots', async () => {
    listActiveConversationIds.mockResolvedValue(['livecid']);
    const globalDir = path.join(tmpDir, TEST_UID, 'cloud', 'sessions');
    const projectRoot = path.join(tmpDir, TEST_UID, 'cloud', 'projects', 'p1');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'project.json'), '{"project_id":"p1"}');
    const liveGlobal = writeSession(globalDir, 'gconv-livecid');
    const orphanGlobal = writeSession(globalDir, 'gconv-orphancid');
    const liveProject = writeSession(path.join(projectRoot, 'sessions'), 'gmember-livecid-agent1');

    const sweep = await import('../../../src/main/features/sessions_sweep');
    const result = await sweep.sweepSessions(TEST_UID);

    expect(listActiveConversationIds).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(liveGlobal)).toBe(true);
    expect(fs.existsSync(liveProject)).toBe(true);
    expect(fs.existsSync(orphanGlobal)).toBe(false);
    expect(result.orphan_cid).toBe(1);
  });

  it('keeps cid-bound sessions when the conversation snapshot fails', async () => {
    listActiveConversationIds.mockRejectedValue(new Error('index unavailable'));
    const file = writeSession(
      path.join(tmpDir, TEST_UID, 'cloud', 'sessions'),
      'gconv-keepwhenunknown',
    );

    const sweep = await import('../../../src/main/features/sessions_sweep');
    const result = await sweep.sweepSessions(TEST_UID);

    expect(fs.existsSync(file)).toBe(true);
    expect(result.orphan_cid).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('stops before deleting sessions when the maintenance signal is cancelled', async () => {
    listActiveConversationIds.mockResolvedValue([]);
    const orphan = writeSession(
      path.join(tmpDir, TEST_UID, 'cloud', 'sessions'),
      'gconv-orphancid',
    );
    const controller = new AbortController();
    controller.abort();

    const sweep = await import('../../../src/main/features/sessions_sweep');
    const result = await sweep.sweepSessions(TEST_UID, controller.signal);

    expect(result.cancelled).toBe(true);
    expect(listActiveConversationIds).not.toHaveBeenCalled();
    expect(fs.existsSync(orphan)).toBe(true);
  });
});
