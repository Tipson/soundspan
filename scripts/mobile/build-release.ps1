param(
    [Parameter(Mandatory)][string]$ToolEnvironment,
    [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ToolEnvironmentSha256,
    [Parameter(Mandatory)][string]$SigningMetadata,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedSourceCommit,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'release-tools.psm1') -Force
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$canonical = 'D:\CodexData\workspaces\ChatGPT\soundspan-wave-mixes-release'
if ($source -ne $canonical) { throw 'Release must run from the canonical source checkout' }
$null = Assert-SafeDPath $source
$output = Assert-SafeDPath $OutputDirectory 'D:\CodexData\outputs\soundspan\mobile-app-20261015'
if ($output -ne 'D:\CodexData\outputs\soundspan\mobile-app-20261015\releases') { throw 'Unexpected release output directory' }
$null = Assert-SafeDPath $ToolEnvironment
if ((Get-FileHash -LiteralPath $ToolEnvironment).Hash -ne $ToolEnvironmentSha256) { throw 'Tool environment hash mismatch' }
. $ToolEnvironment
if (-not (Get-Command Invoke-MobileGate -ErrorAction SilentlyContinue)) { throw 'Tool environment must define Invoke-MobileGate' }
foreach ($name in @('FLUTTER_ROOT','PUB_CACHE','GRADLE_USER_HOME','TEMP','TMP','APPDATA','LOCALAPPDATA','USERPROFILE','ANDROID_HOME','ANDROID_USER_HOME','ANDROID_AVD_HOME','ANDROID_EMULATOR_HOME')) {
    $value = [Environment]::GetEnvironmentVariable($name,'Process')
    if ([string]::IsNullOrWhiteSpace($value)) { throw "Missing mutable tooling path: $name" }
    $null = Assert-SafeDPath $value
}
$null = Read-SigningMetadata $SigningMetadata
$version = Get-Content -Raw (Join-Path $env:FLUTTER_ROOT 'bin/cache/flutter.version.json') | ConvertFrom-Json
if ($version.flutterVersion -ne '3.47.7' -or $version.dartSdkVersion -ne '3.13.5' -or $version.frameworkRevision -ne 'abaf9c523780a608bd46686fd5e53740a07077f8') { throw 'Pinned Flutter/Dart toolchain mismatch' }
$lock = Join-Path $source 'mobile/pubspec.lock'
if ((Get-FileHash $lock).Hash -ne '01A909137D3B91DF57DAEC2581772AE2D745CE76DA6736BA00562CA870FDEA32') { throw 'Pinned pub lock mismatch' }
$pinnedInputs = @{
    'mobile/pubspec.yaml' = 'C0241808CC217A0501FDE5F1A4F8465C73AF5AAEFD9C00C8B4255E780EE951C0'
    'mobile/android/settings.gradle.kts' = 'AF7626661E1DE91F28892C8EBF0139F75C5042F078ED132121F68C99365D8A10'
    'mobile/android/gradle/wrapper/gradle-wrapper.properties' = 'B690D26223576FE4E63889FAD9A00DF81945CB870B9476CC5A563152A1A88A74'
}
foreach ($inputPath in $pinnedInputs.Keys) {
    if ((Get-FileHash (Join-Path $source $inputPath)).Hash -ne $pinnedInputs[$inputPath]) { throw "Pinned release input mismatch: $inputPath" }
}
$releaseVersion = Read-PubspecVersion (Get-Content -Raw -LiteralPath (Join-Path $source 'mobile/pubspec.yaml'))
$buildTools = Join-Path $env:ANDROID_HOME 'build-tools/36.0.0'
$metadata = Read-SigningMetadata $SigningMetadata
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$name = "soundspan-$($releaseVersion.versionName)+$($releaseVersion.versionCode)-$($ExpectedSourceCommit.Substring(0,12))-$stamp"
$apkOut = Join-Path $output "$name.apk"
$reportOut = Join-Path $output "$name.json"
Assert-NewOutput $apkOut
Assert-NewOutput $reportOut
Push-Location (Join-Path $source 'mobile')
try {
    Invoke-MobileGate {
        $head = Invoke-CheckedNative 'git' @('-C',$source,'rev-parse','HEAD')
        if ($head.Trim() -ne $ExpectedSourceCommit) { throw 'Source HEAD differs from frozen revision' }
        $dirty = Invoke-CheckedNative 'git' @('-C',$source,'status','--porcelain','--untracked-files=all','--','mobile','scripts/mobile','.gitignore')
        if (-not [string]::IsNullOrWhiteSpace($dirty)) { throw 'Mobile release inputs must be committed and clean' }
        $free = (Get-PSDrive D).Free
        if ($free -lt (20GB + 6GB)) { throw 'Release requires a 20 GiB reserve plus a 6 GiB build budget on D' }
        & (Join-Path $PSScriptRoot 'verify-mobile.ps1') -ToolEnvironment $ToolEnvironment -ToolEnvironmentSha256 $ToolEnvironmentSha256
        if ($LASTEXITCODE -ne 0) { throw "Mobile verification failed: $LASTEXITCODE" }
        # Regenerate the release plugin registry before exposing signing secrets.
        $flutter = Join-Path $env:FLUTTER_ROOT 'bin/flutter.bat'
        Invoke-StreamingNative $flutter @('build','apk','--release','--config-only')
        if ((Get-FileHash $lock).Hash -ne '01A909137D3B91DF57DAEC2581772AE2D745CE76DA6736BA00562CA870FDEA32') { throw 'Pinned pub lock changed during release configuration' }
        # No daemon, disk configuration cache, or heap dumps containing signing secrets.
        Invoke-WithEnvironment @{ GRADLE_OPTS = '-Dorg.gradle.daemon=false -Dorg.gradle.configuration-cache=false'; JAVA_TOOL_OPTIONS = '-Duser.home=D:/CodexData/runtime/mobile-profile -XX:-HeapDumpOnOutOfMemoryError' } {
            Invoke-WithSigning $SigningMetadata {
                & $flutter build apk --release --no-pub --no-android-gradle-daemon
                if ($LASTEXITCODE -ne 0) { throw "Release build failed: $LASTEXITCODE" }
            }
        }
        $built = Join-Path $source 'mobile/build/app/outputs/flutter-apk/app-release.apk'
        $receipt = Test-ReleaseApk $built $buildTools $metadata.certificateSha256 -ExpectedVersionName $releaseVersion.versionName -ExpectedVersionCode $releaseVersion.versionCode
        $receipt.sourceCommit = $ExpectedSourceCommit
        $receipt.flutter = $version
        $receipt.pubLockSha256 = (Get-FileHash $lock).Hash
        $receipt.pinnedInputs = $pinnedInputs
        $receipt.toolEnvironmentSha256 = $ToolEnvironmentSha256
        $receipt.freeBytesBeforeBuild = $free
        $receipt.builtUtc = [DateTime]::UtcNow.ToString('o')
        $receipt.installation = 'not performed'
        $null = New-Item -ItemType Directory -Force -Path $output
        [IO.File]::Copy($built,$apkOut,$false)
        if ((Get-FileHash $apkOut).Hash -ne $receipt.apkSha256) { throw 'Copied artifact hash mismatch' }
        $json = $receipt | ConvertTo-Json -Depth 6
        $stream = [IO.File]::Open($reportOut,[IO.FileMode]::CreateNew)
        try { $data=[Text.Encoding]::UTF8.GetBytes($json); $stream.Write($data,0,$data.Length) } finally { $stream.Dispose() }
        Write-Output "Verified release APK: $apkOut"
        Write-Output "Verification receipt: $reportOut"
    }
} finally { Pop-Location }
