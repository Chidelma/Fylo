param(
    [string]$Destination
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Install-VerifiedGitHubBinary {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$Asset,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$Executable
    )

    $assetPath = Join-Path $Destination $Executable
    $url = "https://github.com/$Repository/releases/download/$Version/$Asset"
    Invoke-WebRequest -Uri $url -OutFile $assetPath

    $actual = (Get-FileHash -Algorithm SHA256 $assetPath).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
        Remove-Item $assetPath -Force -ErrorAction SilentlyContinue
        throw "Checksum mismatch for $Repository@$Version/$Asset."
    }

    Write-Host "Installed verified $Repository@$Version/$Asset."
}

if (-not $Destination) {
    $temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
    $Destination = Join-Path $temporaryRoot 'fylo-vendor-bin'
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Install-VerifiedGitHubBinary `
    -Repository 'd31ma/TTID' `
    -Version 'v26.32.03' `
    -Asset 'ttid-windows-x64.exe' `
    -ExpectedSha256 '41c06d2305e40ceb34baefc214610a869defc772501047e39c23427e0ff8565f' `
    -Executable 'ttid.exe'
Install-VerifiedGitHubBinary `
    -Repository 'd31ma/CHEX' `
    -Version 'v26.32.02' `
    -Asset 'chex-windows-x64.exe' `
    -ExpectedSha256 '3aa465447849d1f0d43318cd7c0e3c69a7db8cc06055a0c6ba0b4d53c24334bc' `
    -Executable 'chex.exe'
Install-VerifiedGitHubBinary `
    -Repository 'd31ma/Tachyon' `
    -Version 'v26.33.01' `
    -Asset 'ty-windows-x64.exe' `
    -ExpectedSha256 '15b624f77c4e582a41332e44aadc7451369b960f8081da7fd670e11eb76a6424' `
    -Executable 'ty.exe'

$env:Path = "$Destination;$env:Path"
if ($env:GITHUB_PATH) {
    Add-Content -Path $env:GITHUB_PATH -Value $Destination
}
& (Join-Path $Destination 'ttid.exe') --help | Out-Null
& (Join-Path $Destination 'chex.exe') --help | Out-Null
$tachyonVersion = & (Join-Path $Destination 'ty.exe') --version
if ($tachyonVersion.Trim() -ne '26.33.01') {
    throw "Unexpected TACHYON version: $tachyonVersion"
}
