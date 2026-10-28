param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][int]$InstallerProcessId
)

$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
  $directory = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  if (-not [IO.Path]::IsPathRooted($InstallDir) -or
      $directory -eq [IO.Path]::GetPathRoot($directory).TrimEnd('\') -or
      $InstallerProcessId -le 0) { throw 'invalid_target' }
  # Fresh installs have nothing to stop. Do not interpret an arbitrary parent
  # directory as an installation and terminate programs in its child folders.
  # Accept either marker so a partially removed old executable can recover.
  if (-not [IO.File]::Exists([IO.Path]::Combine($directory, 'Orkas.exe')) -and
      -not [IO.File]::Exists([IO.Path]::Combine($directory, 'resources', 'app.asar'))) { exit 0 }
  # A separator boundary protects sibling installations such as Orkas-other.
  $prefix = $directory + '\'
  for ($pass = 0; $pass -lt 4; $pass++) {
    $targets = [Collections.Generic.List[object]]::new()
    $ancestry = @{}
    $query = [System.Management.ManagementObjectSearcher]::new('SELECT ProcessId,ParentProcessId,ExecutablePath,CreationDate FROM Win32_Process')
    $rows = $null
    try {
      $rows = $query.Get()
      foreach ($row in $rows) {
        $candidate = $null
        try {
          $id = [int]$row.ProcessId
          $image = [string]$row.ExecutablePath
          if ([string]::IsNullOrWhiteSpace([string]$row.CreationDate)) {
            if ($image.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'process_identity_unavailable' }
            continue
          }
          if ($ancestry.Count -ge 16384 -or $clock.ElapsedMilliseconds -ge 12000) { throw 'snapshot_limit' }
          $snapshotStarted = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$row.CreationDate).ToUniversalTime()
          $ancestry[$id] = @{ Parent = [int]$row.ParentProcessId; Started = $snapshotStarted }
          if ($id -eq $PID -or $id -eq $InstallerProcessId -or
              -not $image.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
          if ($targets.Count -ge 4096 -or $clock.ElapsedMilliseconds -ge 12000) { throw 'cleanup_limit' }
          try {
            $candidate = [Diagnostics.Process]::GetProcessById($id)
            # Pin the handle and verify creation time before acting on a WMI PID.
            $null = $candidate.Handle
            $started = $candidate.StartTime.ToUniversalTime()
          } catch [ArgumentException] { continue } # The process already exited.
          catch [InvalidOperationException] { continue }
          if (($started.Ticks - ($started.Ticks % 10)) -ne $snapshotStarted.Ticks) { continue }
          $targets.Add($candidate)
          $candidate = $null
        } finally {
          if ($null -ne $candidate) { $candidate.Dispose() }
          $row.Dispose()
        }
      }
      # A new uninstaller can be called by an installer stored inside the app
      # directory. Preserve the helper's real control ancestry, not just one PID.
      $protected = [Collections.Generic.HashSet[int]]::new()
      $null = $protected.Add($PID)
      $null = $protected.Add($InstallerProcessId)
      $visited = [Collections.Generic.HashSet[int]]::new()
      $null = $visited.Add($PID)
      $cursor = $PID
      for ($depth = 0; $depth -lt 32; $depth++) {
        $record = $ancestry[$cursor]
        if ($null -eq $record -or $record.Parent -le 0) { break }
        $parent = $ancestry[$record.Parent]
        # A recycled parent PID starts after its old child and is not ancestry.
        if ($null -eq $parent -or $parent.Started -gt $record.Started) { break }
        if (-not $visited.Add($record.Parent)) { break }
        $null = $protected.Add($record.Parent)
        $cursor = $record.Parent
      }
      $remaining = @($targets | Where-Object { -not $protected.Contains($_.Id) })
      if ($remaining.Count -eq 0) { exit 0 }
      foreach ($target in $remaining) {
        if ($clock.ElapsedMilliseconds -ge 12000) { throw 'cleanup_timeout' }
        try {
          if (-not $target.HasExited) { $target.Kill() }
          if (-not $target.WaitForExit(500)) { throw 'termination_incomplete' }
        } catch {
          if (-not $target.HasExited) { throw }
        }
      }
    } finally {
      foreach ($target in $targets) { $target.Dispose() }
      if ($null -ne $rows) { $rows.Dispose() }
      $query.Dispose()
    }
    # Recheck after termination to catch a helper spawned during the sweep.
    Start-Sleep -Milliseconds 200
  }
  throw 'cleanup_incomplete'
} catch {
  [Console]::Error.WriteLine('Installer process cleanup failed.')
  exit 1
}
