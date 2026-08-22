[CmdletBinding()]
param(
    [string]$OutputDirectory = '',
    [string]$CcxPath = '',
    [switch]$SkipBuild,
    [switch]$SkipCcx
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $repoRoot 'scripts\install\Common.ps1')
$packagePath = Join-Path $repoRoot 'package.json'
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$version = [string]$package.version
if ([string]::IsNullOrWhiteSpace($version)) { throw 'package.json does not contain a version.' }

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot 'artifacts'
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$stagingRoot = Join-Path $repoRoot '.release-staging'
$bundleName = "photoshop-full-mcp-$version"
$bundleRoot = Join-Path $stagingRoot $bundleName
$payloadRoot = Join-Path $bundleRoot 'payload'
$runtimeRoot = Join-Path $payloadRoot 'runtime'

if (-not $SkipBuild) {
    & npm --prefix $repoRoot run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
}

$entryPoint = Join-Path $repoRoot 'dist\src\index.js'
$manifestPath = Join-Path $repoRoot 'apps\uxp-plugin\manifest.json'
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) { throw "Missing MCP entry point: $entryPoint" }
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Missing UXP manifest: $manifestPath" }

if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $repoRoot 'dist') -Destination (Join-Path $runtimeRoot 'dist') -Recurse -Force
Copy-Item -LiteralPath $packagePath -Destination (Join-Path $runtimeRoot 'package.json') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'package-lock.json') -Destination (Join-Path $runtimeRoot 'package-lock.json') -Force

& npm --prefix $runtimeRoot ci --omit=dev --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }

$uxpDestination = Join-Path $payloadRoot 'uxp-plugin'
New-Item -ItemType Directory -Path $uxpDestination -Force | Out-Null
foreach ($relativePath in @('manifest.json', 'index.html', 'styles.css', 'main.js')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot "apps\uxp-plugin\$relativePath") -Destination (Join-Path $uxpDestination $relativePath) -Force
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'apps\uxp-plugin\lib') -Destination (Join-Path $uxpDestination 'lib') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'apps\uxp-plugin\icons') -Destination (Join-Path $uxpDestination 'icons') -Recurse -Force

foreach ($scriptName in @('Common.ps1', 'Install.ps1', 'Doctor.ps1', 'Update.ps1', 'Uninstall.ps1')) {
    $source = Join-Path $repoRoot "scripts\install\$scriptName"
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing installer component: $source" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $bundleRoot $scriptName) -Force
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'README.md') -Destination (Join-Path $bundleRoot 'README.md') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination (Join-Path $bundleRoot 'LICENSE') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs') -Destination (Join-Path $bundleRoot 'docs') -Recurse -Force

$commit = (& git -C $repoRoot rev-parse HEAD 2>$null)
if ($LASTEXITCODE -ne 0) { $commit = '' }
$manifest = [ordered]@{
    schema = 'photoshop-full-mcp-release/1'
    version = $version
    commit = [string]$commit
    platform = 'windows'
    architecture = 'requires-node-20'
    entryPoint = 'payload/runtime/dist/src/index.js'
    uxpManifest = 'payload/uxp-plugin/manifest.json'
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $bundleRoot 'release-manifest.json') -Encoding UTF8

if ([string]::IsNullOrWhiteSpace($CcxPath) -and -not $SkipCcx) {
    $CcxPath = Join-Path $OutputDirectory "photoshop-full-mcp-v$version.ccx"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'scripts\Build-Ccx.ps1') -OutputPath $CcxPath
    if ($LASTEXITCODE -ne 0) { throw 'UXP CCX packaging failed.' }
}

if (-not [string]::IsNullOrWhiteSpace($CcxPath)) {
    $resolvedCcx = [System.IO.Path]::GetFullPath($CcxPath)
    if (-not (Test-Path -LiteralPath $resolvedCcx -PathType Leaf)) { throw "CCX package not found: $resolvedCcx" }
    Copy-Item -LiteralPath $resolvedCcx -Destination (Join-Path $bundleRoot "photoshop-full-mcp-v$version.ccx") -Force
}

$zipPath = Join-Path $OutputDirectory "photoshop-full-mcp-v$version-windows.zip"
$hashPath = "$zipPath.sha256"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
if (Test-Path -LiteralPath $hashPath) { Remove-Item -LiteralPath $hashPath -Force }
Compress-Archive -LiteralPath $bundleRoot -DestinationPath $zipPath -CompressionLevel Optimal
$hash = Get-PsMcpSha256 -Path $zipPath
"$hash  $([System.IO.Path]::GetFileName($zipPath))" | Set-Content -LiteralPath $hashPath -Encoding ASCII
if (-not [string]::IsNullOrWhiteSpace($CcxPath)) {
    $ccxHashPath = "$CcxPath.sha256"
    $ccxHash = Get-PsMcpSha256 -Path $CcxPath
    "$ccxHash  $([System.IO.Path]::GetFileName($CcxPath))" | Set-Content -LiteralPath $ccxHashPath -Encoding ASCII
}

Write-Host "Release package: $zipPath"
Write-Host "SHA-256 file: $hashPath"
if (-not [string]::IsNullOrWhiteSpace($CcxPath)) { Write-Host 'CCX package included.' }
