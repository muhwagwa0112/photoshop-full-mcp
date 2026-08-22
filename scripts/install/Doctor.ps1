[CmdletBinding()]
param(
    [string]$InstallRoot,
    [Alias('Live')]
    [switch]$CheckLiveBridge,
    [switch]$SkipCodexRegistration,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$resolvedInstallRoot = Get-PsMcpInstallRoot -InstallRoot $InstallRoot
$checks = New-Object System.Collections.ArrayList
function Add-Check([string]$Name, [bool]$Ok, [string]$Detail, [bool]$Required = $true) {
    [void]$checks.Add([ordered]@{ name = $Name; ok = $Ok; required = $Required; detail = $Detail })
}

try { $node = Assert-PsMcpNode20; Add-Check 'node' $true $node } catch { Add-Check 'node' $false $_.Exception.Message }
$metadata = Get-PsMcpCurrentMetadata -InstallRoot $resolvedInstallRoot
if ($metadata) {
    $entryOk = [bool](Test-Path -LiteralPath ([string]$metadata.entryPoint) -PathType Leaf)
    Add-Check 'runtime' $entryOk ([string]$metadata.entryPoint)
    $manifestOk = [bool](Test-Path -LiteralPath ([string]$metadata.manifestPath) -PathType Leaf)
    Add-Check 'uxp-manifest' $manifestOk ([string]$metadata.manifestPath)
} else {
    Add-Check 'runtime' $false 'No installed version metadata was found.'
    Add-Check 'uxp-manifest' $false 'No installed version metadata was found.'
}

$ccxPath = if ($metadata -and $metadata.PSObject.Properties.Name -contains 'ccxPath') { [string]$metadata.ccxPath } else { $null }
$ccxOk = $ccxPath -and (Test-Path -LiteralPath $ccxPath -PathType Leaf)
$uxpDeveloperTools = $false
$uxpToolDetail = $null
if (-not $ccxOk) {
    foreach ($uninstallRoot in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (Test-Path $uninstallRoot) {
            $match = Get-ChildItem $uninstallRoot -ErrorAction SilentlyContinue | Get-ItemProperty -ErrorAction SilentlyContinue | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -match 'UXP Developer Tool' } | Select-Object -First 1
            if ($match) { $uxpDeveloperTools = $true; $uxpToolDetail = [string]$match.DisplayName; break }
        }
    }
    if (-not $uxpDeveloperTools -and $env:LOCALAPPDATA) {
        foreach ($candidate in @((Join-Path $env:LOCALAPPDATA 'Programs\Adobe UXP Developer Tool'), (Join-Path $env:LOCALAPPDATA 'Adobe\UXP Developer Tool'))) {
            if (Test-Path -LiteralPath $candidate) { $uxpDeveloperTools = $true; $uxpToolDetail = $candidate; break }
        }
    }
}
if ($ccxOk) {
    Add-Check 'uxp-install-path' $true "Install the packaged UXP plugin by opening: $ccxPath"
} elseif ($uxpDeveloperTools) {
    $fallbackManifest = if ($metadata) { [string]$metadata.manifestPath } else { 'unavailable' }
    Add-Check 'uxp-install-path' $true "Manifest fallback via Adobe UXP Developer Tools ($uxpToolDetail): $fallbackManifest"
} else {
    $fallbackManifest = if ($metadata) { [string]$metadata.manifestPath } else { 'unavailable' }
    Add-Check 'uxp-install-path' $false "No installed CCX or Adobe UXP Developer Tools was found. Manifest fallback: $fallbackManifest"
}

$codex = Get-Command codex -ErrorAction SilentlyContinue
if ($SkipCodexRegistration) {
    Add-Check 'codex-registration' $true 'Codex registration check was skipped for this isolated verification.' $false
} elseif ($codex -and $metadata) {
    $registration = @(& codex mcp get photoshop_full_mcp 2>$null) -join "`n"
    $registrationOk = ($LASTEXITCODE -eq 0) -and $registration.Contains([string]$metadata.entryPoint)
    Add-Check 'codex-registration' $registrationOk ($(if ($registrationOk) { 'photoshop_full_mcp points to the installed runtime.' } else { 'Registration is missing or points to a different runtime.' }))
} else {
    Add-Check 'codex-registration' $false 'Codex CLI or installed metadata is unavailable.'
}

$photoshopFound = $false
$photoshopDetails = New-Object System.Collections.ArrayList
foreach ($registryPath in @('HKLM:\SOFTWARE\Adobe\Photoshop', 'HKLM:\SOFTWARE\WOW6432Node\Adobe\Photoshop', 'HKCU:\SOFTWARE\Adobe\Photoshop')) {
    if (Test-Path $registryPath) {
        $photoshopFound = $true
        [void]$photoshopDetails.Add($registryPath)
    }
}
Add-Check 'photoshop' $photoshopFound ($(if ($photoshopFound) { $photoshopDetails -join ', ' } else { 'Photoshop was not found in the Adobe registry keys.' }))

if ($CheckLiveBridge) {
    $live = $false
    $detail = 'No bridge answered on ports 38452-38462.'
    foreach ($port in 38452..38462) {
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/discovery" -Method Get -TimeoutSec 1
            if ($response.protocol -eq 'ps-mcp-bridge/2') { $live = $true; $detail = "Bridge discovered on port $port."; break }
        } catch { }
    }
    Add-Check 'live-bridge' $live $detail
}

$success = -not ($checks | Where-Object { $_.required -and -not $_.ok })
$result = [ordered]@{ ok = $success; installRoot = $resolvedInstallRoot; checks = @($checks) }
if ($Json) { $result | ConvertTo-Json -Depth 6 } else {
    foreach ($check in $checks) { Write-Host ("[{0}] {1}: {2}" -f $(if ($check.ok) { 'OK' } else { 'FAIL' }), $check.name, $check.detail) }
}
if (-not $success) { exit 1 }
