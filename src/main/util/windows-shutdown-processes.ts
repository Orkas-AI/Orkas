import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { ShutdownProcesses } from './shutdown';

const DEADLINE_MS = 15_000;
const appCaptures = new Set<ReadonlySet<number>>();

/** Reuse only a snapshot that already pinned this specific connector root. */
export function hasCapturedWindowsAppProcess(pid: number): boolean {
  for (const captured of appCaptures) if (captured.has(pid)) return true;
  return false;
}

/**
 * A short-lived Windows helper holds process handles before graceful shutdown
 * can orphan children. It only terminates descendants of this app instance,
 * never processes selected by executable name or installation-directory prefix.
 * The installer is launched after this helper has exited.
 */
export async function captureWindowsShutdownProcesses(
  platform: NodeJS.Platform = process.platform,
  ownerPid = process.pid,
  spawnProcess: typeof spawn = spawn,
): Promise<ShutdownProcesses> {
  if (platform !== 'win32') return { terminate: async () => {}, dispose() {} };
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error('Invalid shutdown owner');
  const root = process.env.SystemRoot || 'C:\\Windows';
  const child = spawnProcess(
    path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(`$ownerProcessId = ${ownerPid}\n$reportOwned = $${ownerPid === process.pid}\n${SCRIPT}`, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  let ready = false;
  let finished = false;
  let failed = false;
  let registered: ReadonlySet<number> | undefined;
  const unregister = () => {
    if (registered) { appCaptures.delete(registered); registered = undefined; }
  };
  let output = '';
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveExit!: () => void;
  let rejectExit!: (error: Error) => void;
  const prepared = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise<void>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  // The helper can fail while the app is still flushing local state.
  void exited.catch(() => {});
  const fail = () => {
    failed = true;
    unregister();
    const error = new Error('Windows process cleanup failed');
    rejectReady(error);
    rejectExit(error);
  };
  child.on('error', fail);
  child.stdin!.on('error', fail);
  child.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (output.length > (ownerPid === process.pid ? 65_536 : 64)) { fail(); child.kill(); return; }
    if (output.includes('ready\n') || output.includes('ready\r\n')) {
      ready = true;
      resolveReady();
    }
  });
  child.once('exit', (code) => {
    finished = true;
    unregister();
    if (ready && code === 0) resolveExit();
    else fail();
  });
  const bounded = async (work: Promise<void>) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error('Windows process cleanup timed out'));
        }, DEADLINE_MS);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const dispose = () => {
    unregister();
    if (!finished) child.kill();
  };
  try { await bounded(prepared); }
  catch (error) { dispose(); throw error; }
  if (!finished && !failed && ownerPid === process.pid) {
    // The helper pins at most 4096 process handles. Unknown/late roots need
    // their own capture; an app-wide snapshot is not continuous supervision.
    const record = /^owned:([0-9,]+)\r?$/m.exec(output);
    const ids = record?.[1].split(',').map(Number);
    if (!ids || ids.length > 4096 || !ids.includes(ownerPid)
        || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      dispose();
      throw new Error('Windows process snapshot is invalid');
    }
    registered = new Set(ids);
    appCaptures.add(registered);
  }
  return {
    async terminate() {
      if (finished) throw new Error('Windows process cleanup ended before handoff');
      child.stdin!.end('stop\n');
      await bounded(exited);
    },
    dispose,
  };
}

