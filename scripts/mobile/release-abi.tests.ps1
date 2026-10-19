$ErrorActionPreference = 'Stop'
$module = Import-Module (Join-Path $PSScriptRoot 'release-tools.psm1') -Force -PassThru
$fixture = 'D:\CodexData\temp\t25-abi-tests-' + [guid]::NewGuid().ToString('N')
$null = Assert-SafeDPath $fixture 'D:\CodexData\temp'
$null = New-Item -ItemType Directory -Path $fixture
$script:passed = 0
# Only the external native inspection boundary is stubbed. Test-ReleaseApk reads
# real ZIP entries/lengths. The bytes are fixtures, not executable native code.
& $module {
    $script:fixtureBadging = ''
    function script:Invoke-CheckedNative([string]$Executable, [string[]]$Arguments) {
        if ($Arguments[0] -eq 'verify') { return "Signer #1 certificate DN: CN=Fixture`nSigner #1 certificate SHA-256 digest: $('A' * 64)" }
        if ($Arguments[1] -eq 'badging') { return "package: name='ru.agentik007.soundspan' versionCode='5' versionName='0.1.3'`nsdkVersion:'24'`ntargetSdkVersion:'36'`nuses-permission: name='android.permission.INTERNET'`n$script:fixtureBadging" }
        return 'E: manifest (line=1)'
    }
}
function Check-Package([string]$Name, [object[]]$Entries, [string]$NativeCode, [bool]$Accept = $false) {
    $path = Join-Path $fixture ($Name + '.apk')
    $zip = [IO.Compression.ZipFile]::Open($path,[IO.Compression.ZipArchiveMode]::Create)
    try {
        $null = $zip.CreateEntry('AndroidManifest.xml')
        foreach ($entry in $Entries) {
            $stream = $zip.CreateEntry($entry.path).Open()
            try { if ($entry.nonempty) { $stream.WriteByte(1) } } finally { $stream.Dispose() }
        }
    } finally { $zip.Dispose() }
    & $module { param($value) $script:fixtureBadging = $value } $NativeCode
    $rejected = $false
    $receipt = $null
    try { $receipt = Test-ReleaseApk $path $fixture ('A' * 64) } catch {
        if ($_.Exception.Message -notmatch '^APK native ') { throw }
        $rejected = $true
    }
    if ($Accept) {
        if ($rejected) { throw "Valid package rejected: $Name" }
        if (($receipt.nativeAbis -join ',') -cne 'armeabi-v7a,arm64-v8a,x86_64') { throw 'Receipt must record all verified ABIs' }
        if ($receipt.versionName -cne '0.1.3' -or $receipt.versionCode -ne 5) { throw 'Receipt must record the inspected release version' }
    } elseif (-not $rejected) { throw "Expected rejection: $Name" }
    $script:passed++
    Write-Output "PASS $Name"
}
$valid = @(
    @{path='lib/armeabi-v7a/libflutter.so';nonempty=$true},
    @{path='lib/armeabi-v7a/libapp.so';nonempty=$true},
    @{path='lib/arm64-v8a/libflutter.so';nonempty=$true},
    @{path='lib/arm64-v8a/libapp.so';nonempty=$true},
    @{path='lib/x86_64/libflutter.so';nonempty=$true},
    @{path='lib/x86_64/libapp.so';nonempty=$true}
)
$allAbis = "native-code: 'armeabi-v7a' 'arm64-v8a' 'x86_64'"
try {
    Check-Package 'reject-x64-only' @($valid | Where-Object path -Like 'lib/x86_64/*') "native-code: 'x86_64'"
    Check-Package 'reject-no-flutter-libraries' @() $allAbis
    Check-Package 'accept-complete-pinned-default-abis' $valid $allAbis $true
    Check-Package 'accept-reordered-badging-and-plugin-library' ($valid + @{path='lib/arm64-v8a/libplugin.so';nonempty=$true}) "native-code: 'x86_64' 'arm64-v8a' 'armeabi-v7a'" $true
    Check-Package 'reject-badging-claims-arm64-without-zip-arm64' @($valid | Where-Object path -NotLike 'lib/arm64-v8a/*') $allAbis
    Check-Package 'reject-complete-zip-with-incomplete-badging' $valid "native-code: 'armeabi-v7a' 'x86_64'"
    foreach ($required in $valid) {
        $name = ($required.path -replace '[/\.]','-')
        Check-Package "reject-missing-$name" @($valid | Where-Object path -CNE $required.path) $allAbis
        Check-Package "reject-empty-$name" (@($valid | Where-Object path -CNE $required.path) + @{path=$required.path;nonempty=$false}) $allAbis
    }
    Check-Package 'reject-wrong-library-name' (@($valid | Where-Object path -CNE 'lib/arm64-v8a/libapp.so') + @{path='lib/arm64-v8a/libapplication.so';nonempty=$true}) $allAbis
    Check-Package 'reject-duplicate-library-entry' ($valid + $valid[2]) $allAbis
    Check-Package 'reject-unexpected-zip-abi' ($valid + @{path='lib/x86/libplugin.so';nonempty=$true}) $allAbis
    Check-Package 'reject-unexpected-badging-abi' $valid ($allAbis + " 'x86'")
    Check-Package 'reject-duplicate-badging-abi' $valid ($allAbis + " 'arm64-v8a'")
    Check-Package 'reject-duplicate-native-code-lines' $valid ($allAbis + "`n" + $allAbis)
    Check-Package 'reject-missing-native-code-line' $valid ''
    Check-Package 'reject-malformed-native-code-line' $valid "native-code: 'armeabi-v7a' 'arm64-v8a' 'x86_64' trailing-junk"
    Write-Output "PASS ABI total=$script:passed"
} finally {
    $safeFixture = Assert-SafeDPath $fixture 'D:\CodexData\temp'
    Remove-Item -LiteralPath $safeFixture -Recurse -Force
    Remove-Module $module
}
