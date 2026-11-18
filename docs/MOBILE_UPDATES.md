# Android release metadata

`GET /api/system/mobile-release/manifest?channel=stable` accepts the `stable`
and `test` channels through the existing user/API-key authentication guard.
The channel comes from the installed Android application. The endpoint accepts
exactly one `channel` parameter; it does not select owners or accept uploads.
All manifest GET outcomes use `Cache-Control: private, no-store`. An unset `MOBILE_RELEASE_ROOT`
or an absent channel marker returns 204. Invalid input returns 400; an invalid
configured tree or release returns 503. Metadata is read freshly, including
before the response, so withdrawal does not require a restart.

## Read-only release tree

Set `MOBILE_RELEASE_ROOT` to an absolute container path, such as `/releases`,
with an operator-managed read-only bind mount. Compose and Helm pass the
optional setting but do not create this storage. For Compose, an operator
override may mount `/srv/soundspan-mobile-releases:/releases:ro` on the API
and set `MOBILE_RELEASE_ROOT=/releases`. The shared worker config supports the
setting but the worker does not read, write or publish releases. Use a separate
read-only mount of only `android/` for the HTTPS edge. Never expose the root,
`channels/`, `receipts/`, temporary files or directory listings publicly.

```text
/releases/
  channels/stable.json
  channels/test.json
  receipts/android/stable/30/<apk-sha256>.json
  android/stable/30/<apk-sha256>.apk
```

The marker is the exact 12-field native v1 manifest: `schemaVersion:1`,
`channel`, positive integer `versionCode`, bounded `versionName`,
`applicationId:ru.agentik007.soundspan`, exact `apkPath`, `bytes`, `sha256`,
`signerSha256`, `minSdk`, unique supported `abis` and `requiredCapabilities`.
The APK path is exactly
`/mobile-releases/android/{channel}/{versionCode}/{sha256}.apk`.
Only `importDrafts:1` and `orderedWave:1` are recognized hard capabilities.
The current application signer pin is
`9692faedf466e915de5bc02e2f4cbabc2b835c2a3dfd78ba47069820e3430b8c`.
APKs must be 1 through 268435456 bytes. Marker and receipt files are bounded
to 65536 bytes, regular files with one link; linked roots/ancestors are rejected.

The private receipt has exactly these six fields:

```json
{
  "schemaVersion": 1,
  "manifestSha256": "<sha256 of the exact channel marker file bytes>",
  "apkSha256": "<same sha256 as the manifest>",
  "apkBytes": 123456,
  "signerSha256": "9692faedf466e915de5bc02e2f4cbabc2b835c2a3dfd78ba47069820e3430b8c",
  "apkSignatureVerified": true
}
```

The operator verifies the **final signed APK** with Android's signing/package
tools, including application ID, signer, channel, numeric version, ABI and
minimum SDK. It computes the final APK hash/size and exact marker hash before
writing this receipt. The server checks their binding and the asset's regular
file/size; it does not hash a large APK on every GET or run Android tools.
The receipt is trusted operator evidence, not a cryptographic JSON signature.
Native Android separately verifies the APK signer and installed application.
The application signing key never belongs in backend environment or storage.

## Immutable same-origin APK delivery

The existing Web proxy handles `/api/*` only. It does not serve
`/mobile-releases/*`; the operator must configure the HTTPS edge separately
before publishing a marker. Serve only exact channel/code/lowercase-hash APK
paths from the read-only `android/` subtree. Reject other methods/paths,
traversal, links, directory indexes and temporary files. Missing paths return
404; do not redirect to storage, a login page or the Web application.

APK GET is intentionally anonymous: the native APK HttpClient sends neither
Bearer credentials nor cookies. This is a public download of a signed,
non-secret application, not a public upload API. Return 200 with the original
bytes, exact `Content-Length`, `Content-Type: application/vnd.android.package-archive`,
`X-Content-Type-Options: nosniff` and
`Cache-Control: public, max-age=31536000, immutable, no-transform`.
Disable gzip/transcoding and never send Set-Cookie. The client does not require
Range or resume support. Preserve ordinary app/API/audio routing.

## Operator publication and withdrawal

Stage outside the public directory, verify the final signed file and receipt,
then publish a new content-addressed APK path without overwriting any existing
path. A collision with different contents is an error. Verify public byte hash,
size, identity encoding, status and headers before atomically replacing the
private channel marker. The API and edge must never have write access to this
tree; there is no publisher or background installer inside the application.
Concurrent operators must serialize publication and protect existing files.

Withdraw by removing the channel marker; clients then receive 204. Do not
overwrite or immediately remove immutable APKs that may still be downloading.
Release retention and filesystem capacity remain operator responsibilities.
Metadata authentication/TLS and APK signing do not constitute an independently
signed JSON envelope. Extra manifest fields are incompatible with native v1.
