param(
    [Parameter(Mandatory)][string]$ToolEnvironment,
    [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ToolEnvironmentSha256
)
$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0
try {
    Import-Module (Join-Path $PSScriptRoot 'release-tools.psm1')
    $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    if ($source -ne 'D:\CodexData\workspaces\ChatGPT\soundspan-wave-mixes-release') { throw 'Verification must run from the canonical source checkout' }
    $null = Assert-SafeDPath $source
    $null = Assert-SafeDPath $ToolEnvironment
    if ((Get-FileHash -LiteralPath $ToolEnvironment).Hash -ne $ToolEnvironmentSha256) { throw 'Tool environment hash mismatch' }
    . $ToolEnvironment
    if (-not (Get-Command Invoke-MobileGate -ErrorAction SilentlyContinue)) { throw 'Tool environment must define Invoke-MobileGate' }
    foreach ($name in @('FLUTTER_ROOT','PUB_CACHE','GRADLE_USER_HOME','TEMP','TMP','APPDATA','LOCALAPPDATA','USERPROFILE','ANDROID_HOME','ANDROID_SDK_ROOT','ANDROID_USER_HOME','ANDROID_AVD_HOME','ANDROID_EMULATOR_HOME')) {
        $value = [Environment]::GetEnvironmentVariable($name,'Process')
        if ([string]::IsNullOrWhiteSpace($value)) { throw "Missing mutable tooling path: $name" }
        $null = Assert-SafeDPath $value
    }
    $version = Get-Content -Raw -LiteralPath (Join-Path $env:FLUTTER_ROOT 'bin/cache/flutter.version.json') | ConvertFrom-Json
    if ($version.flutterVersion -ne '3.47.7' -or $version.dartSdkVersion -ne '3.13.5' -or $version.frameworkRevision -ne 'abaf9c523780a608bd46686fd5e53740a07077f8') { throw 'Pinned Flutter/Dart toolchain mismatch' }
    if ((Get-FileHash -LiteralPath (Join-Path $source 'mobile/pubspec.lock')).Hash -ne '01A909137D3B91DF57DAEC2581772AE2D745CE76DA6736BA00562CA870FDEA32') { throw 'Pinned pub lock mismatch' }
    Push-Location (Join-Path $source 'mobile')
    try {
        Invoke-MobileGate {
            $flutter = Join-Path $env:FLUTTER_ROOT 'bin/flutter.bat'
            $dart = Join-Path $env:FLUTTER_ROOT 'bin/dart.bat'
            Write-Output 'Verify mobile: pinned dependencies'
            Invoke-StreamingNative $flutter @('pub','get','--enforce-lockfile')
            Write-Output 'Verify mobile: format check (no source writes)'
            Invoke-StreamingNative $dart @('format','--output=none','--set-exit-if-changed','lib','test','integration_test')
            Write-Output 'Verify mobile: analysis'
            Invoke-StreamingNative $flutter @('analyze')
            Write-Output 'Verify mobile: complete test suite'
            Invoke-StreamingNative $flutter @('test')
        }
    } finally { Pop-Location }
} catch {
    $failureCode = $LASTEXITCODE
    if ($null -eq $failureCode -or $failureCode -eq 0) { $failureCode = 1 }
    Write-Error -Message ("Mobile verification failed: " + $_.Exception.Message) -ErrorAction Continue
    exit $failureCode
}
exit 0
