import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Same setup shape as turn_buffer.test.ts — WS_ROOT swap + activateUser
// must run before any expert_signals import (storage caches active uid).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-skill-ineff-'));
process.env.ORKAS_WORKSPACE_ROOT = TMP;
fs.writeFileSync(path.join(TMP, 'users.json'),
  JSON.stringify({ current_user_id: '99999992', users: [{ user_id: '99999992', created_at: new Date().toISOString() }] }));
const UID = '99999992';

import { activateUser } from '../../../../src/main/features/users';
activateUser(UID);

import { createSkillTurnBuffer } from '../../../../src/main/features/expert_signals/turn_hooks';
import { querySignals } from '../../../../src/main/features/expert_signals';

async function wait() { return new Promise((r) => setTimeout(r, 30)); }

// Per CLAUDE.md §9: text-munging / extractor / decision branches must have
// fixture coverage for shapes that MUST emit (set A) AND shapes that MUST
// NOT (set B). The new skill_ineffective signal is a turn-end decision.

describe('SkillTurnBuffer.drainAndEmit › skill_ineffective — set A (emits)', () => {
  it('1 invoked + permanent errText → 1 skill_ineffective', async () => {
    const buf = createSkillTurnBuffer();
    buf.recordInvoked('search-docs', 'A.custom', 'read_file');
    const cid = 'cid-ineff-a1';
    buf.drainAndEmit({
      uid: UID, cid, aid: 'agent_x',
      turn_id: 'm_a1', msg_ids: ['m_a1'],
      errText: 'agent specification missing — file vanished mid-turn',
    });
    await wait();

    const sigs = await querySignals({ types: ['skill_ineffective'], cid });
    expect(sigs.length).toBe(1);
    expect(sigs[0].delta!.system).toBe('A.custom');
    expect(sigs[0].delta!.skill_id).toBe('search-docs');
    expect(sigs[0].turn_id).toBe('m_a1');
    expect(sigs[0].metadata!.error_kind).toBe('permanent');
    expect(typeof sigs[0].metadata!.error_excerpt).toBe('string');
  });

  it('multiple invoked across systems + permanent errText → 1 signal per skill', async () => {
    const buf = createSkillTurnBuffer();
    buf.recordInvoked('skill-a', 'A.custom', 'read_file');
    buf.recordInvoked('skill-b', 'A.platform', 'read_file');
    buf.recordInvoked('skill-c', 'B', 'read_file');
    const cid = 'cid-ineff-a2';
    buf.drainAndEmit({
      uid: UID, cid, aid: 'agent_x',
      turn_id: 'm_a2', msg_ids: ['m_a2'],
      errText: 'parse failure: invalid JSON in tool output',
    });
    await wait();

    const sigs = await querySignals({ types: ['skill_ineffective'], cid });
    expect(sigs.length).toBe(3);
    const bySkill = new Map(sigs.map((s) => [s.delta!.skill_id, s.delta!.system]));
    expect(bySkill.get('skill-a')).toBe('A.custom');
    expect(bySkill.get('skill-b')).toBe('A.platform');
    expect(bySkill.get('skill-c')).toBe('B');
  });

  it('error_excerpt is truncated to 200 chars', async () => {
    const buf = createSkillTurnBuffer();
    buf.recordInvoked('x', 'A.custom', 'read_file');
    const cid = 'cid-ineff-a3';
    const longErr = 'permanent failure: ' + 'X'.repeat(500);
    buf.drainAndEmit({
      uid: UID, cid, aid: 'agent_x',
      turn_id: 'm_a3', msg_ids: ['m_a3'],
      errText: longErr,
    });
    await wait();

    const sigs = await querySignals({ types: ['skill_ineffective'], cid });
    expect(sigs.length).toBe(1);
    expect((sigs[0].metadata!.error_excerpt as string).length).toBe(200);
  });
});

describe('SkillTurnBuffer.drainAndEmit › skill_ineffective — set B (does NOT emit)', () => {
  it('no invoked + permanent errText → 0 signals', async () => {
    const buf = createSkillTurnBuffer();
    // No invoked recorded.
    const cid = 'cid-ineff-b1';
    buf.drainAndEmit({
      uid: UID, cid, aid: 'agent_x',
      turn_id: 'm_b1', msg_ids: ['m_b1'],
      errText: 'permanent: spec missing',
    });
    await wait();

    const sigs = await querySignals({ types: ['skill_ineffective'], cid });
    expect(sigs.length).toBe(0);
  });

  it('invoked + empty errText → 0 signals (clean turn)', async () => {
    const buf = createSkillTurnBuffer();
    buf.recordInvoked('search-docs', 'A.custom', 'read_file');
    const cid = 'cid-ineff-b2';
    buf.drainAndEmit({
      uid: UID, cid, aid: 'agent_x',
      turn_id: 'm_b2', msg_ids: ['m_b2'],
      // errText omitted
    });
    await wait();

    const sigs = await querySignals({ types: ['skill_ineffective'], cid });
    expect(sigs.length).toBe(0);
  });

  it('invoked + transient errText (ECONNRESET) → 0 signals', async () => {
    const buf = createSkillTurnBuffer();
    buf.recordInvoked('search-docs', 'A.custom', 'read_file');
    const cid = 'cid-ineff-b3';
    buf.drainAndEmit({
      uid: UID, cid, aid: 'agent_x',
      turn_id: 'm_b3', msg_ids: ['m_b3'],
      errText: 'request failed: ECONNRESET',
    });
    await wait();

    const sigs = await querySignals({ types: ['skill_ineffective'], cid });
    expect(sigs.length).toBe(0);
  });

  it('invoked + transient errText (fetch failed) → 0 signals', async () => {
    const buf = createSkillTurnBuffer();
    buf.recordInvoked('search-docs', 'A.custom', 'read_file');
    const cid = 'cid-ineff-b4';
    buf.drainAndEmit({
      uid: UID, cid, aid: 'agent_x',
      turn_id: 'm_b4', msg_ids: ['m_b4'],
      errText: 'fetch failed at provider',
    });
    await wait();

    const sigs = await querySignals({ types: ['skill_ineffective'], cid });
    expect(sigs.length).toBe(0);
  });

  it('invoked + permanent errText + aborted=true → 0 signals (user-cancelled is not the skill\'s fault)', async () => {
    const buf = createSkillTurnBuffer();
    buf.recordInvoked('search-docs', 'A.custom', 'read_file');
    const cid = 'cid-ineff-b5';
    buf.drainAndEmit({
      uid: UID, cid, aid: 'agent_x',
      turn_id: 'm_b5', msg_ids: ['m_b5'],
      errText: 'aborted by user',
      aborted: true,
    });
    await wait();

    const sigs = await querySignals({ types: ['skill_ineffective'], cid });
    expect(sigs.length).toBe(0);
  });

  it('legacy call (no errText / aborted args) keeps the old skill_invoked behavior', async () => {
    const buf = createSkillTurnBuffer();
    buf.recordInvoked('search-docs', 'A.custom', 'read_file');
    const cid = 'cid-ineff-b6';
    buf.drainAndEmit({
      uid: UID, cid, aid: 'agent_x',
      turn_id: 'm_b6', msg_ids: ['m_b6'],
    });
    await wait();

    const ineff = await querySignals({ types: ['skill_ineffective'], cid });
    expect(ineff.length).toBe(0);
    const inv = await querySignals({ types: ['skill_invoked'], cid });
    expect(inv.length).toBe(1);  // legacy emit still fires
  });
});
