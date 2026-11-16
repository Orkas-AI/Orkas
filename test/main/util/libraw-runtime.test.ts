import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const fixture = require('../../fixtures/libraw-runtime.cjs');
const gate = require('../../../bin/runtime-gate.cjs');
const provision = require('../../../scripts/fetch-libraw.cjs');
const roots: string[] = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-libraw-gate-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('bundled LibRaw contract', () => {
  it.each(['win32-x64', 'darwin-arm64', 'darwin-x64'])('requires the target binary, source and licenses for %s', key => {
    const root = temp(), spec = fixture.write(root, key), [platform, arch] = key.split('-');
    // Windows fixtures cannot represent POSIX execute bits. Target integrity
    // remains checked here; POSIX packaging mode has its own native-host case.
    const options = { librawContract: spec, checkArch: false, requireExecutable: process.platform !== 'win32' };
    expect(gate.verifyLibRawRuntimeDir(root, platform, arch, options)).toContain('dcraw_emu');
    for (const name of ['source.tar.gz', 'LICENSE', `bin/${platform === 'win32' ? 'dcraw_emu.exe' : 'dcraw_emu'}`]) {
      const file = path.join(root, 'libraw', key, name), bytes = fs.readFileSync(file);
      fs.writeFileSync(file, 'corrupt');
      expect(() => gate.verifyLibRawRuntimeDir(root, platform, arch, options)).toThrow(/hash\/size mismatch/);
      fs.writeFileSync(file, bytes);
    }
    fs.mkdirSync(path.join(root, 'libraw', 'foreign-arch'));
    expect(() => gate.verifyLibRawRuntimeDir(root, platform, arch, options)).toThrow(/unexpected runtime/);
  });
  it('accepts only signed executables after team verification and still checks source bytes', () => {
    const root = temp(), key = 'darwin-arm64', spec = fixture.write(root, key);
    fs.appendFileSync(path.join(root, 'libraw', key, 'bin/dcraw_emu'), 'signature');
    const options = { librawContract: spec, checkArch: false, allowSignedDarwinRuntime: true, expectedTeamIdentifier: 'fixture', verifySignedDarwinBinary: () => {} };
    expect(() => gate.verifyLibRawRuntimeDir(root, 'darwin', 'arm64', options)).not.toThrow();
    fs.appendFileSync(path.join(root, 'libraw', key, 'source.tar.gz'), 'corrupt');
    expect(() => gate.verifyLibRawRuntimeDir(root, 'darwin', 'arm64', options)).toThrow(/hash\/size/);
  });
  it('registers RAW verification as mandatory and uses the same development/release provisioner', () => {
    expect(gate.requiredRuntimeVerificationEntries('win32', 'x64')).toContain('runtime:libraw:win32-x64');
    for (const file of ['scripts/ensure-dev-dependencies.cjs', 'scripts/ensure-runtime-before-pack.cjs']) {
      expect(fs.readFileSync(path.resolve(file), 'utf8')).toContain('fetch-libraw.cjs');
    }
    const target = gate.LIBRAW_RUNTIME_CONTRACT.targets['win32-x64'];
    const files = provision.expectedFiles(target);
    for (const name of ['libraw.dll', 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) expect(files[`bin/${name}`].sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('reuses verified cached archives without any network request', async () => {
    const root = temp(), bytes = Buffer.from('verified archive');
    const spec = { name: 'fixture.zip', bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), url: 'https://invalid.example/never' };
    fs.writeFileSync(path.join(root, spec.name), bytes);
    expect(await provision.cachedDownload(spec, root)).toBe(path.join(root, spec.name));
  });
});
