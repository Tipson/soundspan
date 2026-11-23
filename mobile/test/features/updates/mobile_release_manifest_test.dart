import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/features/updates/mobile_release_manifest.dart';

import '../../support/update_fixtures.dart';

void main() {
  final origin = Uri.parse('https://music.example');
  test('v1 binds immutable APK to the exact configured HTTPS origin', () {
    final manifest = MobileReleaseManifest.decode(releaseDto(), origin: origin);
    expect(manifest.versionCode, 29);
    expect(manifest.apkUri.origin, origin.origin);
    expect(manifest.apkUri.path, releaseDto()['apkPath']);
    expect(manifest.requiredCapabilities, isEmpty);
  });
  for (final (name, mutate) in <(String, void Function(Map<String, Object?>))>[
    ('unknown schema', (m) => m['schemaVersion'] = 2),
    ('unknown field', (m) => m['silentInstall'] = true),
    ('wrong package', (m) => m['applicationId'] = 'attacker.app'),
    ('wrong signer', (m) => m['signerSha256'] = List.filled(64, 'f').join()),
    ('zero bytes', (m) => m['bytes'] = 0),
    ('oversized APK', (m) => m['bytes'] = 268435457),
    ('numeric string', (m) => m['versionCode'] = '29'),
    ('unknown channel', (m) => m['channel'] = 'nightly'),
    ('external URL', (m) => m['apkPath'] = 'https://attacker.example/a.apk'),
    (
      'encoded traversal',
      (m) => m['apkPath'] = '/mobile-releases/%2e%2e/a.apk',
    ),
    ('query credentials', (m) => m['apkPath'] = '${m['apkPath']}?token=a'),
    ('duplicate ABI', (m) => m['abis'] = ['arm64-v8a', 'arm64-v8a']),
    (
      'unknown hard capability',
      (m) => m['requiredCapabilities'] = {'future': 1},
    ),
    (
      'unknown capability version',
      (m) => m['requiredCapabilities'] = {'orderedWave': 2},
    ),
  ]) {
    test('rejects $name', () {
      final dto = releaseDto();
      mutate(dto);
      expect(
        () => MobileReleaseManifest.decode(dto, origin: origin),
        throwsA(isA<FormatException>()),
      );
    });
  }
  test('decoded capability collections are immutable snapshots', () {
    final caps = <String, Object?>{'importDrafts': 1};
    final dto = releaseDto()..['requiredCapabilities'] = caps;
    final manifest = MobileReleaseManifest.decode(dto, origin: origin);
    caps.clear();
    expect(manifest.requiredCapabilities, {'importDrafts': 1});
    expect(() => manifest.requiredCapabilities.clear(), throwsUnsupportedError);
  });
}
