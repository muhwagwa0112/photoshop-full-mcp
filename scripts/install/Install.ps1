[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$PackagePath,
    [switch]$SkipBuild,
    [switch]$SkipCodexRegistration
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$resolvedInstallRoot = Get-PsMcpInstallRoot -InstallRoot $InstallRoot
$scriptProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$inputRoot = if ($PackagePath) { [System.IO.Path]::GetFullPath($PackagePath) } else { $scriptProjectRoot }
$releaseRuntime = Join-Path $inputRoot 'payload\runtime'
$releasePlugin = Join-Path $inputRoot 'payload\uxp-plugin'
$sourcePackage = Join-Path $inputRoot 'package.json'
$isRelease = (Test-Path -LiteralPath $releaseRuntime -PathType Container) -and (Test-Path -LiteralPath $releasePlugin -PathType Container)
$isSource = (Test-Path -LiteralPath (Join-Path $inputRoot 'src') -PathType Container) -and (Test-Path -LiteralPath $sourcePackage -PathType Leaf)

if (-not $isRelease -and -not $isSource) {
    throw "PackagePath is neither a release payload nor a source checkout: $inputRoot"
}

$nodeVersion = Assert-PsMcpNode20
if ($isRelease) {
    $runtimeSource = $releaseRuntime
    $pluginSource = $releasePlugin
    $packageJson = Join-Path $runtimeSource 'package.json'
    foreach ($required in @('package.json', 'dist\src\index.js', 'node_modules')) {
        if (-not (Test-Path -LiteralPath (Join-Path $runtimeSource $required))) { throw "Release payload is incomplete: payload\runtime\$required" }
    }
} else {
    $runtimeSource = $inputRoot
    $pluginSource = Join-Path $inputRoot 'apps\uxp-plugin'
    $packageJson = $sourcePackage
    if (-not $SkipBuild) {
        Invoke-PsMcpCommand -FilePath 'npm' -Arguments @('--prefix', $inputRoot, 'run', 'build') -FailureMessage 'Build failed'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $inputRoot 'dist\src\index.js'))) { throw 'Source build did not produce dist\src\index.js.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $pluginSource 'manifest.json'))) { throw 'Missing UXP manifest.' }

$version = Get-PsMcpPackageVersion -PackageJson $packageJson
$appRoot = Join-Path $resolvedInstallRoot 'app'
$versionsRoot = Join-Path $appRoot 'versions'
$target = Join-Path $versionsRoot $version
$stage = Join-Path $versionsRoot ('.staging-{0}' -f [Guid]::NewGuid().ToString('N'))
$backup = Join-Path $versionsRoot ('.backup-{0}' -f [Guid]::NewGuid().ToString('N'))
$toolsTarget = Join-Path $appRoot 'tools'
$toolsStage = Join-Path $appRoot ('.tools-staging-{0}' -f [Guid]::NewGuid().ToString('N'))
$toolsBackup = Join-Path $appRoot ('.tools-backup-{0}' -f [Guid]::NewGuid().ToString('N'))
$currentPath = Join-Path $appRoot 'current.json'
$oldCurrent = if (Test-Path -LiteralPath $currentPath) { Get-Content -LiteralPath $currentPath -Raw } else { $null }
$targetBackedUp = $false
$stagePromoted = $false
$toolsBackedUp = $false
$toolsPromoted = $false

New-Item -ItemType Directory -Path $versionsRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $resolvedInstallRoot 'exports') -Force | Out-Null
try {
    $stageRuntime = Join-Path $stage 'runtime'
    $stagePlugin = Join-Path $stage 'uxp-plugin'
    New-Item -ItemType Directory -Path $stageRuntime -Force | Out-Null
    if ($isRelease) {
        Copy-Item -Path (Join-Path $runtimeSource '*') -Destination $stageRuntime -Recurse -Force
    } else {
        foreach ($item in @('package.json', 'package-lock.json', 'dist')) {
            $sourceItem = Join-Path $runtimeSource $item
            if (-not (Test-Path -LiteralPath $sourceItem)) { throw "Missing source runtime item: $item" }
            Copy-Item -LiteralPath $sourceItem -Destination $stageRuntime -Recurse -Force
        }
        Invoke-PsMcpCommand -FilePath 'npm' -Arguments @('--prefix', $stageRuntime, 'ci', '--omit=dev', '--ignore-scripts') -FailureMessage 'Production dependency installation failed'
    }
    Copy-Item -LiteralPath $pluginSource -Destination $stagePlugin -Recurse -Force
    if (-not (Test-Path -LiteralPath (Join-Path $stageRuntime 'dist\src\index.js'))) { throw 'Staged MCP entry point is missing.' }
    if (-not (Test-Path -LiteralPath (Join-Path $stagePlugin 'manifest.json'))) { throw 'Staged UXP manifest is missing.' }

    New-Item -ItemType Directory -Path $toolsStage -Force | Out-Null
    foreach ($toolName in @('Common.ps1', 'Doctor.ps1', 'Update.ps1', 'Uninstall.ps1')) {
        $toolSource = Join-Path $PSScriptRoot $toolName
        if (-not (Test-Path -LiteralPath $toolSource -PathType Leaf)) { throw "Installer lifecycle tool is missing: $toolName" }
        Copy-Item -LiteralPath $toolSource -Destination (Join-Path $toolsStage $toolName) -Force
    }
    $releasePublicKey = Join-Path $PSScriptRoot 'release-signing-public.xml'
    if (-not (Test-Path -LiteralPath $releasePublicKey -PathType Leaf)) { throw 'Installer release signing public key is missing.' }
    Copy-Item -LiteralPath $releasePublicKey -Destination (Join-Path $toolsStage 'release-signing-public.xml') -Force
    $ccxSource = Get-ChildItem -LiteralPath $inputRoot -Filter 'photoshop-full-mcp-v*.ccx' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    $stagedCcxPath = $null
    if ($ccxSource) {
        $packagesPath = Join-Path $toolsStage 'packages'
        New-Item -ItemType Directory -Path $packagesPath -Force | Out-Null
        $stagedCcxPath = Join-Path $packagesPath $ccxSource.Name
        Copy-Item -LiteralPath $ccxSource.FullName -Destination $stagedCcxPath -Force
    }

    if (Test-Path -LiteralPath $target) {
        Move-Item -LiteralPath $target -Destination $backup
        $targetBackedUp = $true
    }
    Move-Item -LiteralPath $stage -Destination $target
    $stagePromoted = $true
    if (Test-Path -LiteralPath $toolsTarget) {
        Move-Item -LiteralPath $toolsTarget -Destination $toolsBackup
        $toolsBackedUp = $true
    }
    Move-Item -LiteralPath $toolsStage -Destination $toolsTarget
    $toolsPromoted = $true
    $entryPoint = Join-Path $target 'runtime\dist\src\index.js'
    $manifestPath = Join-Path $target 'uxp-plugin\manifest.json'
    $currentMetadata = [ordered]@{
        version = $version
        installedAt = (Get-Date).ToUniversalTime().ToString('o')
        entryPoint = $entryPoint
        manifestPath = $manifestPath
        installRoot = $resolvedInstallRoot
        doctorPath = (Join-Path $toolsTarget 'Doctor.ps1')
        updatePath = (Join-Path $toolsTarget 'Update.ps1')
        uninstallPath = (Join-Path $toolsTarget 'Uninstall.ps1')
    }
    if ($stagedCcxPath) { $currentMetadata['ccxPath'] = Join-Path (Join-Path $toolsTarget 'packages') $ccxSource.Name }
    Write-PsMcpJsonAtomic -Path $currentPath -Value $currentMetadata
    if (-not $SkipCodexRegistration) {
        Set-PsMcpCodexRegistration -EntryPoint $entryPoint -InstallRoot $resolvedInstallRoot
    }
    if ($targetBackedUp -and (Test-Path -LiteralPath $backup)) { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue }
    if ($toolsBackedUp -and (Test-Path -LiteralPath $toolsBackup)) { Remove-Item -LiteralPath $toolsBackup -Recurse -Force -ErrorAction SilentlyContinue }
} catch {
    if ($toolsPromoted -and (Test-Path -LiteralPath $toolsTarget)) { Remove-Item -LiteralPath $toolsTarget -Recurse -Force }
    if ($toolsBackedUp -and (Test-Path -LiteralPath $toolsBackup)) { Move-Item -LiteralPath $toolsBackup -Destination $toolsTarget }
    if ($stagePromoted -and (Test-Path -LiteralPath $target)) { Remove-Item -LiteralPath $target -Recurse -Force }
    if ($targetBackedUp -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $target }
    if ($null -ne $oldCurrent) {
        [System.IO.File]::WriteAllText($currentPath, $oldCurrent, (New-Object System.Text.UTF8Encoding($false)))
    } elseif (Test-Path -LiteralPath $currentPath) {
        Remove-Item -LiteralPath $currentPath -Force
    }
    throw
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    if (Test-Path -LiteralPath $toolsStage) { Remove-Item -LiteralPath $toolsStage -Recurse -Force }
}

Write-Host "Photoshop Full MCP $version installed."
Write-Host "Runtime: $target"
Write-Host "UXP manifest: $(Join-Path $target 'uxp-plugin\manifest.json')"
Write-Host "Node: $nodeVersion"
if ($SkipCodexRegistration) { Write-Host 'Codex registration was skipped.' } else { Write-Host 'Codex registration: photoshop_full_mcp' }
Write-Host "Doctor: powershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $toolsTarget 'Doctor.ps1')`""
Write-Host "Update: powershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $toolsTarget 'Update.ps1')`""
Write-Host "Uninstall: powershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $toolsTarget 'Uninstall.ps1')`""
if ($stagedCcxPath) { Write-Host "UXP package: $(Join-Path (Join-Path $toolsTarget 'packages') $ccxSource.Name)" }
