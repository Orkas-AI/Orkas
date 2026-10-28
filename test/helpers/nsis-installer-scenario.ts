import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type CleanupFixture = 'real' | 'failed' | 'timeout' | 'disabled';
export type InstallerFixtures = Record<CleanupFixture, string>;

export interface NsisTool {
  path: string;
  env?: NodeJS.ProcessEnv;
}

/** Use an installed public compiler; resolving a test tool never downloads it. */
export function resolveNsisTool(env: NodeJS.ProcessEnv = process.env, platform = process.platform): NsisTool {
  const configured = env.ORKAS_TEST_MAKENSIS?.trim();
  const directory = env.ELECTRON_BUILDER_NSIS_DIR?.trim();
  if (configured && !path.isAbsolute(configured)) throw new Error('ORKAS_TEST_MAKENSIS must be an absolute compiler path');
  if (directory && !path.isAbsolute(directory)) throw new Error('ELECTRON_BUILDER_NSIS_DIR must be an absolute toolchain path');
  return {
    path: configured || (directory
      ? path.join(directory, platform === 'darwin' ? 'mac' : platform === 'win32' ? 'Bin' : 'linux',
        platform === 'win32' ? 'makensis.exe' : 'makensis')
      : platform === 'win32' ? 'makensis.exe' : 'makensis'),
    ...(directory ? { env: { NSISDIR: directory } } : {}),
  };
}

/** Compile the production hook; substitute only the helper for explicit fault
 * fixtures. No registry, real installation, certificate, or user profile writes. */
