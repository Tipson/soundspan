import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/playback/platform_playback_guard.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/session/credential_vault.dart';

import '../support/media_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine, entry;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final scenario in [
    'denied',
    'foreground',
    'unknown',
    'new track',
    'new owner',
    'paused',
    'disposed',
    'pending start',
    'unrelated',
    'probe error',
    'probe delayed track',
  ]) {
    test('platform guard: $scenario', () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = FakeEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.file('D:/CodexData/temp/fixture.wav'),
          revoke: () async {},
        ),
      );
      final errors = StreamController<Object>.broadcast(sync: true);
      final grace = Completer<void>();
      final probe = Completer<void>();
      var checks = 0;
      bool? foreground = scenario == 'unknown'
          ? null
          : scenario == 'foreground';
      final guard = PlatformPlaybackGuard(
        coordinator: queue,
        errors: errors.stream,
        foreground: () async {
          checks++;
          if (scenario == 'probe delayed track') await probe.future;
          if (scenario == 'probe error') throw StateError('Status unavailable');
          return foreground;
        },
        settle: () => grace.future,
      );
      try {
        await queue.dispatch(
          ReplaceQueue([
            entry('a'),
            entry('b'),
          ], fence: authority.requireFence()),
        );
        await queue.dispatch(const Seek(Duration(seconds: 37)));
        final before = queue.snapshot;
        errors.add(
          PlatformException(
            code: scenario == 'unrelated' ? 'artwork unavailable' : 'startForegroundService() not allowed due to mAllowStartForeground false',
          ),
        );
        await pumpEventQueue();
        expect(
          queue.snapshot.playing,
          isTrue,
          reason: 'Allow an admitted foreground start to settle',
        );
        if (scenario == 'new track') await queue.dispatch(const Next());
        if (scenario == 'new owner') {
          await authority.invalidate();
          await authority.establish(
            OwnerKey(
              serverOrigin: Uri.parse('https://audio.example'),
              userId: 'second',
            ),
            const TokenPair(accessToken: 'test', refreshToken: 'test'),
          );
          await queue.dispatch(
            ReplaceQueue([entry('new')], fence: authority.requireFence()),
          );
        }
        if (scenario == 'paused') await queue.dispatch(const Pause());
        if (scenario == 'disposed') await guard.dispose();
        if (scenario == 'pending start') foreground = true;
        grace.complete();
        await pumpEventQueue();
        if (scenario == 'probe delayed track') {
          await queue.dispatch(const Next());
          probe.complete();
          await pumpEventQueue();
        }
        if (scenario == 'denied') {
          expect(queue.snapshot.playing, isFalse);
          expect(
            queue.snapshot.failure?.code,
            'background_playback_unavailable',
          );
          expect(queue.snapshot.failure?.retryable, isTrue);
          expect(queue.snapshot.entries, before.entries);
          expect(queue.snapshot.effectiveOrder, before.effectiveOrder);
          expect(queue.snapshot.currentEntryId, before.currentEntryId);
          expect(queue.snapshot.position, before.position);
          await queue.dispatch(const Resume());
          expect(queue.snapshot.playing, isTrue);
          expect(queue.snapshot.failure, isNull);
        } else {
          expect(queue.snapshot.failure, isNull);
          expect(queue.snapshot.playing, scenario != 'paused');
        }
        if (scenario == 'unrelated' ||
            scenario == 'new track' ||
            scenario == 'new owner' ||
            scenario == 'paused' ||
            scenario == 'disposed') {
          expect(checks, 0);
        }
      } finally {
        await guard.dispose();
        await errors.close();
        await queue.dispose();
      }
    });
  }
  test(
    'native foreground status preserves false, true and unknown distinctly',
    () async {
      const channel = MethodChannel('soundspan/playback_service');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      Object? reply;
      messenger.setMockMethodCallHandler(channel, (call) async {
        expect(call.method, 'foreground');
        expect(call.arguments, isNull);
        return reply;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      expect(await PlatformPlaybackGuard.readAndroidForeground(), isNull);
      reply = false;
      expect(await PlatformPlaybackGuard.readAndroidForeground(), isFalse);
      reply = true;
      expect(await PlatformPlaybackGuard.readAndroidForeground(), isTrue);
      reply = 'false';
      await expectLater(
        PlatformPlaybackGuard.readAndroidForeground(),
        throwsA(isA<TypeError>()),
      );
    },
  );
}
