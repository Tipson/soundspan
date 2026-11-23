import 'package:soundspan/features/updates/mobile_release_manifest.dart';

const installedUpdateApp = InstalledAppInfo(
  versionCode: 28,
  versionName: '0.1.25',
  channel: 'stable',
  signerSha256: releaseSignerSha256,
  sdk: 36,
  abis: ['arm64-v8a'],
);
Map<String, Object?> releaseDto({
  int code = 29,
  String channel = 'stable',
  String? hash,
  int bytes = 3,
}) {
  final sha = hash ?? List.filled(64, 'a').join();
  return {
    'schemaVersion': 1,
    'channel': channel,
    'versionCode': code,
    'versionName': '0.1.26',
    'applicationId': releaseApplicationId,
    'apkPath': '/mobile-releases/android/$channel/$code/$sha.apk',
    'bytes': bytes,
    'sha256': sha,
    'signerSha256': releaseSignerSha256,
    'minSdk': 24,
    'abis': ['armeabi-v7a', 'arm64-v8a', 'x86_64'],
    'requiredCapabilities': <String, Object?>{},
  };
}
