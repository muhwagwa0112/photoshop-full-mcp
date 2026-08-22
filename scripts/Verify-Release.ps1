[CmdletBinding()]
param(
    [string]$ArchivePath = '',
    [string]$CcxPath = '',
    [string]$ManifestPath = '',
    [string]$SignaturePath = '',
    [string]$Repository = 'muhwagwa0112/photoshop-full-mcp'
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
if ([string]::IsNullOrWhiteSpace($ManifestPath)) { $ManifestPath = "$ArchivePath.manifest.json" }
if ([string]::IsNullOrWhiteSpace($SignaturePath)) { $SignaturePath = "$ManifestPath.sig" }
$ManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)
$SignaturePath = [System.IO.Path]::GetFullPath($SignaturePath)
if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw "Release archive not found: $ArchivePath" }
$signed = Read-PsMcpSignedReleaseManifest -ManifestPath $ManifestPath -SignaturePath $SignaturePath -ExpectedRepository $Repository -ExpectedTag "v$version"
$signedCcxProperty = $signed.assets.PSObject.Properties['ccx']
$signedCcx = if ($signedCcxProperty) { $signedCcxProperty.Value } else { $null }
if ([System.IO.Path]::GetFileName($ArchivePath) -ne [string]$signed.assets.windowsZip.name) { throw 'Signed release asset name does not match the archive.' }
if ((Get-Item -LiteralPath $ArchivePath).Length -ne [long]$signed.assets.windowsZip.size) { throw 'Signed release archive size does not match.' }
$actualHash = Get-PsMcpSha256 -Path $ArchivePath
if ($actualHash -ne [string]$signed.assets.windowsZip.sha256) { throw 'Signed release archive SHA-256 does not match.' }
if ($signedCcx) {
    if ([string]::IsNullOrWhiteSpace($CcxPath)) { $CcxPath = Join-Path $repoRoot "artifacts\photoshop-full-mcp-v$version.ccx" }
    $CcxPath = [System.IO.Path]::GetFullPath($CcxPath)
    if (-not (Test-Path -LiteralPath $CcxPath -PathType Leaf)) { throw "Signed CCX asset not found: $CcxPath" }
    if ([System.IO.Path]::GetFileName($CcxPath) -ne [string]$signedCcx.name -or (Get-Item -LiteralPath $CcxPath).Length -ne [long]$signedCcx.size -or (Get-PsMcpSha256 -Path $CcxPath) -ne [string]$signedCcx.sha256) {
        throw 'Signed CCX asset verification failed.'
    }
}

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
    $topLevel = @(Get-ChildItem -LiteralPath $expandedRoot -Force)
    if ($topLevel.Count -ne 1 -or -not $topLevel[0].PSIsContainer -or $topLevel[0].Name -ne "photoshop-full-mcp-$version") {
        throw 'Release archive must contain exactly one authenticated top-level bundle directory.'
    }
    $bundlePath = Join-Path $expandedRoot "photoshop-full-mcp-$version"
    if (-not (Test-Path -LiteralPath $bundlePath -PathType Container)) { throw 'Release archive does not contain the exact authenticated bundle directory.' }
    $bundle = Get-Item -LiteralPath $bundlePath

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

    $ccxFiles = @(Get-ChildItem -LiteralPath $bundle.FullName -Filter '*.ccx' -File)
    $expectedCcxName = "photoshop-full-mcp-v$version.ccx"
    if ($ccxFiles.Count -ne 1 -or $ccxFiles[0].Name -ne $expectedCcxName) { throw 'Release bundle must contain exactly one expected CCX package.' }
    $ccx = $ccxFiles[0]
    if ($signedCcx -and ((Get-Item -LiteralPath $ccx.FullName).Length -ne [long]$signedCcx.size -or (Get-PsMcpSha256 -Path $ccx.FullName) -ne [string]$signedCcx.sha256)) {
        throw 'Bundled CCX does not match the signed standalone CCX asset.'
    }
    $ccxZip = Join-Path $resolvedTemporaryRoot 'plugin.zip'
    $ccxExpanded = Join-Path $resolvedTemporaryRoot 'plugin'
    Copy-Item -LiteralPath $ccx.FullName -Destination $ccxZip -Force
    Expand-Archive -LiteralPath $ccxZip -DestinationPath $ccxExpanded -Force
    if (-not (Test-Path -LiteralPath (Join-Path $ccxExpanded 'manifest.json') -PathType Leaf)) {
        throw 'CCX package does not contain manifest.json at its root.'
    }
    $ccxManifest = Get-Content -LiteralPath (Join-Path $ccxExpanded 'manifest.json') -Raw | ConvertFrom-Json
    if ($ccxManifest.id -ne 'com.codex.photoshop-full-mcp' -or [string]$ccxManifest.version -ne $version -or $ccxManifest.main -ne 'index.html' -or $ccxManifest.host.app -ne 'PS') {
        throw 'CCX package identity does not match the authenticated release.'
    }

    & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $bundle.FullName 'Install.ps1') -InstallRoot $installRoot -PackagePath $bundle.FullName -SkipCodexRegistration
    if ($LASTEXITCODE -ne 0) { throw 'Isolated release installation failed.' }
    $installedDoctor = Join-Path $installRoot 'app\tools\Doctor.ps1'
    if (-not (Test-Path -LiteralPath $installedDoctor -PathType Leaf)) { throw 'Installed Doctor tool is missing.' }
    & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installedDoctor -InstallRoot $installRoot -SkipCodexRegistration
    if ($LASTEXITCODE -ne 0) { throw 'Installed Doctor reported a failure.' }

    Write-Host "Release verification passed: $ArchivePath"
    Write-Host "Authenticated SHA-256: $actualHash"
}
finally {
    if (Test-Path -LiteralPath $resolvedTemporaryRoot) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
    }
}
