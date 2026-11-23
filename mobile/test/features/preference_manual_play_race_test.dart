import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/owner_playback_actions.dart';
import 'package:soundspan/core/model/app_failure.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/features/library/library_models.dart';
import 'package:soundspan/features/likes/likes_models.dart';
import 'package:soundspan/features/likes/preference_controller.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../playback/queue_coordinator_test.dart' show FakeEngine;
import '../support/collection_fixtures.dart';

class _HeldAuthority extends CollectionAuthority {
  int calls = 0;
  int? holdAt;
  int? failAt;
  final entered = Completer<void>();
  final release = Completer<void>();
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    calls++;
    if (calls == failAt) throw StateError('Injected owner-store failure');
    if (calls == holdAt) {
      entered.complete();
      await release.future;
    }
    await super.assertCurrent(fence);
  }
}

void main() {
  for (final mode in ['newer Play wins', 'owner-store failure is reported']) {
    test('fenced manual admission: $mode', () async {
      final authority = _HeldAuthority();
      final queue = QueueCoordinator(
        authority: authority,
        engine: FakeEngine(),
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/synthetic'),
          revoke: () async {},
        ),
      );
      try {
        final entries = queue.createEntries([
          collectionTrack(1),
        ], const PlayContext(surface: PlaySurface.library));
        await queue.dispatch(
          ReplaceQueue(entries, fence: collectionFence, play: false),
        );
        await queue.dispatch(const Seek(Duration(seconds: 37)));
        final actions = OwnerPlaybackActions(
          authority: authority,
          fence: collectionFence,
          playback: queue,
          isCurrent: () => authority.isCurrent(collectionFence),
          prefetch: (_) async {},
        );
        if (mode == 'newer Play wins') {
          authority.holdAt = authority.calls + 3;
          final older = actions.play(
            CollectionPlaybackRequest(
              tracks: [collectionTrack(99)],
              startIndex: 0,
              fence: collectionFence,
            ),
          );
          await authority.entered.future;
          await actions.play(
            CollectionPlaybackRequest(
              tracks: [collectionTrack(100)],
              startIndex: 0,
              fence: collectionFence,
            ),
          );
          authority.release.complete();
          await older;
          expect(
            queue.snapshot.currentEntry!.track.ref,
            collectionTrack(100).ref,
          );
        } else {
          authority.failAt = authority.calls + 3;
          await expectLater(
            actions.play(
              CollectionPlaybackRequest(
                tracks: [collectionTrack(99)],
                startIndex: 0,
                fence: collectionFence,
              ),
            ),
            throwsStateError,
          );
          expect(queue.snapshot.currentEntryId, entries.single.entryId);
          expect(queue.snapshot.position, const Duration(seconds: 37));
          await actions.play(
            CollectionPlaybackRequest(
              tracks: [collectionTrack(100)],
              startIndex: 0,
              fence: collectionFence,
            ),
          );
          expect(
            queue.snapshot.currentEntry!.track.ref,
            collectionTrack(100).ref,
          );
        }
      } finally {
        if (!authority.release.isCompleted) authority.release.complete();
        await queue.dispose();
        await authority.updates.close();
      }
    });
  }

  test('a timed out fenced manual Play reports admission failure', () async {
    final authority = _HeldAuthority();
    final queue = QueueCoordinator(
      authority: authority,
      engine: FakeEngine(),
      prepareTimeout: const Duration(milliseconds: 20),
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('http://127.0.0.1/synthetic'),
        revoke: () async {},
      ),
    );
    try {
      final entries = queue.createEntries([
        collectionTrack(1),
      ], const PlayContext(surface: PlaySurface.library));
      await queue.dispatch(
        ReplaceQueue(entries, fence: collectionFence, play: false),
      );
      final actions = OwnerPlaybackActions(
        authority: authority,
        fence: collectionFence,
        playback: queue,
        isCurrent: () => authority.isCurrent(collectionFence),
        prefetch: (_) async {},
      );
      authority.holdAt = authority.calls + 3;
      await expectLater(
        actions.play(
          CollectionPlaybackRequest(
            tracks: [collectionTrack(99)],
            startIndex: 0,
            fence: collectionFence,
          ),
        ),
        throwsA(
          isA<AppFailure>().having(
            (error) => error.code,
            'code',
            'playback_admission_timeout',
          ),
        ),
      );
      expect(queue.snapshot.currentEntryId, entries.single.entryId);
    } finally {
      if (!authority.release.isCompleted) authority.release.complete();
      await queue.dispose();
      await authority.updates.close();
    }
  });

  test(
    'an old-Wave negative cannot cancel a pending manual collection Play',
    () async {
      final authority = _HeldAuthority();
      final queue = QueueCoordinator(
        authority: authority,
        engine: FakeEngine(),
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
          (request, _) => preferenceResponse(
            Uri.decodeComponent(request.path.split('/')[4]),
            request.body!['signal'] as String,
          ),
        ),
      );
      try {
        final entries = queue.createEntries(
          [collectionTrack(1), collectionTrack(2), collectionTrack(3)],
          const PlayContext(
            surface: PlaySurface.wave,
            recommendationSessionId: 'manual-race',
          ),
        );
        await queue.dispatch(
          ReplaceQueue(entries, fence: collectionFence, play: false),
        );
        final actions = OwnerPlaybackActions(
          authority: authority,
          fence: collectionFence,
          playback: queue,
          isCurrent: () => authority.isCurrent(collectionFence),
          prefetch: (_) async {},
        );
        authority.holdAt = authority.calls + 3;
        final manual = actions.play(
          CollectionPlaybackRequest(
            tracks: [collectionTrack(99)],
            startIndex: 0,
            fence: collectionFence,
          ),
        );
        await authority.entered.future;
        await preferences.set(
          entries.first.track.ref,
          PreferenceSignal.dislike,
        );
        authority.release.complete();
        await manual;
        expect(queue.snapshot.currentEntry!.track.ref, collectionTrack(99).ref);
        expect(
          preferences.current(entries.first.track.ref).signal,
          PreferenceSignal.dislike,
        );
      } finally {
        if (!authority.release.isCompleted) authority.release.complete();
        preferences.dispose();
        await queue.dispose();
        await authority.updates.close();
      }
    },
  );
}