// Use .NET/WMI directly: no optional modules, shell interpolation of paths,
// native dependencies, or user data in the helper protocol.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$owned = @{}
$ordered = [Collections.Generic.List[object]]::new()
$result = 1
function Capture-Descendants {
  $since = [System.Management.ManagementDateTimeConverter]::ToDmtfDateTime($owned[$ownerProcessId].Started)
  $query = [System.Management.ManagementObjectSearcher]::new("SELECT ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine FROM Win32_Process WHERE CreationDate >= '$since'")
  $rows = [Collections.Generic.List[object]]::new()
  $found = $null
  try {
    $found = $query.Get()
    foreach ($row in $found) {
      try {
        $rows.Add([pscustomobject]@{
          Id = [int]$row.ProcessId
          Parent = [int]$row.ParentProcessId
          Started = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$row.CreationDate).ToUniversalTime()
          Electron = [string]::Equals([string]$row.ExecutablePath, $rootExecutable, [StringComparison]::OrdinalIgnoreCase) -and
            ([string]$row.CommandLine -match '(?:^|\s)--type=[a-z-]+(?:\s|$)')
        })
      } finally { $row.Dispose() }
      if ($rows.Count -gt 16384) { throw 'snapshot_limit' }
    }
  } finally {
    if ($null -ne $found) { $found.Dispose() }
    $query.Dispose()
  }
  $children = @{}
  foreach ($row in $rows) {
    if (-not $children.ContainsKey($row.Parent)) { $children[$row.Parent] = [Collections.Generic.List[object]]::new() }
    $children[$row.Parent].Add($row)
  }
  $queue = [Collections.Generic.List[int]]::new()
  foreach ($id in $owned.Keys) { $queue.Add($id) }
  for ($index = 0; $index -lt $queue.Count; $index++) {
    foreach ($row in $children[$queue[$index]]) {
      $id = $row.Id
      $parent = $owned[$row.Parent]
      if ($id -eq $PID -or $owned.ContainsKey($id) -or $null -eq $parent) { continue }
      if ($row.Started -lt $parent.Started) { continue }
      $candidate = $null
      try {
        $candidate = [Diagnostics.Process]::GetProcessById($id)
        $null = $candidate.Handle
        $started = $candidate.StartTime.ToUniversalTime()
        # WMI truncates creation time to microseconds. Reject a recycled PID.
        if (($started.Ticks - ($started.Ticks % 10)) -ne $row.Started.Ticks) { continue }
        if ($owned.Count -ge 4096) { throw 'descendant_limit' }
        $entry = @{ Process = $candidate; Started = $started; Electron = $row.Electron }
        $owned[$id] = $entry
        $ordered.Add($entry)
        $candidate = $null
        $queue.Add($id)
      } catch [ArgumentException] {
        # The candidate exited between the snapshot and opening its handle.
      } finally {
        if ($null -ne $candidate) { $candidate.Dispose() }
      }
    }
  }
}
try {
  $root = [Diagnostics.Process]::GetProcessById($ownerProcessId)
  $null = $root.Handle
  $rootExecutable = $root.MainModule.FileName
  $owned[$ownerProcessId] = @{ Process = $root; Started = $root.StartTime.ToUniversalTime() }
  $null = Capture-Descendants
  if ($reportOwned) { [Console]::Out.WriteLine('owned:' + ($owned.Keys -join ',')) }
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
  if ([Console]::In.ReadLine() -cne 'stop') { return }
  for ($pass = 0; $pass -lt 4; $pass++) {
    $null = Capture-Descendants
    # Keep handles open across all passes, including exited parents, so late
    # grandchildren cannot escape merely by being reparented during cleanup.
    foreach ($entry in $ordered) {
      # Electron owns the renderer/GPU/utility exit. Keep the UI alive if a
      # helper cannot be stopped; app.quit closes it after successful handoff.
      # Electron-as-Node helpers have no Chromium --type flag and are swept.
      if ($entry.Electron) { continue }
      try {
        if (-not $entry.Process.HasExited) { $entry.Process.Kill() }
        if (-not $entry.Process.WaitForExit(500)) { throw 'termination_incomplete' }
      } catch {
        if (-not $entry.Process.HasExited) { throw }
      }
    }
    $null = Capture-Descendants
    $alive = @($ordered | Where-Object { -not $_.Electron -and -not $_.Process.HasExited })
    if ($alive.Count -eq 0) { $result = 0; break }
  }
} catch {
  $result = 1
} finally {
  foreach ($entry in $owned.Values) { $entry.Process.Dispose() }
}
exit $result
`;
