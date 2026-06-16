import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = '99999999';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-auth-order-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('BYO API key auth ordering', () => {
  it('places the newest search profile first', async () => {
    const searchAuth = await import('../../../src/main/features/search_auth');

    expect(searchAuth.addSearchProfile({ provider: 'tavily', apiKey: 'tvly-one', label: 'one' }).ok).toBe(true);
    expect(searchAuth.addSearchProfile({ provider: 'serper', apiKey: 'serper-two', label: 'two' }).ok).toBe(true);

    expect(searchAuth.listSearchProfiles().map((p) => p.label)).toEqual(['two', 'one']);
  });

  it('places the newest image profile first', async () => {
    const imageAuth = await import('../../../src/main/features/image_auth');

    expect(imageAuth.addImageProfile({ provider: 'openai', apiKey: 'sk-image-one', label: 'one' }).ok).toBe(true);
    expect(imageAuth.addImageProfile({ provider: 'google', apiKey: 'google-image-two', label: 'two' }).ok).toBe(true);

    expect(imageAuth.listImageProfiles().map((p) => p.label)).toEqual(['two', 'one']);
  });
});
