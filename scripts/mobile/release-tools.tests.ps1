$ErrorActionPreference = 'Stop'
$module = Join-Path $PSScriptRoot 'release-tools.psm1'
if (-not (Test-Path $module)) { throw 'RED: release tooling not implemented' }
Import-Module $module -Force
$script:passed = 0
function Check($Name, [scriptblock]$Action) { & $Action; $script:passed++; Write-Output "PASS $Name" }
function Reject([scriptblock]$Action) { $caught = $false; try { & $Action | Out-Null } catch { $caught = $true }; if (-not $caught) { throw 'Expected rejection' } }
$digest = 'A' * 64
$cert = "Signer #1 certificate DN: CN=Soundspan Local Release`nSigner #1 certificate SHA-256 digest: $digest"
$badging = "package: name='ru.agentik007.soundspan' versionCode='1' versionName='0.1.0'`nsdkVersion:'24'`ntargetSdkVersion:'36'`nuses-permission: name='android.permission.INTERNET'"
Check 'valid inspected APK metadata accepted' { Assert-ApkMetadata $cert $badging $digest @('AndroidManifest.xml','classes.dex') }
Check 'foreign certificate rejected' { Reject { Assert-ApkMetadata $cert $badging ('B'*64) @() } }
Check 'debug certificate rejected even when pinned' { Reject { Assert-ApkMetadata ($cert.Replace('Soundspan Local Release','Android Debug')) $badging $digest @() } }
Check 'malformed missing signer rejected' { Reject { Assert-ApkMetadata '' $badging $digest @() } }
Check 'multiple signers rejected' { Reject { Assert-ApkMetadata ($cert+"`nSigner #2 certificate SHA-256 digest: $digest") $badging $digest @() } }
foreach ($case in @("application-debuggable", "application-testOnly", "uses-permission: name='android.permission.MANAGE_EXTERNAL_STORAGE'")) {
    Check "unsafe APK attribute rejected: $case" { Reject { Assert-ApkMetadata $cert ($badging+"`n"+$case) $digest @() } }
}
foreach ($replacement in @(@('ru.agentik007.soundspan','wrong.app'),@("versionCode='1'","versionCode='2'"),@("versionName='0.1.0'","versionName='2'"),@("sdkVersion:'24'","sdkVersion:'23'"),@("targetSdkVersion:'36'","targetSdkVersion:'35'"))) {
    Check "identity mismatch rejected: $($replacement[0])" { Reject { Assert-ApkMetadata $cert ($badging.Replace($replacement[0],$replacement[1])) $digest @() } }
}
Check 'packaged key rejected' { Reject { Assert-ApkMetadata $cert $badging $digest @('assets/key.properties') } }
Check 'noncanonical true boolean in binary manifest rejected' { Reject { Assert-ReleaseManifest 'A: android:testOnly(0x01010272)=(type 0x12)0x1' } }
Check 'false boolean in binary manifest accepted' { Assert-ReleaseManifest 'A: android:debuggable(0x0101000f)=(type 0x12)0x0' }
Check 'missing private metadata rejected' { Reject { Read-SigningMetadata 'D:\CodexData\private\missing-t25\signing.json' } }
Check 'unsafe destination rejected' { Reject { Assert-SafeDPath 'C:\Temp\x.apk' 'D:\CodexData\outputs' } }
Check 'parent traversal rejected' { Reject { Assert-SafeDPath 'D:\CodexData\outputs\..\private\x' 'D:\CodexData\outputs' } }
Check 'existing output never overwritten' { Reject { Assert-NewOutput $PSCommandPath } }
Check 'nonzero native subprocess rejected' { Reject { Invoke-CheckedNative (Get-Process -Id $PID).Path @('-NoProfile','-Command','exit 7') } }
Check 'secret restored after exception' {
    $env:SOUNDSPAN_STORE_PASSWORD = 'prior-test-value'
    try {
        Reject { Invoke-WithEnvironment @{ SOUNDSPAN_STORE_PASSWORD = 'temporary-test-value' } { throw 'fixture failure' } }
        if ($env:SOUNDSPAN_STORE_PASSWORD -ne 'prior-test-value') { throw 'Secret restoration failed' }
    } finally { Remove-Item Env:SOUNDSPAN_STORE_PASSWORD }
}
Check 'secret removed after exception' {
    Reject { Invoke-WithEnvironment @{ SOUNDSPAN_STORE_PASSWORD = 'temporary-test-value' } { throw 'fixture failure' } }
    if (Test-Path Env:SOUNDSPAN_STORE_PASSWORD) { throw 'Secret cleanup failed' }
}
$fixture = 'D:\CodexData\private\t25-test-' + [guid]::NewGuid().ToString('N')
$null = New-Item -ItemType Directory -Path $fixture
Set-PrivateDirectoryAcl $fixture
try {
    $key = Join-Path $fixture 'fixture.p12'
    $secret = Join-Path $fixture 'fixture.dpapi'
    $metadataPath = Join-Path $fixture 'signing.json'
    [IO.File]::WriteAllBytes($key, @(1,2,3))
    [IO.File]::WriteAllBytes($secret, [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('test-fixture-only'), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
    $metadata = @{ schema=1; applicationId='ru.agentik007.soundspan'; alias='soundspan-local-release'; keystore=$key; passwordFile=$secret; certificateSha256=$digest; keystoreSha256=(Get-FileHash $key).Hash }
    $metadata | ConvertTo-Json | Set-Content $metadataPath
    Check 'complete private metadata accepted' { $actual=Read-SigningMetadata $metadataPath; if ($actual.alias -ne 'soundspan-local-release') { throw 'Incorrect metadata' } }
    Check 'DPAPI signing environment cleared after action failure' {
        Reject { Invoke-WithSigning $metadataPath { if ($env:SOUNDSPAN_STORE_PASSWORD -ne 'test-fixture-only') { throw 'Decryption failed' }; throw 'Build fixture failure' } }
        foreach ($name in @('SOUNDSPAN_STORE_PASSWORD','SOUNDSPAN_KEY_ALIAS','SOUNDSPAN_KEYSTORE')) { if (Test-Path "Env:$name") { throw 'Signing environment leaked' } }
    }
    Check 'existing private directory not rotated' { Reject { & (Join-Path $PSScriptRoot 'initialize-signing.ps1') -PrivateDirectory $fixture -BackupDirectory 'D:\CodexData\archives\t25-never-created' -Keytool 'missing' } }
    $metadata.applicationId = 'foreign.app'
    $metadata | ConvertTo-Json | Set-Content $metadataPath
    Check 'foreign private metadata rejected' { Reject { Read-SigningMetadata $metadataPath } }
    $metadata.applicationId = 'ru.agentik007.soundspan'
    $metadata | ConvertTo-Json | Set-Content $metadataPath
    Remove-Item -LiteralPath $secret
    Check 'missing protected password rejected' { Reject { Read-SigningMetadata $metadataPath } }
    [IO.File]::WriteAllBytes($secret, @(1,2,3))
    Check 'corrupt DPAPI rejected without environment pollution' { Reject { Invoke-WithSigning $metadataPath { throw 'Must not reach action' } }; if (Test-Path Env:SOUNDSPAN_STORE_PASSWORD) { throw 'Password leaked' } }
    Remove-Item -LiteralPath $key
    Check 'missing private key rejected' { Reject { Read-SigningMetadata $metadataPath } }
} finally {
    $safeFixture = Assert-SafeDPath $fixture 'D:\CodexData\private'
    Remove-Item -LiteralPath $safeFixture -Recurse -Force
}
Write-Output "PASS total=$script:passed"
