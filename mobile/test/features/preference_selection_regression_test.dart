import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/network/api_transport.dart';
import 'package:soundspan/features/likes/likes_models.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/collection_fixtures.dart';

class _Engine implements PlaybackEngine {
  @override
  Stream<EngineEvent> get events => const Stream.empty();
  @override
  Future<void> load(Uri uri, int generation) async {}
  @override
  Future<void> play() async {}
  @override
  Future<void> pause() async {}
  @override
  Future<void> stop() async {}
  @override
  Future<void> seek(Duration position) async {}
  @override
  Future<void> setVolume(double volume) async {}
  @override
  Future<void> dispose() async {}
}

void main() {
  for (final repeat in [QueueRepeat.off, QueueRepeat.one]) {
    test(
      'new dislike after clear and reselect advances again with $repeat',
      () async {
        final authority = CollectionAuthority();
        final queue = QueueCoordinator(
          authority: authority,
          engine: _Engine(),
          prepare: (_, _) async => PreparedAudio(
            uri: Uri.parse('http://127.0.0.1/synthetic'),
            revoke: () async {},
          ),
        );
        final preferences = PreferenceController(
          authority: authority,
          fence: collectionFence,
          playback: queue,
          transport: CollectionTransport(
            (r, _) =>
                preferenceResponse('local-1', r.body!['signal'] as String),
          ),
        );
        addTearDown(() async {
          preferences.dispose();
          await queue.dispose();
          await authority.updates.close();
        });
        final entries = queue.createEntries([
          collectionTrack(1),
          collectionTrack(2),
        ], const PlayContext(surface: PlaySurface.library));
        await queue.dispatch(ReplaceQueue(entries, fence: collectionFence));
        await queue.dispatch(SetRepeat(repeat));
        await preferences.set(
          entries.first.track.ref,
          PreferenceSignal.dislike,
        );
        await Future<void>.delayed(Duration.zero);
        expect(queue.snapshot.currentEntryId, entries.last.entryId);
        await preferences.set(entries.first.track.ref, PreferenceSignal.clear);
        await queue.dispatch(PlayEntry(entries.first.entryId));
        await preferences.set(
          entries.first.track.ref,
          PreferenceSignal.dislike,
        );
        await Future<void>.delayed(Duration.zero);
        expect(queue.snapshot.currentEntryId, entries.last.entryId);
        expect(
          preferences.current(entries.first.track.ref).signal,
          PreferenceSignal.dislike,
        );
      },
    );
  }

  test(
    'reentrant duplicate and its late acknowledgements advance selection once',
    () async {
      final authority = CollectionAuthority();
      final track = collectionTrack(1);
      final entry = QueueEntry(
        entryId: 'a',
        track: track,
        context: const PlayContext(surface: PlaySurface.library),
      );
      final playback = CollectionPlayback(
        QueueSnapshot(
          entries: [entry],
          currentEntryId: 'a',
          fence: collectionFence,
          generation: 1,
        ),
      )..moveOnNext = false;
      final gate = Completer<ApiResponse>();
      final preferences = PreferenceController(
        authority: authority,
        fence: collectionFence,
        playback: playback,
        transport: CollectionTransport((_, _) => gate.future),
      );
      addTearDown(preferences.dispose);
      addTearDown(authority.updates.close);
      Future<void>? duplicate;
      var entered = false;
      preferences.addListener(() {
        if (entered) return;
        entered = true;
        duplicate = preferences.set(track.ref, PreferenceSignal.dislike);
      });
      final first = preferences.set(track.ref, PreferenceSignal.dislike);
      expect(playback.commands.whereType<Next>(), hasLength(1));
      playback.value = QueueSnapshot(
        entries: [entry],
        currentEntryId: 'a',
        fence: collectionFence,
        generation: 2,
      );
      gate.complete(preferenceResponse('local-1', 'thumbs_down'));
      await Future.wait([first, duplicate!]);
      expect(playback.commands.whereType<Next>(), hasLength(1));
      final next = playback.commands.single as Next;
      expect(next.expectedEntryId, 'a');
      expect(next.fence, collectionFence);
    },
  );

  test(
    'synchronous selection change during notification preserves new generation',
    () async {
      final authority = CollectionAuthority();
      final track = collectionTrack(1);
      final entry = QueueEntry(
        entryId: 'a',
        track: track,
        context: const PlayContext(surface: PlaySurface.library),
      );
      final playback = CollectionPlayback(
        QueueSnapshot(
          entries: [entry],
          currentEntryId: 'a',
          fence: collectionFence,
          generation: 1,
        ),
      )..moveOnNext = false;
      final preferences = PreferenceController(
        authority: authority,
        fence: collectionFence,
        playback: playback,
        transport: CollectionTransport(
          (_, _) => preferenceResponse('local-1', 'thumbs_down'),
        ),
      );
      addTearDown(preferences.dispose);
      addTearDown(authority.updates.close);
      preferences.addListener(() {
        playback.value = QueueSnapshot(
          entries: [entry],
          currentEntryId: 'a',
          fence: collectionFence,
          generation: 2,
        );
      });
      await preferences.set(track.ref, PreferenceSignal.dislike);
      expect(playback.commands, isEmpty);
    },
  );
}
