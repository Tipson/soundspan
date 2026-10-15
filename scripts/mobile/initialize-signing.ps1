param(
    [Parameter(Mandatory)][string]$PrivateDirectory,
    [Parameter(Mandatory)][string]$BackupDirectory,
    [Parameter(Mandatory)][string]$Keytool
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'release-tools.psm1') -Force
$private = Assert-SafeDPath $PrivateDirectory 'D:\CodexData\private'
$backup = Assert-SafeDPath $BackupDirectory 'D:\CodexData\archives'
Assert-NewOutput $private
Assert-NewOutput $backup
if (-not (Test-Path -LiteralPath $Keytool -PathType Leaf)) { throw 'Explicit keytool executable is missing' }
if ((Get-PSDrive D).Free -lt 100MB) { throw 'Insufficient D free space for private signing backup' }
# Reserve both destinations before generating a key; failures preserve recovery material.
$null = New-Item -ItemType Directory -Path $private
Set-PrivateDirectoryAcl $private
$null = New-Item -ItemType Directory -Path $backup
Set-PrivateDirectoryAcl $backup
$keystore = Join-Path $private 'soundspan-release.p12'
$passwordFile = Join-Path $private 'password.dpapi'
$bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(48)
$clear = $null
try {
    $clear = [Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($bytes))
    [IO.File]::WriteAllBytes($passwordFile, [Security.Cryptography.ProtectedData]::Protect($clear, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
    Invoke-WithEnvironment @{ SOUNDSPAN_STORE_PASSWORD = [Text.Encoding]::UTF8.GetString($clear) } {
        $null = Invoke-CheckedNative $Keytool @('-genkeypair','-keystore',$keystore,'-storetype','PKCS12','-alias','soundspan-local-release','-keyalg','RSA','-keysize','3072','-sigalg','SHA256withRSA','-validity','10000','-dname','CN=Soundspan Local Release, O=Soundspan','-storepass:env','SOUNDSPAN_STORE_PASSWORD','-keypass:env','SOUNDSPAN_STORE_PASSWORD','-noprompt')
        $null = Invoke-CheckedNative $Keytool @('-exportcert','-keystore',$keystore,'-alias','soundspan-local-release','-storepass:env','SOUNDSPAN_STORE_PASSWORD','-file',(Join-Path $private 'certificate.der'))
    }
    $digest = (Get-FileHash -LiteralPath (Join-Path $private 'certificate.der')).Hash
    $metadata = [ordered]@{ schema=1; applicationId='ru.agentik007.soundspan'; alias='soundspan-local-release'; keystore=$keystore; passwordFile=$passwordFile; certificateSha256=$digest; keystoreSha256=(Get-FileHash -LiteralPath $keystore).Hash; createdUtc=[DateTime]::UtcNow.ToString('o'); passwordProtection='Windows DPAPI CurrentUser' }
    $metadataPath = Join-Path $private 'signing.json'
    $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding utf8
    $null = Read-SigningMetadata $metadataPath
    foreach ($file in @('soundspan-release.p12','password.dpapi','certificate.der','signing.json')) {
        $source = Join-Path $private $file
        $destination = Join-Path $backup $file
        [IO.File]::Copy($source, $destination, $false)
        Assert-PrivateAcl $destination
        if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) { throw 'Private backup hash mismatch' }
    }
    # Backup metadata deliberately preserves original paths; recovery is an explicit operation.
    [ordered]@{ metadataPath=$metadataPath; backupDirectory=$backup; certificateSha256=$digest; keystoreSha256=$metadata.keystoreSha256; currentWindowsProfileRequired=$true } | ConvertTo-Json
} finally {
    [Array]::Clear($bytes,0,$bytes.Length)
    if ($null -ne $clear) { [Array]::Clear($clear,0,$clear.Length) }
}
