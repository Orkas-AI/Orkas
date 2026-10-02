import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const fs = require('node:fs') as typeof import('node:fs');
const codecPath = path.resolve(__dirname, '../../../../bin/local-api-credential-codec.cjs');
const codec = require(codecPath);
const directories: string[] = [];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-credential-continuity-'));
  directories.push(directory);
  const config = { credentialFile: path.join(directory, 'credentials.enc'), credentialKey: crypto.randomBytes(32).toString('base64url'),
    credentials: { provider: 'fixture', access_token: 'previous-access', refresh_token: 'previous-refresh', expires_at: 0, identity: { shop_id: '123' } } };
  codec.writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials);
  const next = { ...config.credentials, access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_at: Date.now() + 3600_000 };
  return { config, next, read: () => codec.readCredentialFile(config.credentialFile, config.credentialKey) };
}
afterEach(() => { vi.restoreAllMocks(); while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true }); });

describe('encrypted credential rotation recovery', () => {
  it('resumes identity verification in a new process without refreshing the old grant', async () => {
    const { config, next, read } = fixture();
    await expect(codec.rotateCredentialFile(config, async () => next, async () => { throw new Error('Fixture offline'); })).rejects.toThrow('Fixture offline');
    expect(read()).toEqual(config.credentials);
    const output = execFileSync(process.execPath, ['-e', `
      const codec = require(process.argv[1]);
      const config = { credentialFile: process.argv[2], credentialKey: process.argv[3] };
      config.credentials = codec.readCredentialFile(config.credentialFile, config.credentialKey);
      codec.rotateCredentialFile(config, () => { throw new Error('Old grant must not be reused'); }, candidate => {
        if (candidate.credentials.identity.shop_id !== '123') throw new Error('Binding changed');
      }).then(() => process.stdout.write('recovered')).catch(() => process.exit(1));
    `, codecPath, config.credentialFile, config.credentialKey], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
    expect(output).toBe('recovered');
    expect(read()).toEqual(next);
    expect(fs.existsSync(`${config.credentialFile}.rotation`)).toBe(false);
  });

  it('retains the candidate when committing the verified grant fails and removes failed temporary files', async () => {
    const { config, next, read } = fixture();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (destination === config.credentialFile) throw new Error('Fixture disk unavailable');
      rename(source, destination);
    });
    await expect(codec.rotateCredentialFile(config, async () => next, async () => {})).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM',
      message: expect.not.stringContaining(config.credentialFile) });
    expect(read()).toEqual(config.credentials);
    expect(fs.readdirSync(path.dirname(config.credentialFile)).some((name: string) => name.endsWith('.tmp'))).toBe(false);
    vi.restoreAllMocks();
    const acquire = vi.fn(async () => { throw new Error('Old grant must not be reused'); });
    await codec.rotateCredentialFile(config, acquire, async () => {});
    expect(acquire).not.toHaveBeenCalled();
    expect(read()).toEqual(next);
  });

  it('discards a previous authorization checkpoint after credentials are replaced', async () => {
    const { config, next, read } = fixture();
    await expect(codec.rotateCredentialFile(config, async () => next, async () => { throw new Error('Fixture offline'); })).rejects.toThrow();
    config.credentials = { ...config.credentials, access_token: 'replacement-access', refresh_token: 'replacement-refresh', identity: { shop_id: '456' } };
    codec.writeCredentialFile(config.credentialFile, config.credentialKey, config.credentials);
    const replacement = { ...config.credentials, expires_at: Date.now() + 3600_000 };
    await codec.rotateCredentialFile(config, async () => replacement, async (candidate: typeof config) => {
      expect(candidate.credentials.identity.shop_id).toBe('456');
    });
    expect(read()).toEqual(replacement);
  });

  it('renews an expired pending access token using the pending refresh token after a long interruption', async () => {
    const { config, next, read } = fixture();
    await expect(codec.rotateCredentialFile(config, async () => ({ ...next, expires_at: 1 }), async () => { throw new Error('Fixture offline'); })).rejects.toThrow();
    const acquire = vi.fn(async () => {
      expect(config.credentials.refresh_token).toBe('rotated-refresh');
      return { ...next, access_token: 'renewed-access', refresh_token: 'renewed-refresh' };
    });
    await codec.rotateCredentialFile(config, acquire, async () => {});
    expect(acquire).toHaveBeenCalledOnce();
    expect(read().refresh_token).toBe('renewed-refresh');
  });

  it('does not overwrite a replacement authorization made while identity verification was pending', async () => {
    const { config, next, read } = fixture();
    const replacement = { ...config.credentials, access_token: 'replacement-access', refresh_token: 'replacement-refresh' };
    await expect(codec.rotateCredentialFile(config, async () => next, async () => {
      codec.writeCredentialFile(config.credentialFile, config.credentialKey, replacement);
    })).rejects.toMatchObject({ code: 'E_TOOL_CALL_AUTH' });
    expect(read()).toEqual(replacement);
  });
});
