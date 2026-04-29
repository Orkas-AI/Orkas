import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Session-store path routing — no LLM calls here, just `sessionFileFor`
// plumbing. The gate guards a real bug we fixed earlier: extract/organizer
// session jsonls used to land in a shared top-level dir (feature name in
// the first segment instead of the uid), which leaked across users.
//
// CRITICAL: this file previously called `activateUser(uid)` in `beforeAll`
// WITHOUT setting ORKAS_WORKSPACE_ROOT first, so the real `PC/data/`
// received a `data/<uid>/` skeleton + a rewritten `users.json` every time
// the test suite ran. Reproduce the fix by keeping the workspace pinned to
// a per-run tmp dir and resetting the module graph so `paths.ts` picks it
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

// `sessionFileFor` and `WS_ROOT` must be dynamic-imported inside each test
// so they pick up the post-reset module graph (importing at the top would
// capture the stale default `WS_ROOT` before beforeAll runs).
async function loadRouting() {
  const { sessionFileFor } = await import('../../../src/main/model/core-agent/session-store');
  const { WS_ROOT } = await import('../../../src/main/paths');
  return { sessionFileFor, expectDir: path.join(WS_ROOT, uid, 'cloud', 'sessions') };
}

describe('session-store.sessionFileFor', () => {
  it('routes gconv session to <uid>/cloud/sessions/', async () => {
    const { sessionFileFor, expectDir } = await loadRouting();
    const id = `${uid}-gconv-abcdef123456`;
    expect(sessionFileFor(id)).toBe(path.join(expectDir, `${id}.jsonl`));
  });

  it('routes gmember session to <uid>/cloud/sessions/', async () => {
    const { sessionFileFor, expectDir } = await loadRouting();
    const id = `${uid}-gmember-cid01-agentX`;
    expect(sessionFileFor(id)).toBe(path.join(expectDir, `${id}.jsonl`));
  });

  it('routes skill-edit session to <uid>/cloud/sessions/', async () => {
    const { sessionFileFor, expectDir } = await loadRouting();
    const id = `${uid}-skill-my_skill_id`;
    expect(sessionFileFor(id)).toBe(path.join(expectDir, `${id}.jsonl`));
  });

  it('routes agent-edit session to <uid>/cloud/sessions/', async () => {
    const { sessionFileFor, expectDir } = await loadRouting();
    const id = `${uid}-agent-abcdef123456`;
    expect(sessionFileFor(id)).toBe(path.join(expectDir, `${id}.jsonl`));
  });

  it('routes extract-img session to <uid>/cloud/sessions/', async () => {
    const { sessionFileFor, expectDir } = await loadRouting();
    const id = `${uid}-extract-img-077355b2`;
    expect(sessionFileFor(id)).toBe(path.join(expectDir, `${id}.jsonl`));
  });

  it('routes reflect / memory-extract / anon kinds (compound names ok)', async () => {
    const { sessionFileFor, expectDir } = await loadRouting();
    for (const id of [
      `${uid}-reflect-abc123`,
      `${uid}-memory-extract-1234567890`,
      `${uid}-anon-12345678`,
    ]) {
      expect(sessionFileFor(id)).toBe(path.join(expectDir, `${id}.jsonl`));
    }
  });

  it('preserves legacy kinds (organizer / sub / conv) — content not regenerated, but reads still resolve', async () => {
    // Migration strips brand prefix but leaves legacy kinds intact so users
    // can still open old transcripts. session-store accepts them as-is.
    const { sessionFileFor, expectDir } = await loadRouting();
    for (const id of [
      `${uid}-conv-abcdef123456`,
      `${uid}-sub-parentcid01-call01`,
      `${uid}-organizer-7a5432a7`,
      `${uid}-organizer-refine-e1cc9374`,
    ]) {
      expect(sessionFileFor(id)).toBe(path.join(expectDir, `${id}.jsonl`));
    }
  });

  it('REJECTS legacy brand-prefixed ids (orkas- / aiteam-)', async () => {
    // After migration these should never reach session-store; if a stale
    // call site somehow still emits one, fail loud rather than route it.
    const { sessionFileFor } = await loadRouting();
    expect(() => sessionFileFor(`orkas-${uid}-agent-abcdef123456`))
      .toThrow(/invalid session id/);
    expect(() => sessionFileFor(`aiteam-${uid}-agent-abcdef123456`))
      .toThrow(/invalid session id/);
  });

  it('REJECTS legacy "kind-first" format (uid in second slot)', async () => {
    // Regression guard: old-style id `extract-img-<uid>-<hex>` would
    // previously route to data/extract/sessions/ via a lax regex.
    const { sessionFileFor } = await loadRouting();
    expect(() => sessionFileFor(`extract-img-${uid}-077355b2`))
      .toThrow(/invalid session id/);
    expect(() => sessionFileFor(`organizer-${uid}-abc123`))
      .toThrow(/invalid session id/);
  });

  it('REJECTS id for a different uid', async () => {
    const { sessionFileFor } = await loadRouting();
    expect(() => sessionFileFor('99999999-gconv-abc'))
      .toThrow(/invalid session id/);
  });

  it('REJECTS unrelated string', async () => {
    const { sessionFileFor } = await loadRouting();
    expect(() => sessionFileFor('hello-world'))
      .toThrow(/invalid session id/);
  });

  it('REJECTS missing tail after uid', async () => {
    const { sessionFileFor } = await loadRouting();
    expect(() => sessionFileFor(`${uid}-`))
      .toThrow(/invalid session id/);
  });
});
