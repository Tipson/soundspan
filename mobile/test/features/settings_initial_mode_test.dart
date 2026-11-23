import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/features/settings/settings_controller.dart';
import 'package:soundspan/features/settings/settings_models.dart';
import 'package:soundspan/features/settings/settings_repository.dart';

import '../support/collection_fixtures.dart';

void main() {
  test(
    'offline reconstruction keeps the confirmed device loudness choice',
    () async {
      final authority = CollectionAuthority();
      final transport = CollectionTransport(
        (_, _) => throw StateError('No offline HTTP'),
      );
      final repository = SettingsRepository(
        transport: transport,
        authority: authority,
        fence: collectionFence,
        networkPolicy: const NetworkPolicy.offline(),
      );
      final quality = ValueNotifier('original');
      final controller = SettingsController(
        repository: repository,
        quality: quality,
        setQuality: (_) async {},
        initialLoudnessMode: LoudnessMode.off,
      );
      addTearDown(controller.dispose);
      addTearDown(repository.dispose);
      addTearDown(quality.dispose);
      expect(controller.loudnessMode, LoudnessMode.off);
      await controller.load();
      expect(controller.loudnessMode, LoudnessMode.off);
      expect(transport.requests, isEmpty);
      expect(controller.failure?.code, 'offline_mode');
    },
  );

  test('a successful server read replaces cached mode and a refused patch keeps it', () async {
    final authority = CollectionAuthority();
    final repository = SettingsRepository(
      transport: CollectionTransport(
        (r, _) => r.method == ApiMethod.get
            ? const ApiResponse(200, {'loudnessMode': 'track'})
            : const ApiResponse(403, {}),
      ),
      authority: authority,
      fence: collectionFence,
      networkPolicy: const NetworkPolicy.online(),
    );
    final quality = ValueNotifier('original');
    final controller = SettingsController(
      repository: repository,
      quality: quality,
      setQuality: (_) async {},
      initialLoudnessMode: LoudnessMode.off,
    );
    addTearDown(controller.dispose);
    addTearDown(repository.dispose);
    addTearDown(quality.dispose);
    await controller.load();
    expect(controller.loudnessMode, LoudnessMode.track);
    expect(
      await controller.update(
        const UserSettingsPatch(loudnessMode: LoudnessMode.album),
      ),
      isFalse,
    );
    expect(controller.loudnessMode, LoudnessMode.track);
  });
}
