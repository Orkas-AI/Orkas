import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u-connectors-migrate';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-migrate-connectors-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMigration() {
  const paths = await import('../../../src/main/paths');
  const migration = await import('../../../src/main/util/migrate-connectors-to-cloud');
  return { paths, migration };
}

describe('util/migrate-connectors-to-cloud', () => {
  it('defers migration until an OAuth user is available', async () => {
    const { paths, migration } = await loadMigration();
    const oldPath = path.join(paths.userLocalConfigDir(TEST_UID), 'connectors.json');
    const newPath = path.join(paths.userCloudConfigDir(TEST_UID), 'connectors.json');
    const stamp = path.join(paths.userCloudConfigDir(TEST_UID), '.migrate-connectors-to-cloud.done');
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, '{"version":2}', 'utf8');

    expect(migration.migrateConnectorsToCloud(TEST_UID)).toBe(false);

    expect(fs.existsSync(oldPath)).toBe(true);
    expect(fs.existsSync(newPath)).toBe(false);
    expect(fs.existsSync(stamp)).toBe(false);
  });

  it('keeps plaintext connector registry local in the open build', async () => {
    const { paths, migration } = await loadMigration();
    const oldPath = path.join(paths.userLocalConfigDir(TEST_UID), 'connectors.json');
    const newPath = path.join(paths.userCloudConfigDir(TEST_UID), 'connectors.json');
    const stamp = path.join(paths.userCloudConfigDir(TEST_UID), '.migrate-connectors-to-cloud.done');
    const body = JSON.stringify({ version: 2, connections: { github: { enabled: true } } });
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, body, 'utf8');

    expect(migration.migrateConnectorsToCloud(TEST_UID)).toBe(false);

    expect(fs.readFileSync(oldPath, 'utf8')).toBe(body);
    expect(fs.existsSync(newPath)).toBe(false);
    expect(fs.existsSync(stamp)).toBe(false);
  });
});
