/** Cancellation-only helper. Handles and creation times pin each tree
 * independently; cold PowerShell startup and WMI snapshots are shared.
 * No helper runs on the healthy path and no native payload is shipped.
 */
export function windowsTreeCleanupCommand(): string {
  return Buffer.from(SCRIPT, "utf16le").toString("base64");
}

const SCRIPT = String.raw`
function Read-ProcessSnapshot {
  $since = [System.Management.ManagementDateTimeConverter]::ToDmtfDateTime($earliest)
  $query = [System.Management.ManagementObjectSearcher]::new("SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process WHERE CreationDate >= '$since'")
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
function Check-Deadline($tree) {
  if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $tree.Deadline) { throw 'cleanup_deadline' }
}
function Stop-Entry($entry, $tree) {
  Check-Deadline $tree
  try {
    if (-not $entry.Process.HasExited) { $entry.Process.Kill() }
  } catch { if (-not $entry.Process.HasExited) { throw } }
}
$ErrorActionPreference = 'Stop'
$trees = [Collections.Generic.List[object]]::new()
$earliest = [DateTime]::MaxValue
try {
  [Console]::Out.WriteLine('accepting')
  [Console]::Out.Flush()
  $manifest = [Console]::In.ReadLine()
  foreach ($spec in $manifest.Split(';')) {
    $parts = $spec.Split(',')
    $targetProcessId = [int]$parts[1]
    $tree = @{ Id = [int]$parts[0]; Deadline = [long]$parts[2]; Owned = @{};
      Ordered = [Collections.Generic.List[object]]::new(); Result = 1; Terminated = $false; Active = $false }
    $trees.Add($tree)
    $root = $null
    try {
      Check-Deadline $tree
      $root = [Diagnostics.Process]::GetProcessById($targetProcessId)
      $null = $root.Handle
      $entry = @{ Process = $root; Started = $root.StartTime.ToUniversalTime() }
      $tree.Owned[$targetProcessId] = $entry
      $tree.Ordered.Add($entry)
      [Console]::Out.WriteLine('ready:' + $tree.Id)
      [Console]::Out.Flush()
      if ([Console]::In.ReadLine() -cne ('go:' + $tree.Id)) { $tree.Result = 0; continue }
      Check-Deadline $tree
      # Stop the root immediately, before WMI startup can delay cancellation.
      if (-not $root.HasExited) {
        try { $root.Kill(); $tree.Terminated = $true }
        catch { if (-not $root.HasExited) { throw } }
      }
      $tree.Active = $true
      if ($entry.Started -lt $earliest) { $earliest = $entry.Started }
    } catch {
      if ($null -ne $root -and $tree.Owned.Count -eq 0) { $root.Dispose() }
    }
  }
  # Issue all root kills before waiting. Sequential Kill/Wait pairs multiply
  # shell exit latency across the batch and can consume the cleanup deadline.
  foreach ($tree in $trees) {
    if (-not $tree.Active) { continue }
    try {
      Check-Deadline $tree
      if (-not $tree.Ordered[0].Process.WaitForExit(500)) { throw 'termination_incomplete' }
    } catch { $tree.Active = $false }
  }
  if ($earliest -ne [DateTime]::MaxValue) {
    $rows = @(Read-ProcessSnapshot)
    for ($pass = 0; $pass -lt 4; $pass++) {
      foreach ($tree in $trees) {
        if (-not $tree.Active) { continue }
        try {
          Check-Deadline $tree
          $owned = $tree.Owned
          do {
            $added = 0
            foreach ($row in $rows) {
              $id = [int]$row.ProcessId
              $parent = $owned[[int]$row.ParentProcessId]
              if ($null -eq $parent -or $owned.ContainsKey($id)) { continue }
              if ($row.CreationDate -lt $parent.Started) { continue }
              Check-Deadline $tree
              $candidate = $null
              try {
                $candidate = [Diagnostics.Process]::GetProcessById($id)
                $null = $candidate.Handle
                $started = $candidate.StartTime.ToUniversalTime()
                $ticks = $started.Ticks - ($started.Ticks % 10)
                if ($ticks -ne $row.CreationDate.Ticks) { continue }
                $owned[$id] = @{ Process = $candidate; Started = $started }
                $tree.Ordered.Add($owned[$id])
                $candidate = $null
                $added++
              } catch [ArgumentException] {
                # Snapshot member exited before its handle could be acquired.
              } finally { if ($null -ne $candidate) { $candidate.Dispose() } }
            }
          } while ($added -gt 0)
          if ($tree.Ordered.Count -eq 1) { $tree.Result = 0; $tree.Active = $false; continue }
          # Parent-first order stops producers; held handles retain lineage for
          # children born after this snapshot, without accepting recycled PIDs.
          foreach ($entry in $tree.Ordered) { Stop-Entry $entry $tree }
        } catch { $tree.Active = $false }
      }
      # All known producers have received termination before waiting for any
      # one's exit. Keep every identity pinned until the verification snapshot.
      foreach ($tree in $trees) {
        if (-not $tree.Active) { continue }
        try {
          foreach ($entry in $tree.Ordered) {
            Check-Deadline $tree
            if (-not $entry.Process.WaitForExit(500)) { throw 'termination_incomplete' }
          }
        } catch { $tree.Active = $false }
      }
      $active = @($trees | Where-Object { $_.Active })
      if ($active.Count -eq 0) { break }
      $rows = @(Read-ProcessSnapshot)
      foreach ($tree in $active) {
        $remaining = $false
        foreach ($row in $rows) {
          $parent = $tree.Owned[[int]$row.ParentProcessId]
          if ($null -ne $parent -and -not $tree.Owned.ContainsKey([int]$row.ProcessId) -and $row.CreationDate -ge $parent.Started) {
            $remaining = $true; break
          }
        }
        if (-not $remaining) { $tree.Result = 0; $tree.Active = $false }
      }
    }
  }
} catch {
  # Incomplete trees keep failure; never emit raw WMI errors or private paths.
} finally {
  foreach ($tree in $trees) {
    foreach ($entry in $tree.Owned.Values) { $entry.Process.Dispose() }
    if ($tree.Result -eq 0) {
      [Console]::Out.WriteLine('done:' + $tree.Id + ':' + [int]$tree.Terminated)
    } else { [Console]::Out.WriteLine('failed:' + $tree.Id) }
  }
  [Console]::Out.Flush()
}
exit 0
`;
