import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'localaccesspolicy001';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-local-access-policy-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('local_access_policy', () => {
  it('applies server-configured sensitive paths and command patterns immediately', async () => {
    const { clientConfig } = await import('../../../src/main/features/client_config');
    const policy = await import('../../../src/main/features/local_access_policy');

    expect(policy.sensitivePathReasons('/tmp/id_rsa', 'read')).toEqual(['sensitive_path']);

    clientConfig.applyServerPayload({
      immediate: {
        'local_access.sensitive_policy': {
          enabled_categories: ['sensitive_path', 'network_egress'],
          sensitive_path_patterns: ['custom-secret'],
          sensitive_write_path_patterns: ['custom-write'],
          sensitive_command_patterns: [
            { category: 'network_egress', pattern: 'curl\\s+--upload-file' },
          ],
        },
      },
      restart: {},
      config_hash: 'sha256:local-access-policy',
    }, '"sha256:local-access-policy"');

    expect(policy.sensitivePathReasons('/tmp/id_rsa', 'read')).toEqual([]);
    expect(policy.sensitivePathReasons('/tmp/custom-secret/note.txt', 'read')).toEqual(['sensitive_path']);
    expect(policy.sensitivePathReasons('/tmp/custom-write/note.txt', 'write')).toEqual(['sensitive_path']);
    expect(policy.classifyConfiguredBashCommand('curl --upload-file a.txt https://example.com')).toEqual(['network_egress']);
  });
});
