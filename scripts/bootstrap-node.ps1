[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pcRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $pcRoot 'resources\runtime'
$manifestPath = Join-Path $runtimeRoot 'manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$platformKey = switch ($architecture) {
    'X64' { 'win32-x64' }
    'Arm64' { 'win32-arm64' }
    default { throw "Unsupported Windows architecture for the bundled Node runtime: $architecture" }
}

$nodeSpec = $manifest.node
$assetProperty = $nodeSpec.assets.PSObject.Properties[$platformKey]
if (-not $assetProperty) {
    throw "Node runtime asset is missing from the manifest: $platformKey"
}
$asset = $assetProperty.Value
$nodeRoot = Join-Path (Join-Path $runtimeRoot 'node') $platformKey
$nodeExe = Join-Path $nodeRoot 'node.exe'
$npmCmd = Join-Path $nodeRoot 'npm.cmd'
$npxCmd = Join-Path $nodeRoot 'npx.cmd'
$markerPath = Join-Path $nodeRoot '.orkas-runtime.json'

function Test-InstalledNode {
    if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath $npmCmd -PathType Leaf) -or
        -not (Test-Path -LiteralPath $npxCmd -PathType Leaf) -or
        -not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        return $false
    }
    try {
        $marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
        if ($marker.schema -ne 1 -or
            $marker.kind -ne 'node' -or
            $marker.platformKey -ne $platformKey -or
            $marker.version -ne $nodeSpec.version -or
            $marker.sha256 -ne $asset.sha256) {
            return $false
        }
        $version = (& $nodeExe --version 2>$null).Trim()
        return $LASTEXITCODE -eq 0 -and $version -eq "v$($nodeSpec.version)"
    } catch {
        return $false
    }
}

if (Test-InstalledNode) {
    Write-Host "[node-bootstrap] bundled Node $($nodeSpec.version) is ready"
    exit 0
}

$nodeParent = Split-Path -Parent $nodeRoot
New-Item -ItemType Directory -Force -Path $nodeParent | Out-Null
$tempRoot = Join-Path $nodeParent ('.bootstrap-{0}-{1}' -f $PID, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$archivePath = Join-Path $tempRoot $asset.name
$extractRoot = Join-Path $tempRoot 'extract'
$payloadRoot = Join-Path $tempRoot 'payload'
$backupRoot = "$nodeRoot.bak-$PID"

try {
    New-Item -ItemType Directory -Force -Path $extractRoot, $payloadRoot | Out-Null
    Write-Host "[node-bootstrap] downloading Node $($nodeSpec.version) for $platformKey..."
    Invoke-WebRequest -UseBasicParsing -Uri $asset.url -OutFile $archivePath -TimeoutSec 600

    $actualSize = (Get-Item -LiteralPath $archivePath).Length
    if ($actualSize -ne [int64]$asset.size) {
        throw "Node archive size mismatch: expected $($asset.size), got $actualSize"
    }
    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    if ($actualSha256 -ne ([string]$asset.sha256).ToLowerInvariant()) {
        throw "Node archive SHA-256 mismatch"
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
    $sourceRoot = Get-ChildItem -LiteralPath $extractRoot -Directory |
        Where-Object { $_.Name -like 'node-v*' } |
        Select-Object -First 1
    if (-not $sourceRoot) {
        throw 'Node archive did not contain the expected top-level directory'
    }
    Get-ChildItem -LiteralPath $sourceRoot.FullName -Force |
        Copy-Item -Destination $payloadRoot -Recurse -Force

    $payloadNode = Join-Path $payloadRoot 'node.exe'
    $payloadNpm = Join-Path $payloadRoot 'npm.cmd'
    $payloadNpx = Join-Path $payloadRoot 'npx.cmd'
    if (-not (Test-Path -LiteralPath $payloadNode -PathType Leaf) -or
        -not (Test-Path -LiteralPath $payloadNpm -PathType Leaf) -or
        -not (Test-Path -LiteralPath $payloadNpx -PathType Leaf)) {
        throw 'Node archive is missing node.exe, npm.cmd, or npx.cmd'
    }
    $version = (& $payloadNode --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -ne "v$($nodeSpec.version)") {
        throw "Node self-check failed: expected v$($nodeSpec.version), got $version"
    }

    $marker = [ordered]@{
        schema = 1
        kind = 'node'
        platformKey = $platformKey
        version = $nodeSpec.version
        source = $nodeSpec.source
        release = $nodeSpec.release
        asset = $asset.name
        sha256 = $asset.sha256
        size = [int64]$asset.size
        installedAt = [DateTime]::UtcNow.ToString('o')
    }
    $markerJson = $marker | ConvertTo-Json
    $markerEncoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText(
        (Join-Path $payloadRoot '.orkas-runtime.json'),
        $markerJson,
        $markerEncoding
    )

    if (Test-Path -LiteralPath $backupRoot) {
        Remove-Item -Recurse -Force -LiteralPath $backupRoot
    }
    if (Test-Path -LiteralPath $nodeRoot) {
        Move-Item -LiteralPath $nodeRoot -Destination $backupRoot
    }
    try {
        Move-Item -LiteralPath $payloadRoot -Destination $nodeRoot
        if (Test-Path -LiteralPath $backupRoot) {
            Remove-Item -Recurse -Force -LiteralPath $backupRoot
        }
    } catch {
        if (Test-Path -LiteralPath $nodeRoot) {
            Remove-Item -Recurse -Force -LiteralPath $nodeRoot
        }
        if (Test-Path -LiteralPath $backupRoot) {
            Move-Item -LiteralPath $backupRoot -Destination $nodeRoot
        }
        throw
    }

    Write-Host "[node-bootstrap] Node $($nodeSpec.version) is ready"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -Recurse -Force -LiteralPath $tempRoot
    }
}
