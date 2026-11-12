$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'build-release.ps1'
Import-Module (Join-Path $PSScriptRoot 'release-tools.psm1') -Force
$fixture = 'D:\CodexData\temp\mobile-release-configuration-' + [guid]::NewGuid().ToString('N')
$null = Assert-SafeDPath $fixture 'D:\CodexData\temp'
$null = New-Item -ItemType Directory -Path (Join-Path $fixture 'sdk/bin/cache')
$sdk = Join-Path $fixture 'sdk'
[IO.File]::Copy('D:\CodexData\runtime\flutter\bin\cache\flutter.version.json', (Join-Path $sdk 'bin/cache/flutter.version.json'))
$events = Join-Path $fixture 'events.txt'
# The only executable is this tiny fixture, never the real Flutter tool.
[IO.File]::WriteAllText((Join-Path $sdk 'bin/flutter.bat'), "@echo off`r`nif not `"%SOUNDSPAN_STORE_PASSWORD%`"==`"fixture-only`" exit /b 91`r`necho signed:%*>>`"%SOUNDSPAN_RELEASE_TEST_LOG%`"`r`nexit /b 0`r`n", [Text.Encoding]::ASCII)
$environment = Join-Path $fixture 'environment.ps1'
$baseEnvironment = 'D:\CodexData\outputs\soundspan\mobile-app-20261015\mobile-env.ps1'
[IO.File]::WriteAllText($environment, ". '$baseEnvironment'`n`$env:FLUTTER_ROOT = '$sdk'`n`$env:SOUNDSPAN_RELEASE_TEST_LOG = '$events'`nfunction Invoke-MobileGate { param([scriptblock]`$Action); & `$Action }`n")
$environmentHash = (Get-FileHash -LiteralPath $environment).Hash
$priorLocation = (Get-Location).ProviderPath
$originalEnvironment = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) { $originalEnvironment[$entry.Key] = $entry.Value }
$script:passed = 0

# Execute both real caller scripts. Replace only external tools, signing/APK
# boundaries and host admission; retain actual ordering and failure branches.
$sandbox = New-Module -ScriptBlock {
    function Import-Module { param($Name, [switch]$Force); if ((Split-Path $Name -Leaf) -ne 'release-tools.psm1') { throw 'Unexpected module import' } }
    function Get-PSDrive { param($Name); if ($Name -ne 'D') { throw 'Unexpected drive' }; [pscustomobject]@{ Free = if ($env:SOUNDSPAN_RELEASE_TEST_CASE -eq 'disk-low') { 21GB } else { 30GB } } }
    function Read-SigningMetadata { param($Path); [pscustomobject]@{ certificateSha256 = ('A' * 64) } }
    function Invoke-CheckedNative {
        param($Executable, $Arguments)
        if ($Executable -ne 'git') { throw 'Unexpected checked subprocess' }
        if ('rev-parse' -in $Arguments) { return ('1' * 40) }
        if ('status' -in $Arguments) { return '' }
        throw 'Unexpected Git operation'
    }
    function Get-FileHash {
        param([Parameter(Position=0)][string]$LiteralPath)
        if ($env:SOUNDSPAN_RELEASE_TEST_CASE -eq 'lock-drift' -and $env:SOUNDSPAN_RELEASE_TEST_CONFIGURED -eq 'yes' -and (Split-Path $LiteralPath -Leaf) -eq 'pubspec.lock') {
            return [pscustomobject]@{ Hash = ('B' * 64) }
        }
        Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath
    }
    function Record([string]$Event) { [IO.File]::AppendAllText($env:SOUNDSPAN_RELEASE_TEST_LOG, "$Event`n") }
    function Invoke-StreamingNative {
        param($Executable, [string[]]$Arguments)
        $env:SOUNDSPAN_RELEASE_TEST_CALLS = [string]([int]$env:SOUNDSPAN_RELEASE_TEST_CALLS + 1)
        if ('--config-only' -in $Arguments) {
            if ($env:SOUNDSPAN_STORE_PASSWORD -or $env:SOUNDSPAN_KEYSTORE -or $env:SOUNDSPAN_KEY_ALIAS) { throw 'Signing material reached unsigned configuration' }
            Record ('config:' + ($Arguments -join ' '))
            $env:SOUNDSPAN_RELEASE_TEST_CONFIGURED = 'yes'
            if ($env:SOUNDSPAN_RELEASE_TEST_CASE -eq 'config-failure') { $global:LASTEXITCODE = 29; throw 'Fixture configuration failure' }
        } else { Record ('verify:' + ($Arguments -join ' ')) }
        if ($env:SOUNDSPAN_RELEASE_TEST_CASE -like 'verify-failure-*' -and [int]$env:SOUNDSPAN_RELEASE_TEST_CALLS -eq [int]$env:SOUNDSPAN_RELEASE_TEST_CASE.Substring(15)) {
            $global:LASTEXITCODE = 23
            throw 'Fixture verification failure'
        }
        $global:LASTEXITCODE = 0
    }
    function Invoke-WithSigning {
        param($Metadata, [scriptblock]$Action)
        Record 'signing'
        Invoke-WithEnvironment @{ SOUNDSPAN_STORE_PASSWORD='fixture-only'; SOUNDSPAN_KEYSTORE='fixture-only'; SOUNDSPAN_KEY_ALIAS='fixture-only' } $Action
    }
    function Test-ReleaseApk { param($Apk, $Tools, $Certificate); Record 'verify-apk'; throw 'FIXTURE_APK_BOUNDARY' }
    Export-ModuleMember -Function @()
}

