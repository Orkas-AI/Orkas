/**
 * Per-user enabled/disabled overrides — resolver semantics.
 *
 * Locks the contract every filter point in §6 relies on:
 *   - missing key → spec default → fallback `true`
 *   - explicit `false` wins
 *   - explicit `true` is never persisted (only false overrides hit disk)
 *   - `setXEnabled(true)` clears a prior override (idempotent re-enable)
 *   - corrupt / missing file → empty defaults (no throw)
 *
 * No coverage here for the consumers (skill-registry filter, _buildAgentsIndex,
 * conv send-block) — those are integration paths and would dilute this file.
 * The single resolver is the high-leverage seam worth pinning.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-comp-enabled-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('component_enabled resolver', () => {
  it('returns true when no override and no spec default', async () => {
    const ce = await import('../../../src/main/features/component_enabled');
    expect(ce.isAgentEnabled(TEST_UID, 'a1')).toBe(true);
    expect(ce.isSkillEnabled(TEST_UID, 's1')).toBe(true);
  });

  it('falls through to specDefault when override missing', async () => {
    const ce = await import('../../../src/main/features/component_enabled');
    expect(ce.isAgentEnabled(TEST_UID, 'a1', false)).toBe(false);
    expect(ce.isAgentEnabled(TEST_UID, 'a1', true)).toBe(true);
  });

  it('explicit false override wins over specDefault', async () => {
    const ce = await import('../../../src/main/features/component_enabled');
    ce.setAgentEnabled(TEST_UID, 'a1', false);
    expect(ce.isAgentEnabled(TEST_UID, 'a1')).toBe(false);
    expect(ce.isAgentEnabled(TEST_UID, 'a1', true)).toBe(false);
  });

  it('setEnabled(true) clears the prior false override (only false persisted)', async () => {
    const ce = await import('../../../src/main/features/component_enabled');
    ce.setSkillEnabled(TEST_UID, 's1', false);
    const disabledClock = ce.readEnabledMap(TEST_UID)._item_updated_at?.skills?.s1 || 0;
    expect(ce.isSkillEnabled(TEST_UID, 's1')).toBe(false);
    ce.setSkillEnabled(TEST_UID, 's1', true);
    expect(ce.isSkillEnabled(TEST_UID, 's1')).toBe(true);
    // The on-disk map should not contain s1 at all (true is the absence default).
    const map = ce.readEnabledMap(TEST_UID);
    expect(map.skills).not.toHaveProperty('s1');
    expect(map._item_updated_at?.skills?.s1).toBeGreaterThan(disabledClock);
  });

  it('readDisabledSets returns ids of currently-disabled overrides only', async () => {
    const ce = await import('../../../src/main/features/component_enabled');
    ce.setAgentEnabled(TEST_UID, 'a1', false);
    ce.setSkillEnabled(TEST_UID, 's1', false);
    ce.setSkillEnabled(TEST_UID, 's2', true); // never written, should not appear
    const sets = ce.readDisabledSets(TEST_UID);
    expect(sets.agents.has('a1')).toBe(true);
    expect(sets.skills.has('s1')).toBe(true);
    expect(sets.skills.has('s2')).toBe(false);
  });

  it('agents and skills namespaces are independent', async () => {
    const ce = await import('../../../src/main/features/component_enabled');
    ce.setAgentEnabled(TEST_UID, 'shared', false);
    expect(ce.isAgentEnabled(TEST_UID, 'shared')).toBe(false);
    // Same id under skills should still default to true — independent maps.
    expect(ce.isSkillEnabled(TEST_UID, 'shared')).toBe(true);
  });

  it('corrupt JSON file → empty defaults (no throw)', async () => {
    const ce = await import('../../../src/main/features/component_enabled');
    const paths = await import('../../../src/main/paths');
    const p = paths.userComponentEnabledFile(TEST_UID);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ this is not json', 'utf8');
    expect(ce.isAgentEnabled(TEST_UID, 'a1')).toBe(true);
    const map = ce.readEnabledMap(TEST_UID);
    expect(map.agents).toEqual({});
  });
});