export async function buildInstallerFixtures(
  pcRoot: string, destination: string, tool: NsisTool = resolveNsisTool(),
): Promise<InstallerFixtures> {
  const escape = (value: string) => value.replaceAll('$', '$$');
  const payload = path.join(destination, 'runtime-payload.txt');
  fs.writeFileSync(payload, 'new-runtime');
  const result = {} as InstallerFixtures;
  for (const fault of ['real', 'failed', 'timeout', 'disabled'] as const) {
    const cleanup = path.join(destination, `${fault}.ps1`);
    if (fault !== 'real') fs.writeFileSync(cleanup, {
      failed: 'exit 1', timeout: 'Start-Sleep -Seconds 60', disabled: 'exit 0',
    }[fault]);
    const executable = path.join(destination, `${fault}.exe`);
    const script = path.join(destination, `${fault}.nsi`);
    fs.writeFileSync(script, `Unicode true
RequestExecutionLevel user
!include LogicLib.nsh
!include x64.nsh
!define isUpdated '"1" == "1"'
Name "Orkas installation regression"
OutFile "${escape(executable)}"
InstallDir "$TEMP\\Orkas-installation-test"
LangString appCannotBeClosed 1033 "Orkas cannot be closed."
!include "${escape(path.join(pcRoot, 'scripts/windows-installer.nsh'))}"
${fault === 'real' ? '' : `!undef ORKAS_INSTALLER_CLEANUP\n!define ORKAS_INSTALLER_CLEANUP "${escape(cleanup)}"`}
Function .onInit
  !insertmacro customInit
FunctionEnd
Function .onInstFailed
  SetErrorLevel 2
FunctionEnd
Section
  SetOutPath "$INSTDIR\\runtime"
  File /oname=node.exe "${escape(payload)}"
  SetOutPath "$INSTDIR"
  FileOpen $0 "$INSTDIR\\version.txt" w
  FileWrite $0 "version-2"
  FileClose $0
SectionEnd
`);
    const compiled = spawnSync(tool.path, ['-V3', script], {
      env: { ...process.env, ...tool.env }, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    assert.equal(compiled.error, undefined,
      'NSIS compiler unavailable; install makensis or set ORKAS_TEST_MAKENSIS / ELECTRON_BUILDER_NSIS_DIR');
    assert.equal(compiled.status, 0,
      `NSIS fixture compilation failed (signal ${compiled.signal || 'none'}):\n${compiled.stdout}\n${compiled.stderr}`);
    assert.equal(compiled.stderr, '');
    assert.doesNotMatch(compiled.stdout, /warning \d+:/i);
    assert.equal(fs.readFileSync(executable).subarray(0, 2).toString(), 'MZ');
    result[fault] = executable;
  }
  return result;
}

export async function exerciseNsisInstaller(node: string, fixtures: InstallerFixtures, fault: CleanupFixture) {
  assert.equal(process.platform, 'win32');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Orkas NSIS 测试 ' "));
  const install = path.join(root, 'Orkas');
  const sibling = `${install}-other`;
  fs.mkdirSync(path.join(install, 'runtime'), { recursive: true });
  fs.mkdirSync(sibling);
  const images = [path.join(install, 'Orkas.exe'), path.join(install, 'runtime/node.exe'), path.join(sibling, 'Orkas.exe')];
  const children: ChildProcess[] = [];
  const errors: string[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const version = path.join(install, 'version.txt');
  const data = path.join(install, 'data.json');
  fs.writeFileSync(version, 'version-1');
  fs.writeFileSync(data, '{"retained":true}');
  const run = (kind: CleanupFixture) => {
    // Execute inside the installation directory to test the real PID exclusion.
    const installer = path.join(install, 'setup.exe');
    fs.copyFileSync(fixtures[kind], installer);
    return spawnSync(installer, ['/S', '/D=' + install], {
      windowsVerbatimArguments: true, windowsHide: true, timeout: 30_000, encoding: 'utf8', maxBuffer: 64 * 1024,
    });
  };
  const verifyInstalled = (installed: ReturnType<typeof run>) => {
    assert.equal(installed.error, undefined);
    assert.equal(installed.status, 0);
    assert.equal(installed.stdout + installed.stderr, '');
    assert.equal(fs.readFileSync(version, 'utf8'), 'version-2');
    assert.equal(fs.readFileSync(images[1], 'utf8'), 'new-runtime');
    assert.equal(alive(children[0].pid!), false);
    assert.equal(alive(children[1].pid!), false);
    assert.equal(alive(children[2].pid!), true);
    assert.equal(fs.readFileSync(data, 'utf8'), '{"retained":true}');
  };
  try {
    for (const image of images) {
      fs.copyFileSync(node, image);
      const child = spawn(image, ['-e', "console.log('ready');setTimeout(()=>{},90000)"], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
      children.push(child);
      child.stderr!.on('data', bytes => errors.push(String(bytes)));
      await once(child.stdout!, 'data', { signal: AbortSignal.timeout(5000) });
    }
    // Prove that skipping cleanup would encounter a real locked executable.
    assert.throws(() => fs.writeFileSync(images[1], 'new-runtime'));
    if (fault !== 'real') {
      const oldImage = fs.readFileSync(images[1]);
      const failed = run(fault);
      assert.equal(failed.error, undefined, 'Installer must stop by itself before the harness deadline');
      assert.equal(failed.stdout + failed.stderr, '');
      if (fault === 'disabled') {
        // Mutation control: a silent NSIS File instruction can ignore a locked
        // image and still return zero/write the version marker. The exact same
        // success oracle must reject this incomplete installation.
        assert.throws(() => verifyInstalled(failed), 'The oracle accepted disabled cleanup');
      } else {
        assert.equal(failed.status, 2);
        assert.equal(fs.readFileSync(version, 'utf8'), 'version-1');
      }
      assert.deepEqual(fs.readFileSync(images[1]), oldImage);
      assert.equal(children.every(child => alive(child.pid!)), true);
    }
    const installed = run('real');
    verifyInstalled(installed);
    assert.deepEqual(errors, []);
    return { fault, installedVersion: 2, siblingPreserved: true, userDataPreserved: true };
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close', { signal: AbortSignal.timeout(5000) });
      child.kill();
      await closed;
    }));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
