import { afterEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const fetchVc = require('../../../scripts/fetch-win-vc-runtime.cjs') as {
  installWindowsVcRuntime(options: Record<string, unknown>): Promise<string>;
  ready(destination: string, contract: any): boolean;
  targetOptions(argv: string[]): { platform: string; arch: string; force: boolean };
  windowsExpandExtract(archiveFile: string, destination: string, options?: Record<string, unknown>): void;
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function record(bytes: Buffer): { bytes: number; sha256: string } {
  return {
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function windowsPe(): Buffer {
  const bytes = Buffer.alloc(0x100);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(0x8664, 0x84);
  return bytes;
}

function burnBundle(attached: Buffer): Buffer {
  const peOffset = 0x80;
  const optionalHeaderBytes = 0xe0;
  const sectionOffset = peOffset + 24 + optionalHeaderBytes;
  const burnOffset = 0x200;
  const originalSignatureOffset = 0x300;
  const originalSignatureBytes = 0x10;
  const attachedOffset = originalSignatureOffset + originalSignatureBytes;
  const bytes = Buffer.alloc(attachedOffset + attached.length);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(peOffset, 0x3c);
  bytes.write('PE\0\0', peOffset, 'ascii');
  bytes.writeUInt16LE(0x8664, peOffset + 4);
  bytes.writeUInt16LE(1, peOffset + 6);
  bytes.writeUInt16LE(optionalHeaderBytes, peOffset + 20);
  bytes.writeUInt16LE(0x10b, peOffset + 24);
  bytes.write('.wixburn', sectionOffset, 'ascii');
  bytes.writeUInt32LE(0x100, sectionOffset + 16);
  bytes.writeUInt32LE(burnOffset, sectionOffset + 20);
  bytes.writeUInt32LE(0x00f14300, burnOffset);
  bytes.writeUInt32LE(2, burnOffset + 4);
  bytes.writeUInt32LE(originalSignatureOffset, burnOffset + 32);
  bytes.writeUInt32LE(originalSignatureBytes, burnOffset + 36);
  bytes.writeUInt32LE(1, burnOffset + 40);
  bytes.writeUInt32LE(2, burnOffset + 44);
  bytes.writeUInt32LE(attached.length, burnOffset + 52);
  attached.copy(bytes, attachedOffset);
  return bytes;
}

function fixture(): {
  archive: string;
  contract: any;
  files: Record<string, Buffer>;
  destination: string;
  sevenZipExtract: (archiveFile: string, output: string) => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-vc-runtime-'));
  tempDirs.push(root);
  const archive = path.join(root, 'VC_redist.x64.exe');
  const destination = path.join(root, 'runtime', 'vc', 'win32-x64');
  const files = {
    'msvcp140.dll': windowsPe(),
    'vcruntime140.dll': windowsPe(),
  };
  const attached = Buffer.from('MSCF-pinned-attached-cab');
  const runtimeCab = Buffer.from('MSCF-pinned-x64-runtime-cab');
  fs.writeFileSync(archive, burnBundle(attached));
  const archiveBytes = fs.readFileSync(archive);
  const contract = {
    schema: 1,
    version: '14.99.99999.0',
    platformKey: 'win32-x64',
    source: {
      name: path.basename(archive),
      url: 'https://example.invalid/vc_redist.x64.exe',
      ...record(archiveBytes),
      attachedCab: record(attached),
      x64RuntimeCab: { embeddedName: 'a4', ...record(runtimeCab) },
    },
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [
      name,
      { sourceName: `${name}_amd64`, ...record(bytes) },
    ])),
  };
  const sevenZipExtract = (archiveFile: string, output: string) => {
    fs.mkdirSync(output, { recursive: true });
    if (path.basename(archiveFile) === 'attached.cab') {
      fs.writeFileSync(path.join(output, 'a4'), runtimeCab);
      return;
    }
    if (path.basename(archiveFile) === 'a4') {
      for (const [name, bytes] of Object.entries(files)) {
        fs.writeFileSync(path.join(output, contract.files[name].sourceName), bytes);
      }
      return;
    }
    throw new Error(`unexpected fake archive: ${archiveFile}`);
  };
  return { archive, contract, files, destination, sevenZipExtract };
}

describe('fetch-win-vc-runtime', () => {
  it('parses an explicit Windows package target', () => {
    expect(fetchVc.targetOptions([
      'node', 'fetch-win-vc-runtime.cjs', '--platform', 'win32', '--arch', 'x64', '--force',
    ])).toEqual({ platform: 'win32', arch: 'x64', force: true });
  });

  it('uses the Windows built-in CAB extractor without requiring a second runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-vc-expand-'));
    tempDirs.push(root);
    const archive = path.join(root, 'attached.cab');
    const destination = path.join(root, 'expanded');
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];

    fetchVc.windowsExpandExtract(archive, destination, {
      systemRoot: 'C:\\Windows',
      execFileSync: (file: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ file, args, options });
      },
    });

    expect(calls).toEqual([{
      file: path.join('C:\\Windows', 'System32', 'expand.exe'),
      args: [archive, '-F:*', destination],
      options: { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    }]);
  });

  it('extracts only pinned Microsoft runtime DLLs and writes a verified app-local marker', async () => {
    const { archive, contract, files, destination, sevenZipExtract } = fixture();
    await fetchVc.installWindowsVcRuntime({
      platform: 'win32',
      arch: 'x64',
      force: true,
      archiveFile: archive,
      destination,
      contract,
      sevenZipExtract,
    });

    expect(fetchVc.ready(destination, contract)).toBe(true);
    expect(fs.readdirSync(destination).sort()).toEqual([
      '.orkas-vc-runtime.json',
      'NOTICE.txt',
      ...Object.keys(files),
    ].sort());
    const marker = JSON.parse(fs.readFileSync(path.join(destination, '.orkas-vc-runtime.json'), 'utf8'));
    expect(marker.deployment).toBe('application-local');
    expect(marker.sourceSha256).toBe(contract.source.sha256);
  });

  it('copies the VC DLLs into the Windows app root and has no NSIS runtime installer hook', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.build.win.extraFiles).toEqual([{
      from: 'resources/runtime/vc/win32-x64',
      to: '.',
      filter: ['*.dll'],
    }]);
    expect(pkg.build.nsis?.include).toBeUndefined();
    expect(fs.existsSync(path.join(process.cwd(), 'product', 'whisper-runtime.nsh'))).toBe(false);
  });

  it('uses shared dev and beforePack lifecycles without adding VC logic to run.cmd', () => {
    const root = process.cwd();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const ensureDev = fs.readFileSync(path.join(root, 'scripts', 'ensure-dev-dependencies.cjs'), 'utf8');
    const ensurePack = fs.readFileSync(path.join(root, 'scripts', 'ensure-runtime-before-pack.cjs'), 'utf8');
    const runCmd = fs.readFileSync(path.join(root, 'run.cmd'), 'utf8');
    const bootstrap = fs.readFileSync(path.join(root, 'bootstrap.cjs'), 'utf8');

    expect(pkg.scripts['vc:fetch']).toBe(
      'node scripts/fetch-win-vc-runtime.cjs --platform win32 --arch x64',
    );
    expect(ensureDev).toContain("run('Windows VC runtime', 'scripts/fetch-win-vc-runtime.cjs'");
    expect(ensureDev.indexOf('scripts/fetch-win-vc-runtime.cjs')).toBeLessThan(
      ensureDev.indexOf('scripts/fetch-whisper.cjs'),
    );
    expect(ensurePack).toContain("path.join(pcRoot, 'scripts', 'fetch-win-vc-runtime.cjs')");
    expect(ensurePack.indexOf("'fetch-win-vc-runtime.cjs'")).toBeLessThan(
      ensurePack.indexOf("'fetch-whisper.cjs'"),
    );
    expect(runCmd).toContain('scripts\\ensure-dev-dependencies.cjs');
    expect(runCmd).not.toContain('fetch-win-vc-runtime');
    expect(runCmd).not.toContain('prepare-dev-win-vc-runtime');
    expect(bootstrap).toContain("path.join(__dirname, 'resources', 'runtime', 'vc', platformKey)");
  });
});
