import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Session-store path routing — no LLM calls here, just `sessionFileFor` plumbing. The format
// is now `<kind>-<tail>` (CLAUDE.md §5 — uid no longer in session_id, since the path root
// `<activeUid>/{cloud,local}/sessions/<sid>.jsonl` already scopes by user). The router picks
// cloud vs local based on whether the kind is ephemeral (extract-img / reflect / memory-extract
// / anon → local; gconv / gmember / skill / agent → cloud).
//
// CRITICAL: this file previously called `activateUser(uid)` in `beforeAll` WITHOUT setting
// ORKAS_WORKSPACE_ROOT first, so the real `PC/data/` received a `data/<uid>/` skeleton + a
// rewritten `users.json` every time the test suite ran. Reproduce the fix by keeping the
// workspace pinned to a per-run tmp dir and resetting the module graph so `paths.ts` picks it
// up before anything imports `users`.

let tmpDir: string;
let prevWs: string | undefined;
const uid = '12155733';

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-sstore-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(uid);
});

afterAll(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// `sessionFileFor` and `WS_ROOT` must be dynamic-imported inside each test so they pick up
// the post-reset module graph (importing at the top would capture the stale default `WS_ROOT`
// before beforeAll runs).
async function loadRouting() {
  const { sessionFileFor } = await import('../../../src/main/model/core-agent/session-store');
  const { WS_ROOT } = await import('../../../src/main/paths');
  return {
    sessionFileFor,
    cloudDir: path.join(WS_ROOT, uid, 'cloud', 'sessions'),
    localDir: path.join(WS_ROOT, uid, 'local', 'sessions'),
  };
}

describe('session-store.sessionFileFor', () => {
  it('routes gconv → <uid>/cloud/sessions/', async () => {
    const { sessionFileFor, cloudDir } = await loadRouting();
    const id = 'gconv-abcdef123456';
    expect(sessionFileFor(id)).toBe(path.join(cloudDir, `${id}.jsonl`));
  });

  it('routes gmember → <uid>/cloud/sessions/', async () => {
    const { sessionFileFor, cloudDir } = await loadRouting();
    const id = 'gmember-cid01-agentX';
    expect(sessionFileFor(id)).toBe(path.join(cloudDir, `${id}.jsonl`));
  });

  it('routes skill-edit → <uid>/cloud/sessions/', async () => {
    const { sessionFileFor, cloudDir } = await loadRouting();
    const id = 'skill-my_skill_id';
    expect(sessionFileFor(id)).toBe(path.join(cloudDir, `${id}.jsonl`));
  });

  it('routes agent-edit → <uid>/cloud/sessions/', async () => {
    const { sessionFileFor, cloudDir } = await loadRouting();
    const id = 'agent-abcdef123456';
    expect(sessionFileFor(id)).toBe(path.join(cloudDir, `${id}.jsonl`));
  });

  it('routes ephemeral kinds (extract-img / reflect / memory-extract / anon) → <uid>/local/sessions/', async () => {
    const { sessionFileFor, localDir } = await loadRouting();
    for (const id of [
      'extract-img-077355b2',
      'reflect-abc123',
      'memory-extract-1234567890',
      'anon-12345678',
    ]) {
      expect(sessionFileFor(id)).toBe(path.join(localDir, `${id}.jsonl`));
    }
  });

  it('routes cli (devtools archive only) → <uid>/cloud/sessions/', async () => {
    // CLI dispatch sessions don't write a real jsonl (the CLI brings its own transcript), but
    // the id is used as the archive key and as the spill-dir anchor. Routing is still defined.
    const { sessionFileFor, cloudDir } = await loadRouting();
    const id = 'cli-claude-run42';
    expect(sessionFileFor(id)).toBe(path.join(cloudDir, `${id}.jsonl`));
  });

  it('REJECTS legacy uid-prefixed ids (`<uid>-<kind>-…`)', async () => {
    // Migration `migrateLegacySessionIds` rewrites these on activateUser; if a stale call site
    // still emits one, fail loud — silently routing it to a wrong-shaped filename in the
    // active user's dir would create dangling state.
    const { sessionFileFor } = await loadRouting();
    expect(() => sessionFileFor(`${uid}-gconv-abcdef123456`))
      .toThrow(/invalid session id/);
    expect(() => sessionFileFor('D69594E0-CF31-424C-9318-30231197E3A9-gconv-abc'))
      .toThrow(/invalid session id/);
  });

  it('REJECTS legacy brand-prefixed ids (orkas- / aiteam-)', async () => {
    const { sessionFileFor } = await loadRouting();
    expect(() => sessionFileFor('orkas-agent-abcdef123456'))
      .toThrow(/invalid session id/);
    expect(() => sessionFileFor('aiteam-agent-abcdef123456'))
      .toThrow(/invalid session id/);
  });

  it('REJECTS unrelated strings (no recognised kind keyword)', async () => {
    const { sessionFileFor } = await loadRouting();
    expect(() => sessionFileFor('hello-world'))
      .toThrow(/invalid session id/);
    expect(() => sessionFileFor('garbage'))
      .toThrow(/invalid session id/);
  });

  it('REJECTS empty string', async () => {
    const { sessionFileFor } = await loadRouting();
    expect(() => sessionFileFor(''))
      .toThrow(/invalid session id/);
  });
});
