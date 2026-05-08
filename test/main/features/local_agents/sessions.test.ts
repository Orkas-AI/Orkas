import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const TEST_CID = 'c1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-sessions-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadSessions() {
  return import('../../../../src/main/features/local_agents/sessions');
}

describe('local_agents/sessions', () => {
  it('returns null when no binding exists', async () => {
    const s = await loadSessions();
    expect(await s.getSessionId(TEST_UID, TEST_CID, 'agent-x', 'claude')).toBeNull();
  });

  it('round-trips a session id for the same (cid, aid, cli)', async () => {
    const s = await loadSessions();
    await s.setSessionId(TEST_UID, TEST_CID, 'agent-x', 'claude', 'sess-1');
    expect(await s.getSessionId(TEST_UID, TEST_CID, 'agent-x', 'claude')).toBe('sess-1');
  });

  it('invalidates the binding when the CLI changes (runtime swap)', async () => {
    const s = await loadSessions();
    await s.setSessionId(TEST_UID, TEST_CID, 'agent-x', 'claude', 'sess-1');
    // Same agent, different CLI → stale; should miss.
    expect(await s.getSessionId(TEST_UID, TEST_CID, 'agent-x', 'codex')).toBeNull();
    // Original binding still readable for the original CLI.
    expect(await s.getSessionId(TEST_UID, TEST_CID, 'agent-x', 'claude')).toBe('sess-1');
  });

  it('overwrites the binding when set is called again', async () => {
    const s = await loadSessions();
    await s.setSessionId(TEST_UID, TEST_CID, 'agent-x', 'claude', 'sess-1');
    await s.setSessionId(TEST_UID, TEST_CID, 'agent-x', 'claude', 'sess-2');
    expect(await s.getSessionId(TEST_UID, TEST_CID, 'agent-x', 'claude')).toBe('sess-2');
  });

  it('isolates bindings per agent', async () => {
    const s = await loadSessions();
    await s.setSessionId(TEST_UID, TEST_CID, 'agent-a', 'claude', 'sess-a');
    await s.setSessionId(TEST_UID, TEST_CID, 'agent-b', 'claude', 'sess-b');
    expect(await s.getSessionId(TEST_UID, TEST_CID, 'agent-a', 'claude')).toBe('sess-a');
    expect(await s.getSessionId(TEST_UID, TEST_CID, 'agent-b', 'claude')).toBe('sess-b');
  });

  it('clearForAgent drops only the targeted entry; deletes file when last', async () => {
    const s = await loadSessions();
    await s.setSessionId(TEST_UID, TEST_CID, 'agent-a', 'claude', 'sess-a');
    await s.setSessionId(TEST_UID, TEST_CID, 'agent-b', 'claude', 'sess-b');
    await s.clearForAgent(TEST_UID, TEST_CID, 'agent-a');
    expect(await s.getSessionId(TEST_UID, TEST_CID, 'agent-a', 'claude')).toBeNull();
    expect(await s.getSessionId(TEST_UID, TEST_CID, 'agent-b', 'claude')).toBe('sess-b');
    await s.clearForAgent(TEST_UID, TEST_CID, 'agent-b');
    expect(await s.getSessionId(TEST_UID, TEST_CID, 'agent-b', 'claude')).toBeNull();
  });

  it('clearForConversation removes the file entirely', async () => {
    const s = await loadSessions();
    await s.setSessionId(TEST_UID, TEST_CID, 'agent-a', 'claude', 'sess-a');
    await s.setSessionId(TEST_UID, TEST_CID, 'agent-b', 'claude', 'sess-b');
    await s.clearForConversation(TEST_UID, TEST_CID);
    expect(await s.getSessionId(TEST_UID, TEST_CID, 'agent-a', 'claude')).toBeNull();
    expect(await s.getSessionId(TEST_UID, TEST_CID, 'agent-b', 'claude')).toBeNull();
    // File must be gone, not just empty.
    const file = path.join(tmpDir, TEST_UID, 'local', 'cli-sessions', `${TEST_CID}.json`);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('clearForConversation is a no-op when nothing exists', async () => {
    const s = await loadSessions();
    await expect(s.clearForConversation(TEST_UID, TEST_CID)).resolves.toBeUndefined();
  });

  it('setSessionId with empty id is a no-op', async () => {
    const s = await loadSessions();
    await s.setSessionId(TEST_UID, TEST_CID, 'agent-x', 'claude', '');
    expect(await s.getSessionId(TEST_UID, TEST_CID, 'agent-x', 'claude')).toBeNull();
  });

  it('isolates bindings per conversation', async () => {
    const s = await loadSessions();
    await s.setSessionId(TEST_UID, 'c1', 'agent-a', 'claude', 'sess-c1');
    await s.setSessionId(TEST_UID, 'c2', 'agent-a', 'claude', 'sess-c2');
    expect(await s.getSessionId(TEST_UID, 'c1', 'agent-a', 'claude')).toBe('sess-c1');
    expect(await s.getSessionId(TEST_UID, 'c2', 'agent-a', 'claude')).toBe('sess-c2');
    await s.clearForConversation(TEST_UID, 'c1');
    expect(await s.getSessionId(TEST_UID, 'c1', 'agent-a', 'claude')).toBeNull();
    expect(await s.getSessionId(TEST_UID, 'c2', 'agent-a', 'claude')).toBe('sess-c2');
  });
});
