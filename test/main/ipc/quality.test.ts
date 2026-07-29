import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('quality report IPC boundary', () => {
  beforeEach(async () => {
    vi.resetModules();
    const users = await import('../../../src/main/features/users');
    users.activateUser('quality-user');
  });

  it('reads only safe report identifiers for the active account', async () => {
    const { persistReport } = await import('../../../src/main/quality/report');
    await persistReport({
      uid: 'quality-user',
      kind: 'skill',
      id: 'safe-skill_1',
      report: {
        ok: true,
        violations: [],
        validated_at: '2026-07-25T00:00:00.000Z',
        validator_version: '1',
      },
    });
    const { invokeHandlers } = await import('../../../src/main/ipc/quality');

    await expect(invokeHandlers['quality.readSkillReport']({ id: 'safe-skill_1' }))
      .resolves.toMatchObject({ report: { validator_version: '1' } });
    await expect(invokeHandlers['quality.readSkillReport']({ id: '../config/auth-profiles' }))
      .rejects.toThrow('invalid id');
    await expect(invokeHandlers['quality.readAgentReport']({ id: 'writer/../../secret' }))
      .rejects.toThrow('invalid id');
    await expect(invokeHandlers['quality.readAgentReport']({ id: '   ' }))
      .rejects.toThrow('invalid id');
  });

  it('cannot traverse from quality reports into another local JSON file', async () => {
    const paths = await import('../../../src/main/paths');
    const configFile = path.join(paths.userLocalConfigDir('quality-user'), 'auth-profiles.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ secret: 'must-not-cross-ipc' }), 'utf8');
    const { invokeHandlers } = await import('../../../src/main/ipc/quality');

    await expect(invokeHandlers['quality.readSkillReport']({
      id: '../../config/auth-profiles',
    })).rejects.toThrow('invalid id');
  });
});
