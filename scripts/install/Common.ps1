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

function Get-PsMcpReleasePublicKeyPath {
    param([string]$PublicKeyPath)
    $path = if ($PublicKeyPath) { $PublicKeyPath } else { Join-Path $PSScriptRoot 'release-signing-public.xml' }
    $resolved = [System.IO.Path]::GetFullPath($path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Release signing public key is missing: $resolved" }
    return $resolved
}

function Assert-PsMcpReleaseSigningKey {
    param(
        [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
        [string]$PublicKeyPath
    )
    $resolvedPrivate = [System.IO.Path]::GetFullPath($PrivateKeyPath)
    $resolvedPublic = Get-PsMcpReleasePublicKeyPath -PublicKeyPath $PublicKeyPath
    if (-not (Test-Path -LiteralPath $resolvedPrivate -PathType Leaf)) { throw "Release signing private key is missing: $resolvedPrivate" }
    $privateRsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    $publicRsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    try {
        $privateRsa.FromXmlString([System.IO.File]::ReadAllText($resolvedPrivate))
        $publicRsa.FromXmlString([System.IO.File]::ReadAllText($resolvedPublic))
        if ($privateRsa.PublicOnly) { throw 'Release signing key does not contain a private key.' }
        $probe = [System.Text.Encoding]::UTF8.GetBytes('photoshop-full-mcp release-key preflight v1')
        $signature = $privateRsa.SignData($probe, [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'))
        if (-not $publicRsa.VerifyData($probe, [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'), $signature)) {
            throw 'Release signing private key does not match the committed public key.'
        }
    } finally {
        $privateRsa.Dispose()
        $publicRsa.Dispose()
    }
}

function Write-PsMcpReleaseSignature {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$SignaturePath,
        [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
        [string]$PublicKeyPath
    )
    $resolvedManifest = [System.IO.Path]::GetFullPath($ManifestPath)
    $resolvedPrivate = [System.IO.Path]::GetFullPath($PrivateKeyPath)
    if (-not (Test-Path -LiteralPath $resolvedManifest -PathType Leaf)) { throw "Release manifest is missing: $resolvedManifest" }
    if (-not (Test-Path -LiteralPath $resolvedPrivate -PathType Leaf)) { throw "Release signing private key is missing: $resolvedPrivate" }
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    try {
        $rsa.FromXmlString([System.IO.File]::ReadAllText($resolvedPrivate))
        if ($rsa.PublicOnly) { throw 'Release signing key does not contain a private key.' }
        $bytes = [System.IO.File]::ReadAllBytes($resolvedManifest)
        $signature = $rsa.SignData($bytes, [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'))
        [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($SignaturePath), [Convert]::ToBase64String($signature) + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    } finally {
        $rsa.Dispose()
    }
    $null = Read-PsMcpSignedReleaseManifest -ManifestPath $resolvedManifest -SignaturePath $SignaturePath -PublicKeyPath $PublicKeyPath
}

function Read-PsMcpSignedReleaseManifest {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$SignaturePath,
        [string]$PublicKeyPath,
        [string]$ExpectedRepository,
        [string]$ExpectedTag
    )
    $resolvedManifest = [System.IO.Path]::GetFullPath($ManifestPath)
    $resolvedSignature = [System.IO.Path]::GetFullPath($SignaturePath)
    $resolvedPublic = Get-PsMcpReleasePublicKeyPath -PublicKeyPath $PublicKeyPath
    foreach ($required in @($resolvedManifest, $resolvedSignature)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Signed release metadata is missing: $required" }
    }
    try { $signature = [Convert]::FromBase64String(([System.IO.File]::ReadAllText($resolvedSignature)).Trim()) }
    catch { throw 'Release signature is not valid base64.' }
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    try {
        $rsa.FromXmlString([System.IO.File]::ReadAllText($resolvedPublic))
        $valid = $rsa.VerifyData([System.IO.File]::ReadAllBytes($resolvedManifest), [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'), $signature)
    } finally {
        $rsa.Dispose()
    }
    if (-not $valid) { throw 'Release manifest signature verification failed.' }
    try { $manifest = Get-Content -LiteralPath $resolvedManifest -Raw | ConvertFrom-Json }
    catch { throw 'Release manifest is not valid JSON.' }
    $keyId = Get-PsMcpSha256 -Path $resolvedPublic
    if ($manifest.schema -ne 'photoshop-full-mcp-release/2' -or $manifest.product -ne 'photoshop-full-mcp') { throw 'Release manifest schema or product is invalid.' }
    if ($manifest.signatureAlgorithm -ne 'rsa-sha256-pkcs1' -or $manifest.keyId -ne $keyId) { throw 'Release manifest signing identity is invalid.' }
    if ($ExpectedRepository -and $manifest.repository -ne $ExpectedRepository) { throw 'Release manifest repository does not match the configured repository.' }
    if ($ExpectedTag -and $manifest.tag -ne $ExpectedTag) { throw 'Release manifest tag does not match the selected release.' }
    if (-not $manifest.version -or $manifest.version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$' -or $manifest.tag -ne "v$($manifest.version)") { throw 'Release manifest version or tag is invalid.' }
    if ($manifest.platform -ne 'windows' -or $manifest.architecture -ne 'requires-node-20') { throw 'Release manifest platform is invalid.' }
    $asset = $manifest.assets.windowsZip
    $expectedName = "photoshop-full-mcp-v$($manifest.version)-windows.zip"
    if (-not $asset -or $asset.name -ne $expectedName -or $asset.sha256 -notmatch '^[a-f0-9]{64}$' -or [long]$asset.size -le 0) { throw 'Release manifest Windows asset binding is invalid.' }
    $ccxProperty = $manifest.assets.PSObject.Properties['ccx']
    if ($ccxProperty) {
        $ccx = $ccxProperty.Value
        if ($ccx.name -ne "photoshop-full-mcp-v$($manifest.version).ccx" -or $ccx.sha256 -notmatch '^[a-f0-9]{64}$' -or [long]$ccx.size -le 0 -or $ccx.pluginId -ne 'com.codex.photoshop-full-mcp' -or $ccx.pluginVersion -ne $manifest.version) {
            throw 'Release manifest CCX asset binding is invalid.'
        }
    }
    return $manifest
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
