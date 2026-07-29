[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$NodeExe
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pcRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bootstrap = Join-Path $pcRoot 'scripts\bootstrap-node.ps1'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'orkas-node-bootstrap-{0}-{1}' -f $PID, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
)
$fixturePc = Join-Path $tempRoot 'PC'
$runtimeRoot = Join-Path $fixturePc 'resources\runtime'
$sourceParent = Join-Path $tempRoot 'archive-source'
$sourceRoot = Join-Path $sourceParent 'node-vfixture-win-x64'
$archive = Join-Path $tempRoot 'node-fixture.zip'
$nodeRoot = Join-Path $runtimeRoot 'node\win32-x64'
$markerPath = Join-Path $nodeRoot '.orkas-runtime.json'
$global:OrkasBootstrapDownloadSource = $archive
$global:OrkasBootstrapDownloadCalls = 0
$global:OrkasBootstrapDownloadShouldFail = $false
$global:OrkasBootstrapFailPayloadMove = $false
$global:OrkasBootstrapNodeRoot = $nodeRoot

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )
    if (-not $Condition) {
        throw "ASSERTION FAILED: $Message"
    }
}

function global:Invoke-WebRequest {
    [CmdletBinding()]
    param(
        [switch]$UseBasicParsing,
        [string]$Uri,
        [string]$OutFile,
        [int]$TimeoutSec
    )
    $global:OrkasBootstrapDownloadCalls += 1
    if ($global:OrkasBootstrapDownloadShouldFail) {
        throw 'download should not have been called'
    }
    Copy-Item -LiteralPath $global:OrkasBootstrapDownloadSource -Destination $OutFile -Force
}

