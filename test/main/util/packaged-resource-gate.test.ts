import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const {
  parseAppleStrings,
  verifyEmbeddingModelRoot,
  verifyExtraResourcesConfig,
  verifyMacLocalizedMetadataRoot,
  verifyResourceContract,
} = require('../../../bin/packaged-resource-gate.cjs') as {
  parseAppleStrings: (text: string, label?: string) => Record<string, string>;
  verifyEmbeddingModelRoot: (root: string) => string;
  verifyExtraResourcesConfig: (entries: unknown) => string[];
  verifyMacLocalizedMetadataRoot: (root: string, options?: { allowElectronResources?: boolean }) => string;
  verifyResourceContract: (root: string, contract: Record<string, unknown>) => string;
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-packaged-resource-gate-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeFixture(): { root: string; file: string; contract: Record<string, unknown> } {
  const root = path.join(tmpDir, 'resource');
  const dir = path.join(root, 'model-v1');
  const bytes = Buffer.from('pinned model bytes');
  const file = path.join(dir, 'model.bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, bytes);
  return {
    root,
    file,
    contract: {
      kind: 'test-model',
      id: 'model-v1',
      files: [{ name: 'model.bin', bytes: bytes.length, sha256: sha256(bytes) }],
    },
  };
}

describe('packaged-resource-gate', () => {
  it('verifies the complete pinned resource tree', () => {
    const fixture = writeFixture();
    expect(verifyResourceContract(fixture.root, fixture.contract)).toBe('resource:test-model:model-v1');
  });

  it('fails when a pinned file is changed', () => {
    const fixture = writeFixture();
    fs.appendFileSync(fixture.file, 'tampered');
    expect(() => verifyResourceContract(fixture.root, fixture.contract)).toThrow(/size mismatch/);
  });

  it('fails when an undeclared resource file is present', () => {
    const fixture = writeFixture();
    fs.writeFileSync(path.join(path.dirname(fixture.file), 'stale.bin'), 'stale');
    expect(() => verifyResourceContract(fixture.root, fixture.contract)).toThrow(/unexpected test-model file/);
  });

  it('matches the checked-in embedding-model payload to the pinned contract', () => {
    const root = path.join(process.cwd(), 'resources', 'embedding-model');
    expect(verifyEmbeddingModelRoot(root)).toBe('resource:embedding-model:fast-bge-small-zh-v1.5');
  });

  it('verifies the complete macOS localized metadata tree and translations', () => {
    const root = path.join(process.cwd(), 'resources', 'mac-locales');
    expect(verifyMacLocalizedMetadataRoot(root)).toBe('resource:mac-locales:v1');
  });

  it('parses comments and escaped values in Apple strings syntax', () => {
    expect(parseAppleStrings('/* locale */\n"key" = "line\\nvalue"; // done\n')).toEqual({
      key: 'line\nvalue',
    });
    expect(() => parseAppleStrings('"key" = "missing semicolon"')).toThrow(/expected ; after value/);
  });

  it('rejects a missing, changed, or unexpected macOS localized resource', () => {
    const root = path.join(tmpDir, 'mac-locales');
    fs.cpSync(path.join(process.cwd(), 'resources', 'mac-locales'), root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'en.lproj', 'InfoPlist.strings'),
      '"NSMicrophoneUsageDescription" = "Changed";\n',
    );
    expect(() => verifyMacLocalizedMetadataRoot(root)).toThrow(/content mismatch/);

    fs.cpSync(path.join(process.cwd(), 'resources', 'mac-locales'), root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'fr.lproj'));
    fs.writeFileSync(path.join(root, 'fr.lproj', 'InfoPlist.strings'), '"key" = "value";\n');
    expect(() => verifyMacLocalizedMetadataRoot(root)).toThrow(/unexpected mac localized metadata locale/);
  });

  it('allows Electron-owned locale siblings only in the final Resources directory', () => {
    const root = path.join(tmpDir, 'Resources');
    fs.cpSync(path.join(process.cwd(), 'resources', 'mac-locales'), root, { recursive: true });
    fs.mkdirSync(path.join(root, 'af.lproj'));
    fs.writeFileSync(path.join(root, 'af.lproj', 'locale.pak'), 'electron locale');
    fs.writeFileSync(path.join(root, 'en.lproj', 'locale.pak'), 'electron locale');

    expect(() => verifyMacLocalizedMetadataRoot(root)).toThrow(/unexpected mac localized metadata locale/);
    expect(verifyMacLocalizedMetadataRoot(root, { allowElectronResources: true }))
      .toBe('resource:mac-locales:v1');
  });

  it('requires every package extraResources destination to have shared contract ownership', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(verifyExtraResourcesConfig(pkg.build.extraResources)).toEqual([
      'embedding-model', 'runtime', 'builtin', 'officecli', '.',
    ]);
  });

  it('rejects a newly packaged resource until it is registered', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(() => verifyExtraResourcesConfig([
      ...pkg.build.extraResources,
      { from: 'resources/new-runtime', to: 'new-runtime' },
    ])).toThrow(/unregistered extraResources destination: new-runtime/);
  });

  it('requires the macOS locale copy rule to be closed-world', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const localeEntry = pkg.build.extraResources.find((entry: { to?: string }) => entry.to === '.');
    localeEntry.filter.push('**/*');
    expect(() => verifyExtraResourcesConfig(pkg.build.extraResources))
      .toThrow(/mac localized metadata filters must exactly match/);
  });
});
