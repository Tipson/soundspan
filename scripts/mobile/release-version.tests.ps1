$ErrorActionPreference = 'Stop'
$module = Import-Module (Join-Path $PSScriptRoot 'release-tools.psm1') -Force -PassThru
. (Join-Path $PSScriptRoot 'release-media.fixtures.ps1')
$script:passed = 0
function Check([string]$Name, [scriptblock]$Action) { & $Action; $script:passed++; Write-Output "PASS $Name" }
function Reject([scriptblock]$Action) { $caught = $false; try { & $Action | Out-Null } catch { $caught = $true }; if (-not $caught) { throw 'Expected rejection' } }
$digest = 'A' * 64
$cert = "Signer #1 certificate DN: CN=Soundspan Local Release`nSigner #1 certificate SHA-256 digest: $digest"
$badging14 = "package: name='ru.agentik007.soundspan' versionCode='14' versionName='0.1.11'`nsdkVersion:'24'`ntargetSdkVersion:'36'`nuses-permission: name='android.permission.INTERNET'`nnative-code: 'armeabi-v7a' 'arm64-v8a' 'x86_64'"
$badging13 = $badging14.Replace("versionCode='14' versionName='0.1.11'", "versionCode='13' versionName='0.1.10'")

# This first case exercises the real validator and fails before implementation.
Check 'release14 accepted only with explicit expected version14' { Assert-ApkMetadata $cert $badging14 $digest @('AndroidManifest.xml') '0.1.11' 14 }
Check 'legacy defaults still accept release13' { Assert-ApkMetadata $cert $badging13 $digest @('AndroidManifest.xml') }
Check 'legacy defaults reject release14' { Reject { Assert-ApkMetadata $cert $badging14 $digest @() } }
Check 'expected14 rejects release13' { Reject { Assert-ApkMetadata $cert $badging13 $digest @() '0.1.11' 14 } }
foreach ($replacement in @(@('ru.agentik007.soundspan','foreign.app'),@("versionCode='14'","versionCode='15'"),@("versionName='0.1.11'","versionName='0.1.110'"),@("sdkVersion:'24'","sdkVersion:'23'"),@("targetSdkVersion:'36'","targetSdkVersion:'35'"))) {
    Check "release14 rejects mismatch $($replacement[0])" { Reject { Assert-ApkMetadata $cert ($badging14.Replace($replacement[0],$replacement[1])) $digest @() '0.1.11' 14 } }
}
Check 'release14 rejects foreign signer' { Reject { Assert-ApkMetadata $cert $badging14 ('B' * 64) @() '0.1.11' 14 } }
Check 'release14 rejects pinned debug signer' { Reject { Assert-ApkMetadata ($cert.Replace('Soundspan Local Release','Android Debug')) $badging14 $digest @() '0.1.11' 14 } }
foreach ($attribute in @('application-debuggable','application-testOnly',"uses-permission: name='android.permission.MANAGE_EXTERNAL_STORAGE'")) {
    Check "release14 rejects unsafe attribute $attribute" { Reject { Assert-ApkMetadata $cert ($badging14+"`n"+$attribute) $digest @() '0.1.11' 14 } }
}
foreach ($entry in @('assets/signing.json','assets/key.properties','assets/.env','assets/release.p12','assets/private.key')) {
    Check "release14 rejects private entry $entry" { Reject { Assert-ApkMetadata $cert $badging14 $digest @($entry) '0.1.11' 14 } }
}
foreach ($version in @('0.1.11+0','0.1.11+-1','0.1.11+1.5','0.1.11+2100000001','0.1.11+9999999999999999999999999','0.1.11','0.1.11+014','0.1.11+14junk','0x1x11+14')) {
    Check "invalid pubspec version rejected $version" { Reject { Read-PubspecVersion "name: fixture`nversion: $version`n" } }
}
foreach ($text in @('', "name: fixture`n", "version: 0.1.11+14`nversion: 0.1.10+13`n", 'version: "0.1.11+14"')) {
    Check 'missing duplicate or unsupported pubspec version rejected' { Reject { Read-PubspecVersion $text } }
}
Check 'canonical pubspec yields exact release14 metadata' {
    $version = Read-PubspecVersion "name: fixture`r`nversion: 0.1.11+14`r`n"
    if ($version.versionName -cne '0.1.11' -or $version.versionCode -ne 14) { throw 'Incorrect source version' }
}
Check 'maximum Android distribution version code accepted' {
    if ((Read-PubspecVersion 'version: 1.2.3+2100000000').versionCode -ne 2100000000) { throw 'Incorrect Android version-code bound' }
}
foreach ($expected in @(@('0.1.11',0),@('0.1.11',2100000001),@('0x1x11',14),@('0.1.11','14.5'))) {
    Check 'malformed explicit expected version rejected' { Reject { Assert-ApkMetadata $cert $badging14 $digest @() $expected[0] $expected[1] } }
}

