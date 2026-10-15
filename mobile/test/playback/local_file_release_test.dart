import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/collection_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine, entry;

class HeldAuthority extends CollectionAuthority {
  Completer<void>? gate;
  @override
  Future<void> assertCurrent(SessionFence fence) async {
    final captured = gate;
    gate = null;
    await captured?.future;
    await super.assertCurrent(fence);
  }
}

void main() {
  late HeldAuthority authority;
  late FakeEngine engine;
  late QueueCoordinator queue;
  final file = Uri.file('D:/CodexData/temp/synthetic-ready.wav');
  var revoked = 0;
  setUp(() async {
    authority = HeldAuthority();
    engine = FakeEngine();
    revoked = 0;
    queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: file,
        revoke: () async {
          revoked++;
        },
      ),
    );
    await queue.dispatch(
      ReplaceQueue([entry('a'), entry('b')], fence: collectionFence),
    );
    await queue.dispatch(const Seek(Duration(seconds: 12)));
  });
  tearDown(() => queue.dispose());
  Future<bool> release() {
    final before = queue.snapshot;
    return queue.releaseLocalFile(
      file,
      fence: collectionFence,
      expectedEntryId: before.currentEntryId,
      expectedGeneration: before.generation,
      expectedLineage: before.lineage,
    );
  }

  test(
    'release current local file preserves paused occurrence metadata',
    () async {
      expect(await release(), isTrue);
      expect(queue.snapshot.entries.map((e) => e.entryId), ['a', 'b']);
      expect(queue.snapshot.currentEntryId, 'a');
      expect(queue.snapshot.position, const Duration(seconds: 12));
      expect(queue.snapshot.playingIntent, isFalse);
      expect(queue.snapshot.processing, PlaybackProcessing.idle);
      expect(revoked, 1);
    },
  );
  test('manual seek during authority admission wins without stop', () async {
    final gate = Completer<void>();
    authority.gate = gate;
    final stops = engine.stops;
    final pending = release();
    await queue.dispatch(const Seek(Duration(seconds: 20)));
    gate.complete();
    expect(await pending, isFalse);
    expect(engine.stops, stops);
    expect(queue.snapshot.position, const Duration(seconds: 20));
  });
  test(
    'already pending manual replacement cannot be invalidated by file release',
    () async {
      final gate = Completer<void>();
      authority.gate = gate;
      final replacement = queue.dispatch(
        ReplaceQueue([entry('c')], fence: collectionFence),
      );
      final stops = engine.stops;
      try {
        expect(await release(), isFalse);
        expect(engine.stops, stops);
      } finally {
        gate.complete();
        await replacement;
      }
      expect(queue.snapshot.currentEntryId, 'c');
    },
  );
  test(
    'natural next during authority admission cannot be stopped by release',
    () async {
      final gate = Completer<void>();
      authority.gate = gate;
      final pending = release();
      engine.emit(processing: PlaybackProcessing.completed);
      await Future<void>.delayed(Duration.zero);
      final stops = engine.stops;
      gate.complete();
      expect(await pending, isFalse);
      expect(engine.stops, stops);
      expect(queue.snapshot.currentEntryId, 'b');
    },
  );
}
