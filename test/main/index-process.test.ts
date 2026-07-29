import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('main process child-process ownership', () => {
  it('keeps unpackaged E2E launches isolated and hidden by default', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/index.ts'),
      'utf8',
    );

    expect(source).toContain('process.env.ORKAS_E2E_USER_DATA_DIR');
    expect(source).toContain('process.env.ORKAS_E2E_HIDE_WINDOW');
    expect(source).toMatch(
      /else if \(E2E_USER_DATA_DIR\)[\s\S]*app\.setPath\('userData', path\.resolve\(E2E_USER_DATA_DIR\)\)/,
    );
    expect(source).toContain(
      'show: !IS_PACKAGED_LAUNCH_SMOKE && !E2E_HIDE_WINDOW',
    );
  });

  it('keeps the open-build relaunch command detached and hidden', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/index.ts'),
      'utf8',
    );
    const relaunchStart = source.indexOf('const child = spawn');
    expect(relaunchStart).toBeGreaterThan(-1);
    const relaunchBlock = source.slice(relaunchStart, relaunchStart + 500);
    expect(relaunchBlock).toContain('detached: true');
    expect(relaunchBlock).toContain("stdio: 'ignore'");
    expect(relaunchBlock).toContain('windowsHide: true');
    expect(relaunchBlock).toContain('child.unref()');
  });
});
