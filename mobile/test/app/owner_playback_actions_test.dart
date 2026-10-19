import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/app/owner_playback_actions.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/features/library/library_models.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/playback_controller.dart';

import '../support/collection_fixtures.dart';

class _Engine implements PlaybackEngine {
  final updates = StreamController<EngineEvent>.broadcast();
  Completer<void>? nextLoad;
  @override
  Stream<EngineEvent> get events => updates.stream;
  @override
  Future<void> load(Uri uri, int generation) async {
    final gate = nextLoad;
    nextLoad = null;
    await gate?.future;
  }

  @override
  Future<void> play() async {}
  @override
  Future<void> pause() async {}
  @override
  Future<void> stop() async {}
  @override
  Future<void> seek(Duration position) async {}
  @override
  Future<void> setVolume(double value) async {}
  @override
  Future<void> dispose() => updates.close();
}

class _AdmissionAuthority extends CollectionAuthority {
  Completer<void>? nextAdmission;
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    final gate = nextAdmission;
    nextAdmission = null;
    await gate?.future;
    await super.assertCurrent(fence);
  }
}

void main() {
  late _AdmissionAuthority authority;
  late _Engine engine;
  late QueueCoordinator queue;
  setUp(() {
    authority = _AdmissionAuthority();
    engine = _Engine();
    queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('file:///synthetic.mp3'),
        revoke: () async {},
      ),
    );
  });
  tearDown(() async {
    await queue.dispose();
    await authority.updates.close();
  });

  OwnerPlaybackActions actions(Future<void> Function(Iterable<Track>) covers) =>
      OwnerPlaybackActions(
        authority: authority,
        fence: collectionFence,
        playback: queue,
        isCurrent: () => authority.isCurrent(collectionFence),
        prefetch: covers,
      );

  Future<void> select(OwnerPlaybackActions owner, {bool enqueue = false}) =>
      enqueue
      ? owner.enqueue([collectionTrack(1), collectionTrack(2)], collectionFence)
      : owner.play(
          CollectionPlaybackRequest(
            tracks: [
              collectionTrack(1),
              collectionTrack(1),
              collectionTrack(2),
            ],
            startIndex: 1,
            fence: collectionFence,
          ),
        );

  for (final enqueue in [false, true]) {
    final operation = enqueue ? 'enqueue' : 'play';
    test(
      '$operation reaches the queue while cover retrieval is pending',
      () async {
        final gate = Completer<void>();
        final requested = <String>[];
        var completed = false;
        final result = select(
          actions((tracks) {
            requested.addAll(tracks.map((track) => track.ref.identityKey));
            return gate.future;
          }),
          enqueue: enqueue,
        ).then((_) => completed = true);
        try {
          await Future<void>.delayed(Duration.zero);
          expect(
            completed,
            isTrue,
            reason: 'Cover IO cannot hold audio admission',
          );
          expect(requested, ['library:local-1', 'library:local-2']);
          expect(
            queue.snapshot.entries.map((entry) => entry.track.ref.identityKey),
            enqueue
                ? ['library:local-1', 'library:local-2']
                : ['library:local-1', 'library:local-1', 'library:local-2'],
          );
          expect(
            queue.snapshot.currentEntry!.entryId,
            queue.snapshot.entries[enqueue ? 0 : 1].entryId,
          );
          expect(queue.snapshot.playingIntent, !enqueue);
        } finally {
          gate.complete();
          await result;
        }
      },
    );
    for (final synchronous in [false, true]) {
      test(
        '$operation survives ${synchronous ? 'synchronous' : 'asynchronous'} cover failure',
        () async {
          final owner = actions((_) {
            if (synchronous) throw StateError('Unavailable cover');
            return Future<void>.error(StateError('Unavailable cover'));
          });
          await expectLater(select(owner, enqueue: enqueue), completes);
          expect(queue.snapshot.entries.length, enqueue ? 2 : 3);
          expect(queue.snapshot.failure, isNull);
          expect(queue.snapshot.playingIntent, !enqueue);
        },
      );
    }

    test('$operation cannot cross an owner change during admission', () async {
      final gate = authority.nextAdmission = Completer<void>();
      var coverRequests = 0;
      final result = select(
        actions((_) async => coverRequests++),
        enqueue: enqueue,
      );
      final rejected = expectLater(result, throwsA(isA<Object>()));
      authority.switchOwner();
      gate.complete();
      await rejected;
      expect(queue.snapshot.entries, isEmpty);
      expect(coverRequests, 0);
    });

    test(
      '$operation cannot overwrite a queue replaced during admission',
      () async {
        final gate = authority.nextAdmission = Completer<void>();
        final result = select(actions((_) async {}), enqueue: enqueue);
        final rejected = enqueue
            ? expectLater(result, completes)
            : expectLater(result, throwsA(isA<Object>()));
        await queue.dispatch(
          ReplaceQueue(
            queue.createEntries([
              collectionTrack(9),
            ], const PlayContext(surface: PlaySurface.library)),
            fence: collectionFence,
          ),
        );
        gate.complete();
        await rejected;
        expect(
          queue.snapshot.entries.map((entry) => entry.track.ref.identityKey),
          ['library:local-9'],
        );
      },
    );
  }

  test('late old playback cannot enable shuffle on a newer queue', () async {
    final gate = engine.nextLoad = Completer<void>();
    final old = actions((_) async {}).play(
      CollectionPlaybackRequest(
        tracks: [collectionTrack(1)],
        startIndex: 0,
        fence: collectionFence,
        shuffle: true,
      ),
    );
    await Future<void>.delayed(Duration.zero);
    await actions((_) async {}).play(
      CollectionPlaybackRequest(
        tracks: [collectionTrack(9)],
        startIndex: 0,
        fence: collectionFence,
        shuffle: false,
      ),
    );
    gate.complete();
    await old;
    expect(queue.snapshot.shuffle, isFalse);
    expect(
      queue.snapshot.currentEntry!.track.ref.identityKey,
      'library:local-9',
    );
  });
}
