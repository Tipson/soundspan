import 'package:audio_service/audio_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/playback/playback_command.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/soundspan_audio_handler.dart';

import '../support/media_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine, entry;

void main() {
  test(
    'decoder duration reaches current system media item and scrubber',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = FakeEngine();
      final coordinator = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      final handler = SoundspanAudioHandler(coordinator: coordinator);
      await coordinator.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      expect(handler.mediaItem.value!.duration, isNull);
      engine.emit(duration: const Duration(seconds: 123));
      await pumpEventQueue();
      expect(handler.mediaItem.value!.duration, const Duration(seconds: 123));
      await handler.dispose();
    },
  );
  test(
    'position ticks do not flood system metadata or notification updates',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = FakeEngine();
      final coordinator = QueueCoordinator(
        authority: authority,
        engine: engine,
        elapsed: () => Duration.zero,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      final handler = SoundspanAudioHandler(coordinator: coordinator);
      await coordinator.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      engine.emit();
      await pumpEventQueue();
      var updates = 0, metadata = 0, queueUpdates = 0;
      final stateSub = handler.playbackState.listen((_) {
        updates++;
      });
      final mediaSub = handler.mediaItem.listen((_) {
        metadata++;
      });
      final queueSub = handler.queue.listen((_) {
        queueUpdates++;
      });
      await pumpEventQueue();
      updates = 0;
      metadata = 0;
      queueUpdates = 0;
      for (var i = 0; i < 60; i++) {
        engine.emit(position: Duration(milliseconds: i * 16));
      }
      await pumpEventQueue();
      expect(updates, lessThanOrEqualTo(1));
      expect(metadata, 0);
      expect(queueUpdates, 0);
      await handler.seek(const Duration(seconds: 10));
      expect(
        handler.playbackState.value.updatePosition,
        const Duration(seconds: 10),
      );
      await coordinator.dispatch(
        Enqueue([entry('b')], fence: authority.requireFence()),
      );
      await pumpEventQueue();
      expect(queueUpdates, 1);
      await coordinator.dispatch(const Reorder(['b', 'a']));
      await pumpEventQueue();
      expect(queueUpdates, 2);
      expect(handler.queue.value.map((e) => e.id), ['b', 'a']);
      await stateSub.cancel();
      await mediaSub.cancel();
      await queueSub.cancel();
      await handler.dispose();
    },
  );
  test(
    'system commands share occurrence queue and expose no source capability',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = FakeEngine();
      final coordinator = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/private-capability'),
          revoke: () async {},
        ),
      );
      final handler = SoundspanAudioHandler(coordinator: coordinator);
      await coordinator.dispatch(
        ReplaceQueue([entry('a'), entry('b')], fence: authority.requireFence()),
      );
      await handler.skipToNext();
      expect(handler.mediaItem.value!.id, 'b');
      expect(handler.queue.value.map((e) => e.id), ['a', 'b']);
      expect(handler.mediaItem.value!.extras, isNull);
      expect(
        handler.playbackState.value.systemActions,
        isNot(contains(MediaAction.seekForward)),
      );
      expect(
        handler.playbackState.value.controls,
        containsAll([MediaControl.skipToPrevious, MediaControl.skipToNext]),
      );
      await handler.pause();
      expect(coordinator.snapshot.playingIntent, false);
      await handler.play();
      expect(coordinator.snapshot.playingIntent, true);
      await handler.seek(const Duration(seconds: 7));
      expect(coordinator.snapshot.position.inSeconds, 7);
      await handler.stop();
      expect(coordinator.snapshot.entries, isEmpty);
      await handler.dispose();
    },
  );
}
