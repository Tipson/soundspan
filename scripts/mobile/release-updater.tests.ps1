$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'release-tools.psm1') -Force
$digest = 'A' * 64
$certificate = "Signer #1 certificate DN: CN=Soundspan Local Release`nSigner #1 certificate SHA-256 digest: $digest"
$base29 = "package: name='ru.agentik007.soundspan' versionCode='29' versionName='0.1.26'`nsdkVersion:'24'`ntargetSdkVersion:'36'`nuses-permission: name='android.permission.INTERNET'"
$installPermission = "uses-permission: name='android.permission.REQUEST_INSTALL_PACKAGES'"
$with29 = $base29 + "`n" + $installPermission
$passed = 0
function Check([string]$Name, [scriptblock]$Action) { & $Action; $script:passed++; Write-Output "PASS $Name" }
function Reject([scriptblock]$Action) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Expected metadata rejection' }
}
Check 'updater release29 accepts explicit user-mediated installer permission' {
    Assert-ApkMetadata $certificate $with29 $digest @('AndroidManifest.xml') '0.1.26' 29
}
Check 'successor updater release retains explicit installer permission' {
    $value = $with29.Replace("versionCode='29' versionName='0.1.26'", "versionCode='30' versionName='0.1.27'")
    Assert-ApkMetadata $certificate $value $digest @('AndroidManifest.xml') '0.1.27' 30
}
Check 'legacy release28 rejects an added installer permission' {
    $value = $with29.Replace("versionCode='29' versionName='0.1.26'", "versionCode='28' versionName='0.1.25'")
    Reject { Assert-ApkMetadata $certificate $value $digest @() '0.1.25' 28 }
}
Check 'updater release rejects a missing installer permission' {
    Reject { Assert-ApkMetadata $certificate $base29 $digest @() '0.1.26' 29 }
}
Check 'unattended installation permission remains forbidden' {
    Reject { Assert-ApkMetadata $certificate ($with29 + "`nuses-permission: name='android.permission.INSTALL_PACKAGES'") $digest @() '0.1.26' 29 }
}
Check 'unrelated dangerous permission remains forbidden' {
    Reject { Assert-ApkMetadata $certificate ($with29 + "`nuses-permission: name='android.permission.MANAGE_EXTERNAL_STORAGE'") $digest @() '0.1.26' 29 }
}
Check 'updater permission does not bypass release signer verification' {
    Reject { Assert-ApkMetadata $certificate $with29 ('B' * 64) @() '0.1.26' 29 }
}
Check 'updater permission does not permit a test-only target' {
    Reject { Assert-ApkMetadata $certificate ($with29 + "`napplication-testOnly") $digest @() '0.1.26' 29 }
}
Write-Output "PASS updater release metadata total=$passed"
