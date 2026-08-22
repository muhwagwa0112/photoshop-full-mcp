[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$InstallRoot,
    [switch]$SkipCodexRegistration,
    [switch]$RemoveUserData
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$resolvedInstallRoot = Test-PsMcpSafeRemovalRoot -Path (Get-PsMcpInstallRoot -InstallRoot $InstallRoot)

if (-not $SkipCodexRegistration) {
    $codex = Get-Command codex -ErrorAction SilentlyContinue
    if ($codex) {
        $listed = @(& codex mcp list 2>$null)
        if ($LASTEXITCODE -eq 0 -and ($listed | Select-String -Pattern '^photoshop_full_mcp\s')) {
            Invoke-PsMcpCommand -FilePath 'codex' -Arguments @('mcp', 'remove', 'photoshop_full_mcp') -FailureMessage 'Could not remove the Codex MCP registration'
        }
    }
}

$target = if ($RemoveUserData) { $resolvedInstallRoot } else { Join-Path $resolvedInstallRoot 'app' }
if (Test-Path -LiteralPath $target) {
    if ($PSCmdlet.ShouldProcess($target, 'Remove Photoshop Full MCP files')) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}
if ($RemoveUserData) { Write-Host "Photoshop Full MCP and user data removed from $resolvedInstallRoot" }
else { Write-Host "Photoshop Full MCP runtime removed. User data remains in $resolvedInstallRoot" }
