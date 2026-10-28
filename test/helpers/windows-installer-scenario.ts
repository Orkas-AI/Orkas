import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Shared by the native test lane and the isolated remote Windows probe.
export async function exerciseWindowsInstaller(node: string, script: string) {
  assert.equal(process.platform, 'win32');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Orkas install 测试 ' "));
  const install = path.join(root, 'Orkas');
  const sibling = `${install}-other`;
  const runtime = path.join(install, 'resources/runtime/node');
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(sibling);
  const stockNode = node;
  assert.ok(stockNode);
  const executables = [
    path.join(install, 'Orkas.exe'), path.join(runtime, 'node.exe'),
    path.join(sibling, 'Orkas.exe'), path.join(install, 'installer.exe'),
  ];
  for (const file of executables) fs.copyFileSync(stockNode, file);
  const children: ChildProcess[] = [];
  const errors: string[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    for (const file of executables) {
      const child = spawn(file, ['-e', "console.log('ready');setTimeout(()=>{},60000)"], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
      children.push(child);
      child.stderr!.on('data', bytes => errors.push(String(bytes)));
      await once(child.stdout!, 'data', { signal: AbortSignal.timeout(5000) });
    }
    // Independent negative control: a running image cannot be overwritten.
    assert.throws(() => fs.copyFileSync(stockNode, executables[1]));
    const powershell = path.win32.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const run = (target: string) => spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-InstallDir', target, '-InstallerProcessId', String(children[3].pid),
    ], { timeout: 25_000, encoding: 'utf8', windowsHide: true });
    const invalid = run(path.parse(install).root);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.equal(invalid.stderr.trim(), 'Installer process cleanup failed.');
    assert.equal(children.every(child => alive(child.pid!)), true);
    // A parent folder is not the installed app, even when it contains one.
    // Selecting it must not expand cleanup to all sibling installations.
    const parent = run(root);
    assert.equal(parent.status, 0);
    assert.equal(parent.stdout + parent.stderr, '');
    assert.equal(children.every(child => alive(child.pid!)), true, 'A non-installation parent directory broadened cleanup');
    const result = run(install);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stdout + result.stderr, '');
    assert.equal(alive(children[0].pid!), false);
    assert.equal(alive(children[1].pid!), false);
    assert.equal(alive(children[2].pid!), true);
    assert.equal(alive(children[3].pid!), true);
    fs.copyFileSync(stockNode, executables[1]);
    // An interrupted uninstall can remove Orkas.exe first. Its ASAR still
    // identifies the installation; a subsequently orphaned runtime must close.
    fs.unlinkSync(executables[0]);
    fs.writeFileSync(path.join(install, 'resources', 'app.asar'), 'fixture app marker');
    const residual = spawn(executables[1], ['-e', "console.log('ready');setTimeout(()=>{},60000)"], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    children.push(residual);
    residual.stderr!.on('data', bytes => errors.push(String(bytes)));
    await once(residual.stdout!, 'data', { signal: AbortSignal.timeout(5000) });
    const retry = run(install);
    assert.equal(retry.status, 0);
    assert.equal(retry.stdout + retry.stderr, '');
    assert.equal(alive(residual.pid!), false, 'A partial installation retained its orphaned runtime');
    assert.equal(alive(children[2].pid!), true);
    assert.equal(alive(children[3].pid!), true);
    fs.copyFileSync(stockNode, executables[1]);
    const emptyRetry = run(install);
    assert.equal(emptyRetry.status, 0);
    assert.equal(emptyRetry.stdout + emptyRetry.stderr, '');
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close', { signal: AbortSignal.timeout(5000) });
      child.kill();
      await closed;
    }));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  assert.deepEqual(errors, []);
  return { fileReplaced: true, siblingPreserved: true, installerPreserved: true, invalidTargetRejected: true, parentDirectoryPreserved: true, partialInstallRecovered: true, retrySucceeded: true };
}
