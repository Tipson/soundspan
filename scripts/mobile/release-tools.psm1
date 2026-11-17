Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-SafeDPath([string]$Path, [string]$Root = 'D:\CodexData') {
    $full = [IO.Path]::GetFullPath($Path)
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if (-not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase) -or -not $full.StartsWith('D:\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path is outside the permitted D directory' }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Mutable path contains a reparse point' }
        }
        $cursor = Split-Path -Parent $cursor
    }
    return $full
}

function Assert-NewOutput([string]$Path) {
    if (Test-Path -LiteralPath $Path) { throw 'Refusing to overwrite an existing output' }
}

function Invoke-CheckedNative([string]$Executable, [string[]]$Arguments) {
    $output = @(& $Executable @Arguments 2>&1)
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw "Native tool failed: $([IO.Path]::GetFileName($Executable)); exit=$code" }
    return ($output -join "`n")
}

function Invoke-StreamingNative([string]$Executable, [string[]]$Arguments) {
    # Verification logs must retain both streams even when a tool fails. Other
    # callers keep Invoke-CheckedNative's captured-text contract unchanged.
    $previousPreference = $ErrorActionPreference
    $global:LASTEXITCODE = $null
    try {
        $ErrorActionPreference = 'Continue'
        & $Executable @Arguments 2>&1 | ForEach-Object { Write-Output $_ }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($null -eq $code) {
        $global:LASTEXITCODE = 1
        throw "Native tool did not start: $([IO.Path]::GetFileName($Executable))"
    }
    if ($code -ne 0) { throw "Native tool failed: $([IO.Path]::GetFileName($Executable)); exit=$code" }
}

function Invoke-WithEnvironment([hashtable]$Values, [scriptblock]$Action) {
    $previous = @{}
    try {
        foreach ($name in $Values.Keys) {
            $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $Values[$name], 'Process')
        }
        & $Action
    } finally {
        foreach ($name in $previous.Keys) {
            if ($null -eq $previous[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
            else { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
        }
    }
}

function Set-PrivateDirectoryAcl([string]$Path) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($owner)
    foreach ($sid in @($owner.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-PrivateAcl([string]$Path) {
    $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
    $acl = Get-Acl -LiteralPath $Path
    foreach ($rule in $acl.Access) {
        $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($rule.AccessControlType -eq 'Allow' -and $sid -notin $allowed) { throw 'Private signing ACL grants access to another principal' }
    }
}

function Read-SigningMetadata([string]$MetadataPath) {
    $path = Assert-SafeDPath $MetadataPath 'D:\CodexData\private'
    $metadata = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
    if ($metadata.schema -ne 1 -or $metadata.applicationId -ne 'ru.agentik007.soundspan' -or $metadata.alias -ne 'soundspan-local-release' -or $metadata.certificateSha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw 'Invalid or foreign signing metadata' }
    foreach ($file in @($path,$metadata.keystore,$metadata.passwordFile)) {
        $null = Assert-SafeDPath $file (Split-Path -Parent $path)
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Missing signing material' }
        Assert-PrivateAcl $file
    }
    if ((Get-FileHash -LiteralPath $metadata.keystore).Hash -ne $metadata.keystoreSha256) { throw 'Keystore hash mismatch' }
    return $metadata
}

function Invoke-WithSigning([string]$MetadataPath, [scriptblock]$Action) {
    $metadata = Read-SigningMetadata $MetadataPath
    $clearBytes = $null
    try {
        $cipher = [IO.File]::ReadAllBytes($metadata.passwordFile)
        $clearBytes = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        Invoke-WithEnvironment @{
            SOUNDSPAN_KEYSTORE = $metadata.keystore
            SOUNDSPAN_KEY_ALIAS = $metadata.alias
            SOUNDSPAN_STORE_PASSWORD = [Text.Encoding]::UTF8.GetString($clearBytes)
        } $Action
    } finally {
        if ($null -ne $clearBytes) { [Array]::Clear($clearBytes, 0, $clearBytes.Length) }
    }
}

function ConvertTo-ReleaseVersion([string]$Version) {
    $match = [regex]::Match($Version, '\A(?<name>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\+(?<code>[1-9][0-9]*)\z')
    $code = 0
    if (-not $match.Success -or -not [int]::TryParse($match.Groups['code'].Value, [ref]$code) -or $code -gt 2100000000) { throw 'Invalid release version: expected major.minor.patch+positive Android versionCode' }
    return [pscustomobject]@{ versionName=$match.Groups['name'].Value; versionCode=$code }
}

function Read-PubspecVersion([string]$Pubspec) {
    $lines = [regex]::Matches($Pubspec, '(?m)^version:[ \t]*([^\r\n]*)\r?$')
    if ($lines.Count -ne 1) { throw 'Pubspec must contain exactly one top-level release version' }
    return ConvertTo-ReleaseVersion $lines[0].Groups[1].Value.Trim()
}

function Assert-ApkMetadata([string]$Certificates, [string]$Badging, [string]$ExpectedCertificate, [string[]]$Entries, [string]$ExpectedVersionName = '0.1.10', [string]$ExpectedVersionCode = '13') {
    $expectedVersion = ConvertTo-ReleaseVersion "$ExpectedVersionName+$ExpectedVersionCode"
    if ($ExpectedCertificate -notmatch '^[A-Fa-f0-9]{64}$') { throw 'Invalid pinned certificate digest' }
    $digests = [regex]::Matches($Certificates, '(?m)^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})\s*$')
    if ($digests.Count -ne 1 -or $digests[0].Groups[1].Value -ne $ExpectedCertificate -or $Certificates -match '(?i)Android Debug') { throw 'APK signer does not match the private release identity' }
    if ($Badging -notmatch "(?m)^package: name='ru\.agentik007\.soundspan' versionCode='$($expectedVersion.versionCode)' versionName='$([regex]::Escape($expectedVersion.versionName))'" -or $Badging -notmatch "(?m)^sdkVersion:'24'" -or $Badging -notmatch "(?m)^targetSdkVersion:'36'") { throw 'APK identity/version/SDK mismatch' }
    if ($Badging -match '(?i)application-debuggable|application-testOnly|testOnly') { throw 'Debuggable or test-only APK rejected' }
    $allowed = @('android.permission.INTERNET','android.permission.WAKE_LOCK','android.permission.FOREGROUND_SERVICE','android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK','android.permission.FOREGROUND_SERVICE_DATA_SYNC','android.permission.POST_NOTIFICATIONS','android.permission.ACCESS_NETWORK_STATE','android.permission.RECEIVE_BOOT_COMPLETED','ru.agentik007.soundspan.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION')
    foreach ($permission in [regex]::Matches($Badging, "(?m)^uses-permission[^:]*: name='([^']+)'")) {
        if ($permission.Groups[1].Value -notin $allowed) { throw "Unexpected APK permission: $($permission.Groups[1].Value)" }
    }
    foreach ($entry in $Entries) {
        if ($entry -match '(?i)(\.(p12|pfx|jks|keystore|dpapi|pem|key)$|(^|/)(key\.properties|signing\.json|\.env)(/|$))') { throw 'Private material packaged in APK' }
    }
}

function Assert-ReleaseManifest([string]$Manifest) {
    foreach ($line in ($Manifest -split "`n")) {
        if ($line -match 'android:(debuggable|testOnly)\(') {
            if ($line -notmatch '=\(type 0x12\)0x0\s*$') { throw 'Debuggable or test-only binary manifest rejected' }
        }
    }
}

function Assert-ApkNativeLibraries([string]$Badging, [IO.Compression.ZipArchiveEntry[]]$Entries) {
    # Flutter 3.47.7 build apk --release defaults to android-arm/android-arm64/android-x64.
    # This validates that fixed packaging contract, not ELF execution compatibility.
    $expected = @('armeabi-v7a','arm64-v8a','x86_64')
    $lines = [regex]::Matches($Badging, '(?m)^native-code:([^\r\n]*)\r?$')
    if ($lines.Count -ne 1 -or $lines[0].Groups[1].Value -notmatch "^(?:\s+'[^']+')+\s*$") { throw 'APK native badging is missing, duplicated or malformed' }
    $declared = @([regex]::Matches($lines[0].Groups[1].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    $seenAbis = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($abi in $declared) {
        if ($expected -cnotcontains $abi -or -not $seenAbis.Add($abi)) { throw 'APK native badging contains an unexpected or duplicate ABI' }
    }
    if ($seenAbis.Count -ne $expected.Count) { throw 'APK native badging does not contain the pinned ABI set' }

    $nativeFiles = [Collections.Generic.Dictionary[string,IO.Compression.ZipArchiveEntry]]::new([StringComparer]::Ordinal)
    $zipAbis = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in $Entries) {
        if ($entry.FullName.StartsWith('lib/',[StringComparison]::Ordinal) -and $entry.FullName.EndsWith('.so',[StringComparison]::Ordinal)) {
            $match = [regex]::Match($entry.FullName, '^lib/([^/]+)/[^/]+\.so$')
            if (-not $match.Success -or $expected -cnotcontains $match.Groups[1].Value) { throw 'APK native ZIP contains an unexpected ABI or library path' }
            if (-not $nativeFiles.TryAdd($entry.FullName,$entry)) { throw 'APK native ZIP contains a duplicate library entry' }
            $null = $zipAbis.Add($match.Groups[1].Value)
        }
    }
    if (-not $zipAbis.SetEquals($seenAbis)) { throw 'APK native badging and ZIP ABI inventories disagree' }
    foreach ($abi in $expected) {
        foreach ($library in @('libflutter.so','libapp.so')) {
            $path = "lib/$abi/$library"
            if (-not $nativeFiles.ContainsKey($path) -or $nativeFiles[$path].Length -le 0) { throw "APK native required library is missing or empty: $path" }
        }
    }
    return $expected
}

function Assert-ApkMediaResources([string]$Resources, [IO.Compression.ZipArchiveEntry[]]$Entries) {
    # audio_service resolves these drawables with getIdentifier at runtime, so
    # source XML and spec-only table entries cannot prove release availability.
    $required = @('audio_service_pause','audio_service_play_arrow','audio_service_skip_previous','audio_service_skip_next','audio_service_stop','ic_stat_soundspan')
    $records = @{}
    foreach ($name in $required) { $records[$name] = [Collections.Generic.List[object]]::new() }
    $current = $null
    foreach ($line in ($Resources -split "`n")) {
        $resource = [regex]::Match($line, '^\s*resource\s+(0x[0-9a-fA-F]{8})\s+([^:\s]+):([^/\s]+)/([^:\s]+):\s*(.*)$')
        if ($resource.Success) {
            $current = $null
            $name = $resource.Groups[4].Value
            if ($resource.Groups[2].Value -ceq 'ru.agentik007.soundspan' -and $resource.Groups[3].Value -ceq 'drawable' -and $required -ccontains $name) {
                $value = [regex]::Match($resource.Groups[5].Value, '^t=(0x[0-9a-fA-F]{2})\s+d=0x[0-9a-fA-F]{8}\b')
                if ($resource.Groups[1].Value -eq '0x00000000' -or -not $value.Success -or $value.Groups[1].Value -ne '0x03') { throw "APK media drawable has a zero ID or invalid compiled value: $name" }
                $current = [pscustomobject]@{ id=$resource.Groups[1].Value.ToLowerInvariant(); files=[Collections.Generic.List[string]]::new() }
                $records[$name].Add($current)
            }
        } elseif ($line -match '^\s*(spec resource|config|type|Package|INVALID)\b') { $current = $null }
        if ($null -ne $current) {
            $file = [regex]::Match($line, '\(string(?:8|16)\)\s+"([^"\r\n]+)"\s*$')
            if ($file.Success) { $current.files.Add($file.Groups[1].Value) }
        }
    }
    $verified = [Collections.Generic.List[object]]::new()
    foreach ($name in $required) {
        if ($records[$name].Count -eq 0) { throw "APK media drawable is missing from the compiled resource table: $name" }
        $ids = @($records[$name].id | Sort-Object -Unique)
        if ($ids.Count -ne 1) { throw "APK media drawable has conflicting compiled IDs: $name" }
        $paths = [Collections.Generic.List[string]]::new()
        foreach ($record in $records[$name]) {
            if ($record.files.Count -ne 1) { throw "APK media drawable has no unique compiled file value: $name" }
            $path = $record.files[0]
            if (-not $path.StartsWith('res/', [StringComparison]::Ordinal) -or $path -match '(^|/)\.{1,2}(/|$)|\\') { throw "APK media drawable has an invalid compiled ZIP path: $name" }
            $files = @($Entries | Where-Object { $_.FullName -ceq $path })
            if ($files.Count -ne 1 -or $files[0].Length -le 0) { throw "APK media drawable ZIP file is missing, empty or duplicated: $name" }
            if (-not $paths.Contains($path)) { $paths.Add($path) }
        }
        $verified.Add([pscustomobject]@{ name=$name; id=$ids[0]; files=$paths.ToArray() })
    }
    return $verified.ToArray()
}

function Test-ReleaseApk([string]$Apk, [string]$BuildTools, [string]$ExpectedCertificate, [string]$ExpectedVersionName = '0.1.10', [string]$ExpectedVersionCode = '13') {
    $expectedVersion = ConvertTo-ReleaseVersion "$ExpectedVersionName+$ExpectedVersionCode"
    $cert = Invoke-CheckedNative (Join-Path $BuildTools 'apksigner.bat') @('verify','--verbose','--print-certs',$Apk)
    $badging = Invoke-CheckedNative (Join-Path $BuildTools 'aapt.exe') @('dump','badging',$Apk)
    $tree = Invoke-CheckedNative (Join-Path $BuildTools 'aapt.exe') @('dump','xmltree',$Apk,'AndroidManifest.xml')
    $resources = Invoke-CheckedNative (Join-Path $BuildTools 'aapt.exe') @('dump','--values','resources',$Apk)
    Assert-ReleaseManifest $tree
    $zip = [IO.Compression.ZipFile]::OpenRead($Apk)
    try {
        Assert-ApkMetadata $cert $badging $ExpectedCertificate @($zip.Entries.FullName) $expectedVersion.versionName $expectedVersion.versionCode
        $nativeAbis = @(Assert-ApkNativeLibraries $badging @($zip.Entries))
        $mediaDrawables = @(Assert-ApkMediaResources $resources @($zip.Entries))
    } finally { $zip.Dispose() }
    return [ordered]@{ apkSha256=(Get-FileHash -LiteralPath $Apk).Hash; certificateSha256=$ExpectedCertificate; applicationId='ru.agentik007.soundspan'; versionName=$expectedVersion.versionName; versionCode=$expectedVersion.versionCode; minSdk=24; targetSdk=36; nativeAbis=$nativeAbis; mediaDrawables=$mediaDrawables; apksigner=$cert; badging=$badging; manifest=$tree }
}

Export-ModuleMember -Function *
