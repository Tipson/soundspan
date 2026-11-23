import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/native_app_update.dart';
import 'package:soundspan/features/updates/apk_update_downloader.dart';
import 'package:soundspan/features/updates/mobile_release_manifest.dart';

import '../support/update_fixtures.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('soundspan/app_update');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));
  final apk = VerifiedApk(
    'a' * 32,
    MobileReleaseManifest.decode(
      releaseDto(),
      origin: Uri.parse('https://music.example'),
    ),
  );
  test('installed trust comes from native package information', () async {
    messenger.setMockMethodCallHandler(
      channel,
      (call) async => {
        'applicationId': releaseApplicationId,
        'versionCode': 28,
        'versionName': '0.1.25',
        'channel': 'stable',
        'signerSha256': releaseSignerSha256,
        'sdk': 36,
        'abis': ['arm64-v8a'],
        'trusted': true,
      },
    );
    final info = await NativeAppUpdate().installedInfo();
    expect(info.trusted, isTrue);
    expect(info.versionCode, 28);
  });
  test(
    'held native stage is followed by fresh current check before commit',
    () async {
      final stage = Completer<Object?>(), started = Completer<void>();
      final calls = <String>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call.method);
        if (call.method == 'stage') {
          started.complete();
          return stage.future;
        }
        return null;
      });
      var current = true;
      final pending = NativeAppUpdate().stageAndRequestInstall(
        apk,
        'b' * 32,
        () => current,
      );
      final result = expectLater(pending, throwsA(anything));
      await started.future.timeout(const Duration(seconds: 1));
      current = false;
      stage.complete({'sessionId': 7});
      await result;
      expect(calls, ['stage', 'cancel']);
    },
  );
  test(
    'exact staged session is committed once and pending is not success',
    () async {
      final calls = <MethodCall>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call);
        return call.method == 'stage' ? {'sessionId': 7} : 'handedToSystem';
      });
      await NativeAppUpdate().stageAndRequestInstall(apk, 'b' * 32, () => true);
      expect(calls.map((c) => c.method), ['stage', 'commit']);
      expect(calls.last.arguments, {'nonce': 'b' * 32, 'sessionId': 7});
    },
  );
}
