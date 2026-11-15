import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/playback/playback_controller.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';

import '../support/media_fixtures.dart';
import 'playback_admission_test.dart' show CachedAuthority;
import 'queue_coordinator_test.dart' show FakeEngine, entry;

void main() {
  late CachedAuthority authority;
  late FakeEngine engine;
  late QueueCoordinator queue;
  setUp(() async {
    authority = CachedAuthority(
      await mediaAuthority(Uri.parse('https://audio.example')),
    );
    engine = FakeEngine();
    queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('file:///synthetic.wav'),
        revoke: () async {},
      ),
    );
    await queue.dispatch(
      ReplaceQueue([
        entry('a'),
        entry('b'),
        entry('c'),
      ], fence: authority.requireFence()),
    );
  });
  tearDown(() => queue.dispose());

  test(
    'invalid manual selection cannot leave a permanent background guard',
    () async {
      final state = queue.snapshot;
      await expectLater(
        queue.dispatch(
          ReplaceQueue(
            [entry('bad')],
            fence: state.fence!,
            initialEntryId: 'missing',
          ),
        ),
        throwsArgumentError,
      );
      await queue.dispatch(
        ReplaceQueue(
          [entry('valid')],
          fence: state.fence!,
          expectedLineage: state.lineage,
        ),
      );
      expect(queue.snapshot.currentEntryId, 'valid');
    },
  );
  test('late guarded append cannot enter a manually replaced queue', () async {
    final lineage = queue.snapshot.lineage;
    await queue.dispatch(
      ReplaceQueue([entry('manual')], fence: authority.requireFence()),
    );
    await queue.dispatch(
      Enqueue(
        [entry('wave-late')],
        fence: authority.requireFence(),
        expectedLineage: lineage,
        automaticRecommendation: true,
      ),
    );
    expect(queue.snapshot.entries.map((e) => e.entryId), ['manual']);
  });
  test('guarded append rechecks lineage after authoritative await', () async {
    final lineage = queue.snapshot.lineage;
    authority.gateAdmissions = true;
    final append = queue.dispatch(
      Enqueue(
        [entry('wave-late')],
        fence: authority.requireFence(),
        expectedLineage: lineage,
        automaticRecommendation: true,
      ),
    );
    await pumpEventQueue();
    authority.gateAdmissions = false;
    await queue.dispatch(
      ReplaceQueue([entry('manual')], fence: authority.requireFence()),
    );
    authority.pendingAdmissions.single.complete();
    await append;
    expect(queue.snapshot.entries.map((e) => e.entryId), ['manual']);
  });
  test('automatic next preserves lineage and accepts guarded refill', () async {
    final lineage = queue.snapshot.lineage;
    authority.gateAdmissions = true;
    final append = queue.dispatch(
      Enqueue(
        [entry('refill')],
        fence: authority.requireFence(),
        expectedLineage: lineage,
        automaticRecommendation: true,
      ),
    );
    await pumpEventQueue();
    authority.gateAdmissions = false;
    engine.emit(
      position: const Duration(seconds: 123),
      duration: const Duration(seconds: 123),
      processing: PlaybackProcessing.completed,
    );
    await pumpEventQueue();
    authority.pendingAdmissions.single.complete();
    await append;
    expect(queue.snapshot.currentEntryId, 'b');
    expect(queue.snapshot.lineage, lineage);
    expect(queue.snapshot.entries.map((e) => e.entryId), [
      'a',
      'b',
      'c',
      'refill',
    ]);
  });
  test(
    'manual structural edits invalidate lineage but transport does not',
    () async {
      var revision = queue.snapshot.lineage;
      await queue.dispatch(const Reorder(['c', 'a', 'b']));
      expect(queue.snapshot.lineage, greaterThan(revision));
      revision = queue.snapshot.lineage;
      await queue.dispatch(const Remove('c'));
      expect(queue.snapshot.lineage, greaterThan(revision));
      revision = queue.snapshot.lineage;
      await queue.dispatch(
        Enqueue([entry('manual')], fence: authority.requireFence()),
      );
      expect(queue.snapshot.lineage, greaterThan(revision));
      revision = queue.snapshot.lineage;
      await queue.dispatch(const Seek(Duration(seconds: 10)));
      await queue.dispatch(const Pause());
      await queue.dispatch(const Resume());
      await queue.dispatch(const Next());
      expect(queue.snapshot.lineage, revision);
    },
  );
  test('pending manual selection wins late guarded replacement', () async {
    final state = queue.snapshot;
    authority.gateAdmissions = true;
    final manual = queue.dispatch(
      ReplaceQueue([entry('manual')], fence: state.fence!),
    );
    await pumpEventQueue();
    authority.gateAdmissions = false;
    await queue.dispatch(
      ReplaceQueue(
        [entry('late-start')],
        fence: state.fence!,
        expectedLineage: state.lineage,
        automaticRecommendation: true,
      ),
    );
    authority.pendingAdmissions.single.complete();
    await manual;
    expect(queue.snapshot.currentEntryId, 'manual');
    expect(queue.snapshot.entries.map((e) => e.entryId), ['manual']);
  });
  test('old-run completion is emitted once with terminal position before transition', () async {
    final events = <PlaybackEvent>[];
    final sub = queue.events.listen(events.add);
    engine.emit(
      position: const Duration(seconds: 123),
      duration: const Duration(seconds: 123),
      processing: PlaybackProcessing.completed,
    );
    await pumpEventQueue();
    final completed = events
        .where((e) => e.kind == PlaybackEventKind.completed)
        .toList();
    expect(completed.length, 1);
    expect(completed.single.snapshot.currentEntryId, 'a');
    expect(completed.single.snapshot.position, const Duration(seconds: 123));
    expect(completed.single.snapshot.audible, false);
    expect(
      events.indexOf(completed.single),
      lessThan(
        events.indexWhere((e) => e.kind == PlaybackEventKind.transition),
      ),
    );
    await sub.cancel();
  });
  test(
    'repeat-one and terminal-off emit a single completion for the old run',
    () async {
      await queue.dispatch(
        ReplaceQueue([entry('only')], fence: authority.requireFence()),
      );
      final events = <PlaybackEvent>[];
      final sub = queue.events.listen(events.add);
      await queue.dispatch(const SetRepeat(QueueRepeat.one));
      engine.emit(
        position: const Duration(seconds: 9),
        processing: PlaybackProcessing.completed,
      );
      await pumpEventQueue();
      expect(
        events.where((e) => e.kind == PlaybackEventKind.completed).length,
        1,
      );
      events.clear();
      await queue.dispatch(const SetRepeat(QueueRepeat.off));
      engine.emit(
        position: const Duration(seconds: 9),
        processing: PlaybackProcessing.completed,
      );
      await pumpEventQueue();
      expect(
        events.where((e) => e.kind == PlaybackEventKind.completed).length,
        1,
      );
      expect(queue.snapshot.playingIntent, false);
      await sub.cancel();
    },
  );
}
