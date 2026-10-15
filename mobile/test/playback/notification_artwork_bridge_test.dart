import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/artwork/artwork_repository.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/core/network/network_policy.dart';
import 'package:soundspan/playback/audio_focus_coordinator.dart';
import 'package:soundspan/playback/notification_artwork_bridge.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/service_playback_controller.dart';
import 'package:soundspan/playback/soundspan_audio_handler.dart';

import '../artwork/artwork_repository_test.dart' show png;
import '../support/fake_tls_server.dart';
import '../support/media_fixtures.dart';
import '../support/wave_reporting_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  test('late old artwork cannot replace current occurrence and duration retains verified art', () async {
    final first = Completer<void>(), arrived = Completer<void>();
    final bytes = await png();
    final server = await FakeTlsServer.start((request) async {
      if (request.uri.queryParameters['url'] == 'native:old') {
        arrived.complete();
        await first.future;
      }
      request.response.headers.contentType = ContentType('image', 'png');
      request.response.add(bytes);
      await request.response.close();
    });
    final authority = await mediaAuthority(server.origin);
    final base = await Directory('D:/CodexData/temp/soundspan-notification')
        .create(recursive: true);
    final root = Directory(
      await (await base.createTemp()).resolveSymbolicLinks(),
    );
    final art = ArtworkRepository(
      authority: authority,
      store: ReportingStore(),
      fence: authority.requireFence(),
      networkPolicy: const NetworkPolicy.online(),
      privateRoot: root,
      testSecurityContext: server.clientContext,
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
    final handler = SoundspanAudioHandler(coordinator: queue);
    final bridge = NotificationArtworkBridge(
      handler: handler,
      artwork: art,
      authority: authority,
      fence: authority.requireFence(),
    );
    try {
      final entries = [
        for (final name in ['old', 'new'])
          QueueEntry(
            entryId: name,
            track: Track(
              ref: LibraryTrackRef(name),
              title: name,
              artist: 'Fixture',
              artwork: Uri.parse('native:$name'),
            ),
            context: const PlayContext(surface: PlaySurface.library),
          ),
      ];
      await queue.dispatch(
        ReplaceQueue(entries, fence: authority.requireFence()),
      );
      await arrived.future;
      await queue.dispatch(const Next());
      await handler.mediaItem
          .firstWhere((item) => item?.id == 'new' && item?.artUri != null)
          .timeout(const Duration(seconds: 5));
      final current = handler.mediaItem.value!;
      expect(current.artUri!.scheme, 'file');
      expect(await File.fromUri(current.artUri!).exists(), isTrue);
      first.complete();
      await settle();
      expect(handler.mediaItem.value!.id, 'new');
      engine.emit(duration: const Duration(seconds: 17));
      await settle();
      expect(handler.mediaItem.value!.duration, const Duration(seconds: 17));
      expect(handler.mediaItem.value!.artUri, current.artUri);
      await bridge.close();
      expect(handler.mediaItem.value!.artUri, isNull);
    } finally {
      if (!first.isCompleted) first.complete();
      await bridge.close();
      await art.close();
      await handler.dispose();
      await server.close();
      await root.delete(recursive: true);
    }
  });

  test(
    'service controller disposal also disables the handler focus owner',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://fixture.invalid'),
      );
      final engine = _FocusEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) => throw StateError('Unused'),
      );
      final focus = AudioFocusCoordinator(queue);
      final controller = ServicePlaybackController(
        SoundspanAudioHandler(coordinator: queue, focus: focus),
      );
      await controller.dispose();
      await focus.interruptionBegan();
      expect(engine.pauses, 0);
      await controller.dispose();
    },
  );
}

class _FocusEngine extends FakeEngine {
  int pauses = 0;
  @override
  Future<void> pause() async {
    pauses++;
  }
}
