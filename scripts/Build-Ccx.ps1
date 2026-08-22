[CmdletBinding()]
param(
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
$pluginRoot = Join-Path $repoRoot 'apps\uxp-plugin'
$manifestPath = Join-Path $pluginRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Missing UXP manifest: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([int]$manifest.manifestVersion -lt 4) { throw 'CCX packaging requires UXP manifest v4 or later.' }
if ([string]$manifest.host.app -eq 'PS' -and [version]$manifest.host.minVersion -lt [version]'22.0.0') {
    throw 'CCX packaging requires Photoshop minVersion 22 or later.'
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $repoRoot "artifacts\photoshop-full-mcp-v$version.ccx"
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputParent = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputParent -Force | Out-Null

$stagingRoot = Join-Path $repoRoot '.release-staging\ccx'
$zipPath = "$OutputPath.zip"
if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

foreach ($relativePath in @('manifest.json', 'index.html', 'styles.css', 'main.js')) {
    Copy-Item -LiteralPath (Join-Path $pluginRoot $relativePath) -Destination (Join-Path $stagingRoot $relativePath) -Force
}
Copy-Item -LiteralPath (Join-Path $pluginRoot 'lib') -Destination (Join-Path $stagingRoot 'lib') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $pluginRoot 'icons') -Destination (Join-Path $stagingRoot 'icons') -Recurse -Force

Compress-Archive -Path (Join-Path $stagingRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal
Move-Item -LiteralPath $zipPath -Destination $OutputPath -Force

$verificationRoot = Join-Path $repoRoot '.release-staging\ccx-verify'
if (Test-Path -LiteralPath $verificationRoot) { Remove-Item -LiteralPath $verificationRoot -Recurse -Force }
New-Item -ItemType Directory -Path $verificationRoot -Force | Out-Null
Copy-Item -LiteralPath $OutputPath -Destination (Join-Path $verificationRoot 'package.zip')
Expand-Archive -LiteralPath (Join-Path $verificationRoot 'package.zip') -DestinationPath (Join-Path $verificationRoot 'expanded') -Force
$verifiedManifest = Join-Path $verificationRoot 'expanded\manifest.json'
if (-not (Test-Path -LiteralPath $verifiedManifest -PathType Leaf)) { throw 'Packaged CCX does not contain manifest.json at its root.' }
$verified = Get-Content -LiteralPath $verifiedManifest -Raw | ConvertFrom-Json
if ([string]$verified.id -ne [string]$manifest.id -or [string]$verified.version -ne [string]$manifest.version) {
    throw 'Packaged CCX manifest identity does not match the source plugin.'
}

Write-Host "UXP CCX package: $OutputPath"
Write-Host "Plugin: $($manifest.name) $($manifest.version) ($($manifest.id))"