function Invoke-Case([string]$Case) {
    $result = & $sandbox {
        param($Case, $Helper, $Environment, $EnvironmentHash, $Events)
        $env:SOUNDSPAN_RELEASE_TEST_CASE = $Case
        $env:SOUNDSPAN_RELEASE_TEST_CONFIGURED = 'no'
        $env:SOUNDSPAN_RELEASE_TEST_CALLS = '0'
        [IO.File]::WriteAllText($Events, '')
        $caught = ''
        try {
            & $Helper -ToolEnvironment $Environment -ToolEnvironmentSha256 $EnvironmentHash -SigningMetadata 'fixture-only' -ExpectedSourceCommit ('1' * 40) -OutputDirectory 'D:\CodexData\outputs\soundspan\mobile-app-20261015\releases' | Out-Null
        } catch { $caught = $_.Exception.Message }
        [pscustomobject]@{ error=$caught; events=@([IO.File]::ReadAllLines($Events)) }
    } $Case $helper $environment $environmentHash $events
    if ((Get-Location).ProviderPath -ne $priorLocation) { throw 'Release helper leaked its working directory' }
    foreach ($name in @('SOUNDSPAN_STORE_PASSWORD','SOUNDSPAN_KEYSTORE','SOUNDSPAN_KEY_ALIAS')) {
        if ([Environment]::GetEnvironmentVariable($name, 'Process') -ne $originalEnvironment[$name]) { throw 'Signing boundary leaked its environment' }
    }
    return $result
}
function Check([string]$Name, [scriptblock]$Action) { & $Action; $script:passed++; Write-Output "PASS $Name" }
function Assert-UnsignedFailure($Result, [string]$Message) {
    if ($Result.error -notlike "*$Message*" -or 'signing' -in $Result.events -or @($Result.events | Where-Object { $_ -like 'signed:*' }).Count -gt 0) { throw "Failure did not block signing: $($Result.error); $($Result.events -join '; ')" }
}
try {
    Check 'physical reserve plus build budget blocks release before verification or signing' {
        $result = Invoke-Case 'disk-low'
        Assert-UnsignedFailure $result 'reserve'
        if ($result.events.Count -ne 0) { throw 'Low storage started verification or configuration' }
    }
    Check 'strict verification precedes unsigned release configuration and signed no-pub assembly' {
        $result = Invoke-Case 'success'
        $expected = @(
            'verify:pub get --enforce-lockfile',
            'verify:format --output=none --set-exit-if-changed lib test integration_test',
            'verify:analyze',
            'verify:test',
            'config:build apk --release --config-only',
            'signing',
            'signed:build apk --release --no-pub --no-android-gradle-daemon',
            'verify-apk'
        )
        if ($result.error -ne 'FIXTURE_APK_BOUNDARY') { throw "Unexpected caller failure: $($result.error)" }
        if (($result.events -join "`n") -cne ($expected -join "`n")) { throw "Missing or wrongly ordered unsigned release configuration: $($result.events -join '; ')" }
    }
    Check 'configuration failure prevents signing' { Assert-UnsignedFailure (Invoke-Case 'config-failure') 'Fixture configuration failure' }
    Check 'dependency lock drift after configuration prevents signing' { Assert-UnsignedFailure (Invoke-Case 'lock-drift') 'lock' }
    foreach ($stage in 1..4) {
        Check "verification stage $stage failure prevents configuration and signing" {
            $result = Invoke-Case "verify-failure-$stage"
            Assert-UnsignedFailure $result 'verification'
            if (@($result.events | Where-Object { $_ -like 'config:*' }).Count -ne 0) { throw 'Configuration ran after failed verification' }
        }
    }
    Write-Output "PASS release configuration total=$script:passed"
} finally {
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        if (-not $originalEnvironment.ContainsKey($name)) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    }
    foreach ($name in $originalEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process') }
    $safeFixture = Assert-SafeDPath $fixture 'D:\CodexData\temp'
    Remove-Item -LiteralPath $safeFixture -Recurse -Force
    Remove-Module $sandbox
}
$global:LASTEXITCODE = 0
