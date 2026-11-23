$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'verify-mobile.ps1'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'RED: mobile verification helper is not implemented' }
$module = Import-Module (Join-Path $PSScriptRoot 'release-tools.psm1') -Force -PassThru
$environment = 'D:\CodexData\outputs\soundspan\mobile-app-20261015\mobile-env.ps1'
# Test the selected fixture environment, not a stale historical output digest.
# The mismatch case below still verifies fail-closed admission before loading it.
$environmentHash = (Get-FileHash -LiteralPath $environment).Hash
$fixture = 'D:\CodexData\temp\mobile-verification-tests-' + [guid]::NewGuid().ToString('N')
$null = Assert-SafeDPath $fixture 'D:\CodexData\temp'
$null = New-Item -ItemType Directory -Path $fixture
$canary = Join-Path $fixture 'format-canary.dart'
[IO.File]::WriteAllText($canary, "void main() { print('preserve'); }`n")
$canaryHash = (Get-FileHash -LiteralPath $canary).Hash
$priorLocation = (Get-Location).ProviderPath
$originalEnvironment = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) { $originalEnvironment[$entry.Key] = $entry.Value }
$script:passed = 0

# Only the external Dart/Flutter subprocess boundary is replaced. The real
# helper still loads the pinned environment, checks paths/SDK/lock and owns
# working-directory restoration, command ordering and failure propagation.
& $module {
    $script:realVerificationLauncher = ${function:Invoke-StreamingNative}
    $script:verificationCalls = [Collections.Generic.List[object]]::new()
    $script:failureAt = 0
    $script:failureCode = 0
    $script:interruptionAt = 0
    $script:formatCanary = ''
    function script:Invoke-StreamingNative([string]$Executable, [string[]]$Arguments) {
        $script:verificationCalls.Add([pscustomobject]@{
            executable = $Executable
            arguments = @($Arguments)
            directory = (Get-Location).ProviderPath
        })
        if ([IO.Path]::GetFileName($Executable) -eq 'dart.bat' -and $Arguments[0] -eq 'format' -and '--output=none' -notin $Arguments) {
            [IO.File]::WriteAllText($script:formatCanary, 'unexpected format mutation')
        }
        if ($script:interruptionAt -eq $script:verificationCalls.Count) {
            $global:LASTEXITCODE = $null
            throw 'External launch interrupted before an exit code was available'
        }
        if ($script:failureAt -eq $script:verificationCalls.Count) {
            $command = "[Console]::Out.WriteLine('fixture stdout before failure'); [Console]::Error.WriteLine('fixture stderr before failure'); [Console]::Out.WriteLine('fixture stdout after stderr'); exit $script:failureCode"
            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
            & $script:realVerificationLauncher (Get-Process -Id $PID).Path @('-NoProfile','-EncodedCommand',$encoded)
            return
        }
        $global:LASTEXITCODE = 0
        return "fixture subprocess completed: $([IO.Path]::GetFileName($Executable))"
    }
}

function Invoke-Case([string]$EnvironmentPath = $environment, [string]$EnvironmentHash = $environmentHash, [int]$FailureAt = 0, [int]$FailureCode = 0, [string]$HelperPath = $helper, [int]$InterruptionAt = 0) {
    & $module {
        param($ordinal, $code, $canaryPath, $interruptionOrdinal)
        $script:verificationCalls.Clear()
        $script:failureAt = $ordinal
        $script:failureCode = $code
        $script:formatCanary = $canaryPath
        $script:interruptionAt = $interruptionOrdinal
    } $FailureAt $FailureCode $canary $InterruptionAt
    $global:LASTEXITCODE = 99
    $output = @(& $HelperPath -ToolEnvironment $EnvironmentPath -ToolEnvironmentSha256 $EnvironmentHash 2>&1)
    $code = $LASTEXITCODE
    $calls = @(& $module { $script:verificationCalls.ToArray() })
    if ((Get-Location).ProviderPath -ne $priorLocation) { throw 'Helper leaked its working directory' }
    return [pscustomobject]@{ code = $code; calls = $calls; output = ($output -join "`n") }
}

function Check([string]$Name, [scriptblock]$Action) {
    & $Action
    $script:passed++
    Write-Output "PASS $Name"
}

function Assert-RejectedBeforeTools($Result) {
    if ($Result.code -eq 0 -or $Result.calls.Count -ne 0) { throw 'Unsafe admission reached an external tool or returned success' }
}

