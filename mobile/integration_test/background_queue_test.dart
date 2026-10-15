import 'dart:io';

import 'package:audio_service/audio_service.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/session/session_broker_entrypoint.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/soundspan_audio_handler.dart';

import '../test/support/media_fixtures.dart';
import 'support/synthetic_audio.dart';

// Keep the real broker entrypoint available for the unchanged Application host.
@pragma('vm:entry-point')
Future<void> sessionBrokerMain() => runSessionBroker();

Future<void> waitFor(
  PlaybackController controller,
  bool Function(QueueSnapshot) predicate,
) async {
  if (predicate(controller.snapshot)) return;
  await controller.snapshots
      .firstWhere(predicate)
      .timeout(const Duration(seconds: 20));
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real decoder transitions with absent widget and native media commands',
    (tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        final authority = await mediaAuthority(
          Uri.parse('https://synthetic-audio.invalid'),
        );
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        final bytes = syntheticWav();
        var reads = 0;
        final requests = server.listen((request) async {
          reads++;
          var start = 0, end = bytes.length - 1;
          final raw = request.headers.value('range');
          if (raw != null) {
            final range = RegExp(r'^bytes=(\d+)-(\d*)$').firstMatch(raw)!;
            start = int.parse(range[1]!);
            if (range[2]!.isNotEmpty) end = minEnd(int.parse(range[2]!), end);
            request.response.statusCode = 206;
            request.response.headers.set(
              'content-range',
              'bytes $start-$end/${bytes.length}',
            );
          }
          request.response.headers.contentType = ContentType('audio', 'wav');
          request.response.headers.set('accept-ranges', 'bytes');
          request.response.contentLength = end - start + 1;
          if (request.method != 'HEAD') {
            request.response.add(bytes.sublist(start, end + 1));
          }
          await request.response.close();
        });
        final resolves = <String>[], revokes = <String>[];
        final concrete = await SoundspanAudioHandler.create(
          authority: authority,
          prepare: (entry, fence) async {
            await authority.assertCurrent(fence);
            resolves.add(entry.entryId);
            return PreparedAudio(
              uri: Uri.parse(
                'http://127.0.0.1:${server.port}/synthetic/${entry.entryId}',
              ),
              revoke: () async {
                revokes.add(entry.entryId);
              },
            );
          },
        );
        final system = await AudioService.init(
          builder: () => concrete,
          config: const AudioServiceConfig(
            androidNotificationChannelId: 'ru.agentik007.soundspan.playback',
            androidNotificationChannelName: 'Soundspan',
            androidStopForegroundOnPause: false,
          ),
        );
        final controller = concrete.controller;
        final audible = <String>{};
        final completions = <int, int>{};
        final terminalPositions = <Duration>[];
        final playbackEvents = controller.events.listen((event) {
          if (event.kind == PlaybackEventKind.completed) {
            completions.update(
              event.snapshot.generation,
              (count) => count + 1,
              ifAbsent: () => 1,
            );
            terminalPositions.add(event.snapshot.position);
          }
        });
        final events = controller.snapshots.listen((state) {
          if (state.audible &&
              state.position > const Duration(milliseconds: 200)) {
            audible.add(state.currentEntryId!);
          }
        });
        try {
          final entries = controller.createEntries(
            List.generate(
              12,
              (i) => Track(
                ref: LibraryTrackRef('synthetic-$i'),
                title: 'Synthetic $i',
                artist: 'Soundspan test fixture',
              ),
            ),
            const PlayContext(surface: PlaySurface.library),
          );
          await controller.dispatch(
            ReplaceQueue(entries, fence: authority.requireFence()),
          );
          debugPrint('T04_BACKGROUND_READY');
          await waitFor(controller, (_) => audible.length >= 4);
          expect(resolves.length, greaterThanOrEqualTo(4));
          expect(reads, greaterThanOrEqualTo(4));
          expect(completions.length, greaterThanOrEqualTo(3));
          expect(completions.values.every((count) => count == 1), true);
          expect(
            terminalPositions.every((position) => position > Duration.zero),
            true,
          );
          debugPrint('T04_EXPECT_NATIVE_PAUSE');
          await waitFor(controller, (s) => !s.playingIntent);
          debugPrint('T04_EXPECT_NATIVE_PLAY');
          await waitFor(controller, (s) => s.playingIntent);
          final beforeNext = controller.snapshot.currentEntryId;
          debugPrint('T04_EXPECT_NATIVE_NEXT');
          await waitFor(controller, (s) => s.currentEntryId != beforeNext);
          final beforePrevious = controller.snapshot.currentEntryId;
          debugPrint('T04_EXPECT_NATIVE_PREVIOUS');
          await waitFor(controller, (s) => s.currentEntryId != beforePrevious);
          expect(controller.snapshot.failure, isNull);
          await system.stop();
          expect(controller.snapshot.entries, isEmpty);
          expect(revokes.length, resolves.length);
          debugPrint(
            'T04_NATIVE_PASS transitions=${audible.length - 1} resolves=${resolves.length} reads=$reads revokes=${revokes.length} completions=${completions.length}',
          );
        } finally {
          await events.cancel();
          await playbackEvents.cancel();
          await concrete.dispose();
          await requests.cancel();
          await server.close(force: true);
        }
      });
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}

int minEnd(int value, int end) => value < end ? value : end;
