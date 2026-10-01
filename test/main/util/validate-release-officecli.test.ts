import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { verifyHostOfficeCliBinary } = require('../../../bin/officecli-policy-gate.cjs');
const { VERSION } = require('../../../scripts/fetch-officecli.cjs');
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-release-officecli-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('mac release OfficeCLI version probe', () => {
  function binary(version: string): string {
    const directory = path.join(root, 'resources', 'officecli');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'officecli');
    // Model the real upstream side effect: even --version starts an update
    // unless the caller explicitly disables it. No network is needed here.
    fs.writeFileSync(file, [
      '#!/bin/sh',
      '[ "$1" = "--version" ] || [ "$1 $2" = "view --help" ] || exit 2',
      'if [ "$OFFICECLI_SKIP_UPDATE" != "1" ]; then',
      '  printf "partial update" > "$0.update.partial"',
      'fi',
      `[ "$1" != "--version" ] || printf '%s\\n' '${version}'`,
      '[ "$1" != "view" ] || printf "html --page --out\\n"',
      '',
    ].join('\n'), { mode: 0o755 });
    const scripts = path.join(root, 'scripts');
    fs.mkdirSync(scripts);
    const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.writeFileSync(path.join(scripts, 'fetch-officecli.cjs'), `module.exports = ${JSON.stringify({
      VERSION, ASSETS: { [`${process.platform}-${process.arch}`]: 'officecli' }, SHA256: { officecli: sha },
    })};`);
    return file;
  }

  it('verifies the pinned version without modifying the signed payload directory', () => {
    const file = binary(VERSION.replace(/^v/, ''));
    const before = fs.readFileSync(file);
    verifyHostOfficeCliBinary(root, { required: true });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['officecli']);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('rejects a different version while still suppressing self-update', () => {
    const file = binary('0.0.0');
    expect(() => verifyHostOfficeCliBinary(root, { required: true })).toThrow(/version mismatch/);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['officecli']);
  });
});
