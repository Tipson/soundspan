$ErrorActionPreference = 'Stop'
$module = Import-Module (Join-Path $PSScriptRoot 'release-tools.psm1') -Force -PassThru
. (Join-Path $PSScriptRoot 'release-media.fixtures.ps1')
$fixtureRoot = 'D:\CodexData\temp\soundspan-media-acceptance-20261020'
$fixture = Join-Path $fixtureRoot ('media-resource-tests-' + [guid]::NewGuid().ToString('N'))
$null = Assert-SafeDPath $fixture $fixtureRoot
$null = New-Item -ItemType Directory -Path $fixture
$script:passed = 0
# Native tools are external inspection boundaries. The validator still inspects
# real ZIP entries and lengths, never source files or source resource names.
& $module {
    $script:fixtureMediaResources = ''
    function script:Invoke-CheckedNative([string]$Executable, [string[]]$Arguments) {
        if ($Arguments[0] -eq 'verify') { return "Signer #1 certificate DN: CN=Fixture`nSigner #1 certificate SHA-256 digest: $('A' * 64)" }
        if ($Arguments[1] -eq 'badging') { return "package: name='ru.agentik007.soundspan' versionCode='7' versionName='0.1.5'`nsdkVersion:'24'`ntargetSdkVersion:'36'`nnative-code: 'armeabi-v7a' 'arm64-v8a' 'x86_64'" }
        if ($Arguments[1] -eq '--values' -and $Arguments[2] -eq 'resources') { return $script:fixtureMediaResources }
        if ($Arguments[1] -ne 'xmltree') { throw 'Unexpected native inspection request' }
        return 'E: manifest (line=1)'
    }
}
function Check-MediaPackage([string]$Name, [string]$Resources, [object[]]$MediaEntries, [bool]$Accept = $false) {
    $path = Join-Path $fixture ($Name + '.apk')
    $zip = [IO.Compression.ZipFile]::Open($path,[IO.Compression.ZipArchiveMode]::Create)
    try {
        $null = $zip.CreateEntry('AndroidManifest.xml')
        foreach ($abi in @('armeabi-v7a','arm64-v8a','x86_64')) {
            foreach ($library in @('libflutter.so','libapp.so')) {
                $stream = $zip.CreateEntry("lib/$abi/$library").Open()
                try { $stream.WriteByte(1) } finally { $stream.Dispose() }
            }
        }
        foreach ($entry in $MediaEntries) {
            $stream = $zip.CreateEntry($entry.path).Open()
            try { if ($entry.nonempty) { $stream.WriteByte(1) } } finally { $stream.Dispose() }
        }
    } finally { $zip.Dispose() }
    & $module { param($value) $script:fixtureMediaResources = $value } $Resources
    $rejected = $false
    $receipt = $null
    try { $receipt = Test-ReleaseApk $path $fixture ('A' * 64) } catch {
        if ($_.Exception.Message -notmatch '^APK media ') { throw }
        $rejected = $true
    }
    if ($Accept) {
        if ($rejected) { throw "Valid media package rejected: $Name" }
        if (($receipt.mediaDrawables.name -join ',') -cne 'audio_service_pause,audio_service_play_arrow,audio_service_skip_previous,audio_service_skip_next,audio_service_stop,ic_stat_soundspan') { throw 'Receipt must record all six verified media drawables' }
        if ($receipt.mediaDrawables[0].id -cne '0x7f070001' -or $receipt.mediaDrawables[5].files[0] -cne 'res/media5.xml') { throw 'Receipt must record compiled resource IDs and ZIP file paths' }
    } elseif (-not $rejected) { throw "Expected rejection: $Name" }
    $script:passed++
    Write-Output "PASS $Name"
}
$valid = New-MediaResourceFixture
try {
    Check-MediaPackage 'reject-compiled-apk-without-media-resources' 'Package 0 id=0x7f name=ru.agentik007.soundspan' @()
    Check-MediaPackage 'accept-complete-compiled-media-contract' $valid.resources $valid.entries $true
    Check-MediaPackage 'reject-empty-compiled-resource-inventory' '' $valid.entries
    Check-MediaPackage 'reject-zip-files-without-compiled-resource-names' 'Package 0 id=0x7f name=ru.agentik007.soundspan' $valid.entries
    Check-MediaPackage 'reject-foreign-package-resource-names' ($valid.resources.Replace('ru.agentik007.soundspan','foreign.app')) $valid.entries
    Check-MediaPackage 'reject-specification-without-compiled-values' (($valid.resources -split "`n" | Where-Object { $_ -notmatch '^\s+resource |\(string8\)' }) -join "`n") $valid.entries
    for ($index = 0; $index -lt $valid.names.Count; $index++) {
        $name = $valid.names[$index]
        $id = '0x7f07000' + ($index + 1)
        Check-MediaPackage "reject-missing-$name" ($valid.resources.Replace("drawable/${name}:", "drawable/not_${name}:")) $valid.entries
        Check-MediaPackage "reject-wrong-type-$name" ($valid.resources.Replace("drawable/${name}:", "mipmap/${name}:")) $valid.entries
        Check-MediaPackage "reject-zero-resource-id-$name" ($valid.resources.Replace($id, '0x00000000')) $valid.entries
        Check-MediaPackage "reject-missing-zip-file-$name" $valid.resources @($valid.entries | Where-Object path -CNE "res/media$index.xml")
        Check-MediaPackage "reject-empty-zip-file-$name" $valid.resources (@($valid.entries | Where-Object path -CNE "res/media$index.xml") + @{path="res/media$index.xml";nonempty=$false})
    }
    Check-MediaPackage 'reject-null-typed-resource-value' ($valid.resources.Replace('t=0x03 d=0x00000000','t=0x00 d=0x00000000')) $valid.entries
    Check-MediaPackage 'reject-drawable-alias-to-zero' ($valid.resources.Replace('t=0x03 d=0x00000000','t=0x01 d=0x00000000')) $valid.entries
    Check-MediaPackage 'reject-missing-compiled-file-value' ($valid.resources.Replace('(string8) "res/media0.xml"','')) $valid.entries
    Check-MediaPackage 'reject-duplicate-media-zip-entry' $valid.resources ($valid.entries + $valid.entries[0])
    Check-MediaPackage 'reject-conflicting-resource-ids' ($valid.resources + "`n        resource 0x7f070007 ru.agentik007.soundspan:drawable/audio_service_pause: t=0x03 d=0x00000000 (s=0x0008 r=0x00)`n          (string8) `"res/media0.xml`"") $valid.entries
    Check-MediaPackage 'accept-additional-qualified-resource-file' ($valid.resources + "`n      config v24:`n        resource 0x7f070001 ru.agentik007.soundspan:drawable/audio_service_pause: t=0x03 d=0x00000006 (s=0x0008 r=0x00)`n          (string8) `"res/media-pause-v24.xml`"") ($valid.entries + @{path='res/media-pause-v24.xml';nonempty=$true}) $true
    Check-MediaPackage 'reject-empty-qualified-resource-file' ($valid.resources + "`n      config v24:`n        resource 0x7f070001 ru.agentik007.soundspan:drawable/audio_service_pause: t=0x03 d=0x00000006 (s=0x0008 r=0x00)`n          (string8) `"res/media-pause-v24.xml`"") ($valid.entries + @{path='res/media-pause-v24.xml';nonempty=$false})
    Write-Output "PASS media total=$script:passed"
} finally {
    $safeFixture = Assert-SafeDPath $fixture $fixtureRoot
    Remove-Item -LiteralPath $safeFixture -Recurse -Force
    Remove-Module $module
}
