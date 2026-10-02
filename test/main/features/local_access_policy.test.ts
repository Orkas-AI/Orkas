import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

const UID = 'localaccesspolicy001';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  it('recognizes actual public keys and empty templates, retaining secret, write and custom-policy boundaries', async () => {
    const policy = await import('../../../src/main/features/local_access_policy');
    const config = await import('../../../src/main/features/client_config');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const key = path.join(tmpDir, 'key.pem');
    const template = path.join(tmpDir, '.env.example');
    fs.writeFileSync(key, publicKey.export({ type: 'spki', format: 'pem' }));
    fs.writeFileSync(template, 'API_TOKEN=\nENDPOINT=""\nREGION=${REGION}\n');
    expect(policy.sensitivePathReasons(key)).toEqual([]);
    expect(policy.sensitivePathReasons(template)).toEqual([]);
    expect(policy.sensitivePathReasons(key, 'write')).toEqual(['sensitive_path']);
    fs.writeFileSync(template, 'API_TOKEN=real-credential\n');
    expect(policy.sensitivePathReasons(template)).toEqual(['sensitive_path']);
    fs.appendFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    expect(policy.sensitivePathReasons(key)).toEqual(['sensitive_path']);
    fs.writeFileSync(key, publicKey.export({ type: 'spki', format: 'pem' }));
    config.clientConfig.applyServerPayload({ immediate: { 'local_access.sensitive_policy': {
      sensitive_path_patterns: ['key\\.pem$'],
    } }, restart: {}, config_hash: 'sha256:public-material-custom' }, 'public-material-custom');
    expect(policy.sensitivePathReasons(key)).toEqual(['sensitive_path']);
  });
  it('validates the complete OpenSSH public record and never trusts the .pub suffix alone', async () => {
    const policy = await import('../../../src/main/features/local_access_policy');
    const { publicKey } = generateKeyPairSync('ed25519');
    const field = (value: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(value.length); return Buffer.concat([size, value]); };
    const bytes = Buffer.concat([field(Buffer.from('ssh-ed25519')), field(Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url'))]);
    const file = path.join(tmpDir, '.ssh', 'id_ed25519.pub');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, `ssh-ed25519 ${bytes.toString('base64')}\n`);
    expect(policy.sensitivePathReasons(file)).toEqual([]);
    expect(policy.sensitivePathReasons(file, 'write')).toEqual(['sensitive_path']);
    for (const text of ['not a public key', `ssh-ed25519 ${bytes.toString('base64')}\nprivate data`, 'A'.repeat(65537)]) {
      fs.writeFileSync(file, text);
      expect(policy.sensitivePathReasons(file)).toEqual(['sensitive_path']);
    }
    const template = path.join(tmpDir, '.env.example');
    fs.writeFileSync(template, '');
    expect(policy.sensitivePathReasons(template)).toEqual([]);
  });
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
    const absoluteSecretRoot = path.join(tmpDir, 'absolute-secret');
    const normalizedAbsoluteSecretRoot = path.resolve(absoluteSecretRoot).split(path.sep).join('/');

    expect(policy.sensitivePathReasons('/tmp/id_rsa', 'read')).toEqual(['sensitive_path']);

    clientConfig.applyServerPayload({
      immediate: {
        'local_access.sensitive_policy': {
          enabled_categories: ['sensitive_path', 'network_egress'],
          sensitive_path_patterns: ['custom-secret', `^${escapeRegex(normalizedAbsoluteSecretRoot)}`],
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
    expect(policy.sensitivePathReasons(path.join(absoluteSecretRoot, 'note.txt'), 'read')).toEqual(['sensitive_path']);
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

  it('uses structural defaults without disabling custom server rules', async () => {
    const { clientConfig } = await import('../../../src/main/features/client_config');
    const policy = await import('../../../src/main/features/local_access_policy');
    const options = { structuredDefaults: true };
    expect(policy.classifyConfiguredBashCommand('echo sudo', [], options)).toEqual([]);
    expect(policy.classifyConfiguredBashCommand('echo ~/.ssh/id_rsa', [], options)).toEqual([]);
    expect(policy.classifyConfiguredBashCommand('sudo ls', ['priv_esc'], options)).toEqual(['priv_esc']);
    clientConfig.applyServerPayload({ immediate: { 'local_access.sensitive_policy': {
      sensitive_command_patterns: [{ category: 'network_egress', pattern: 'custom-network-command' }],
      sensitive_path_patterns: ['custom-secret'],
    } }, restart: {}, config_hash: 'sha256:structured-defaults' }, '"sha256:structured-defaults"');
    expect(policy.classifyConfiguredBashCommand('custom-network-command', [], options)).toEqual(['network_egress']);
    expect(policy.classifyConfiguredBashCommand('cat custom-secret', [], options)).toEqual(['sensitive_path']);
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
