[CmdletBinding()]
param(
    [string]$ArchivePath = '',
    [string]$ChecksumPath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $repoRoot 'scripts\install\Common.ps1')
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if ([string]::IsNullOrWhiteSpace($ArchivePath)) {
    $ArchivePath = Join-Path $repoRoot "artifacts\photoshop-full-mcp-v$version-windows.zip"
}
$ArchivePath = [System.IO.Path]::GetFullPath($ArchivePath)
if ([string]::IsNullOrWhiteSpace($ChecksumPath)) { $ChecksumPath = "$ArchivePath.sha256" }
$ChecksumPath = [System.IO.Path]::GetFullPath($ChecksumPath)
if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw "Release archive not found: $ArchivePath" }
if (-not (Test-Path -LiteralPath $ChecksumPath -PathType Leaf)) { throw "Release checksum not found: $ChecksumPath" }

$expectedHash = ((Get-Content -LiteralPath $ChecksumPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actualHash = Get-PsMcpSha256 -Path $ArchivePath
if ($expectedHash -ne $actualHash) { throw 'Release archive SHA-256 does not match its checksum file.' }

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$temporaryRoot = Join-Path $temporaryBase ("ps-mcp-release-smoke-{0}" -f [Guid]::NewGuid().ToString('N'))
$resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
if (-not $resolvedTemporaryRoot.StartsWith($temporaryBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to create a release smoke directory outside the system temporary directory.'
}

try {
    $expandedRoot = Join-Path $resolvedTemporaryRoot 'expanded'
    $installRoot = Join-Path $resolvedTemporaryRoot 'installed'
    New-Item -ItemType Directory -Path $expandedRoot -Force | Out-Null
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $expandedRoot -Force
    $bundle = Get-ChildItem -LiteralPath $expandedRoot -Directory | Select-Object -First 1
    if (-not $bundle) { throw 'Release archive has no bundle directory.' }

    foreach ($relativePath in @(
        'Install.ps1',
        'Doctor.ps1',
        'Update.ps1',
        'Uninstall.ps1',
        'release-manifest.json',
        'docs\INSTALL.md',
        'docs\TROUBLESHOOTING.md',
        'docs\assets\kofi-support-red.png',
        'payload\runtime\dist\src\index.js',
        'payload\runtime\node_modules',
        'payload\uxp-plugin\manifest.json'
    )) {
        $candidate = Join-Path $bundle.FullName $relativePath
        if (-not (Test-Path -LiteralPath $candidate)) { throw "Release payload is missing: $relativePath" }
    }

    $releaseManifest = Get-Content -LiteralPath (Join-Path $bundle.FullName 'release-manifest.json') -Raw | ConvertFrom-Json
    if ([string]$releaseManifest.version -ne $version) { throw 'Release manifest version does not match package.json.' }

    $ccx = Get-ChildItem -LiteralPath $bundle.FullName -Filter '*.ccx' -File | Select-Object -First 1
    if (-not $ccx) { throw 'Release bundle does not contain a CCX package.' }
    $ccxZip = Join-Path $resolvedTemporaryRoot 'plugin.zip'
    $ccxExpanded = Join-Path $resolvedTemporaryRoot 'plugin'
    Copy-Item -LiteralPath $ccx.FullName -Destination $ccxZip -Force
    Expand-Archive -LiteralPath $ccxZip -DestinationPath $ccxExpanded -Force
    if (-not (Test-Path -LiteralPath (Join-Path $ccxExpanded 'manifest.json') -PathType Leaf)) {
        throw 'CCX package does not contain manifest.json at its root.'
    }

    & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $bundle.FullName 'Install.ps1') -InstallRoot $installRoot -PackagePath $bundle.FullName -SkipCodexRegistration
    if ($LASTEXITCODE -ne 0) { throw 'Isolated release installation failed.' }
    $installedDoctor = Join-Path $installRoot 'app\tools\Doctor.ps1'
    if (-not (Test-Path -LiteralPath $installedDoctor -PathType Leaf)) { throw 'Installed Doctor tool is missing.' }
    & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installedDoctor -InstallRoot $installRoot -SkipCodexRegistration
    if ($LASTEXITCODE -ne 0) { throw 'Installed Doctor reported a failure.' }

    Write-Host "Release verification passed: $ArchivePath"
    Write-Host "SHA-256: $actualHash"
}
finally {
    if (Test-Path -LiteralPath $resolvedTemporaryRoot) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
    }
}
