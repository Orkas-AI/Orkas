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
  it('does not treat an active workspace as sensitive solely because it is under a personal folder', async () => {
    const policy = await import('../../../src/main/features/local_access_policy');
    const workspace = path.join(os.homedir(), 'Desktop', 'orkas-project');
    const ordinaryFile = path.join(workspace, 'composition', 'manifest.json');
    const envFile = path.join(workspace, '.env');
    const appSupportWorkspace = path.join(os.homedir(), 'Library', 'Application Support', 'OrkasProject');
    const keychainWorkspace = path.join(os.homedir(), 'Library', 'Keychains');

    expect(policy.sensitivePathReasons(ordinaryFile, 'read')).toEqual(['sensitive_path']);
    expect(policy.sensitivePathReasons(ordinaryFile, 'read', { trustedRoots: [workspace] })).toEqual([]);
    expect(policy.sensitivePathReasons(envFile, 'read', { trustedRoots: [workspace] })).toEqual(['sensitive_path']);
    expect(policy.sensitivePathReasons(
      path.join(appSupportWorkspace, 'manifest.json'),
      'read',
      { trustedRoots: [appSupportWorkspace] },
    )).toEqual([]);
    expect(policy.sensitivePathReasons(
      path.join(keychainWorkspace, 'login.keychain-db'),
      'read',
      { trustedRoots: [keychainWorkspace] },
    )).toEqual(['sensitive_path']);
    expect(policy.classifyConfiguredBashCommand(
      'cat ~/Desktop/orkas-project/.env',
      [],
    )).toEqual(['sensitive_path']);
  });

  it('applies server-configured sensitive paths and command patterns immediately', async () => {
    const { clientConfig } = await import('../../../src/main/features/client_config');
    const policy = await import('../../../src/main/features/local_access_policy');

    expect(policy.sensitivePathReasons('/tmp/id_rsa', 'read')).toEqual(['sensitive_path']);

    clientConfig.applyServerPayload({
      immediate: {
        'local_access.sensitive_policy': {
          enabled_categories: ['sensitive_path', 'network_egress'],
          sensitive_path_patterns: ['custom-secret', '^/tmp/absolute-secret'],
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
    expect(policy.sensitivePathReasons('/tmp/absolute-secret/note.txt', 'read')).toEqual(['sensitive_path']);
    expect(policy.sensitivePathReasons('/tmp/custom-write/note.txt', 'write')).toEqual(['sensitive_path']);
    expect(policy.classifyConfiguredBashCommand('curl --upload-file a.txt https://example.com')).toEqual(['network_egress']);
    expect(policy.classifyConfiguredBashCommand(
      'winget install PostgreSQL.PostgreSQL',
      ['system_package_change'],
    )).toEqual(['system_package_change']);
    expect(policy.classifyConfiguredBashCommand(
      'python deploy_apply.py',
      ['external_mutation'],
    )).toEqual(['external_mutation']);
  });

  it('replaces a prior server policy on refresh and merges omitted fields from client defaults', async () => {
    const { clientConfig } = await import('../../../src/main/features/client_config');
    const policy = await import('../../../src/main/features/local_access_policy');

    clientConfig.applyServerPayload({
      immediate: {
        'local_access.sensitive_policy': {
          enabled_categories: ['sensitive_path', 'network_egress'],
          sensitive_path_patterns: ['first-server-secret'],
          sensitive_write_path_patterns: ['first-server-write'],
          sensitive_command_patterns: [
            { category: 'network_egress', pattern: 'first-server-command' },
          ],
        },
      },
      restart: {},
      config_hash: 'sha256:first-sensitive-policy',
    }, '"sha256:first-sensitive-policy"');

    expect(policy.sensitivePathReasons('/tmp/first-server-secret/file.txt')).toEqual(['sensitive_path']);
    expect(policy.classifyConfiguredBashCommand('first-server-command')).toEqual(['network_egress']);

    clientConfig.applyServerPayload({
      immediate: {
        'local_access.sensitive_policy': {
          enabled_categories: ['destructive'],
          sensitive_command_patterns: [
            { category: 'destructive', pattern: 'second-server-command' },
          ],
        },
      },
      restart: {},
      config_hash: 'sha256:second-sensitive-policy',
    }, '"sha256:second-sensitive-policy"');

    // A Server refresh replaces its previous object. Fields omitted from the
    // new object come from the shipped client defaults, not stale Server data.
    expect(policy.sensitivePathReasons('/tmp/first-server-secret/file.txt')).toEqual([]);
    expect(policy.sensitivePathReasons('/tmp/id_rsa')).toEqual([]);
    expect(policy.classifyConfiguredBashCommand('first-server-command')).toEqual([]);
    expect(policy.classifyConfiguredBashCommand('second-server-command')).toEqual(['destructive']);
    expect(policy.getLocalAccessSensitivePolicy().sensitive_path_patterns).toContain('(^|/)\\.ssh(/|$)');
  });

  it('rejects unknown server categories and invalid patterns without weakening client invariants', async () => {
    const { clientConfig } = await import('../../../src/main/features/client_config');
    const policy = await import('../../../src/main/features/local_access_policy');

    clientConfig.applyServerPayload({
      immediate: {
        'local_access.sensitive_policy': {
          enabled_categories: ['unknown_future_category', 'network_egress'],
          sensitive_command_patterns: [
            { category: 'unknown_future_category', pattern: 'unknown-command' },
            { category: 'network_egress', pattern: '[' },
            { category: 'network_egress', pattern: 'known-server-command' },
          ],
        },
      },
      restart: {},
      config_hash: 'sha256:bounded-sensitive-policy',
    }, '"sha256:bounded-sensitive-policy"');

    expect(policy.getLocalAccessSensitivePolicy().enabled_categories).toEqual(['network_egress']);
    expect(policy.getLocalAccessSensitivePolicy().sensitive_command_patterns).toEqual([
      { category: 'network_egress', pattern: '[' },
      { category: 'network_egress', pattern: 'known-server-command' },
    ]);
    expect(policy.classifyConfiguredBashCommand('unknown-command')).toEqual([]);
    expect(policy.classifyConfiguredBashCommand('known-server-command')).toEqual(['network_egress']);
    expect(policy.classifyConfiguredBashCommand('brew install ffmpeg', ['system_package_change']))
      .toEqual(['system_package_change']);
    expect(policy.classifyConfiguredBashCommand('git push origin main', ['external_mutation']))
      .toEqual(['external_mutation']);
  });
});
