[CmdletBinding()]
param(
    [string]$OutputDirectory = '',
    [string]$CcxPath = '',
    [string]$Repository = 'muhwagwa0112/photoshop-full-mcp',
    [string]$SigningKeyPath = '',
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
$workingTree = @(& git -C $repoRoot status --porcelain --untracked-files=all 2>$null)
if ($LASTEXITCODE -ne 0) { throw 'Release builds require a Git worktree.' }
if ($workingTree.Count -ne 0) { throw 'Release builds require a clean Git worktree; commit or remove every tracked and untracked change first.' }
$commit = (& git -C $repoRoot rev-parse HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$commit)) { throw 'Could not resolve the release commit.' }
$publicKeyPath = Join-Path $repoRoot 'scripts\install\release-signing-public.xml'
if ([string]::IsNullOrWhiteSpace($SigningKeyPath)) {
    if ($env:PS_MCP_RELEASE_SIGNING_PRIVATE_KEY) { $SigningKeyPath = $env:PS_MCP_RELEASE_SIGNING_PRIVATE_KEY }
    elseif ($env:LOCALAPPDATA) { $SigningKeyPath = Join-Path $env:LOCALAPPDATA 'PS_MCP\release-signing-private.xml' }
}
if ([string]::IsNullOrWhiteSpace($SigningKeyPath)) { throw 'A dedicated release signing private key is required. Pass -SigningKeyPath or configure PS_MCP_RELEASE_SIGNING_PRIVATE_KEY.' }
Assert-PsMcpReleaseSigningKey -PrivateKeyPath $SigningKeyPath -PublicKeyPath $publicKeyPath

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
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\install\release-signing-public.xml') -Destination (Join-Path $bundleRoot 'release-signing-public.xml') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'README.md') -Destination (Join-Path $bundleRoot 'README.md') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination (Join-Path $bundleRoot 'LICENSE') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs') -Destination (Join-Path $bundleRoot 'docs') -Recurse -Force

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
    if ([System.IO.Path]::GetFileName($resolvedCcx) -ne "photoshop-full-mcp-v$version.ccx") { throw 'CCX package filename does not match the release version.' }
    $CcxPath = $resolvedCcx
    $ccxValidationRoot = Join-Path $stagingRoot '.ccx-validation'
    $ccxValidationZip = Join-Path $stagingRoot '.ccx-validation.zip'
    try {
        Copy-Item -LiteralPath $resolvedCcx -Destination $ccxValidationZip -Force
        New-Item -ItemType Directory -Path $ccxValidationRoot -Force | Out-Null
        Expand-Archive -LiteralPath $ccxValidationZip -DestinationPath $ccxValidationRoot -Force
        $ccxManifestPath = Join-Path $ccxValidationRoot 'manifest.json'
        if (-not (Test-Path -LiteralPath $ccxManifestPath -PathType Leaf)) { throw 'CCX package does not contain manifest.json at its root.' }
        $ccxManifest = Get-Content -LiteralPath $ccxManifestPath -Raw | ConvertFrom-Json
        if ($ccxManifest.id -ne 'com.codex.photoshop-full-mcp' -or [string]$ccxManifest.version -ne $version -or $ccxManifest.main -ne 'index.html' -or $ccxManifest.host.app -ne 'PS') {
            throw 'CCX package identity does not match the release source manifest.'
        }
    } finally {
        if (Test-Path -LiteralPath $ccxValidationRoot) { Remove-Item -LiteralPath $ccxValidationRoot -Recurse -Force }
        if (Test-Path -LiteralPath $ccxValidationZip) { Remove-Item -LiteralPath $ccxValidationZip -Force }
    }
    Copy-Item -LiteralPath $resolvedCcx -Destination (Join-Path $bundleRoot "photoshop-full-mcp-v$version.ccx") -Force
}

$zipPath = Join-Path $OutputDirectory "photoshop-full-mcp-v$version-windows.zip"
$hashPath = "$zipPath.sha256"
$signedManifestPath = "$zipPath.manifest.json"
$signaturePath = "$signedManifestPath.sig"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
if (Test-Path -LiteralPath $hashPath) { Remove-Item -LiteralPath $hashPath -Force }
if (Test-Path -LiteralPath $signedManifestPath) { Remove-Item -LiteralPath $signedManifestPath -Force }
if (Test-Path -LiteralPath $signaturePath) { Remove-Item -LiteralPath $signaturePath -Force }
Compress-Archive -LiteralPath $bundleRoot -DestinationPath $zipPath -CompressionLevel Optimal
$hash = Get-PsMcpSha256 -Path $zipPath
"$hash  $([System.IO.Path]::GetFileName($zipPath))" | Set-Content -LiteralPath $hashPath -Encoding ASCII
$signedAssets = [ordered]@{
    windowsZip = [ordered]@{
        name = [System.IO.Path]::GetFileName($zipPath)
        sha256 = $hash
        size = (Get-Item -LiteralPath $zipPath).Length
    }
}
if (-not [string]::IsNullOrWhiteSpace($CcxPath)) {
    $signedAssets.ccx = [ordered]@{
        name = [System.IO.Path]::GetFileName($CcxPath)
        sha256 = Get-PsMcpSha256 -Path $CcxPath
        size = (Get-Item -LiteralPath $CcxPath).Length
        pluginId = 'com.codex.photoshop-full-mcp'
        pluginVersion = $version
    }
}
$signedManifest = [ordered]@{
    schema = 'photoshop-full-mcp-release/2'
    product = 'photoshop-full-mcp'
    repository = $Repository
    tag = "v$version"
    version = $version
    commit = [string]$commit
    platform = 'windows'
    architecture = 'requires-node-20'
    signatureAlgorithm = 'rsa-sha256-pkcs1'
    keyId = (Get-PsMcpSha256 -Path $publicKeyPath)
    assets = $signedAssets
}
Write-PsMcpJsonAtomic -Path $signedManifestPath -Value $signedManifest
Write-PsMcpReleaseSignature -ManifestPath $signedManifestPath -SignaturePath $signaturePath -PrivateKeyPath $SigningKeyPath -PublicKeyPath $publicKeyPath
if (-not [string]::IsNullOrWhiteSpace($CcxPath)) {
    $ccxHashPath = "$CcxPath.sha256"
    $ccxHash = Get-PsMcpSha256 -Path $CcxPath
    "$ccxHash  $([System.IO.Path]::GetFileName($CcxPath))" | Set-Content -LiteralPath $ccxHashPath -Encoding ASCII
}

Write-Host "Release package: $zipPath"
Write-Host "SHA-256 file: $hashPath"
Write-Host "Signed manifest: $signedManifestPath"
Write-Host "Manifest signature: $signaturePath"
if (-not [string]::IsNullOrWhiteSpace($CcxPath)) { Write-Host 'CCX package included.' }
