import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-commander-stats-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('commander runtime stats', () => {
  it('stores counters under cloud/commander, not cloud/agents/commander', async () => {
    const stats = await import('../../../src/main/features/commander_runtime_stats');
    const paths = await import('../../../src/main/paths');

    const res = await stats.recordCommanderRuntimeStats({ duration_ms: 1_500, success: true }, TEST_UID);

    expect(res.ok).toBe(true);
    expect(res.stats.attempts).toBe(1);
    expect(res.stats.successes).toBe(1);
    expect(res.stats.deliveries).toBe(1);
    expect(res.stats.failures).toBe(0);
    expect(res.stats.errors).toBe(0);
    expect(res.stats.total_duration_ms).toBe(1_500);
    expect(fs.existsSync(paths.commanderRuntimeStatsFile(TEST_UID))).toBe(true);
    expect(fs.existsSync(path.join(paths.userAgentsDir(TEST_UID), 'commander', 'runtime_stats.json'))).toBe(false);
  });
});
