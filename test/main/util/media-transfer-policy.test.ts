import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { MEDIA_TRANSFER_POLICY } from '../../../src/main/util/media-transfer-policy';
const require = createRequire(import.meta.url);
const { verifyMediaTransferPolicy } = require('../../../scripts/media-transfer-policy.cjs');

describe('media transfer policy packaging', () => {
  it('keeps the monorepo and standalone PC budgets compatible', () => {
    verifyMediaTransferPolicy(process.cwd());
    const minimatchModule = require('minimatch');
    const minimatch = minimatchModule.minimatch || minimatchModule;
    const included = (file: string, patterns: string[]) => {
      let result = false;
      for (const raw of patterns || []) {
        if (typeof raw !== 'string') throw new Error('Package patterns must be strings.');
        const negative = raw.startsWith('!');
        const pattern = (negative ? raw.slice(1) : raw).replace(/\\/g, '/').replace(/^\.\//, '');
        if (minimatch(file, pattern, { dot: true })
          || (!/[.*?{}[\]()]/.test(pattern) && file.startsWith(`${pattern}/`))) result = !negative;
      }
      return result;
    };
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    expect(included('src/main/util/media-transfer-policy.json', pkg.build.files)).toBe(true);
    expect(MEDIA_TRANSFER_POLICY).toMatchObject({ connectMs: 30_000, controlMs: 60_000,
      transferMs: 600_000, pollMs: 20_000, legacyCreateMs: 130_000 });
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-media-policy-'));
    const root = path.join(temp, 'PC');
    try {
      fs.mkdirSync(path.join(root, 'src/main/util'), { recursive: true });
      const target = path.join(root, 'src/main/util/media-transfer-policy.json');
      const source = fs.readFileSync('src/main/util/media-transfer-policy.json');
      fs.writeFileSync(target, source);
      verifyMediaTransferPolicy(root); // Standalone checkout.
      fs.mkdirSync(path.join(temp, 'Common/config'), { recursive: true });
      fs.writeFileSync(path.join(temp, 'Common/config/media-transfer-policy.json'), source);
      fs.writeFileSync(target, JSON.stringify({ ...JSON.parse(source.toString()), control_seconds: 70 }));
      expect(() => verifyMediaTransferPolicy(root)).toThrow('Stale media transfer policy');
      fs.writeFileSync(target, JSON.stringify({ ...JSON.parse(source.toString()), upload_signature_seconds: 300 }));
      expect(() => verifyMediaTransferPolicy(root)).toThrow('Invalid media transfer policy');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
});
