import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/downloads/device_media_barrier.dart';

import '../support/collection_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine, entry;

class HeldStopEngine extends FakeEngine {
  Completer<void>? heldStop;
  @override
  Future<void> stop() async {
    await super.stop();
    await heldStop?.future;
  }
}

class RetryStopEngine extends FakeEngine {
  bool failNext = false;
  Completer<void>? nextStop;
  @override
  Future<void> stop() {
    final stopped = super.stop();
    if (failNext) {
      failNext = false;
      throw StateError('transient stop failure');
    }
    final held = nextStop;
    nextStop = null;
    return held == null ? stopped : stopped.then((_) => held.future);
  }
}

void main() {
  test('late stop releases its captured old resource and never a newer resource of the same URI', () async {
    final engine = RetryStopEngine();
    final released = <String>[];
    final queue = QueueCoordinator(
      authority: CollectionAuthority(),
      engine: engine,
      prepare: (entry, _) async => PreparedAudio(
        uri: Uri.file('D:/CodexData/temp/shared-reader.wav'),
        revoke: () async {
          released.add(entry.entryId);
        },
      ),
    );
    await queue.dispatch(ReplaceQueue([entry('a')], fence: collectionFence));
    final held = Completer<void>();
    engine.nextStop = held;
    final oldClear = queue.dispatch(const Clear());
    try {
      await queue.dispatch(ReplaceQueue([entry('b')], fence: collectionFence));
      expect(
        released,
        ['a'],
        reason:
            'A newer successful global stop drains the older captured resource',
      );
      held.complete();
      await oldClear;
      expect(
        released,
        ['a'],
        reason: 'The late older stop cannot release new PreparedAudio even at the same path',
      );
    } finally {
      if (!held.isCompleted) held.complete();
      await oldClear;
      await queue.dispose();
    }
  });

  test('a transient local revoke failure is retried after the next successful stop', () async {
    var attempts = 0;
    final reader = DeviceMediaReader(
      File('D:/CodexData/temp/retry-reader.wav'),
      () async {
        attempts++;
        if (attempts == 1) {
          throw const FileSystemException('transient record failure');
        }
      },
    );
    final queue = QueueCoordinator(
      authority: CollectionAuthority(),
      engine: FakeEngine(),
      prepare: (_, _) async =>
          PreparedAudio(uri: reader.file.uri, revoke: reader.release),
    );
    try {
      await queue.dispatch(ReplaceQueue([entry('a')], fence: collectionFence));
      await expectLater(
        queue.dispatch(const Clear()),
        throwsA(isA<FileSystemException>()),
      );
      expect(attempts, 1);
      await queue.dispatch(const Clear());
      expect(attempts, 2);
      await reader.release();
      expect(attempts, 2);
    } finally {
      await queue.dispose();
    }
  });

  test(
    'reader release caches successful settlement but never a failed future',
    () async {
      var attempts = 0;
      final reader = DeviceMediaReader(
        File('D:/CodexData/temp/retry-record.wav'),
        () {
          attempts++;
          if (attempts == 1) {
            throw const FileSystemException('record unavailable');
          }
          return Future<void>.value();
        },
      );
      await expectLater(reader.release(), throwsA(isA<FileSystemException>()));
      await reader.release();
      await reader.release();
      expect(attempts, 2);
    },
  );

  test(
    'successful disposal drains a reader retained by a previous failed stop',
    () async {
      final engine = RetryStopEngine();
      var released = 0;
      final queue = QueueCoordinator(
        authority: CollectionAuthority(),
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.file('D:/CodexData/temp/dispose-reader.wav'),
          revoke: () async {
            released++;
          },
        ),
      );
      await queue.dispatch(ReplaceQueue([entry('a')], fence: collectionFence));
      engine.failNext = true;
      await expectLater(queue.dispatch(const Clear()), throwsStateError);
      expect(released, 0);
      await queue.dispose();
      expect(released, 1);
    },
  );

  for (final action in ['release', 'clear', 'replace', 'failure']) {
    test(
      'local reader remains held until decoder stop settles on $action',
      () async {
        final authority = CollectionAuthority();
        final engine = HeldStopEngine();
        var released = 0;
        final uri = Uri.file('D:/CodexData/temp/synthetic-reader.wav');
        final queue = QueueCoordinator(
          authority: authority,
          engine: engine,
          prepare: (_, _) async => PreparedAudio(
            uri: uri,
            revoke: () async {
              released++;
            },
          ),
        );
        await queue.dispatch(
          ReplaceQueue([entry('a')], fence: collectionFence),
        );
        final gate = Completer<void>();
        engine.heldStop = gate;
        Future<Object?>? operation;
        try {
          switch (action) {
            case 'release':
              final snapshot = queue.snapshot;
              operation = queue.releaseLocalFile(
                uri,
                fence: collectionFence,
                expectedEntryId: snapshot.currentEntryId,
                expectedGeneration: snapshot.generation,
                expectedLineage: snapshot.lineage,
              );
            case 'clear':
              operation = queue.dispatch(const Clear());
            case 'replace':
              operation = queue.dispatch(
                ReplaceQueue([entry('b')], fence: collectionFence),
              );
            case 'failure':
              engine.controller.add(
                EngineEvent(
                  generation: engine.generation,
                  position: Duration.zero,
                  processing: PlaybackProcessing.failed,
                  playing: false,
                  failed: true,
                ),
              );
          }
          await Future<void>.delayed(const Duration(milliseconds: 20));
          expect(
            released,
            0,
            reason: 'A revoke request is not proof of native file release',
          );
          gate.complete();
          await operation;
          await Future<void>.delayed(Duration.zero);
          expect(released, 1);
        } finally {
          if (!gate.isCompleted) gate.complete();
          await operation;
          await queue.dispose();
        }
      },
    );
  }

  test(
    'network capability revocation still starts before a held native stop',
    () async {
      final authority = CollectionAuthority();
      final engine = HeldStopEngine();
      var revoked = false;
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/synthetic'),
          revoke: () async {
            revoked = true;
          },
        ),
      );
      await queue.dispatch(ReplaceQueue([entry('a')], fence: collectionFence));
      final gate = Completer<void>();
      engine.heldStop = gate;
      final clearing = queue.dispatch(const Clear());
      try {
        await Future<void>.delayed(const Duration(milliseconds: 20));
        expect(revoked, isTrue);
      } finally {
        gate.complete();
        await clearing;
        await queue.dispose();
      }
    },
  );
}
