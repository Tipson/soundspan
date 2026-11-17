param(
    [Parameter(Mandatory)][string]$Apk,
    [Parameter(Mandatory)][string]$BuildTools,
    [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedCertificate,
    [string]$ExpectedVersionName = '0.1.10',
    [string]$ExpectedVersionCode = '13'
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'release-tools.psm1') -Force
Test-ReleaseApk $Apk $BuildTools $ExpectedCertificate -ExpectedVersionName $ExpectedVersionName -ExpectedVersionCode $ExpectedVersionCode | ConvertTo-Json -Depth 5
