import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { generateKeyPairSync, ECDH, X509Certificate } from 'node:crypto';

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

  it('offers a folder grant only for reads sensitive solely for their personal location', async () => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const home = path.join(tmpDir, 'home');
    process.env.HOME = home;
    if (process.platform === 'win32') process.env.USERPROFILE = home;
    try {
      const policy = await import('../../../src/main/features/local_access_policy');
      const ads = path.join(home, 'Desktop', 'ads');
      fs.mkdirSync(ads, { recursive: true });
      fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
      const image = path.join(ads, 'a.png');
      fs.writeFileSync(image, 'png');
      fs.writeFileSync(path.join(ads, '.env'), 'TOKEN=1');
      fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host x');
      fs.symlinkSync(path.join(home, '.ssh', 'config'), path.join(ads, 'notes.txt'));
      fs.writeFileSync(path.join(tmpDir, 'plain.txt'), 'plain');

      expect(policy.locationOnlyRead(image)).toEqual({
        folder: ads, realPath: fs.realpathSync(image), realFolder: fs.realpathSync(ads),
      });
      // A listed directory grants itself; a file not created yet, its parent.
      expect(policy.locationOnlyRead(ads)).toMatchObject({ folder: ads, realFolder: fs.realpathSync(ads) });
      expect(policy.locationOnlyRead(path.join(ads, 'later.png'))).toMatchObject({ folder: ads });
      // Intrinsic secrets, links to them, unprotected paths and trusted
      // workspaces never carry a folder grant.
      expect(policy.locationOnlyRead(path.join(ads, '.env'))).toBeUndefined();
      expect(policy.locationOnlyRead(path.join(home, '.ssh', 'config'))).toBeUndefined();
      expect(policy.locationOnlyRead(path.join(ads, 'notes.txt'))).toBeUndefined();
      expect(policy.locationOnlyRead(path.join(tmpDir, 'plain.txt'))).toBeUndefined();
      expect(policy.locationOnlyRead(image, { trustedRoots: [ads] })).toBeUndefined();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
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


// A successful native parse may consume only an ASN.1 prefix. The entire
// encoded file must be public. Preserve the desktop runtime's existing
// decisions for legacy/BER variants as well as its supported encodings.
describe('complete public material proof', () => {
  function sample(shape: string): { label: string; bytes: Buffer } {
    if (shape.startsWith('certificate')) {
      const text = fs.readFileSync(path.join(__dirname, '../../fixtures/public-proof-certificate.pem'), 'utf8');
      const bytes = new X509Certificate(text).raw;
      if (shape === 'certificate-ber') {
        const header = 2 + ((bytes[1] & 0x80) ? bytes[1] & 0x7f : 0);
        return { label: 'CERTIFICATE', bytes: Buffer.concat([Buffer.from([0x30, 0x80]), bytes.subarray(header), Buffer.from([0, 0])]) };
      }
      return { label: 'CERTIFICATE', bytes };
    }
    if (shape.startsWith('rsa')) {
      const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
      if (shape === 'rsa-pkcs1') return { label: 'RSA PUBLIC KEY', bytes: key.export({ type: 'pkcs1', format: 'der' }) };
      const bytes = key.export({ type: 'spki', format: 'der' });
      if (shape === 'rsa-absent-null') {
        expect([...bytes.subarray(4, 6)]).toEqual([0x30, 13]);
        expect([...bytes.subarray(17, 19)]).toEqual([5, 0]);
        const legacy = Buffer.concat([bytes.subarray(0, 4), Buffer.from([0x30, 11]), bytes.subarray(6, 17), bytes.subarray(19)]);
        legacy.writeUInt16BE(legacy.length - 4, 2);
        return { label: 'PUBLIC KEY', bytes: legacy };
      }
      return { label: 'PUBLIC KEY', bytes };
    }
    if (shape.startsWith('ec')) {
      const bytes = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' });
      if (shape === 'ec-compressed') {
        const point = ECDH.convertKey(bytes.subarray(-65), 'prime256v1', undefined, undefined, 'compressed') as Buffer;
        return { label: 'PUBLIC KEY', bytes: Buffer.concat([Buffer.from([0x30, 57]), bytes.subarray(2, 23), Buffer.from([3, 34, 0]), point]) };
      }
      return { label: 'PUBLIC KEY', bytes };
    }
    const bytes = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
    if (shape === 'ed25519-ber') return { label: 'PUBLIC KEY', bytes: Buffer.concat([Buffer.from([0x30, 0x80]), bytes.subarray(2), Buffer.from([0, 0])]) };
    if (shape === 'ed25519-nested-ber') return { label: 'PUBLIC KEY', bytes: Buffer.concat([Buffer.from([0x30, 0x80, 0x30, 0x80]), bytes.subarray(4, 9), Buffer.from([0, 0]), bytes.subarray(9), Buffer.from([0, 0])]) };
    return { label: 'PUBLIC KEY', bytes };
  }
  const pem = (label: string, bytes: Buffer) => `-----BEGIN ${label}-----\n${bytes.toString('base64')}\n-----END ${label}-----\n`;

  it.each(['ed25519', 'rsa-spki', 'rsa-pkcs1', 'rsa-absent-null', 'ec', 'ec-compressed', 'ed25519-ber', 'ed25519-nested-ber', 'certificate', 'certificate-ber'])(
    'preserves the native %s decision and rejects additional encoded data at both policy consumers', async shape => {
      const { isVerifiedPublicMaterial } = await import('../../../src/main/util/public-material');
      const policy = await import('../../../src/main/features/local_access_policy');
      const { ordinaryBashReasons } = await import('../../../src/main/model/core-agent/ordinary-shell-operations');
      const { label, bytes } = sample(shape);
      const file = path.join(tmpDir, 'record.pem');
      const valid = pem(label, bytes);
      const ctx = { cwd: tmpDir, platform: 'linux' as const, canWrite: () => true, isProduced: () => false, ownsTree: () => false };
      const supported = !['rsa-absent-null', 'ed25519-ber', 'ed25519-nested-ber', 'certificate-ber'].includes(shape);
      fs.writeFileSync(file, valid);
      expect(isVerifiedPublicMaterial(file)).toBe(supported);
      expect(policy.sensitivePathReasons(file)).toEqual(supported ? [] : ['sensitive_path']);
      expect(policy.sensitivePathReasons(file, 'write')).toEqual(['sensitive_path']);
      expect(ordinaryBashReasons('cat record.pem', ctx).has('sensitive_path')).toBe(supported);
      fs.writeFileSync(file, pem(label, Buffer.concat([bytes, Buffer.from('synthetic-private-marker')])));
      expect({ proof: isVerifiedPublicMaterial(file), pathReasons: policy.sensitivePathReasons(file),
        shellExemption: ordinaryBashReasons('cat record.pem', ctx).has('sensitive_path'),
        powershellExemption: ordinaryBashReasons('Get-Content -Raw -LiteralPath record.pem', { ...ctx, platform: 'win32' }).has('sensitive_path'),
      }).toEqual({ proof: false, pathReasons: ['sensitive_path'], shellExemption: false, powershellExemption: false });
      fs.writeFileSync(file, valid);
      expect(isVerifiedPublicMaterial(file)).toBe(supported);
    },
  );

  it.each([
    [], [0x30], [0x30, 0x82, 1], [0x30, 0x84, 255, 255, 255, 255],
    [0x30, 0x80], [0x30, 0x80, 3, 0x80, 0, 0, 0, 0],
    [0x30, 0x80, 0x1f, 0x81], [0x30, 0x80, 0x1f],
    [0x30, 1, 0], [0x30, 0, 0, 0],
  ].map(bytes => [bytes]))('does not grant public proof for truncated or malformed ASN.1 %j', async bytes => {
    const { isVerifiedPublicMaterial } = await import('../../../src/main/util/public-material');
    const file = path.join(tmpDir, 'malformed.pem');
    fs.writeFileSync(file, pem('PUBLIC KEY', Buffer.from(bytes)));
    expect(isVerifiedPublicMaterial(file)).toBe(false);
  });

  it('keeps public proof bounded to a single regular file and the 64 KiB limit', async () => {
    const { isVerifiedPublicMaterial } = await import('../../../src/main/util/public-material');
    const text = pem('PUBLIC KEY', sample('ed25519').bytes);
    const file = path.join(tmpDir, 'bounded.pem');
    const alias = path.join(tmpDir, 'alias.pem');
    fs.mkdirSync(path.join(tmpDir, 'directory.pem'));
    expect(isVerifiedPublicMaterial(path.join(tmpDir, 'directory.pem'))).toBe(false);
    expect(isVerifiedPublicMaterial(file)).toBe(false);
    fs.writeFileSync(file, text);
    fs.symlinkSync(file, alias);
    expect(isVerifiedPublicMaterial(alias)).toBe(false);
    fs.unlinkSync(alias);
    fs.linkSync(file, alias);
    expect(isVerifiedPublicMaterial(file)).toBe(false);
    fs.unlinkSync(alias);
    expect(isVerifiedPublicMaterial(file)).toBe(true);
    fs.writeFileSync(file, text.padEnd(64 * 1024, ' '));
    expect(isVerifiedPublicMaterial(file)).toBe(true);
    fs.appendFileSync(file, ' ');
    expect(isVerifiedPublicMaterial(file)).toBe(false);
    fs.writeFileSync(file, '');
    expect(isVerifiedPublicMaterial(file)).toBe(false);
    fs.writeFileSync(file, text);
    expect(isVerifiedPublicMaterial(file)).toBe(true);
  });

  it.each(['open', 'fstat', 'read', 'short-read', 'changed-inode', 'changed-device', 'changed-size'])(
    'denies unknown public content on %s, closes opened descriptors and recovers', async fault => {
      const { isVerifiedPublicMaterial } = await import('../../../src/main/util/public-material');
      const file = path.join(tmpDir, 'fault.pem');
      fs.writeFileSync(file, pem('PUBLIC KEY', sample('ed25519').bytes));
      const fail = () => { throw Object.assign(new Error('controlled unreadable fixture'), { code: 'EIO' }); };
      const nodeFs = (await import('node:fs')).default;
      const close = vi.spyOn(nodeFs, 'closeSync');
      const originalStat = nodeFs.fstatSync;
      let injected: { mockRestore(): void };
      if (fault === 'open') injected = vi.spyOn(nodeFs, 'openSync').mockImplementation(fail);
      else if (fault === 'read') injected = vi.spyOn(nodeFs, 'readSync').mockImplementation(fail);
      else if (fault === 'short-read') injected = vi.spyOn(nodeFs, 'readSync').mockReturnValue(0);
      else injected = vi.spyOn(nodeFs, 'fstatSync').mockImplementation(((fd: number) => {
        if (fault === 'fstat') return fail();
        const original = originalStat(fd);
        const field = fault === 'changed-inode' ? 'ino' : fault === 'changed-device' ? 'dev' : 'size';
        // NTFS inode numbers can exceed Number.MAX_SAFE_INTEGER; adding one
        // may leave the value unchanged and fail to inject the intended race.
        const changed = Number(original[field]) === 0 ? 1 : 0;
        return { ...original, [field]: changed };
      }) as typeof fs.fstatSync);
      syncBuiltinESMExports();
      try {
        expect(isVerifiedPublicMaterial(file)).toBe(false);
        expect(close).toHaveBeenCalledTimes(fault === 'open' ? 0 : 1);
      } finally { injected.mockRestore(); close.mockRestore(); syncBuiltinESMExports(); }
      expect(isVerifiedPublicMaterial(file)).toBe(true);
    },
  );

  it.each(['ed25519', 'rsa-spki', 'rsa-pkcs1', 'ec', 'ec-compressed', 'certificate'])(
    'rejects extra material around and inside the %s encoding', async shape => {
      const { isVerifiedPublicMaterial } = await import('../../../src/main/util/public-material');
      const { label, bytes } = sample(shape);
      const file = path.join(tmpDir, 'encoding.pem');
      const encoded = bytes.toString('base64');
      const header = 2 + ((bytes[1] & 0x80) ? bytes[1] & 0x7f : 0);
      const content = Buffer.concat([bytes.subarray(header), Buffer.from([4, 3, 65, 66, 67])]);
      const length = content.length < 128 ? Buffer.from([content.length]) : Buffer.from([0x82, content.length >> 8, content.length & 255]);
      for (const text of [
        `-----BEGIN ${label}-----\n${encoded}QUJD\n-----END ${label}-----\n`,
        `-----BEGIN ${label}-----\n${encoded}==\n-----END ${label}-----\n`,
        pem(label, bytes) + pem(label, bytes),
        pem(label, Buffer.concat([Buffer.from([0x30]), length, content])),
      ]) {
        fs.writeFileSync(file, text);
        expect(isVerifiedPublicMaterial(file)).toBe(false);
      }
      fs.writeFileSync(file, pem(label, bytes));
      expect(isVerifiedPublicMaterial(file)).toBe(true);
    },
  );
});
