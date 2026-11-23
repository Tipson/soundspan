import 'package:flutter_test/flutter_test.dart';
import 'package:soundspan/playback/playback_command.dart';
import 'package:soundspan/playback/playback_engine.dart';
import 'package:soundspan/playback/queue_coordinator.dart';
import 'package:soundspan/playback/queue_snapshot.dart';
import 'package:soundspan/app/owner_playback_actions.dart';
import 'package:soundspan/core/model/owner_key.dart';
import 'package:soundspan/features/library/library_models.dart';

import '../support/collection_fixtures.dart';
import 'queue_coordinator_test.dart' show FakeEngine;
import 'smart_shuffle_test.dart' show build, ownEntry;

void main() {
  test(
    'retired owner intent cannot cancel another current preparation',
    () async {
      final authority = CollectionAuthority(), engine = FakeEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/fixture'),
          revoke: () async {},
        ),
      );
      addTearDown(queue.dispose);
      var intents = 0;
      final actions = OwnerPlaybackActions(
        authority: authority,
        fence: collectionFence,
        playback: queue,
        isCurrent: () => authority.isCurrent(collectionFence),
        prefetch: (_) async {},
        beforeIntent: () => intents++,
      );
      final stale = SessionFence(owner: collectionOwner, epoch: 2);
      await expectLater(
        actions.play(
          CollectionPlaybackRequest(
            tracks: [ownEntry(1).track],
            startIndex: 0,
            fence: stale,
          ),
        ),
        throwsA(anything),
      );
      await expectLater(
        actions.enqueue([ownEntry(1).track], stale),
        throwsA(anything),
      );
      expect(intents, 0);
    },
  );
  test(
    'disable and guarded undo never reload current or erase its history',
    () async {
      final authority = CollectionAuthority(), engine = FakeEngine();
      final queue = QueueCoordinator(
        authority: authority,
        engine: engine,
        prepare: (_, _) async => PreparedAudio(
          uri: Uri.parse('http://127.0.0.1/fixture'),
          revoke: () async {},
        ),
      );
      addTearDown(queue.dispose);
      final entries = build(count: 12),
          order = entries.map((entry) => entry.entryId).toList();
      await queue.dispatch(
        RestoreQueue(
          QueueSnapshot(
            entries: entries,
            effectiveOrder: order,
            currentEntryId: order[3],
            fence: collectionFence,
            position: const Duration(seconds: 17),
          ),
          fence: collectionFence,
          expectedLineage: 0,
        ),
      );
      final before = queue.snapshot, stops = engine.stops;
      await queue.dispatch(
        EditSmartShuffle(
          fence: collectionFence,
          expectedLineage: before.lineage,
          expectedGeneration: before.generation,
          expectedCurrentEntryId: before.currentEntryId,
          sessionId: 'session',
        ),
      );
      final after = queue.snapshot;
      expect(after.currentEntryId, before.currentEntryId);
      expect(after.position, before.position);
      expect(after.effectiveOrder.take(4), before.effectiveOrder.take(4));
      expect(after.entries, hasLength(13));
      expect(engine.stops, stops);
      expect(engine.loaded, isEmpty);
      await queue.dispatch(
        EditSmartShuffle(
          fence: collectionFence,
          expectedLineage: after.lineage,
          expectedGeneration: after.generation,
          expectedCurrentEntryId: after.currentEntryId,
          sessionId: 'session',
          restoreEntries: before.entries,
          restoreOrder: before.effectiveOrder,
          admissionCurrent: () => true,
        ),
      );
      expect(queue.snapshot.effectiveOrder, before.effectiveOrder);
      expect(engine.stops, stops);
      expect(engine.loaded, isEmpty);
      await queue.dispatch(
        Reorder(
          queue.snapshot.entries
              .map((entry) => entry.entryId)
              .toList()
              .reversed
              .toList(),
        ),
      );
      final changed = queue.snapshot.effectiveOrder;
      await queue.dispatch(
        EditSmartShuffle(
          fence: collectionFence,
          expectedLineage: after.lineage,
          expectedGeneration: after.generation,
          expectedCurrentEntryId: after.currentEntryId,
          sessionId: 'session',
          restoreEntries: before.entries,
          restoreOrder: before.effectiveOrder,
          admissionCurrent: () => true,
        ),
      );
      expect(queue.snapshot.effectiveOrder, changed);
    },
  );
  test('late disable or undo cannot replace a new Play or owner', () async {
    final authority = CollectionAuthority(), engine = FakeEngine();
    final queue = QueueCoordinator(
      authority: authority,
      engine: engine,
      prepare: (_, _) async => PreparedAudio(
        uri: Uri.parse('http://127.0.0.1/fixture'),
        revoke: () async {},
      ),
    );
    addTearDown(queue.dispose);
    final entries = build();
    await queue.dispatch(
      ReplaceQueue(entries, fence: collectionFence, play: false),
    );
    final old = queue.snapshot;
    await queue.dispatch(
      ReplaceQueue([ownEntry(99)], fence: collectionFence, play: false),
    );
    await queue.dispatch(
      EditSmartShuffle(
        fence: collectionFence,
        expectedLineage: old.lineage,
        expectedGeneration: old.generation,
        expectedCurrentEntryId: old.currentEntryId,
        sessionId: 'session',
      ),
    );
    expect(queue.snapshot.entries.single.entryId, 'own-99');
    authority.switchOwner();
    await queue.dispatch(
      EditSmartShuffle(
        fence: collectionFence,
        expectedLineage: queue.snapshot.lineage,
        expectedGeneration: queue.snapshot.generation,
        expectedCurrentEntryId: queue.snapshot.currentEntryId,
        sessionId: 'session',
      ),
    );
    expect(queue.snapshot.entries, isEmpty);
  });
}
