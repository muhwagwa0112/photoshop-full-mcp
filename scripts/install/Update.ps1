[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$PackagePath,
    [string]$Repository = 'muhwagwa0112/photoshop-full-mcp',
    [switch]$SkipCodexRegistration
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$resolvedInstallRoot = Get-PsMcpInstallRoot -InstallRoot $InstallRoot
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('ps-mcp-update-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
try {
    $package = $PackagePath
    if (-not $package) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers @{ 'User-Agent' = 'Photoshop-Full-MCP-Updater' }
        $asset = $release.assets | Where-Object { $_.name -match '^photoshop-full-mcp-v.+-windows\.zip$' } | Select-Object -First 1
        if (-not $asset) { throw 'The latest release does not contain a Windows installer package.' }
        $package = Join-Path $temporaryRoot $asset.name
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $package -UseBasicParsing
        $checksumAsset = $release.assets | Where-Object { $_.name -eq ($asset.name + '.sha256') } | Select-Object -First 1
        if (-not $checksumAsset) { throw 'The latest release is missing its required SHA-256 checksum asset.' }
        $checksumPath = $package + '.sha256'
        Invoke-WebRequest -Uri $checksumAsset.browser_download_url -OutFile $checksumPath -UseBasicParsing
        $expected = ((Get-Content -LiteralPath $checksumPath -Raw) -split '\s+')[0].ToLowerInvariant()
        $actual = Get-PsMcpSha256 -Path $package
        if ($expected -notmatch '^[a-f0-9]{64}$' -or $expected -ne $actual) { throw 'Downloaded package checksum verification failed.' }
    }
    $resolvedPackage = [System.IO.Path]::GetFullPath($package)
    if (Test-Path -LiteralPath $resolvedPackage -PathType Leaf) {
        Expand-Archive -LiteralPath $resolvedPackage -DestinationPath $temporaryRoot -Force
        $packageRoot = $temporaryRoot
        $installer = Get-ChildItem -LiteralPath $temporaryRoot -Filter Install.ps1 -Recurse | Select-Object -First 1
        if (-not $installer) { throw 'The update archive does not contain Install.ps1.' }
        $installScript = $installer.FullName
        $packageRoot = $installer.DirectoryName
    } elseif (Test-Path -LiteralPath $resolvedPackage -PathType Container) {
        $packageRoot = $resolvedPackage
        $direct = Join-Path $packageRoot 'Install.ps1'
        $source = Join-Path $packageRoot 'scripts\install\Install.ps1'
        if (Test-Path -LiteralPath $direct) { $installScript = $direct }
        elseif (Test-Path -LiteralPath $source) { $installScript = $source }
        else { throw 'Package directory does not contain an installer.' }
    } else { throw "Update package does not exist: $resolvedPackage" }

    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installScript, '-InstallRoot', $resolvedInstallRoot, '-PackagePath', $packageRoot)
    if ($SkipCodexRegistration) { $arguments += '-SkipCodexRegistration' }
    Invoke-PsMcpCommand -FilePath 'powershell.exe' -Arguments $arguments -FailureMessage 'Update installation failed'
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