$fixture = 'D:\CodexData\temp\soundspan-release-version-' + [guid]::NewGuid().ToString('N')
$null = Assert-SafeDPath $fixture 'D:\CodexData\temp'
$null = New-Item -ItemType Directory -Path $fixture
$media = New-MediaResourceFixture
& $module {
    param($Cert, $Badging, $Resources)
    $script:versionCert = $Cert; $script:versionBadging = $Badging; $script:versionResources = $Resources
    function script:Invoke-CheckedNative([string]$Executable, [string[]]$Arguments) {
        if ($Arguments[0] -eq 'verify') { return $script:versionCert }
        if ($Arguments[1] -eq 'badging') { return $script:versionBadging }
        if ($Arguments[1] -eq '--values') { return $script:versionResources }
        return 'E: manifest (line=1)'
    }
} $cert $badging14 $media.resources
try {
    $apk = Join-Path $fixture 'fixture-only.apk'
    $zip = [IO.Compression.ZipFile]::Open($apk,[IO.Compression.ZipArchiveMode]::Create)
    try {
        $null = $zip.CreateEntry('AndroidManifest.xml')
        foreach ($abi in @('armeabi-v7a','arm64-v8a','x86_64')) {
            foreach ($library in @('libflutter.so','libapp.so')) {
                $stream = $zip.CreateEntry("lib/$abi/$library").Open()
                try { $stream.WriteByte(1) } finally { $stream.Dispose() }
            }
        }
        foreach ($entry in $media.entries) {
            $stream = $zip.CreateEntry($entry.path).Open()
            try { $stream.WriteByte(1) } finally { $stream.Dispose() }
        }
    } finally { $zip.Dispose() }
    Check 'real ZIP inspection returns validated release14 in receipt' {
        $receipt = Test-ReleaseApk $apk $fixture $digest '0.1.11' 14
        if ($receipt.versionName -cne '0.1.11' -or $receipt.versionCode -ne 14 -or $receipt.apkSha256 -ne (Get-FileHash -LiteralPath $apk).Hash) { throw 'Receipt does not describe the inspected APK' }
    }
    Check 'ZIP release14 rejected by legacy defaults' { Reject { Test-ReleaseApk $apk $fixture $digest } }
    & $module { param($Value) $script:versionBadging = $Value } $badging13
    Check 'ZIP release13 rejected when release14 expected' { Reject { Test-ReleaseApk $apk $fixture $digest '0.1.11' 14 } }
    Check 'ZIP release13 still accepted by legacy defaults' {
        $receipt = Test-ReleaseApk $apk $fixture $digest
        if ($receipt.versionName -cne '0.1.10' -or $receipt.versionCode -ne 13) { throw 'Legacy receipt changed' }
    }
    $cli = New-Module -ScriptBlock {
        function Import-Module { param($Name, [switch]$Force) }
        function Test-ReleaseApk { param($Apk, $BuildTools, $Certificate, $ExpectedVersionName = '0.1.10', $ExpectedVersionCode = 13); [ordered]@{versionName=$ExpectedVersionName;versionCode=$ExpectedVersionCode} }
        Export-ModuleMember -Function @()
    }
    try {
        $scriptPath = Join-Path $PSScriptRoot 'verify-apk.ps1'
        Check 'independent APK CLI forwards explicit expected release14' {
            $value = & $cli { param($Script, $Digest) & $Script -Apk 'fixture-only' -BuildTools 'fixture-only' -ExpectedCertificate $Digest -ExpectedVersionName '0.1.11' -ExpectedVersionCode 14 } $scriptPath $digest | ConvertFrom-Json
            if ($value.versionName -cne '0.1.11' -or $value.versionCode -ne 14) { throw 'CLI did not forward expected release14' }
        }
        Check 'independent APK CLI retains legacy defaults' {
            $value = & $cli { param($Script, $Digest) & $Script -Apk 'fixture-only' -BuildTools 'fixture-only' -ExpectedCertificate $Digest } $scriptPath $digest | ConvertFrom-Json
            if ($value.versionName -cne '0.1.10' -or $value.versionCode -ne 13) { throw 'CLI legacy defaults changed' }
        }
    } finally { Remove-Module $cli }
    Write-Output "PASS release version total=$script:passed"
} finally {
    $safeFixture = Assert-SafeDPath $fixture 'D:\CodexData\temp'
    Remove-Item -LiteralPath $safeFixture -Recurse -Force
    Remove-Module $module
}
