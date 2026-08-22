[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipCodexRegistration
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $projectRoot 'dist\src\index.js'
$manifestPath = Join-Path $projectRoot 'apps\uxp-plugin\manifest.json'

if (-not $SkipBuild) {
    & npm --prefix $projectRoot run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
}

if (-not (Test-Path -LiteralPath $entryPoint)) { throw "Missing MCP entry point: $entryPoint" }
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing UXP manifest: $manifestPath" }

if (-not $SkipCodexRegistration) {
    $registeredServers = & codex mcp list 2>$null
    $alreadyRegistered = $registeredServers | Select-String -Pattern '^photoshop_full_mcp\s'
    if ($alreadyRegistered) {
        & codex mcp remove photoshop_full_mcp
        if ($LASTEXITCODE -ne 0) { throw 'Could not replace existing photoshop_full_mcp registration' }
    }
    & codex mcp add photoshop_full_mcp -- node $entryPoint
    if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration failed' }
}

Write-Host 'Photoshop Full MCP v2 is built and registered.'
Write-Host "UXP manifest: $manifestPath"
Write-Host 'Open Adobe UXP Developer Tools, choose Add Plugin, select the manifest, and click Load.'
Write-Host 'The existing photoshop_mcp registration was not changed.'
