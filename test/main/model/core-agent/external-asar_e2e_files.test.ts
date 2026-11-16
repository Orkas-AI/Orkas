import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { createPackage } from '@electron/asar';
import { transformSync } from 'esbuild';

const nativeRequire = createRequire(import.meta.url);

it('leaves external archives replaceable after actual file-tool reads, searches and refusals', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-external-asar-')));
  try {
    const source = path.join(root, 'source'); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'entry.txt'), 'packed sentinel');
    // Guarantee a strict-decoding refusal independently of header encoding.
    fs.writeFileSync(path.join(source, 'binary.bin'), Buffer.from([0xff, 0xfe, 0xfd]));
    const archive = path.join(root, 'fixture.asar');
    await finished(await createPackage(source, archive));
    fs.writeFileSync(path.join(source, 'binary.bin'), Buffer.alloc(5 * 1024 * 1024, 0xff));
    const largeArchive = path.join(root, 'large.asar');
    await finished(await createPackage(source, largeArchive));
    const application = path.join(root, 'application'); fs.mkdirSync(application);
    fs.writeFileSync(path.join(application, 'entry.txt'), 'application resource');
    fs.writeFileSync(path.join(application, 'user-file-fs.cjs'), transformSync(fs.readFileSync(path.resolve('src/main/util/user-file-fs.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code);
    const applicationArchive = path.join(root, 'application.asar');
    await finished(await createPackage(application, applicationArchive));
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    const result = spawnSync(nativeRequire('electron'), [path.resolve('test/fixtures/external-asar-file-tools.cjs'), process.cwd(), workspace, archive, largeArchive, applicationArchive], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_WORKSPACE_ROOT: path.join(root, 'state') },
    });
    expect(result.status, JSON.stringify({ status: result.status, stderrBytes: result.stderr?.length })).toBe(0);
    const receipt = result.stdout.split('\n').find(line => line.startsWith('ASAR_FILE_RESULT='));
    expect(receipt, result.stdout).toBeTruthy();
    const report = JSON.parse(receipt!.slice('ASAR_FILE_RESULT='.length));
    console.info('[ASAR filesystem]', JSON.stringify(report));
    expect(report.checks).toHaveLength(14);
    expect(report.checks.every((check: any) => check.outcome && check.replaceable && check.handles === check.before), JSON.stringify(report)).toBe(true);
    for (const check of report.checks) {
      expect(check, check.name).toMatchObject({ outcome: true, replaceable: true });
      if (check.handles !== null) expect(check.handles, check.name).toBe(check.before);
    }
    // Captured child diagnostics are part of acceptance, not discarded stderr.
    expect(result.stderr).toBe('');
    expect(result.stdout.split('\n').filter(line => line && !line.startsWith('ASAR_FILE_RESULT='))).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
