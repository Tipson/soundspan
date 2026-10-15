import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/track.dart';
import 'package:soundspan/core/model/track_ref.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/media_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine, entry;
import 'playback_admission_test.dart' show CachedAuthority;

final class ResettingEngine extends FakeEngine {
  bool failFirst = false;
  final seeks = <Duration>[];
  Completer<void>? seekGate;
  Completer<void>? loadGate;
  @override
  Future<void> load(Uri uri, int generation) async {
    await super.load(uri, generation);
    await loadGate?.future;
    position = Duration.zero;
    if (failFirst && loaded.length == 1) throw StateError('decoder failure');
  }

  @override
  Future<void> seek(Duration value) async {
    seeks.add(value);
    final gate = seekGate;
    seekGate = null;
    await gate?.future;
    position = value;
  }
}

QueueEntry waveEntry(String id) => QueueEntry(
  entryId: id,
  track: Track(ref: LibraryTrackRef(id), title: id, artist: 'Fixture'),
  context: const PlayContext(surface: PlaySurface.wave),
);

void main() {
  test('decoder duration survives paused preparation while old positions are suppressed', () async {
    final authority = await mediaAuthority(Uri.parse('https://audio.example'));
    final engine = ResettingEngine()..loadGate = Completer<void>();
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('file:///synthetic.wav'),
        revoke: () async {},
      ),
    );
    addTearDown(queue.dispose);
    final load = queue.dispatch(
      ReplaceQueue([entry('a')], fence: authority.requireFence()),
    );
    await pumpEventQueue();
    await queue.dispatch(const Seek(Duration(seconds: 80)));
    await queue.dispatch(const Pause());
    engine.emit(
      position: Duration.zero,
      duration: const Duration(seconds: 123),
    );
    engine.loadGate!.complete();
    await load;
    expect(queue.snapshot.duration, const Duration(seconds: 123));
    expect(queue.snapshot.position, const Duration(seconds: 80));
    expect(engine.plays, 0);
  });
  test(
    'pause during late-refill admission cancels service continuation',
    () async {
      final authority = CachedAuthority(
        await mediaAuthority(Uri.parse('https://audio.example')),
      );
      final engine = ResettingEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      addTearDown(queue.dispose);
      await queue.dispatch(
        ReplaceQueue([waveEntry('a')], fence: authority.requireFence()),
      );
      final captured = queue.snapshot;
      engine.emit(processing: PlaybackProcessing.completed, playing: false);
      await pumpEventQueue();
      authority.gateAdmissions = true;
      final append = queue.dispatch(
        Enqueue(
          [waveEntry('fresh')],
          fence: captured.fence!,
          expectedLineage: captured.lineage,
        ),
      );
      await pumpEventQueue();
      await queue.dispatch(const Pause());
      authority.gateAdmissions = false;
      authority.pendingAdmissions.single.complete();
      await append;
      expect(engine.plays, 1);
      expect(queue.snapshot.currentEntryId, 'a');
      expect(queue.snapshot.playingIntent, false);
    },
  );
  test(
    'seek during native load is applied after that load resets position',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = ResettingEngine()..loadGate = Completer<void>();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      addTearDown(queue.dispose);
      final load = queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      await pumpEventQueue();
      await queue.dispatch(const Seek(Duration(seconds: 80)));
      engine.loadGate!.complete();
      await load;
      expect(engine.position, const Duration(seconds: 80));
      expect(engine.seeks, [const Duration(seconds: 80)]);
    },
  );
  test(
    'seek for late old generation cannot reach replacement source',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = ResettingEngine();
      final oldMedia = Completer<PreparedAudio>();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (item, _) async => item.entryId == 'a'
            ? oldMedia.future
            : PreparedAudio(
                uri: Uri.parse('file:///b.wav'),
                revoke: () async {},
              ),
      );
      addTearDown(queue.dispose);
      final old = queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      await pumpEventQueue();
      await queue.dispatch(const Seek(Duration(seconds: 80)));
      await queue.dispatch(
        ReplaceQueue([entry('b')], fence: authority.requireFence()),
      );
      oldMedia.complete(
        PreparedAudio(uri: Uri.parse('file:///old.wav'), revoke: () async {}),
      );
      await old;
      expect(queue.snapshot.currentEntryId, 'b');
      expect(queue.snapshot.position, Duration.zero);
      expect(engine.position, Duration.zero);
      expect(engine.seeks, isEmpty);
      expect(engine.plays, 1);
    },
  );
  for (final replacement in ['new selection', 'clear', 'logout']) {
    test('old failed revoke cannot corrupt $replacement', () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = ResettingEngine()..failFirst = true;
      final revoke = Completer<void>();
      var revokeCalls = 0;
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (item, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () {
            if (item.entryId == 'a') {
              revokeCalls++;
              return revoke.future;
            }
            return Future.value();
          },
        ),
      );
      addTearDown(queue.dispose);
      final old = queue.dispatch(
        ReplaceQueue([entry('a')], fence: authority.requireFence()),
      );
      await pumpEventQueue();
      expect(revokeCalls, 1);
      Future<void>? changed;
      if (replacement == 'new selection') {
        changed = queue.dispatch(
          ReplaceQueue([entry('b')], fence: authority.requireFence()),
        );
      } else if (replacement == 'clear') {
        changed = queue.dispatch(const Clear());
      } else {
        await authority.invalidate();
      }
      await pumpEventQueue();
      revoke.complete();
      await old;
      await changed;
      await pumpEventQueue();
      expect(queue.snapshot.failure, isNull);
      if (replacement == 'new selection') {
        expect(queue.snapshot.currentEntryId, 'b');
        expect(queue.snapshot.processing, PlaybackProcessing.ready);
        expect(engine.plays, 1);
      } else {
        expect(queue.snapshot.entries, isEmpty);
        expect(queue.snapshot.processing, PlaybackProcessing.idle);
        expect(engine.plays, 0);
      }
    });
  }

  test(
    'late guarded Wave page continues only a natural terminal end',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = ResettingEngine();
      final prepared = <String>[];
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (item, _) async {
          prepared.add(item.entryId);
          return PreparedAudio(
            uri: Uri.parse('file:///synthetic.wav'),
            revoke: () async {},
          );
        },
      );
      addTearDown(queue.dispose);
      await queue.dispatch(
        ReplaceQueue([waveEntry('a')], fence: authority.requireFence()),
      );
      final captured = queue.snapshot;
      engine.emit(
        position: const Duration(seconds: 9),
        processing: PlaybackProcessing.completed,
        playing: false,
      );
      await pumpEventQueue();
      expect(queue.snapshot.processing, PlaybackProcessing.completed);
      await queue.dispatch(
        Enqueue(
          [waveEntry('fresh')],
          fence: captured.fence!,
          expectedLineage: captured.lineage,
        ),
      );
      expect(queue.snapshot.currentEntryId, 'fresh');
      expect(queue.snapshot.playingIntent, true);
      expect(queue.snapshot.processing, PlaybackProcessing.ready);
      expect(prepared, ['a', 'fresh']);
      expect(engine.plays, 2);
    },
  );
  for (final cancellation in [
    'pause',
    'clear',
    'manual selection',
    'manual enqueue',
    'explicit next',
  ]) {
    test(
      '$cancellation cancels natural-end permission before late refill',
      () async {
        final authority = await mediaAuthority(
          Uri.parse('https://audio.example'),
        );
        final engine = ResettingEngine();
        final queue = QueueCoordinator(
          authority: authority,
          engine: engine,
          prepare: (_, _) async => PreparedAudio(
            uri: Uri.parse('file:///synthetic.wav'),
            revoke: () async {},
          ),
        );
        addTearDown(queue.dispose);
        await queue.dispatch(
          ReplaceQueue([waveEntry('a')], fence: authority.requireFence()),
        );
        final captured = queue.snapshot;
        engine.emit(processing: PlaybackProcessing.completed, playing: false);
        await pumpEventQueue();
        if (cancellation == 'pause') await queue.dispatch(const Pause());
        if (cancellation == 'clear') await queue.dispatch(const Clear());
        if (cancellation == 'manual selection') {
          await queue.dispatch(
            ReplaceQueue(
              [entry('manual')],
              fence: captured.fence!,
              play: false,
            ),
          );
        }
        if (cancellation == 'manual enqueue') {
          await queue.dispatch(
            Enqueue([entry('manual')], fence: captured.fence!),
          );
        }
        if (cancellation == 'explicit next') await queue.dispatch(const Next());
        await queue.dispatch(
          Enqueue(
            [waveEntry('fresh')],
            fence: captured.fence!,
            expectedLineage: captured.lineage,
          ),
        );
        expect(engine.plays, 1);
        expect(queue.snapshot.playingIntent, false);
        expect(queue.snapshot.currentEntryId, isNot('fresh'));
      },
    );
  }
  test('restored completed metadata never obtains automatic continuation permission', () async {
    final authority = await mediaAuthority(Uri.parse('https://audio.example'));
    final engine = ResettingEngine();
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('file:///synthetic.wav'),
        revoke: () async {},
      ),
    );
    addTearDown(queue.dispose);
    final fence = authority.requireFence();
    await queue.dispatch(
      RestoreQueue(
        QueueSnapshot(
          entries: [waveEntry('saved')],
          effectiveOrder: ['saved'],
          currentEntryId: 'saved',
          fence: fence,
          processing: PlaybackProcessing.completed,
          playingIntent: true,
        ),
        fence: fence,
        expectedLineage: queue.snapshot.lineage,
      ),
    );
    await queue.dispatch(
      Enqueue(
        [waveEntry('fresh')],
        fence: fence,
        expectedLineage: queue.snapshot.lineage,
      ),
    );
    expect(engine.loaded, isEmpty);
    expect(engine.plays, 0);
    expect(queue.snapshot.playingIntent, false);
  });

  for (final paused in [false, true]) {
    test(
      'latest seek during prepare reaches loaded source with paused=$paused',
      () async {
        final authority = await mediaAuthority(
          Uri.parse('https://audio.example'),
        );
        final engine = ResettingEngine();
        final gate = Completer<PreparedAudio>();
        final queue = QueueCoordinator(
          authority: authority,
          engine: engine,
          prepare: (_, _) => gate.future,
        );
        addTearDown(queue.dispose);
        final load = queue.dispatch(
          ReplaceQueue([entry('a')], fence: authority.requireFence()),
        );
        await pumpEventQueue();
        await queue.dispatch(const Seek(Duration(seconds: 40)));
        await queue.dispatch(const Seek(Duration(seconds: 80)));
        if (paused) await queue.dispatch(const Pause());
        gate.complete(
          PreparedAudio(
            uri: Uri.parse('file:///synthetic.wav'),
            revoke: () async {},
          ),
        );
        await load;
        expect(engine.position, const Duration(seconds: 80));
        expect(queue.snapshot.position, const Duration(seconds: 80));
        expect(engine.plays, paused ? 0 : 1);
        expect(engine.seeks, [const Duration(seconds: 80)]);
      },
    );
  }
  test('seek while restore Resume prepares overrides saved position', () async {
    final authority = await mediaAuthority(Uri.parse('https://audio.example'));
    final engine = ResettingEngine();
    final gate = Completer<PreparedAudio>();
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) => gate.future,
    );
    addTearDown(queue.dispose);
    final fence = authority.requireFence();
    await queue.dispatch(
      RestoreQueue(
        QueueSnapshot(
          entries: [entry('saved')],
          effectiveOrder: ['saved'],
          currentEntryId: 'saved',
          fence: fence,
          position: const Duration(seconds: 37),
        ),
        fence: fence,
        expectedLineage: queue.snapshot.lineage,
      ),
    );
    final resume = queue.dispatch(const Resume());
    await pumpEventQueue();
    await queue.dispatch(const Seek(Duration(seconds: 80)));
    gate.complete(
      PreparedAudio(
        uri: Uri.parse('file:///synthetic.wav'),
        revoke: () async {},
      ),
    );
    await resume;
    expect(engine.position, const Duration(seconds: 80));
    expect(queue.snapshot.position, const Duration(seconds: 80));
  });
  test(
    'competing seek during post-load seek applies last request before play',
    () async {
      final authority = await mediaAuthority(
        Uri.parse('https://audio.example'),
      );
      final engine = ResettingEngine()..seekGate = Completer<void>();
      final gate = engine.seekGate!;
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async {},
        ),
      );
      addTearDown(queue.dispose);
      final fence = authority.requireFence();
      await queue.dispatch(
        RestoreQueue(
          QueueSnapshot(
            entries: [entry('saved')],
            effectiveOrder: ['saved'],
            currentEntryId: 'saved',
            fence: fence,
            position: const Duration(seconds: 37),
          ),
          fence: fence,
          expectedLineage: queue.snapshot.lineage,
        ),
      );
      final resume = queue.dispatch(const Resume());
      await pumpEventQueue();
      await queue.dispatch(const Seek(Duration(seconds: 80)));
      gate.complete();
      await resume;
      expect(engine.position, const Duration(seconds: 80));
      expect(queue.snapshot.position, const Duration(seconds: 80));
      expect(engine.plays, 1);
    },
  );
}
