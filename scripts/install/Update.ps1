[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$PackagePath,
    [string]$ManifestPath,
    [string]$SignaturePath,
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
        $manifestAssets = @($release.assets | Where-Object { $_.name -match '^photoshop-full-mcp-v.+-windows\.zip\.manifest\.json$' })
        if ($manifestAssets.Count -ne 1) { throw 'The latest release must contain exactly one signed Windows manifest.' }
        $manifestAsset = $manifestAssets[0]
        $signatureAssets = @($release.assets | Where-Object { $_.name -eq ($manifestAsset.name + '.sig') })
        if ($signatureAssets.Count -ne 1) { throw 'The latest release must contain exactly one matching manifest signature.' }
        $ManifestPath = Join-Path $temporaryRoot $manifestAsset.name
        $SignaturePath = "$ManifestPath.sig"
        Invoke-WebRequest -Uri $manifestAsset.browser_download_url -OutFile $ManifestPath -UseBasicParsing
        Invoke-WebRequest -Uri $signatureAssets[0].browser_download_url -OutFile $SignaturePath -UseBasicParsing
        $signed = Read-PsMcpSignedReleaseManifest -ManifestPath $ManifestPath -SignaturePath $SignaturePath -ExpectedRepository $Repository -ExpectedTag ([string]$release.tag_name)
        $packageAssets = @($release.assets | Where-Object { $_.name -eq $signed.assets.windowsZip.name })
        if ($packageAssets.Count -ne 1) { throw 'The latest release must contain exactly one signed Windows package asset.' }
        $package = Join-Path $temporaryRoot $signed.assets.windowsZip.name
        Invoke-WebRequest -Uri $packageAssets[0].browser_download_url -OutFile $package -UseBasicParsing
    } else {
        $package = [System.IO.Path]::GetFullPath($package)
        if ([string]::IsNullOrWhiteSpace($ManifestPath)) { $ManifestPath = "$package.manifest.json" }
        if ([string]::IsNullOrWhiteSpace($SignaturePath)) { $SignaturePath = "$ManifestPath.sig" }
        $signed = Read-PsMcpSignedReleaseManifest -ManifestPath $ManifestPath -SignaturePath $SignaturePath -ExpectedRepository $Repository
    }
    $resolvedPackage = [System.IO.Path]::GetFullPath($package)
    if (-not (Test-Path -LiteralPath $resolvedPackage -PathType Leaf)) { throw "Signed update archive does not exist: $resolvedPackage" }
    if ([System.IO.Path]::GetFileName($resolvedPackage) -ne [string]$signed.assets.windowsZip.name) { throw 'Signed manifest asset name does not match the selected package.' }
    if ((Get-Item -LiteralPath $resolvedPackage).Length -ne [long]$signed.assets.windowsZip.size) { throw 'Signed package size verification failed.' }
    if ((Get-PsMcpSha256 -Path $resolvedPackage) -ne [string]$signed.assets.windowsZip.sha256) { throw 'Signed package digest verification failed.' }
    $expandedRoot = Join-Path $temporaryRoot 'expanded'
    New-Item -ItemType Directory -Path $expandedRoot -Force | Out-Null
    Expand-Archive -LiteralPath $resolvedPackage -DestinationPath $expandedRoot -Force
    $topLevel = @(Get-ChildItem -LiteralPath $expandedRoot -Force)
    if ($topLevel.Count -ne 1 -or -not $topLevel[0].PSIsContainer -or $topLevel[0].Name -ne "photoshop-full-mcp-$($signed.version)") {
        throw 'The authenticated update archive must contain exactly one expected top-level bundle directory.'
    }
    $packageRoot = $topLevel[0].FullName
    $installScript = Join-Path $packageRoot 'Install.ps1'
    if (-not (Test-Path -LiteralPath $installScript -PathType Leaf)) { throw 'The authenticated update archive does not have the exact expected installer layout.' }

    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installScript, '-InstallRoot', $resolvedInstallRoot, '-PackagePath', $packageRoot)
    if ($SkipCodexRegistration) { $arguments += '-SkipCodexRegistration' }
    Invoke-PsMcpCommand -FilePath 'powershell.exe' -Arguments $arguments -FailureMessage 'Update installation failed'
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
