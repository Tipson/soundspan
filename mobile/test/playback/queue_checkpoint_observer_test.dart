import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/queue_checkpoint_observer.dart';

import '../support/collection_fixtures.dart';

void main() {
  test(
    'synchronous storage exception is observed without interrupting queue',
    () async {
      final playback = _Playback();
      var fail = true;
      final observer = QueueCheckpointObserver(
        playback: playback,
        authority: CollectionAuthority(),
        fence: collectionFence,
        save: (_, _) {
          if (fail) throw StateError('fixture synchronous storage failure');
          return Future.value();
        },
      );
      playback.emit(const Duration(seconds: 5), PlaybackEventKind.seek);
      await Future<void>.delayed(Duration.zero);
      expect(observer.failure.value?.code, 'queue_checkpoint_failed');
      fail = false;
      await observer.close();
      await playback.stream.close();
    },
  );

  test('position checkpoints are bounded to five seconds and discrete seek saves now', () async {
    final playback = _Playback();
    final positions = <Duration>[];
    final observer = QueueCheckpointObserver(
      playback: playback,
      authority: CollectionAuthority(),
      fence: collectionFence,
      save: (snapshot, fence) async {
        positions.add(snapshot.position);
      },
    );
    playback.emit(Duration.zero, PlaybackEventKind.state);
    for (var tick = 1; tick <= 100; tick++) {
      playback.emit(
        Duration(milliseconds: tick * 200),
        PlaybackEventKind.position,
      );
    }
    expect(positions.map((p) => p.inSeconds), [0, 5, 10, 15, 20]);
    playback.emit(
      const Duration(seconds: 2),
      PlaybackEventKind.seek,
      elapsed: const Duration(seconds: 21),
    );
    expect(positions.last, const Duration(seconds: 2));
    await observer.close();
    await playback.stream.close();
  });

  test('queued event checkpoints current service snapshot rather than stale event copy', () async {
    final playback = _Playback();
    final positions = <Duration>[];
    final observer = QueueCheckpointObserver(
      playback: playback,
      authority: CollectionAuthority(),
      fence: collectionFence,
      save: (snapshot, fence) async {
        positions.add(snapshot.position);
      },
    );
    playback.value = QueueSnapshot(
      fence: collectionFence,
      position: const Duration(seconds: 37),
    );
    playback.stream.add(
      PlaybackEvent(
        kind: PlaybackEventKind.seek,
        snapshot: QueueSnapshot(fence: collectionFence),
        elapsed: Duration.zero,
      ),
    );
    expect(positions.single, const Duration(seconds: 37));
    await observer.close();
    await playback.stream.close();
  });

  test(
    'close flushes once and drains pending save before it completes',
    () async {
      final playback = _Playback();
      final gate = Completer<void>();
      var saves = 0, done = false;
      final observer = QueueCheckpointObserver(
        playback: playback,
        authority: CollectionAuthority(),
        fence: collectionFence,
        save: (snapshot, fence) {
          saves++;
          return gate.future;
        },
      );
      final first = observer.close();
      expect(identical(first, observer.close()), isTrue);
      first.then((_) {
        done = true;
      });
      await Future<void>.delayed(Duration.zero);
      expect(saves, 1);
      expect(done, isFalse);
      playback.emit(const Duration(seconds: 8), PlaybackEventKind.seek);
      expect(saves, 1);
      gate.complete();
      await first;
      expect(done, isTrue);
      await playback.stream.close();
    },
  );

  test(
    'revoked owner never writes new account queue during event or close',
    () async {
      final playback = _Playback();
      final authority = CollectionAuthority();
      var saves = 0;
      final observer = QueueCheckpointObserver(
        playback: playback,
        authority: authority,
        fence: collectionFence,
        save: (snapshot, fence) async {
          saves++;
        },
      );
      authority.switchOwner();
      playback.emit(const Duration(seconds: 5), PlaybackEventKind.state);
      await observer.close();
      expect(saves, 0);
      await playback.stream.close();
    },
  );
}

class _Playback extends CollectionPlayback {
  _Playback() : super(QueueSnapshot(fence: collectionFence));
  final stream = StreamController<PlaybackEvent>.broadcast(sync: true);
  @override
  Stream<PlaybackEvent> get events => stream.stream;
  void emit(Duration position, PlaybackEventKind kind, {Duration? elapsed}) {
    value = QueueSnapshot(fence: collectionFence, position: position);
    stream.add(
      PlaybackEvent(kind: kind, snapshot: value, elapsed: elapsed ?? position),
    );
  }
}