try {
    Check 'complete pinned pipeline runs once in canonical mobile directory' {
        $result = Invoke-Case
        if ($result.code -ne 0) { throw "Verification failed: $($result.output)" }
        $actual = @($result.calls | ForEach-Object { ([IO.Path]::GetFileName($_.executable)) + '|' + ($_.arguments -join '|') })
        $expected = @(
            'flutter.bat|pub|get|--enforce-lockfile',
            'dart.bat|format|--output=none|--set-exit-if-changed|lib|test|integration_test',
            'flutter.bat|analyze',
            'flutter.bat|test'
        )
        if (($actual -join "`n") -cne ($expected -join "`n")) { throw "Wrong command sequence: $($actual -join '; ')" }
        foreach ($call in $result.calls) {
            if ($call.directory -ne 'D:\CodexData\workspaces\ChatGPT\soundspan-wave-mixes-release\mobile') { throw 'Tool ran outside mobile' }
            if ((Split-Path -Parent $call.executable) -ne 'D:\CodexData\runtime\flutter\bin') { throw 'Tool bypassed pinned Flutter SDK' }
        }
    }
    Check 'format gate is read only and includes integration tests' {
        $result = Invoke-Case -FailureAt 2 -FailureCode 1
        if ($result.code -ne 1 -or $result.calls.Count -ne 2) { throw 'Format failure did not stop analysis and tests' }
        if ((Get-FileHash -LiteralPath $canary).Hash -ne $canaryHash) { throw 'Format command allowed source mutation' }
    }
    Check 'real subprocess failure retains complete stdout and stderr diagnostics' {
        $result = Invoke-Case -FailureAt 3 -FailureCode 37
        if ($result.code -ne 37 -or $result.calls.Count -ne 3) { throw "Real subprocess failure was not propagated: $($result.code)" }
        foreach ($line in @('fixture stdout before failure','fixture stderr before failure','fixture stdout after stderr')) {
            if (-not $result.output.Contains($line)) { throw "Failed subprocess diagnostic was discarded: $line" }
        }
    }
    Check 'successful subprocess stderr remains diagnostic output and does not fail pipeline' {
        $result = Invoke-Case -FailureAt 2 -FailureCode 0
        if ($result.code -ne 0 -or $result.calls.Count -ne 4) { throw 'Successful process stderr incorrectly stopped later tools' }
        if (-not $result.output.Contains('fixture stderr before failure')) { throw 'Successful stderr was discarded' }
    }
    Check 'external launch without an exit code fails closed and prevents later tools' {
        $result = Invoke-Case -InterruptionAt 1
        if ($result.code -ne 1 -or $result.calls.Count -ne 1) { throw "Interrupted launch incorrectly returned success: $($result.code)" }
    }
    foreach ($case in @(@{ at=1; code=17 }, @{ at=2; code=23 }, @{ at=3; code=31 }, @{ at=4; code=41 })) {
        Check "stage $($case.at) propagates exit $($case.code) and prevents later tools" {
            $result = Invoke-Case -FailureAt $case.at -FailureCode $case.code
            if ($result.code -ne $case.code -or $result.calls.Count -ne $case.at) { throw "Failure propagation changed: code=$($result.code); calls=$($result.calls.Count)" }
        }
    }
    Check 'tool environment outside D is rejected before tools' {
        Assert-RejectedBeforeTools (Invoke-Case -EnvironmentPath 'C:\Temp\not-admitted-mobile-env.ps1')
    }
    Check 'environment digest mismatch is rejected before loading or tools' {
        Assert-RejectedBeforeTools (Invoke-Case -EnvironmentHash ('A' * 64))
    }
    Check 'mutable tool path on C is rejected before tools' {
        $unsafeEnvironment = Join-Path $fixture 'unsafe-environment.ps1'
        [IO.File]::WriteAllText($unsafeEnvironment, ". '$environment'`n`$env:PUB_CACHE = 'C:\unsafe-mobile-cache'`n")
        Assert-RejectedBeforeTools (Invoke-Case -EnvironmentPath $unsafeEnvironment -EnvironmentHash (Get-FileHash -LiteralPath $unsafeEnvironment).Hash)
    }
    Check 'environment without gate is rejected before tools' {
        $missingGate = Join-Path $fixture 'missing-gate.ps1'
        [IO.File]::WriteAllText($missingGate, 'Remove-Item Function:Invoke-MobileGate -ErrorAction SilentlyContinue')
        Assert-RejectedBeforeTools (Invoke-Case -EnvironmentPath $missingGate -EnvironmentHash (Get-FileHash -LiteralPath $missingGate).Hash)
    }
    Check 'noncanonical source checkout is rejected before tools' {
        $copiedScripts = Join-Path $fixture 'source\scripts\mobile'
        $null = New-Item -ItemType Directory -Path $copiedScripts
        [IO.File]::Copy($helper, (Join-Path $copiedScripts 'verify-mobile.ps1'))
        [IO.File]::Copy((Join-Path $PSScriptRoot 'release-tools.psm1'), (Join-Path $copiedScripts 'release-tools.psm1'))
        Assert-RejectedBeforeTools (Invoke-Case -HelperPath (Join-Path $copiedScripts 'verify-mobile.ps1'))
    }
    Write-Output "PASS mobile verification total=$script:passed"
} finally {
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        if (-not $originalEnvironment.ContainsKey($name)) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    }
    foreach ($name in $originalEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process') }
    $safeFixture = Assert-SafeDPath $fixture 'D:\CodexData\temp'
    Remove-Item -LiteralPath $safeFixture -Recurse -Force
    Remove-Module $module
}
$global:LASTEXITCODE = 0
