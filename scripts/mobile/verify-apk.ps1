param(
    [Parameter(Mandatory)][string]$Apk,
    [Parameter(Mandatory)][string]$BuildTools,
    [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedCertificate
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'release-tools.psm1') -Force
Test-ReleaseApk $Apk $BuildTools $ExpectedCertificate | ConvertTo-Json -Depth 5
