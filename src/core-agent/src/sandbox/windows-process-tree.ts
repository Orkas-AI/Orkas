/** Cancellation-only Windows helper. Open handles pin identities even after
 * exit; the host must acknowledge readiness while its original child is live.
 * This avoids both taskkill's snapshot/child-creation race and PID reuse.
 * No helper runs on the normal command path, and no native payload is shipped.
 */
export function windowsTreeCleanupCommand(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process identity");
  return Buffer.from(`$targetProcessId = ${pid}\n` + SCRIPT, "utf16le").toString("base64");
}

const SCRIPT = String.raw`
function Read-ProcessSnapshot {
  $query = [System.Management.ManagementObjectSearcher]::new('SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process')
  $rows = $null
  try {
    $rows = $query.Get()
    foreach ($row in $rows) {
      try {
        [pscustomobject]@{
          ProcessId = [int]$row.ProcessId
          ParentProcessId = [int]$row.ParentProcessId
          CreationDate = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$row.CreationDate).ToUniversalTime()
        }
      } finally { $row.Dispose() }
    }
  } finally {
    if ($null -ne $rows) { $rows.Dispose() }
    $query.Dispose()
  }
}
$ErrorActionPreference = 'Stop'
$owned = @{}
$result = 1
try {
  $root = [Diagnostics.Process]::GetProcessById($targetProcessId)
  $null = $root.Handle
  $owned[$targetProcessId] = @{ Process = $root; Started = $root.StartTime.ToUniversalTime() }
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
  if ([Console]::In.ReadLine() -cne 'go') { $result = 0; return }

  # Stop the root immediately, before WMI startup can delay cancellation.
  # Its held handle keeps the parent identity valid for orphan discovery.
  if (-not $root.HasExited) { $root.Kill() }
  if (-not $root.WaitForExit(500)) { throw 'termination_incomplete' }
  $rows = @(Read-ProcessSnapshot)
  for ($pass = 0; $pass -lt 4; $pass++) {
    # Hold every discoverable identity before killing parents. Old or reused
    # parent ids are rejected by birth time; WMI truncates it to microseconds.
    do {
      $added = 0
      foreach ($row in $rows) {
        $id = [int]$row.ProcessId
        $parent = $owned[[int]$row.ParentProcessId]
        if ($null -eq $parent -or $owned.ContainsKey($id)) { continue }
        if ($row.CreationDate.ToUniversalTime() -lt $parent.Started) { continue }
        $candidate = $null
        try {
          $candidate = [Diagnostics.Process]::GetProcessById($id)
          $null = $candidate.Handle
          $started = $candidate.StartTime.ToUniversalTime()
          $ticks = $started.Ticks - ($started.Ticks % 10)
          if ($ticks -ne $row.CreationDate.ToUniversalTime().Ticks) { continue }
          $owned[$id] = @{ Process = $candidate; Started = $started }
          $candidate = $null
          $added++
        } catch [ArgumentException] {
          # The snapshot member exited before its handle could be acquired.
        } finally {
          if ($null -ne $candidate) { $candidate.Dispose() }
        }
      }
    } while ($added -gt 0)

    # Stop producers first, retaining their handles for the next snapshot.
    # A child created during this sweep remains linked to a pinned parent.
    foreach ($entry in @($owned.Values | Sort-Object Started)) {
      try {
        if (-not $entry.Process.HasExited) { $entry.Process.Kill() }
        if (-not $entry.Process.WaitForExit(500)) { throw 'termination_incomplete' }
      } catch {
        if (-not $entry.Process.HasExited) { throw }
      }
    }
    $rows = @(Read-ProcessSnapshot)
    $remaining = @($rows | Where-Object {
      $parent = $owned[[int]$_.ParentProcessId]
      $null -ne $parent -and -not $owned.ContainsKey([int]$_.ProcessId) -and
        $_.CreationDate.ToUniversalTime() -ge $parent.Started
    })
    if ($remaining.Count -eq 0) { $result = 0; break }
  }
} catch {
  # Only the classified exit code crosses the boundary, never raw WMI errors.
  $result = 1
} finally {
  foreach ($entry in $owned.Values) { $entry.Process.Dispose() }
}
exit $result
`;