try {
    New-Item -ItemType Directory -Force -Path $runtimeRoot, $sourceRoot | Out-Null
    Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $sourceRoot 'node.exe')
    Set-Content -LiteralPath (Join-Path $sourceRoot 'npm.cmd') -Value '@echo npm fixture' -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $sourceRoot 'npx.cmd') -Value '@echo npx fixture' -Encoding Ascii
    Compress-Archive -LiteralPath $sourceRoot -DestinationPath $archive -Force

    $version = ((& $NodeExe --version).Trim() -replace '^v', '')
    $asset = Get-Item -LiteralPath $archive
    $sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    $manifest = [ordered]@{
        node = [ordered]@{
            version = $version
            source = 'integration-fixture'
            release = 'integration-fixture'
            assets = [ordered]@{
                'win32-x64' = [ordered]@{
                    name = $asset.Name
                    url = 'https://example.invalid/node-fixture.zip'
                    size = [int64]$asset.Length
                    sha256 = $sha256
                }
            }
        }
    }
    $manifest | ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath (Join-Path $runtimeRoot 'manifest.json') -Encoding Utf8

    & $bootstrap -PcRoot $fixturePc -Architecture X64
    Assert-True (Test-Path -LiteralPath (Join-Path $nodeRoot 'node.exe') -PathType Leaf) 'node.exe installed'
    Assert-True (Test-Path -LiteralPath (Join-Path $nodeRoot 'npm.cmd') -PathType Leaf) 'npm.cmd installed'
    Assert-True (Test-Path -LiteralPath (Join-Path $nodeRoot 'npx.cmd') -PathType Leaf) 'npx.cmd installed'
    Assert-True ($global:OrkasBootstrapDownloadCalls -eq 1) 'first run downloads once'
    $installedMarker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
    Assert-True ($installedMarker.sha256 -eq $sha256) 'marker records pinned archive hash'
    Assert-True ((& (Join-Path $nodeRoot 'node.exe') --version).Trim() -eq "v$version") 'installed Node self-check'

    $global:OrkasBootstrapDownloadShouldFail = $true
    & $bootstrap -PcRoot $fixturePc -Architecture X64
    Assert-True ($global:OrkasBootstrapDownloadCalls -eq 1) 'verified cache skips download'
    $global:OrkasBootstrapDownloadShouldFail = $false

    $corruptMarker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
    $corruptMarker.sha256 = 'corrupt'
    $corruptMarker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $markerPath -Encoding Utf8
    & $bootstrap -PcRoot $fixturePc -Architecture X64
    Assert-True ($global:OrkasBootstrapDownloadCalls -eq 2) 'corrupt marker forces repair'
    $repairedMarker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
    Assert-True ($repairedMarker.sha256 -eq $sha256) 'repair restores canonical marker'

    $manifest.node.assets.'win32-x64'.sha256 = ('0' * 64)
    $manifest | ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath (Join-Path $runtimeRoot 'manifest.json') -Encoding Utf8
    $hashFailed = $false
    try {
        & $bootstrap -PcRoot $fixturePc -Architecture X64
    } catch {
        $hashFailed = $_.Exception.Message -like '*SHA-256 mismatch*'
    }
    Assert-True $hashFailed 'bad archive hash fails before install'
    Assert-True ((& (Join-Path $nodeRoot 'node.exe') --version).Trim() -eq "v$version") 'hash failure preserves installed Node'
    $preservedMarker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
    Assert-True ($preservedMarker.sha256 -eq $sha256) 'hash failure preserves installed marker'

    $manifest.node.assets.'win32-x64'.sha256 = $sha256
    $manifest | ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath (Join-Path $runtimeRoot 'manifest.json') -Encoding Utf8
    Set-Content -LiteralPath (Join-Path $nodeRoot 'preserve.txt') -Value 'previous payload' -Encoding Utf8
    $corruptMarker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
    $corruptMarker.sha256 = 'force-repair'
    $corruptMarker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $markerPath -Encoding Utf8

    function global:Move-Item {
        [CmdletBinding()]
        param(
            [Parameter(Mandatory = $true)]
            [string]$LiteralPath,
            [Parameter(Mandatory = $true)]
            [string]$Destination
        )
        if (
            $global:OrkasBootstrapFailPayloadMove -and
            (Split-Path -Leaf $LiteralPath) -eq 'payload' -and
            $Destination -eq $global:OrkasBootstrapNodeRoot
        ) {
            $global:OrkasBootstrapFailPayloadMove = $false
            throw 'injected install move failure'
        }
        Microsoft.PowerShell.Management\Move-Item `
            -LiteralPath $LiteralPath `
            -Destination $Destination
    }

    $global:OrkasBootstrapFailPayloadMove = $true
    $moveFailed = $false
    try {
        & $bootstrap -PcRoot $fixturePc -Architecture X64
    } catch {
        $moveFailed = $_.Exception.Message -like '*injected install move failure*'
    }
    Assert-True $moveFailed 'payload move failure reaches rollback path'
    Assert-True (Test-Path -LiteralPath (Join-Path $nodeRoot 'preserve.txt')) 'rollback restores previous payload'
    Assert-True ((& (Join-Path $nodeRoot 'node.exe') --version).Trim() -eq "v$version") 'rollback restores runnable Node'
    Assert-True (-not (Get-ChildItem -LiteralPath (Split-Path -Parent $nodeRoot) -Filter '.bootstrap-*')) 'temporary roots cleaned'
    Assert-True (-not (Test-Path -LiteralPath "$nodeRoot.bak-$PID")) 'backup root consumed by rollback'

    Write-Host '[windows-node-bootstrap] PASS'
} finally {
    Remove-Item Function:\Invoke-WebRequest -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Move-Item -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force -LiteralPath $tempRoot -ErrorAction SilentlyContinue
    Remove-Variable OrkasBootstrapDownloadSource -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable OrkasBootstrapDownloadCalls -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable OrkasBootstrapDownloadShouldFail -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable OrkasBootstrapFailPayloadMove -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable OrkasBootstrapNodeRoot -Scope Global -ErrorAction SilentlyContinue
}
