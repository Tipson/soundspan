import 'dart:convert';

import '../../core/network/api_transport.dart';

const releaseApplicationId = 'ru.agentik007.soundspan';
const releaseSignerSha256 =
    '9692faedf466e915de5bc02e2f4cbabc2b835c2a3dfd78ba47069820e3430b8c';

final class InstalledAppInfo {
  const InstalledAppInfo({
    required this.versionCode,
    required this.versionName,
    required this.channel,
    required this.signerSha256,
    required this.sdk,
    required this.abis,
    this.applicationId = releaseApplicationId,
  });
  final int versionCode, sdk;
  final String versionName, channel, signerSha256, applicationId;
  final List<String> abis;
  bool get trusted =>
      applicationId == releaseApplicationId &&
      signerSha256 == releaseSignerSha256 &&
      const {'stable', 'test'}.contains(channel) &&
      versionCode > 0;
}

final class MobileReleaseManifest {
  const MobileReleaseManifest._({
    required this.origin,
    required this.channel,
    required this.versionCode,
    required this.versionName,
    required this.bytes,
    required this.sha256,
    required this.minSdk,
    required this.abis,
    required this.requiredCapabilities,
  });
  static const maxApkBytes = 256 * 1024 * 1024;
  static final _hash = RegExp(r'^[a-f0-9]{64}$');
  factory MobileReleaseManifest.decode(Object? value, {required Uri origin}) {
    final normalized = normalizeServerOrigin(origin);
    const fields = {
      'schemaVersion',
      'channel',
      'versionCode',
      'versionName',
      'applicationId',
      'apkPath',
      'bytes',
      'sha256',
      'signerSha256',
      'minSdk',
      'abis',
      'requiredCapabilities',
    };
    if (value is! Map ||
        value.length != fields.length ||
        !value.keys.toSet().containsAll(fields) ||
        value['schemaVersion'] is! int ||
        value['schemaVersion'] != 1 ||
        !const {'stable', 'test'}.contains(value['channel']) ||
        value['applicationId'] != releaseApplicationId ||
        value['signerSha256'] != releaseSignerSha256) {
      throw _invalid;
    }
    final code = value['versionCode'],
        name = value['versionName'],
        size = value['bytes'],
        sha = value['sha256'],
        sdk = value['minSdk'],
        abi = value['abis'],
        caps = value['requiredCapabilities'];
    if (code is! int ||
        code < 1 ||
        code > 2100000000 ||
        name is! String ||
        name.isEmpty ||
        name.length > 64 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(name) ||
        size is! int ||
        size < 1 ||
        size > maxApkBytes ||
        sha is! String ||
        !_hash.hasMatch(sha) ||
        sdk is! int ||
        sdk < 24 ||
        sdk > 10000 ||
        abi is! List ||
        abi.isEmpty ||
        abi.length > 3 ||
        abi.toSet().length != abi.length ||
        abi.any(
          (a) => !const {'armeabi-v7a', 'arm64-v8a', 'x86_64'}.contains(a),
        ) ||
        caps is! Map ||
        caps.length > 2 ||
        caps.entries.any(
          (e) =>
              !const {'importDrafts', 'orderedWave'}.contains(e.key) ||
              e.value is! int ||
              e.value != 1,
        )) {
      throw _invalid;
    }
    final channel = value['channel'] as String;
    if (value['apkPath'] !=
        '/mobile-releases/android/$channel/$code/$sha.apk') {
      throw _invalid;
    }
    return MobileReleaseManifest._(
      origin: normalized,
      channel: channel,
      versionCode: code,
      versionName: name,
      bytes: size,
      sha256: sha,
      minSdk: sdk,
      abis: List<String>.unmodifiable(abi.cast<String>()),
      requiredCapabilities: Map.unmodifiable({
        for (final key in ['importDrafts', 'orderedWave'])
          if (caps.containsKey(key)) key: caps[key] as int,
      }),
    );
  }
  final Uri origin;
  final int versionCode, bytes, minSdk;
  final String versionName, channel, sha256;
  final List<String> abis;
  final Map<String, int> requiredCapabilities;
  String get apkPath =>
      '/mobile-releases/android/$channel/$versionCode/$sha256.apk';
  Uri get apkUri => origin.resolve(apkPath);
  Map<String, Object?> toJson() => {
    'schemaVersion': 1,
    'channel': channel,
    'versionCode': versionCode,
    'versionName': versionName,
    'applicationId': releaseApplicationId,
    'apkPath': apkPath,
    'bytes': bytes,
    'sha256': sha256,
    'signerSha256': releaseSignerSha256,
    'minSdk': minSdk,
    'abis': abis,
    'requiredCapabilities': requiredCapabilities,
  };
  bool sameRelease(MobileReleaseManifest other) =>
      origin == other.origin &&
      jsonEncode(toJson()) == jsonEncode(other.toJson());
  static const _invalid = FormatException('Invalid mobile release manifest');
}
