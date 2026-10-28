import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { captureWindowsShutdownProcesses } from '../../src/main/util/windows-shutdown-processes';

/**
 * Shared by Vitest's Windows lane and a dependency-free bundle for remote
 * verification. Assertions use actual process liveness and file replacement,
 * so a helper reporting success without releasing resources cannot pass.
 */
export async function exerciseWindowsShutdown(
  node: string,
  capture = captureWindowsShutdownProcesses,
) {
  assert.equal(process.platform, 'win32', 'This scenario requires native Windows');
  assert.ok(node, 'A stock Node executable is required');
  const directory = await mkdtemp(join(tmpdir(), 'Orkas shutdown 测试 '));
  const lockedFile = join(directory, 'runtime.dll');
  const replacement = join(directory, 'replacement.dll');
  await writeFile(lockedFile, 'old version');
  await writeFile(replacement, 'new version');
  const stderr: string[] = [];
  const launch = (code: string) => {
    const child = spawn(node, ['-e', code], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ORKAS_SHUTDOWN_LOCK_FILE: lockedFile },
    });
    child.stderr!.on('data', chunk => { stderr.push(String(chunk)); });
    return child;
  };
  // Fixtures also expire if the surrounding test process is interrupted.
  const sleeper = 'setTimeout(() => {}, 90000)';
  const branchCode = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',${JSON.stringify(sleeper)}],{stdio:'ignore',windowsHide:true});
    console.log(child.pid);setTimeout(()=>{},90000);`;
  const lockScript = `$ErrorActionPreference='Stop'
    $file=[IO.File]::Open($env:ORKAS_SHUTDOWN_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Threading.Thread]::Sleep(90000) }
    finally { $file.Dispose() }`;
  const rootCode = `const {spawn}=require('node:child_process');
    const {join}=require('node:path');
    require('node:readline').createInterface({input:process.stdin}).on('line',command=>{
      const lock=command==='lock';
      const child=spawn(lock ? join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe') : process.execPath,
        lock ? ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',${JSON.stringify(Buffer.from(lockScript, 'utf16le').toString('base64'))}]
          : ['-e',${JSON.stringify(branchCode)}],
        {stdio:['ignore','pipe','pipe'],windowsHide:true});
      child.stderr.pipe(process.stderr);
      child.stdout.once('data',data=>console.log(JSON.stringify({parent:child.pid,child:lock?null:Number(String(data).trim())})));
    });setTimeout(()=>process.exit(),90000);`;
  const owner = launch(rootCode);
  const other = launch(sleeper);
  const ownedPids: number[] = [];
  let processes: Awaited<ReturnType<typeof capture>> | undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitForExit = async (pid: number) => {
    for (let attempt = 0; attempt < 100 && alive(pid); attempt++) await delay(30);
    assert.equal(alive(pid), false, 'Fixture process did not exit');
  };
  const request = async (command: string) => {
    const line = once(owner.stdout!, 'data', { signal: AbortSignal.timeout(10_000) });
    owner.stdin!.write(`${command}\n`);
    const [bytes] = await line;
    const result = JSON.parse(String(bytes).trim()) as { parent: number; child: number | null };
    ownedPids.push(result.parent);
    if (result.child) ownedPids.push(result.child);
    return result;
  };
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'close', { signal: AbortSignal.timeout(5_000) });
    child.kill();
    await exited;
  };
  try {
    const early = await request('branch');
    await request('lock');
    // Negative control: prove the fixture really prevents replacement.
    await assert.rejects(rename(replacement, lockedFile), { code: 'EPERM' });
    processes = await capture('win32', owner.pid!);
    processes.dispose();
    for (const pid of ownedPids) assert.equal(alive(pid), true, 'Cancelling shutdown killed active work');
    await assert.rejects(rename(replacement, lockedFile), { code: 'EPERM' });

    // Retry after cancellation, then orphan a child during graceful shutdown.
    processes = await capture('win32', owner.pid!);
    process.kill(early.parent);
    await waitForExit(early.parent);
    assert.equal(alive(early.child!), true, 'The orphan fixture exited before cleanup');
    await request('branch');
    await processes.terminate();
    for (const pid of ownedPids) assert.equal(alive(pid), false, 'Owned descendant remains alive');
    assert.equal(alive(owner.pid!), true, 'Cleanup terminated the owner before handoff');
    assert.equal(alive(other.pid!), true, 'Cleanup terminated an unrelated Node process');
    await rename(replacement, lockedFile);
    assert.equal(await readFile(lockedFile, 'utf8'), 'new version', 'Installer could not replace the locked file');
    return { descendants: ownedPids.length, cancellationPreservedWork: true, fileReplaced: true, ownerPreserved: true, unrelatedPreserved: true };
  } finally {
    processes?.dispose();
    for (const pid of ownedPids) { try { process.kill(pid); } catch { /* already exited */ } }
    await Promise.all([stop(owner), stop(other)]);
    for (const pid of ownedPids) await waitForExit(pid);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    assert.equal(stderr.join(''), '', 'Fixture emitted unexpected stderr');
  }
}
