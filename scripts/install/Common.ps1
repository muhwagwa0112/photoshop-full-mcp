Set-StrictMode -Version 2.0

function Get-PsMcpInstallRoot {
    param([string]$InstallRoot)
    if ($InstallRoot) { return [System.IO.Path]::GetFullPath($InstallRoot) }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable. Pass -InstallRoot explicitly.' }
    return Join-Path $env:LOCALAPPDATA 'PS_MCP'
}

function Invoke-PsMcpCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$FailureMessage = 'External command failed'
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FailureMessage (exit $LASTEXITCODE)" }
}

function Assert-PsMcpNode20 {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Node.js 20 or newer is required and was not found on PATH.' }
    $rawVersion = (& node --version 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $rawVersion -or $rawVersion -notmatch '^v(?<major>\d+)\.') {
        throw 'Could not determine the installed Node.js version.'
    }
    if ([int]$Matches.major -lt 20) { throw "Node.js 20 or newer is required; found $rawVersion." }
    return $rawVersion
}

function Get-PsMcpPackageVersion {
    param([Parameter(Mandatory = $true)][string]$PackageJson)
    if (-not (Test-Path -LiteralPath $PackageJson -PathType Leaf)) { throw "Missing package metadata: $PackageJson" }
    $package = Get-Content -LiteralPath $PackageJson -Raw | ConvertFrom-Json
    if (-not $package.version -or $package.version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') {
        throw "Invalid package version in $PackageJson"
    }
    return [string]$package.version
}

function Get-PsMcpSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [System.IO.File]::OpenRead([System.IO.Path]::GetFullPath($Path))
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $algorithm.ComputeHash($stream)
        return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Get-PsMcpCurrentMetadata {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)
    $path = Join-Path $InstallRoot 'app\current.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

function Write-PsMcpJsonAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporary = "$Path.$PID.tmp"
    $json = $Value | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-PsMcpCodexConfigPath {
    if ($env:CODEX_HOME) { return Join-Path $env:CODEX_HOME 'config.toml' }
    if (-not $env:USERPROFILE) { return $null }
    return Join-Path $env:USERPROFILE '.codex\config.toml'
}

function Set-PsMcpCodexRegistration {
    param(
        [Parameter(Mandatory = $true)][string]$EntryPoint,
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )
    $codex = Get-Command codex -ErrorAction SilentlyContinue
    if (-not $codex) { throw 'Codex CLI was not found on PATH.' }
    $configPath = Get-PsMcpCodexConfigPath
    $backup = if ($configPath) { $configPath + ('.ps-mcp-backup-{0}' -f [Guid]::NewGuid().ToString('N')) } else { Join-Path $InstallRoot ('.registration-backup-{0}.toml' -f [Guid]::NewGuid().ToString('N')) }
    $hadConfig = $false
    if ($configPath -and (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        Copy-Item -LiteralPath $configPath -Destination $backup -Force
        $hadConfig = $true
    }
    try {
        $listed = @(& codex mcp list 2>$null)
        if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Codex MCP registrations.' }
        if ($listed | Select-String -Pattern '^photoshop_full_mcp\s') {
            Invoke-PsMcpCommand -FilePath 'codex' -Arguments @('mcp', 'remove', 'photoshop_full_mcp') -FailureMessage 'Could not replace the existing Photoshop MCP registration'
        }
        Invoke-PsMcpCommand -FilePath 'codex' -Arguments @('mcp', 'add', 'photoshop_full_mcp', '--', 'node', $EntryPoint) -FailureMessage 'Codex MCP registration failed'
    } catch {
        if ($configPath) {
            if ($hadConfig) {
                Copy-Item -LiteralPath $backup -Destination $configPath -Force
            } elseif (Test-Path -LiteralPath $configPath) {
                Remove-Item -LiteralPath $configPath -Force
            }
        }
        throw
    } finally {
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    }
}

function Test-PsMcpSafeRemovalRoot {
    param([Parameter(Mandatory = $true)][string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $root = [System.IO.Path]::GetPathRoot($full).TrimEnd('\')
    if (-not $full -or $full -eq $root -or $full -eq $env:USERPROFILE -or $full -eq $env:LOCALAPPDATA) {
        throw "Refusing unsafe removal target: $full"
    }
    return $full
}
