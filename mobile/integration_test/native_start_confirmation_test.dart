import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/session/session_broker_entrypoint.dart';
import 'package:soundspan/playback/just_audio_engine.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../test/support/media_fixtures.dart';
import 'support/synthetic_audio.dart';

@pragma('vm:entry-point')
Future<void> sessionBrokerMain() => runSessionBroker();

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'read-only native ACK confirms exact decoder and observes pause without restarting it',
    (tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        final directory = await Directory.systemTemp.createTemp('native-ack-');
        final file = await File('${directory.path}/silence.wav')
            .writeAsBytes(syntheticWav(duration: const Duration(seconds: 12)));
        final authority = await mediaAuthority(
          Uri.parse('https://ack-fixture.invalid'),
        );
        final engine = JustAudioEngine();
        final queue = QueueCoordinator(
          authority: authority,
          engine: engine,
          prepare: (_, _) async =>
              PreparedAudio(uri: file.uri, revoke: () async {}),
        );
        try {
          await queue.dispatch(const SetVolume(0));
          await queue.dispatch(
            ReplaceQueue(
              queue.createEntries([
                const Track(
                  ref: LibraryTrackRef('ack'),
                  title: 'Native ACK',
                  artist: 'Fixture',
                ),
              ], const PlayContext(surface: PlaySurface.library)),
              fence: authority.requireFence(),
            ),
          );
          for (
            var attempt = 0;
            attempt < 40 && !await engine.confirmPlaying();
            attempt++
          ) {
            await Future<void>.delayed(const Duration(milliseconds: 100));
          }
          expect(await engine.confirmPlaying(), true);
          const channel = MethodChannel('com.ryanheise.just_audio.methods');
          final session = engine.gainDiagnostics.sessionId;
          final state = await channel.invokeMapMethod<String, Object?>(
            'soundspanReadPlayback',
            {'sessionId': session, 'source': file.uri.toString()},
          );
          expect(state?['isPlaying'], true);
          expect(state?['positionMs'], isA<int>());
          expect(
            await channel.invokeMethod<Object?>('soundspanReadPlayback', {
              'sessionId': session,
              'source': 'file:///wrong.wav',
            }),
            isNull,
          );
          await queue.dispatch(const Pause());
          expect(await engine.confirmPlaying(), false);
          await queue.dispatch(const Resume());
          await Future<void>.delayed(const Duration(milliseconds: 300));
          expect(await engine.confirmPlaying(), true);
          await queue.dispatch(const Clear());
          expect(await engine.confirmPlaying(), false);
          debugPrint(
            'NATIVE_START_ACK_PASS exactSource=1 pause=1 resume=1 clear=1 readOnly=1',
          );
        } finally {
          await queue.dispose();
          await directory.delete(recursive: true);
        }
      });
    },
  );
}
