import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/media_fixtures.dart';
import 'playback_admission_test.dart' show CachedAuthority;
import 'queue_coordinator_test.dart' show FakeEngine, entry;

final class _RestoreEngine extends FakeEngine {
  double volume = 1;
  @override
  Future<void> setVolume(double value) async => volume = value;
}

void main() {
  late CachedAuthority authority;
  late _RestoreEngine engine;
  late QueueCoordinator queue;
  late List<String> prepares;
  late List<String> revokes;

  QueueSnapshot saved({SessionFence? fence, List<String>? order}) =>
      QueueSnapshot(
        entries: [entry('first'), entry('current'), entry('last')],
        effectiveOrder: order ?? ['last', 'current', 'first'],
        currentEntryId: 'current',
        fence: fence ?? authority.requireFence(),
        position: const Duration(seconds: 37),
        duration: const Duration(minutes: 3),
        shuffle: true,
        repeat: QueueRepeat.one,
        volume: 0.35,
        playingIntent: true,
        audible: true,
        processing: PlaybackProcessing.ready,
        generation: 999,
        lineage: 999,
      );

  setUp(() async {
    authority = CachedAuthority(
      await mediaAuthority(Uri.parse('https://audio.example')),
    );
    engine = _RestoreEngine();
    prepares = [];
    revokes = [];
    queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (item, _) async {
        prepares.add(item.entryId);
        return PreparedAudio(
          uri: Uri.parse('file:///synthetic.wav'),
          revoke: () async => revokes.add(item.entryId),
        );
      },
    );
  });
  tearDown(() => queue.dispose());

  Future<void> restore(QueueSnapshot snapshot, {int? lineage}) =>
      queue.dispatch(
        RestoreQueue(
          snapshot,
          fence: authority.requireFence(),
          expectedLineage: lineage ?? queue.snapshot.lineage,
        ),
      );

  test(
    'cold hydration restores metadata without resolving or loading audio',
    () async {
      await restore(saved());
      final state = queue.snapshot;
      expect(state.currentEntryId, 'current');
      expect(state.effectiveOrder, ['last', 'current', 'first']);
      expect(state.entries.map((e) => e.entryId), ['first', 'current', 'last']);
      expect(state.position, const Duration(seconds: 37));
      expect(state.shuffle, isTrue);
      expect(state.repeat, QueueRepeat.one);
      expect(state.volume, 0.35);
      expect(state.processing, PlaybackProcessing.idle);
      expect(state.playingIntent, isFalse);
      expect(state.audible, isFalse);
      expect(state.bufferedPosition, Duration.zero);
      expect(state.generation, isNot(999));
      expect(state.lineage, isNot(999));
      expect(prepares, isEmpty);
      expect(engine.loaded, isEmpty);
      expect(engine.plays, 0);
    },
  );

  test(
    'explicit resume prepares exactly once and retains 37s and volume',
    () async {
      await restore(saved());
      await queue.dispatch(const Resume());
      expect(prepares, ['current']);
      expect(engine.loaded, hasLength(1));
      expect(engine.position, const Duration(seconds: 37));
      expect(engine.volume, 0.35);
      expect(engine.plays, 1);
    },
  );

  test(
    'hydration stops and revokes old audio without preparing restored one',
    () async {
      await queue.dispatch(
        ReplaceQueue([entry('old')], fence: authority.requireFence()),
      );
      final stops = engine.stops;
      await restore(saved());
      expect(prepares, ['old']);
      expect(revokes, ['old']);
      expect(engine.stops, greaterThan(stops));
      expect(queue.snapshot.playingIntent, isFalse);
    },
  );

  test('manual selection during restore admission wins', () async {
    authority.gateAdmissions = true;
    final pending = restore(saved());
    await pumpEventQueue();
    authority.gateAdmissions = false;
    await queue.dispatch(
      ReplaceQueue([entry('manual')], fence: authority.requireFence()),
    );
    authority.pendingAdmissions.single.complete();
    await pending;
    expect(queue.snapshot.currentEntryId, 'manual');
    expect(prepares, ['manual']);
  });

  test(
    'a pending manual intent cannot be poisoned by later cold hydration',
    () async {
      authority.gateAdmissions = true;
      final pending = queue.dispatch(
        ReplaceQueue([entry('manual')], fence: authority.requireFence()),
      );
      await pumpEventQueue();
      await restore(saved());
      expect(authority.pendingAdmissions, hasLength(1));
      authority.gateAdmissions = false;
      authority.pendingAdmissions.single.complete();
      await pending;
      expect(queue.snapshot.currentEntryId, 'manual');
    },
  );

  test('clear cancels pending hydration and old lineage never restores over manual', () async {
    final lineage = queue.snapshot.lineage;
    authority.gateAdmissions = true;
    final pending = restore(saved());
    await pumpEventQueue();
    await queue.dispatch(const Clear());
    authority.gateAdmissions = false;
    authority.pendingAdmissions.single.complete();
    await pending;
    expect(queue.snapshot.entries, isEmpty);
    await queue.dispatch(
      ReplaceQueue([entry('manual')], fence: authority.requireFence()),
    );
    await restore(saved(), lineage: lineage);
    expect(queue.snapshot.currentEntryId, 'manual');
  });

  test(
    'invalid order or foreign captured metadata cannot poison later intent',
    () async {
      await expectLater(
        restore(saved(order: ['first', 'first', 'last'])),
        throwsArgumentError,
      );
      final current = authority.requireFence();
      await expectLater(
        restore(
          saved(
            fence: SessionFence(owner: current.owner, epoch: current.epoch + 1),
          ),
        ),
        throwsArgumentError,
      );
      await restore(saved());
      expect(queue.snapshot.currentEntryId, 'current');
      expect(prepares, isEmpty);
    },
  );
}
